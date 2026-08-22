import { useEffect, useMemo, useState } from 'react'
import {
  type ScanSnapshot,
  type WorkspaceSnapshot,
  type AppInfo,
  type CleanupSelection,
  type CleanupProgress,
  type ScanProgress,
  type StorageCategory,
  type StorageEntry,
  type StorageKind,
  type StorageSection,
  StorageSectionOrder,
  categoryBytes,
  categoryReclaimable,
  categoryIsEmpty,
  categorySection,
  isSelectable,
  snapshotSessionBytes,
  snapshotPluginBytes,
  listableSessions,
  workspaceBytes,
  formatBytes
} from '../../shared/types'
import { message } from '../../shared/messages'
import { FolderIcon } from '../icons'
import { usePreferences } from '../preferences'

type Detail = 'sessions' | 'plugins' | 'workspace' | 'settings'

interface Props {
  snapshot: ScanSnapshot
  workspace: WorkspaceSnapshot | null
  appInfo: AppInfo | null
  cleaning: boolean
  scanning: boolean
  scanProgress: ScanProgress | null
  actionsDisabled: boolean
  cleanProgress: CleanupProgress | null
  onCleanup: (selection: CleanupSelection) => void
  onScan: () => void
  onOpenDetail: (detail: Detail) => void
}

export default function OverviewView({ snapshot, workspace, appInfo, cleaning, scanning, scanProgress, actionsDisabled, cleanProgress, onCleanup, onScan, onOpenDetail }: Props) {
  const { t, m, locale } = usePreferences()
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

  const distribution = useMemo(() => {
    const grouped = sections.map(({ section, categories }) => ({
      label: m(message(`section.${section}`)),
      bytes: categories.reduce((sum, category) => sum + categoryBytes(category), 0)
    })).filter((item) => item.bytes > 0).sort((a, b) => b.bytes - a.bytes)
    const classified = grouped.reduce((sum, item) => sum + item.bytes, 0)
    const remainder = Math.max(0, snapshot.totalCodexBytes - classified)
    if (remainder) grouped.push({ label: t('会话与其他', 'Sessions & Other'), bytes: remainder })
    const visible: Array<{ label: string; bytes: number; details?: string[] }> = grouped.slice(0, 3)
    const remaining = grouped.slice(3)
    const rest = remaining.reduce((sum, item) => sum + item.bytes, 0)
    if (rest) visible.push({
      label: t('其他', 'Other'),
      bytes: rest,
      details: remaining.map((item) => `${item.label} ${formatBytes(item.bytes)}`)
    })
    // Protected marketplace sources can live outside the Codex home, so the classified
    // total can exceed it; scale to whichever is larger to keep the bar inside its track
    // and the percentages consistent with the widths they label.
    const total = Math.max(snapshot.totalCodexBytes, classified + rest, 1)
    return visible.map((item) => ({ ...item, fraction: item.bytes / total }))
  }, [m, sections, snapshot.totalCodexBytes, t])

  const distributionPercent = useMemo(() => new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1
  }), [locale])

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
        <div className="hero-heading">
          <h1>Clean My Codex</h1>
          <button className="icon-button settings-button" title={t('设置', 'Settings')} aria-label={t('设置', 'Settings')} onClick={() => onOpenDetail('settings')}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M9.7 3.4h4.6l.6 2.2c.5.2.9.4 1.3.7l2.2-.7 2.3 4-1.7 1.5a7 7 0 0 1 0 1.8l1.7 1.5-2.3 4-2.2-.7c-.4.3-.8.5-1.3.7l-.6 2.2H9.7l-.6-2.2c-.5-.2-.9-.4-1.3-.7l-2.2.7-2.3-4L5 12.9a7 7 0 0 1 0-1.8L3.3 9.6l2.3-4 2.2.7c.4-.3.8-.5 1.3-.7l.6-2.2Z"/>
              <circle cx="12" cy="12" r="2.6"/>
            </svg>
          </button>
        </div>
        <div className="hero-body">
          <div className="hero-summary">
          <div className="hero-metrics">
            <div className="metric">
              <span className="metric-label">{t('当前占用', 'Current usage')}</span>
              <span className="metric-value">{formatBytes(snapshot.totalCodexBytes)}</span>
            </div>
            <div className="metric metric-reclaimable">
              <span className="metric-label">{t('本次可释放', 'Reclaimable')}</span>
              <span className="metric-value accent">
                {formatBytes(selectedBytes)}<small>{t(`${selectedEntries.length} 项`, `${selectedEntries.length} items`)}</small>
              </span>
            </div>
          </div>
            <div className="hero-action">
              <button
                className="btn primary hero-clean-button"
                disabled={!selectedEntries.length || cleaning || actionsDisabled}
                onClick={() => onCleanup({ kind: 'storage', ids: selectedEntries.map((entry) => entry.id) })}
              >
                {cleaning ? t(`清理中… ${cleanProgress?.completed ?? 0}/${cleanProgress?.total ?? selectedEntries.length}`, `Cleaning… ${cleanProgress?.completed ?? 0}/${cleanProgress?.total ?? selectedEntries.length}`) : t('开始清理', 'Start Cleanup')}
              </button>
              <button className="scan-link" disabled={cleaning} onClick={onScan}>{scanning ? t('停止扫描', 'Stop Scan') : t('重新扫描', 'Scan Again')}</button>
            </div>
          </div>
          <div className="usage-distribution">
            <div className="distribution-bar" role="list" aria-label={t('空间占用分布', 'Storage distribution')}>
              {distribution.map((item, index) => {
                const summary = `${formatBytes(item.bytes)} · ${distributionPercent.format(item.fraction)}`
                const description = [item.label, summary, ...(item.details ?? [])].join(t('；', '; '))
                return <span
                  key={item.label}
                  className={`distribution-segment distribution-tone-${index + 1}`}
                  role="listitem"
                  tabIndex={0}
                  aria-label={description}
                  style={{ width: `${item.fraction * 100}%` }}
                >
                  <span className="distribution-tooltip" aria-hidden="true">
                    <strong>{item.label}</strong>
                    <span>{summary}</span>
                    {!!item.details?.length && <small>{item.details.join(' · ')}</small>}
                  </span>
                </span>
              })}
            </div>
          </div>
        </div>
      </section>

      {scanProgress && <div className="progress overview-progress"><progress value={scanProgress.fraction} max={1}/><span>{scanProgress.stage && `${m(scanProgress.stage)} · `}{scanProgress.currentPath}</span></div>}

      {appInfo?.codexRunning && <p className="notice warning">{appInfo.blockers.map(m).join(t('；', '; '))}{t('，需要独占文件的项目本次会跳过；退出 Codex 后需重新清理。', '. Items requiring exclusive file access will be skipped; quit Codex and run cleanup again.')}</p>}
      {snapshot.notes.map((note) => <p className="notice" key={note.key}>{m(note)}</p>)}

      <section className="shortcuts">
        <Shortcut kind="sessions" title={t('会话记录', 'Sessions')} detail={t('查看占用并完整删除会话', 'Review usage and delete complete sessions')} value={t(`${sessionCount} 个 · ${formatBytes(snapshotSessionBytes(snapshot))}`, `${sessionCount} · ${formatBytes(snapshotSessionBytes(snapshot))}`)}
          disabled={!sessionCount} onClick={() => onOpenDetail('sessions')} />
        <Shortcut kind="workspace" title={t('工作产出', 'Workspace Output')} detail={t('Codex 会话的工作目录', 'Working directories created by Codex')} value={workspace?.isScanned ? formatBytes(workspaceBytes(workspace)) : t('尚未统计', 'Not scanned')}
          onClick={() => onOpenDetail('workspace')} />
        <Shortcut kind="plugins" title={t('插件版本', 'Plugin Versions')} detail={t('清理旧版本与卸载残留', 'Remove old versions and leftovers')} value={t(`${snapshot.pluginVersions.length} 个版本 · ${formatBytes(snapshotPluginBytes(snapshot))}`, `${snapshot.pluginVersions.length} versions · ${formatBytes(snapshotPluginBytes(snapshot))}`)}
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
              {selectable.length > 0 && <input type="checkbox" aria-label={t(`选择全部${m(message(`section.${section}`))}`, `Select all ${m(message(`section.${section}`))}`)} checked={allSelected}
                ref={(input) => { if (input) input.indeterminate = someSelected && !allSelected }}
                onChange={(event) => setMany(selectable, event.target.checked)} />}
              <SectionIcon section={section} />
              <h2>{m(message(`section.${section}`))}</h2>
              <span className="section-total">
                {t('共', 'Total')} {formatBytes(categories.reduce((sum, category) => sum + categoryBytes(category), 0))}
                {sectionSelectedBytes > 0 && <>{t('，已选 ', ', selected ')}<b>{formatBytes(sectionSelectedBytes)}</b></>}
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

      {snapshot.categories.length === 0 && <p className="empty-panel">{t('没有扫描到可清理的内容', 'No cleanable content found')}</p>}
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
  const { t, m } = usePreferences()
  const selectableEntries = category.entries.filter((entry) => isSelectable(entry.risk))
  const allSelected = selectableEntries.length > 0 && selectableEntries.every((entry) => selected.has(entry.id))
  const someSelected = selectableEntries.some((entry) => selected.has(entry.id))
  const reclaimable = categoryReclaimable(category)
  return (
    <div className={`row-block${expanded ? ' expanded' : ''}`}>
      <div className="row">
        {selectableEntries.length > 0
          ? <input type="checkbox" aria-label={m(message(`category.${category.kind}.title`))} checked={allSelected}
              ref={(input) => { if (input) input.indeterminate = someSelected && !allSelected }}
              onChange={(event) => onSelectAll(event.target.checked)} />
          : <span className="checkbox-space" />}
        <button className="row-main" onClick={onExpand} aria-expanded={expanded}>
          <span className="row-text">
            <span className="row-title">{m(message(`category.${category.kind}.title`))}</span>
            <span className="row-detail">{m(message(`category.${category.kind}.detail`))}</span>
          </span>
          <span className="row-meta">
            <span className="row-bytes">{formatBytes(categoryBytes(category))}</span>
            <span className={`advice advice-${category.group}`}>{m(message(`group.${category.group}`))}</span>
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
            <button className="icon-button" title={entry.url} aria-label={t('在文件管理器中显示', 'Show in file manager')} onClick={() => window.cleanmycodex.revealPath(entry.url)}><FolderIcon /></button>
          </li>
        ))}
        {reclaimable > 0 && reclaimable !== categoryBytes(category) && <li className="entry entry-summary"><span>{t('实际可回收', 'Actually reclaimable')} {formatBytes(reclaimable)}</span></li>}
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
  const { m } = usePreferences()
  return (
    <span className="entry-text">
      <span className="entry-title">
        {entry.title}
        {entry.tags.map((tag) => <span key={tag.label.key} className={`pill tone-${tag.tone}`}>{m(tag.label)}</span>)}
      </span>
      {entry.note && <span className="entry-detail">{m(entry.note)}</span>}
    </span>
  )
}

function Shortcut({ kind, title, detail, value, disabled = false, onClick }: {
  kind: 'sessions' | 'plugins' | 'workspace'
  title: string; detail: string; value: string; disabled?: boolean; onClick: () => void
}) {
  return (
    <button className={`shortcut shortcut-${kind}`} disabled={disabled} onClick={onClick}>
      <span className="shortcut-top">
        <span className="shortcut-icon" aria-hidden="true">
          <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">
            <path d={ShortcutGlyph[kind]} />
          </svg>
        </span>
        <span className="shortcut-arrow" aria-hidden="true">↗</span>
      </span>
      <span className="shortcut-text"><span className="shortcut-title">{title}</span><span className="shortcut-detail">{detail}</span></span>
      <span className="shortcut-value">{value}</span>
    </button>
  )
}
