import { useEffect, useMemo, useState } from 'react'
import {
  type ScanSnapshot,
  type WorkspaceSnapshot,
  type AppInfo,
  type CleanupSelection,
  type CleanupProgress,
  type StorageCategory,
  type StorageEntry,
  type StorageKind,
  StorageSectionLabel,
  StorageSectionOrder,
  categoryAdvice,
  categoryBytes,
  categoryReclaimable,
  categoryIsEmpty,
  categorySection,
  isSelectable,
  snapshotSessionBytes,
  workspaceBytes,
  formatBytes
} from '../../shared/types'

type Detail = 'sessions' | 'plugins' | 'workspace' | 'automation'

interface Props {
  snapshot: ScanSnapshot
  workspace: WorkspaceSnapshot | null
  appInfo: AppInfo | null
  cleaning: boolean
  actionsDisabled: boolean
  cleanProgress: CleanupProgress | null
  onCleanup: (selection: CleanupSelection) => void
  onOpenDetail: (detail: Detail) => void
}

export default function OverviewView({ snapshot, workspace, appInfo, cleaning, actionsDisabled, cleanProgress, onCleanup, onOpenDetail }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<StorageKind>>(new Set())

  const allEntries = useMemo<StorageEntry[]>(() => snapshot.categories.flatMap((c) => c.entries), [snapshot])
  const selectedEntries = useMemo(() => allEntries.filter((e) => selected.has(e.id)), [allEntries, selected])
  const selectedBytes = selectedEntries.reduce((sum, e) => sum + e.reclaimableBytes, 0)

  /** Sections are content types; whether an item is worth cleaning shows up per row. */
  const sections = useMemo(() => StorageSectionOrder.map((section) => ({
    section,
    categories: snapshot.categories
      .filter((category) => !categoryIsEmpty(category) && categorySection(category) === section)
      .sort((a, b) => categoryReclaimable(b) - categoryReclaimable(a) || categoryBytes(b) - categoryBytes(a))
  })).filter((group) => group.categories.length > 0), [snapshot])

  useEffect(() => {
    setSelected(new Set(snapshot.categories
      .filter((category) => category.group === 'recommended')
      .flatMap((category) => category.entries)
      .filter((item) => isSelectable(item.risk))
      .map((item) => item.id)))
  }, [snapshot.scannedAt])

  const setMany = (entries: StorageEntry[], on: boolean): void => setSelected((previous) => {
    const next = new Set(previous)
    for (const item of entries) on ? next.add(item.id) : next.delete(item.id)
    return next
  })

  const toggleExpanded = (kind: StorageKind): void => setExpanded((previous) => {
    const next = new Set(previous)
    next.has(kind) ? next.delete(kind) : next.add(kind)
    return next
  })

  return (
    <>
      <section className="hero">
        <div className="hero-metrics">
          <div className="metric">
            <span className="metric-label">Codex 总占用</span>
            <span className="metric-value">{formatBytes(snapshot.totalCodexBytes)}</span>
          </div>
          <div className="metric">
            <span className="metric-label">已选择</span>
            <span className="metric-value accent">{formatBytes(selectedBytes)}</span>
            <small>{selectedEntries.length} 项</small>
          </div>
        </div>
        <button
          className="btn primary btn-large"
          disabled={!selectedEntries.length || cleaning || actionsDisabled}
          onClick={() => onCleanup({ kind: 'storage', ids: selectedEntries.map((entry) => entry.id) })}
        >
          {cleaning ? `清理中… ${cleanProgress?.completed ?? 0}/${cleanProgress?.total ?? selectedEntries.length}` : '立即清理'}
        </button>
      </section>

      {appInfo?.codexRunning && <p className="notice warning">{appInfo.runtimeSummary ?? 'Codex 正在运行'}，需要独占文件的项目会推迟到下次清理。</p>}
      {snapshot.notes.map((note) => <p className="notice" key={note}>{note}</p>)}

      <section className="shortcuts">
        <Shortcut title="会话记录" detail="查看、瘦身或删除会话" value={`${snapshot.sessions.length} 个 · ${formatBytes(snapshotSessionBytes(snapshot))}`}
          disabled={!snapshot.sessions.length} onClick={() => onOpenDetail('sessions')} />
        <Shortcut title="插件版本" detail="清理旧版本与卸载残留" value={`${snapshot.pluginVersions.length} 个版本`}
          onClick={() => onOpenDetail('plugins')} />
        <Shortcut title="工作产出" detail="Codex 会话的工作目录" value={workspace?.isScanned ? formatBytes(workspaceBytes(workspace)) : '尚未统计'}
          onClick={() => onOpenDetail('workspace')} />
      </section>

      {sections.map(({ section, categories }) => {
        const selectable = categories.flatMap((category) => category.entries).filter((item) => isSelectable(item.risk))
        const allSelected = selectable.length > 0 && selectable.every((item) => selected.has(item.id))
        const someSelected = selectable.some((item) => selected.has(item.id))
        return (
          <section key={section} className="section">
            <div className="section-head">
              {selectable.length > 0 && <input type="checkbox" aria-label={`选择全部${StorageSectionLabel[section]}`} checked={allSelected}
                ref={(input) => { if (input) input.indeterminate = someSelected && !allSelected }}
                onChange={(event) => setMany(selectable, event.target.checked)} />}
              <h2>{StorageSectionLabel[section]}</h2>
              <span className="section-total">共 {formatBytes(categories.reduce((sum, category) => sum + categoryBytes(category), 0))}</span>
            </div>
            <div className="card">
              {categories.map((category) => (
                <CategoryRow
                  key={category.kind}
                  category={category}
                  selected={selected}
                  expanded={expanded.has(category.kind)}
                  onExpand={() => toggleExpanded(category.kind)}
                  onSelectAll={(on) => setMany(category.entries.filter((entry) => isSelectable(entry.risk)), on)}
                  onToggleEntry={(entry) => setMany([entry], !selected.has(entry.id))}
                />
              ))}
            </div>
          </section>
        )
      })}

      {snapshot.categories.length === 0 && <p className="empty-panel">没有扫描到可清理的内容</p>}
    </>
  )
}

function CategoryRow({ category, selected, expanded, onExpand, onSelectAll, onToggleEntry }: {
  category: StorageCategory
  selected: Set<string>
  expanded: boolean
  onExpand: () => void
  onSelectAll: (on: boolean) => void
  onToggleEntry: (entry: StorageEntry) => void
}) {
  const selectableEntries = category.entries.filter((entry) => isSelectable(entry.risk))
  const allSelected = selectableEntries.length > 0 && selectableEntries.every((entry) => selected.has(entry.id))
  const someSelected = selectableEntries.some((entry) => selected.has(entry.id))
  const reclaimable = categoryReclaimable(category)
  return (
    <div className={`row-block${expanded ? ' expanded' : ''}`}>
      <div className="row">
        {selectableEntries.length > 0
          ? <input type="checkbox" aria-label={category.title} checked={allSelected}
              ref={(input) => { if (input) input.indeterminate = someSelected && !allSelected }}
              onChange={(event) => onSelectAll(event.target.checked)} />
          : <span className="checkbox-space" />}
        <button className="row-main" onClick={onExpand} aria-expanded={expanded}>
          <span className="row-text">
            <span className="row-title">{category.title}</span>
            <span className="row-detail">{category.detail}</span>
          </span>
          <span className="row-meta">
            <span className="row-bytes">{formatBytes(categoryBytes(category))}</span>
            <span className={`advice advice-${category.group}`}>{categoryAdvice(category)}</span>
          </span>
          <span className="chevron">{expanded ? '⌃' : '⌄'}</span>
        </button>
      </div>
      {expanded && <ul className="entries">
        {category.entries.map((entry) => (
          <li className="entry" key={entry.id}>
            {isSelectable(entry.risk)
              ? <label className="entry-label">
                  <input type="checkbox" checked={selected.has(entry.id)} onChange={() => onToggleEntry(entry)} />
                  <span className="entry-text"><span className="entry-title">{entry.title}</span><span className="entry-detail">{entry.detail}</span></span>
                </label>
              : <span className="entry-label">
                  <span className="checkbox-space" />
                  <span className="entry-text"><span className="entry-title">{entry.title}</span><span className="entry-detail">{entry.detail}</span></span>
                </span>}
            <span className="entry-bytes">{formatBytes(entry.reclaimableBytes)}</span>
            <button className="icon-button" title={entry.url} onClick={() => window.cleanmycodex.revealPath(entry.url)}>⌕</button>
          </li>
        ))}
        {reclaimable > 0 && reclaimable !== categoryBytes(category) && <li className="entry entry-summary"><span>实际可回收 {formatBytes(reclaimable)}</span></li>}
      </ul>}
    </div>
  )
}

function Shortcut({ title, detail, value, disabled = false, onClick }: {
  title: string; detail: string; value: string; disabled?: boolean; onClick: () => void
}) {
  return (
    <button className="shortcut" disabled={disabled} onClick={onClick}>
      <span className="shortcut-text"><span className="shortcut-title">{title}</span><span className="shortcut-detail">{detail}</span></span>
      <span className="shortcut-value">{value}</span>
      <span className="chevron">›</span>
    </button>
  )
}
