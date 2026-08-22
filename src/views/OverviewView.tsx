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
  type StorageSection,
  StorageSectionLabel,
  StorageSectionOrder,
  categoryAdvice,
  categoryBytes,
  categoryReclaimable,
  categoryIsEmpty,
  categorySection,
  isSelectable,
  snapshotSessionBytes,
  listableSessions,
  workspaceBytes,
  formatBytes
} from '../../shared/types'
import { FolderIcon } from '../icons'

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
  const sessionCount = listableSessions(snapshot).length

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
            <span className="metric-label">总占用</span>
            <span className="metric-value">{formatBytes(snapshot.totalCodexBytes)}</span>
          </div>
          <div className="metric">
            <span className="metric-label">已选择</span>
            <span className="metric-value accent">
              {formatBytes(selectedBytes)}<small>{selectedEntries.length} 项</small>
            </span>
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
        <Shortcut kind="sessions" title="会话记录" detail="查看、清理图片或删除会话" value={`${sessionCount} 个 · ${formatBytes(snapshotSessionBytes(snapshot))}`}
          disabled={!sessionCount} onClick={() => onOpenDetail('sessions')} />
        <Shortcut kind="workspace" title="工作产出" detail="Codex 会话的工作目录" value={workspace?.isScanned ? formatBytes(workspaceBytes(workspace)) : '尚未统计'}
          onClick={() => onOpenDetail('workspace')} />
        <Shortcut kind="plugins" title="插件版本" detail="清理旧版本与卸载残留" value={`${snapshot.pluginVersions.length} 个版本`}
          onClick={() => onOpenDetail('plugins')} />
      </section>

      {sections.map(({ section, categories }) => {
        const selectable = categories.flatMap((category) => category.entries).filter((item) => isSelectable(item.risk))
        const allSelected = selectable.length > 0 && selectable.every((item) => selected.has(item.id))
        const someSelected = selectable.some((item) => selected.has(item.id))
        const sectionSelectedBytes = selectable
          .filter((item) => selected.has(item.id))
          .reduce((sum, item) => sum + item.reclaimableBytes, 0)
        return (
          <section key={section} className={`section section-${section}`}>
            <div className="section-head">
              {selectable.length > 0 && <input type="checkbox" aria-label={`选择全部${StorageSectionLabel[section]}`} checked={allSelected}
                ref={(input) => { if (input) input.indeterminate = someSelected && !allSelected }}
                onChange={(event) => setMany(selectable, event.target.checked)} />}
              <SectionIcon section={section} />
              <h2>{StorageSectionLabel[section]}</h2>
              <span className="section-total">
                共 {formatBytes(categories.reduce((sum, category) => sum + categoryBytes(category), 0))}
                {sectionSelectedBytes > 0 && <>，已选 <b>{formatBytes(sectionSelectedBytes)}</b></>}
              </span>
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

const SectionGlyph: Record<StorageSection, string> = {
  caches: 'M3 5.5c0-1.4 2.7-2.5 6-2.5s6 1.1 6 2.5S12.3 8 9 8 3 6.9 3 5.5Zm0 3.1C4.3 9.5 6.5 10 9 10s4.7-.5 6-1.4v3.9c0 1.4-2.7 2.5-6 2.5s-6-1.1-6-2.5V8.6Z',
  logs: 'M4.5 2.5h6.2L14 5.8v9.7H4.5V2.5Zm5.8 1.3v2.4h2.4M6.6 8.8h5M6.6 11.4h5',
  plugins: 'M7.4 2.6h3.2v1.9a1.6 1.6 0 1 0 3.2 0v1.9h1.7v3.2h-1.9a1.6 1.6 0 1 0 0 3.2h1.9v2.6H7.4v-1.9a1.6 1.6 0 1 0-3.2 0v-3.9h1.9a1.6 1.6 0 1 0 0-3.2H4.2V6.4h3.2V2.6Z',
  assets: 'M2.8 4.2h12.4v9.6H2.8V4.2Zm1.6 7.4 2.9-3.2 2.1 2.3 2-2.2 2.2 3.1H4.4Zm7.5-4.6a.9.9 0 1 1-1.8 0 .9.9 0 0 1 1.8 0Z',
  protectedData: 'M9 2.4 14.6 4v4.6c0 3.2-2.3 5.7-5.6 7-3.3-1.3-5.6-3.8-5.6-7V4L9 2.4Z'
}

function SectionIcon({ section }: { section: StorageSection }) {
  return (
    <span className="section-icon" aria-hidden="true">
      <svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">
        <path d={SectionGlyph[section]} />
      </svg>
    </span>
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
                  <EntryText entry={entry} />
                </label>
              : <span className="entry-label">
                  <span className="checkbox-space" />
                  <EntryText entry={entry} />
                </span>}
            <span className="entry-bytes">{formatBytes(entry.reclaimableBytes)}</span>
            <button className="icon-button" title={entry.url} aria-label="在文件管理器中显示" onClick={() => window.cleanmycodex.revealPath(entry.url)}><FolderIcon /></button>
          </li>
        ))}
        {reclaimable > 0 && reclaimable !== categoryBytes(category) && <li className="entry entry-summary"><span>实际可回收 {formatBytes(reclaimable)}</span></li>}
      </ul>}
    </div>
  )
}

const ShortcutGlyph: Record<'sessions' | 'plugins' | 'workspace', string> = {
  sessions: 'M3 4.6h12v7.2h-6l-3.4 2.7v-2.7H3V4.6Z',
  plugins: 'M7.4 2.6h3.2v1.9a1.6 1.6 0 1 0 3.2 0v1.9h1.7v3.2h-1.9a1.6 1.6 0 1 0 0 3.2h1.9v2.6H7.4v-1.9a1.6 1.6 0 1 0-3.2 0v-3.9h1.9a1.6 1.6 0 1 0 0-3.2H4.2V6.4h3.2V2.6Z',
  workspace: 'M2.8 4.4h4.4l1.4 1.8h6.6v7.4H2.8V4.4Z'
}

function EntryText({ entry }: { entry: StorageEntry }) {
  return (
    <span className="entry-text">
      <span className="entry-title">
        {entry.title}
        {entry.tags.map((tag) => <span key={tag.label} className={`pill tone-${tag.tone}`}>{tag.label}</span>)}
      </span>
      {entry.detail && <span className="entry-detail">{entry.detail}</span>}
    </span>
  )
}

function Shortcut({ kind, title, detail, value, disabled = false, onClick }: {
  kind: 'sessions' | 'plugins' | 'workspace'
  title: string; detail: string; value: string; disabled?: boolean; onClick: () => void
}) {
  return (
    <button className={`shortcut shortcut-${kind}`} disabled={disabled} onClick={onClick}>
      <span className="shortcut-icon" aria-hidden="true">
        <svg viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">
          <path d={ShortcutGlyph[kind]} />
        </svg>
      </span>
      <span className="shortcut-text"><span className="shortcut-title">{title}</span><span className="shortcut-detail">{detail}</span></span>
      <span className="shortcut-value">{value}</span>
      <span className="chevron">›</span>
    </button>
  )
}
