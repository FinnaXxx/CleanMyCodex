import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type ScanSnapshot,
  type ScanProgress,
  type CleanupReport,
  type CleanupProgress,
  type StorageEntry,
  StorageGroupLabel,
  categoryBytes,
  categoryReclaimable,
  categoryIsEmpty,
  isSelectable,
  cleanupStatusLabel,
  cleanupStatusMessage,
  reportFreedBytes,
  reportProblems,
  formatBytes
} from '../shared/types'

function App() {
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(null)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [cleaning, setCleaning] = useState(false)
  const [cleanProgress, setCleanProgress] = useState<CleanupProgress | null>(null)
  const [report, setReport] = useState<CleanupReport | null>(null)

  const runScan = useCallback(async () => {
    setError(null)
    setReport(null)
    setSelected(new Set())
    setProgress({ stage: '扫描中', currentPath: '', scannedBytes: 0, fraction: 0 })
    try {
      setSnapshot(await window.cleanmycodex.scan())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setProgress(null)
    }
  }, [])

  useEffect(() => {
    const offScan = window.cleanmycodex.onScanProgress(setProgress)
    const offClean = window.cleanmycodex.onCleanupProgress(setCleanProgress)
    void runScan()
    return () => {
      offScan()
      offClean()
    }
  }, [runScan])

  const allEntries = useMemo<StorageEntry[]>(() => {
    if (!snapshot) return []
    return snapshot.categories.flatMap((c) => c.entries)
  }, [snapshot])

  const selectedEntries = useMemo(
    () => allEntries.filter((e) => selected.has(e.id)),
    [allEntries, selected]
  )
  const selectedBytes = useMemo(
    () => selectedEntries.reduce((sum, e) => sum + e.reclaimableBytes, 0),
    [selectedEntries]
  )

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const runCleanup = useCallback(async () => {
    if (selectedEntries.length === 0 || cleaning) return
    setCleaning(true)
    setReport(null)
    setCleanProgress({ completed: 0, total: selectedEntries.length, currentTitle: '' })
    try {
      const result = await window.cleanmycodex.cleanup(selectedEntries)
      setReport(result)
      // Rescan to reflect what was reclaimed.
      await runScan()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCleaning(false)
      setCleanProgress(null)
    }
  }, [selectedEntries, cleaning, runScan])

  const groups: Array<keyof typeof StorageGroupLabel> = ['recommended', 'review', 'protectedData']

  return (
    <main className="app">
      <header className="app-header">
        <div>
          <h1>CleanMyCodex</h1>
          <p className="subtitle">Codex 空间扫描与清理工具</p>
        </div>
        <button className="rescan" onClick={runScan} disabled={!!progress || cleaning}>
          {progress ? '扫描中…' : '重新扫描'}
        </button>
      </header>

      {progress && <p className="progress">正在查看 {progress.currentPath}</p>}
      {error && <p className="error">出错：{error}</p>}

      {snapshot && (
        <>
          <section className="total">
            <span className="total-label">Codex 总占用</span>
            <span className="total-value">{formatBytes(snapshot.totalCodexBytes)}</span>
          </section>

          {report && <CleanupBanner report={report} />}

          {groups.map((group) => {
            const cats = snapshot.categories.filter((c) => c.group === group && !categoryIsEmpty(c))
            if (cats.length === 0) return null
            const meta = StorageGroupLabel[group]
            const selectableGroup = group !== 'protectedData'
            return (
              <section key={group} className="group">
                <h2>{meta.title}</h2>
                <p className="group-subtitle">{meta.subtitle}</p>
                {cats.map((c) => (
                  <article key={c.kind} className="category">
                    <div className="category-head">
                      <span className="category-title">{c.title}</span>
                      <span className="category-bytes">{formatBytes(categoryBytes(c))}</span>
                    </div>
                    <p className="category-detail">{c.detail}</p>
                    {selectableGroup && (
                      <p className="category-reclaimable">可回收 {formatBytes(categoryReclaimable(c))}</p>
                    )}
                    <ul className="entries">
                      {c.entries.map((e) => (
                        <EntryRow
                          key={e.id}
                          entry={e}
                          selectable={selectableGroup && isSelectable(e.risk)}
                          checked={selected.has(e.id)}
                          onToggle={() => toggle(e.id)}
                        />
                      ))}
                    </ul>
                  </article>
                ))}
              </section>
            )
          })}

          {snapshot.categories.length === 0 && <p className="empty">没有扫描到可清理的内容。</p>}

          {selectedEntries.length > 0 && (
            <div className="action-bar">
              <span>
                已选 {selectedEntries.length} 项 · 可回收 {formatBytes(selectedBytes)}
              </span>
              <button className="clean" onClick={runCleanup} disabled={cleaning}>
                {cleaning ? `清理中… (${cleanProgress?.completed ?? 0}/${selectedEntries.length})` : '清理已选'}
              </button>
            </div>
          )}
        </>
      )}
    </main>
  )
}

function EntryRow({
  entry,
  selectable,
  checked,
  onToggle
}: {
  entry: StorageEntry
  selectable: boolean
  checked: boolean
  onToggle: () => void
}) {
  return (
    <li className="entry">
      <label>
        <input type="checkbox" disabled={!selectable} checked={checked} onChange={onToggle} />
        <span className="entry-title">{entry.title}</span>
      </label>
      <span className="entry-bytes">{formatBytes(entry.reclaimableBytes)}</span>
    </li>
  )
}

function CleanupBanner({ report }: { report: CleanupReport }) {
  const problems = reportProblems(report)
  return (
    <section className="report">
      <p className="report-summary">
        已释放 {formatBytes(reportFreedBytes(report))}
        {problems.length > 0 && `，${problems.length} 项未完成`}
      </p>
      <ul className="report-list">
        {report.outcomes.map((o) => (
          <li key={o.id} className={`report-row report-${o.status.kind}`}>
            <span className="report-row-title">{o.title}</span>
            <span className="report-row-status">{cleanupStatusLabel(o.status)}</span>
            {cleanupStatusMessage(o.status) && <span className="report-row-msg">{cleanupStatusMessage(o.status)}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}

export default App