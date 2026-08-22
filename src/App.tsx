import { useCallback, useEffect, useState } from 'react'
import {
  type ScanSnapshot,
  type ScanProgress,
  StorageGroupLabel,
  categoryBytes,
  categoryReclaimable,
  categoryIsEmpty,
  formatBytes
} from '../shared/types'

function App() {
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(null)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  const runScan = useCallback(async () => {
    setError(null)
    setProgress({ stage: '扫描中', currentPath: '', scannedBytes: 0, fraction: 0 })
    try {
      const result = await window.cleanmycodex.scan()
      setSnapshot(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setProgress(null)
    }
  }, [])

  useEffect(() => {
    const off = window.cleanmycodex.onScanProgress(setProgress)
    void runScan()
    return off
  }, [runScan])

  const groups: Array<keyof typeof StorageGroupLabel> = ['recommended', 'review', 'protectedData']

  return (
    <main className="app">
      <header className="app-header">
        <div>
          <h1>CleanMyCodex</h1>
          <p className="subtitle">Codex 空间扫描与清理工具</p>
        </div>
        <button className="rescan" onClick={runScan} disabled={!!progress}>
          {progress ? '扫描中…' : '重新扫描'}
        </button>
      </header>

      {progress && <p className="progress">正在查看 {progress.currentPath}</p>}
      {error && <p className="error">扫描失败：{error}</p>}

      {snapshot && (
        <>
          <section className="total">
            <span className="total-label">Codex 总占用</span>
            <span className="total-value">{formatBytes(snapshot.totalCodexBytes)}</span>
          </section>

          {groups.map((group) => {
            const cats = snapshot.categories.filter((c) => c.group === group && !categoryIsEmpty(c))
            if (cats.length === 0) return null
            const meta = StorageGroupLabel[group]
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
                    {group !== 'protectedData' && (
                      <p className="category-reclaimable">可回收 {formatBytes(categoryReclaimable(c))}</p>
                    )}
                  </article>
                ))}
              </section>
            )
          })}

          {snapshot.categories.length === 0 && <p className="empty">没有扫描到可清理的内容。</p>}
        </>
      )}
    </main>
  )
}

export default App