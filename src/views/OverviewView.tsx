import { useEffect, useMemo, useState } from 'react'
import {
  type ScanSnapshot,
  type WorkspaceSnapshot,
  type AppInfo,
  type CleanupSelection,
  type CleanupProgress,
  type StorageEntry,
  StorageGroupLabel,
  categoryBytes,
  categoryReclaimable,
  categoryIsEmpty,
  isSelectable,
  CleanupRiskLabel,
  snapshotSessionBytes,
  snapshotEmbeddedImageBytes,
  workspaceBytes,
  formatBytes
} from '../../shared/types'

interface Props {
  snapshot: ScanSnapshot
  workspace: WorkspaceSnapshot | null
  appInfo: AppInfo | null
  cleaning: boolean
  actionsDisabled: boolean
  cleanProgress: CleanupProgress | null
  onCleanup: (selection: CleanupSelection) => void
  onOpenDetail: (detail: 'sessions' | 'plugins' | 'workspace' | 'automation') => void
}

export default function OverviewView({ snapshot, workspace, appInfo, cleaning, actionsDisabled, cleanProgress, onCleanup, onOpenDetail }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const allEntries = useMemo<StorageEntry[]>(
    () => snapshot.categories.flatMap((c) => c.entries),
    [snapshot]
  )
  const selectedEntries = useMemo(
    () => allEntries.filter((e) => selected.has(e.id)),
    [allEntries, selected]
  )
  const selectedBytes = selectedEntries.reduce((sum, e) => sum + e.reclaimableBytes, 0)

  useEffect(() => {
    setSelected(new Set(snapshot.categories
      .filter((category) => category.group === 'recommended')
      .flatMap((category) => category.entries)
      .filter((item) => isSelectable(item.risk))
      .map((item) => item.id)))
  }, [snapshot.scannedAt])

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const groups: Array<keyof typeof StorageGroupLabel> = ['recommended', 'review', 'protectedData']

  return (
    <>
      <section className="total">
        <div><span className="total-label">Codex 总占用</span><span className="total-value">{formatBytes(snapshot.totalCodexBytes)}</span></div>
        <div><span className="total-label">已选择</span><span className="total-value accent">{formatBytes(selectedBytes)}</span><small>{selectedEntries.length} 项</small></div>
        <div><span className="total-label">会话数据</span><span className="total-value">{formatBytes(snapshotSessionBytes(snapshot))}</span><small>{snapshot.sessions.length} 个 · 图片 {formatBytes(snapshotEmbeddedImageBytes(snapshot))}</small></div>
      </section>

      {appInfo?.codexRunning && <p className="notice warning">{appInfo.runtimeSummary ?? 'Codex 正在运行'}。需要独占文件的项目会自动推迟。</p>}
      {snapshot.notes.map((note) => <p className="notice" key={note}>{note}</p>)}

      <section className="overview-links">
        <OverviewLink title="会话记录" detail="归档只是隐藏；可按标题、项目、日期和图片占用筛选。" value={`${snapshot.sessions.length} 个 · ${formatBytes(snapshotSessionBytes(snapshot))}`} disabled={!snapshot.sessions.length} onClick={() => onOpenDetail('sessions')} />
        <OverviewLink title="插件版本" detail="当前版本受保护，只清理旧版本和卸载残留。" value={`${snapshot.pluginVersions.length} 个版本`} onClick={() => onOpenDetail('plugins')} />
        <OverviewLink title="工作产出" detail="属于你的成果，默认不选，自动清理永远不会碰。" value={workspace?.isScanned ? formatBytes(workspaceBytes(workspace)) : '尚未统计'} onClick={() => onOpenDetail('workspace')} />
      </section>

      {groups.map((group) => {
        const cats = snapshot.categories.filter((c) => c.group === group && !categoryIsEmpty(c))
        if (cats.length === 0) return null
        const meta = StorageGroupLabel[group]
        const selectableGroup = group !== 'protectedData'
        const groupEntries = cats.flatMap((category) => category.entries).filter((item) => isSelectable(item.risk))
        const groupAllSelected = groupEntries.length > 0 && groupEntries.every((item) => selected.has(item.id))
        const groupSomeSelected = groupEntries.some((item) => selected.has(item.id))
        return (
          <section key={group} className="group">
            <div className="group-heading"><div><h2>{meta.title}</h2><p className="group-subtitle">{meta.subtitle}</p></div>
              {selectableGroup && <input type="checkbox" checked={groupAllSelected}
                ref={(input) => { if (input) input.indeterminate = groupSomeSelected && !groupAllSelected }}
                onChange={(event) => setSelected((previous) => { const next = new Set(previous); for (const item of groupEntries) event.target.checked ? next.add(item.id) : next.delete(item.id); return next })}/>}</div>
            {cats.map((c) => (
              <article key={c.kind} className="category">
                <div className="category-head">
                  {selectableGroup && (<input type="checkbox" checked={c.entries.filter((entry) => isSelectable(entry.risk)).every((entry) => selected.has(entry.id))}
                    ref={(input) => { if (input) input.indeterminate = c.entries.some((entry) => selected.has(entry.id)) && !c.entries.every((entry) => selected.has(entry.id)) }}
                    onChange={(event) => setSelected((previous) => {
                      const next = new Set(previous)
                      for (const entry of c.entries.filter((item) => isSelectable(item.risk))) event.target.checked ? next.add(entry.id) : next.delete(entry.id)
                      return next
                    })}/>)}
                  <button className="category-toggle" onClick={() => setExpanded((previous) => { const next = new Set(previous); next.has(c.kind) ? next.delete(c.kind) : next.add(c.kind); return next })}>
                    <span className="category-title">{c.title}</span><span className="risk-pill">{CleanupRiskLabel[c.risk]}</span>
                  </button>
                  <span className="category-bytes">{formatBytes(categoryBytes(c))}</span>
                </div>
                <p className="category-detail">{c.detail}</p>
                {selectableGroup && <p className="category-reclaimable">可回收 {formatBytes(categoryReclaimable(c))}</p>}
                {expanded.has(c.kind) && <ul className="entries">
                  {c.entries.map((e) => (
                    <EntryRow
                      key={e.id}
                      entry={e}
                      selectable={selectableGroup && isSelectable(e.risk)}
                      checked={selected.has(e.id)}
                      onToggle={() => toggle(e.id)}
                    />
                  ))}
                </ul>}
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
          <button className="clean" onClick={() => {
            onCleanup({ kind: 'storage', ids: selectedEntries.map((entry) => entry.id) })
          }} disabled={cleaning || actionsDisabled}>
            {cleaning ? `清理中… (${cleanProgress?.completed ?? 0}/${selectedEntries.length})` : '清理已选'}
          </button>
        </div>
      )}
    </>
  )
}

function OverviewLink({ title, detail, value, disabled = false, onClick }: { title: string; detail: string; value: string; disabled?: boolean; onClick: () => void }) {
  return <article className="overview-link"><div><strong>{title}</strong><small>{detail}</small></div><span>{value}</span><button className="secondary" disabled={disabled} onClick={onClick}>查看</button></article>
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
      <button className="icon-button" title={entry.url} onClick={() => window.cleanmycodex.revealPath(entry.url)}>⌕</button>
    </li>
  )
}
