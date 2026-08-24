import { useEffect, useMemo, useState } from 'react'
import {
  type ScanSnapshot,
  type AppInfo,
  type CleanupSelection,
  type CleanupProgress,
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
  listableSessions,
  sessionMatchesSuggestedArchivePreset,
  snapshotFoundNothing,
  snapshotGeneratedAssetBytes,
  snapshotWorktreeBytes,
  snapshotSessionBytes,
  workspaceBytes,
  formatBytes
} from '../../shared/types'
import { message } from '../../shared/messages'
import { FolderIcon, NavIcon, type NavGlyphName } from '../icons'
import { usePreferences } from '../preferences'
import { storageDistribution, type StorageDistributionKind } from '../storage-distribution'

interface Props {
  snapshot: ScanSnapshot
  appInfo: AppInfo | null
  cleaning: boolean
  actionsDisabled: boolean
  cleanProgress: CleanupProgress | null
  onCleanup: (selection: CleanupSelection) => void
  onOpenSessions: () => void
  onOpenSuggestedSessions: () => void
  onOpenGeneratedAssets: () => void
  onOpenWorkspace: () => void
  onOpenWorktrees: () => void
  onOpenPlugins: () => void
  onRescan: () => void
}

export default function OverviewView({ snapshot, appInfo, cleaning, actionsDisabled, cleanProgress, onCleanup, onOpenSessions, onOpenSuggestedSessions, onOpenGeneratedAssets, onOpenWorkspace, onOpenWorktrees, onOpenPlugins, onRescan }: Props) {
  const { t, m, locale } = usePreferences()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<StorageKind>>(new Set())

  const sessions = useMemo(() => listableSessions(snapshot), [snapshot])
  const sessionCount = sessions.length
  const suggestedSessionCount = useMemo(() => {
    const now = Date.now()
    return sessions.filter((session) => sessionMatchesSuggestedArchivePreset(session, now)).length
  }, [sessions])
  const allEntries = useMemo<StorageEntry[]>(() => snapshot.categories.flatMap((c) => c.entries), [snapshot])
  const selectedEntries = useMemo(() => allEntries.filter((e) => selected.has(e.id)), [allEntries, selected])
  const selectedBytes = selectedEntries.reduce((sum, e) => sum + e.reclaimableBytes, 0)
  const sessionBytes = snapshotSessionBytes(snapshot)
  const generatedAssetTotalBytes = snapshotGeneratedAssetBytes(snapshot)
  const generatedAssetCount = snapshot.generatedAssets.length
  const workspaceTotalBytes = workspaceBytes(snapshot.workspace)
  const worktreeCount = (snapshot.worktrees ?? []).length
  const worktreeTotalBytes = snapshotWorktreeBytes(snapshot)
  const manualSelectionTarget = sessionCount > 0 ? 'sessions' : workspaceTotalBytes > 0 ? 'workspace' : generatedAssetCount > 0 ? 'generatedAssets' : worktreeCount > 0 ? 'worktrees' : null

  /** Sections are content types; whether an item is worth cleaning shows up per row. */
  const sections = useMemo(() => StorageSectionOrder.map((section) => ({
    section,
    categories: snapshot.categories
      .filter((category) => !categoryIsEmpty(category) && categorySection(category) === section)
      .sort((a, b) => categoryReclaimable(b) - categoryReclaimable(a) || categoryBytes(b) - categoryBytes(a))
  })).filter((group) => group.categories.length > 0), [snapshot])

  const distribution = useMemo(() => {
    const result = storageDistribution(snapshot)
    const label = (kind: StorageDistributionKind): string => {
      if (kind === 'workspace') return t('工作产出', 'Workspace Output')
      if (kind === 'sessions') return t('会话记录', 'Sessions')
      if (kind === 'generatedAssets') return t('生成资产', 'Generated Assets')
      if (kind === 'worktrees') return t('Worktree', 'Worktrees')
      if (kind === 'other') return t('其他 Codex 数据', 'Other Codex Data')
      return m(message(`section.${kind}`))
    }
    return {
      total: result.total,
      items: result.items.map((item) => ({
        ...item,
        label: label(item.kind),
        fraction: item.bytes / Math.max(result.total, 1),
        details: item.kind === 'other'
          ? [t('未被扫描器归入缓存、日志、插件、会话、生成资产或工作产出的 Codex 文件', 'Codex files not classified as caches, logs, plugins, sessions, generated assets, or workspace output')]
          : undefined
      }))
    }
  }, [m, snapshot, t])

  const distributionPercent = useMemo(() => new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1
  }), [locale])

  useEffect(() => {
    setSelected(new Set(snapshot.categories
      // An orphan is confirmed uninstalled by Codex, so its package is safe to suggest
      // on the overview even though the detail page still labels the state explicitly.
      .filter((category) => category.group === 'recommended' || category.kind === 'pluginOrphans')
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

  const runPrimaryAction = (): void => {
    if (selectedEntries.length) {
      onCleanup({ kind: 'storage', ids: selectedEntries.map((entry) => entry.id) })
    } else if (manualSelectionTarget === 'sessions') {
      suggestedSessionCount > 0 ? onOpenSuggestedSessions() : onOpenSessions()
    } else if (manualSelectionTarget === 'generatedAssets') {
      onOpenGeneratedAssets()
    } else if (manualSelectionTarget === 'workspace') {
      onOpenWorkspace()
    } else if (manualSelectionTarget === 'worktrees') {
      onOpenWorktrees()
    }
  }

  if (snapshotFoundNothing(snapshot)) return <div className="detail-content">
    <NothingFound snapshot={snapshot} onRescan={onRescan} />
  </div>

  return (
    <div className="detail-content">
      <section className="summary">
        <div className="summary-main">
          <div className="summary-metrics">
            <div className="metric">
              <span className="metric-label">{t('当前占用', 'Current usage')}</span>
              <span className="metric-value">{formatBytes(distribution.total)}</span>
              <span className="metric-note">{t('上次扫描 ', 'Scanned ')}{new Date(snapshot.scannedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div className="metric metric-reclaimable">
              <span className="metric-label">{selectedEntries.length
                ? t('本次可释放', 'Reclaimable')
                : t('可释放空间', 'Space to reclaim')}</span>
              <span className="metric-value accent">{formatBytes(selectedBytes)}</span>
              <span className="metric-note">{selectedEntries.length
                ? t(`已选择 ${selectedEntries.length} 项`, `${selectedEntries.length} items selected`)
                : manualSelectionTarget === 'sessions'
                  ? suggestedSessionCount > 0
                    ? t(`找到 ${suggestedSessionCount} 个建议检查的旧归档会话`, `${suggestedSessionCount} old archived conversations suggested for review`)
                    : t(`${sessionCount} 个会话需要手动确认`, `${sessionCount} conversations require your review`)
                  : manualSelectionTarget === 'generatedAssets'
                    ? t('生成资产需要手动确认', 'Generated assets require your review')
                    : manualSelectionTarget === 'workspace'
                      ? t('工作产出需要手动确认', 'Workspace output requires your review')
                    : t('没有发现建议清理项', 'No recommended cleanup found')}</span>
            </div>
          </div>
          <button
            className="btn primary btn-large summary-clean"
            disabled={cleaning || actionsDisabled || (!selectedEntries.length && !manualSelectionTarget)}
            onClick={runPrimaryAction}
          >
            {cleaning
              ? t(`清理中… ${cleanProgress?.completed ?? 0}/${cleanProgress?.total ?? selectedEntries.length}`, `Cleaning… ${cleanProgress?.completed ?? 0}/${cleanProgress?.total ?? selectedEntries.length}`)
              : selectedEntries.length
                ? t('开始清理', 'Start Cleanup')
                : manualSelectionTarget === 'sessions'
                  ? suggestedSessionCount > 0
                    ? t('查看建议清理的会话', 'Review Suggested Conversations')
                    : t('选择要清理的会话', 'Choose Conversations')
                  : manualSelectionTarget === 'generatedAssets'
                    ? t('选择要清理的生成资产', 'Choose Generated Assets')
                    : manualSelectionTarget === 'workspace'
                      ? t('选择要清理的工作产出', 'Choose Workspace Output')
                    : t('暂无建议清理项', 'Nothing Recommended')}
          </button>
        </div>
        <div className="summary-chart">
          <div className="distribution-bar" role="list" aria-label={t('空间占用分布', 'Storage distribution')}>
            {distribution.items.map((item) => {
              const summary = `${formatBytes(item.bytes)} · ${distributionPercent.format(item.fraction)}`
              const description = [item.label, summary, ...(item.details ?? [])].join(t('；', '; '))
              return <span
                key={item.label}
                className={`distribution-segment distribution-tone-${item.kind}`}
                role="listitem"
                tabIndex={0}
                aria-label={description}
                style={{ flexGrow: item.bytes }}
              >
                <span className="distribution-tooltip" aria-hidden="true">
                  <strong>{item.label}</strong>
                  <span>{summary}</span>
                  {!!item.details?.length && <small>{item.details.join(' · ')}</small>}
                </span>
              </span>
            })}
          </div>
          <ul className="distribution-legend">
            {distribution.items.map((item) => <li key={item.label} title={item.details?.join(' · ')}>
              <span className={`legend-dot distribution-tone-${item.kind}`} aria-hidden="true" />
              <span className="legend-label">{item.label}</span>
              <b>{formatBytes(item.bytes)}</b>
              <span className="legend-percent">{distributionPercent.format(item.fraction)}</span>
            </li>)}
          </ul>
        </div>
      </section>

      {appInfo?.codexRunning && <p className="notice warning">{appInfo.blockers.map(m).join(t('；', '; '))}{t('，需要独占文件的项目本次会跳过；退出 Codex 后需重新清理。', '. Items requiring exclusive file access will be skipped; quit Codex and run cleanup again.')}</p>}
      {snapshot.notes.map((note) => <p className="notice" key={note.key}>{m(note)}</p>)}

      <PageSection
        glyph="sessions"
        title={t('会话记录', 'Sessions')}
        bytes={sessionBytes}
        rowDetail={sessionCount
          ? t(`${sessionCount} 个会话，在会话记录页删除`, `${sessionCount} conversations, picked on the Sessions page`)
          : t('没有扫描到本地会话', 'No local conversations found')}
        value={sessionCount ? formatBytes(sessionBytes) : '—'}
        onOpen={onOpenSessions}
      />

      <PageSection
        glyph="workspace"
        title={t('工作产出', 'Workspace Output')}
        bytes={workspaceTotalBytes}
        rowDetail={snapshot.workspace.isScanned
          ? t('Codex 生成的文件和仓库，在工作产出页删除', 'Files and repositories Codex produced, confirmed on the Workspace page')
          : t('尚未完成统计，重新扫描后可查看', 'Not measured yet; scan again to see it')}
        value={snapshot.workspace.isScanned ? formatBytes(workspaceTotalBytes) : '—'}
        onOpen={onOpenWorkspace}
      />

      <PageSection
        glyph="worktrees"
        title={t('Worktree', 'Worktrees')}
        bytes={worktreeTotalBytes}
        rowDetail={worktreeCount
          ? t(`${worktreeCount} 个 worktree，在 Worktree 页删除`, `${worktreeCount} worktrees, picked on the Worktrees page`)
          : t('没有扫描到 Codex worktree', 'No Codex worktrees found')}
        value={worktreeCount ? formatBytes(worktreeTotalBytes) : '—'}
        onOpen={onOpenWorktrees}
      />

      <PageSection
        glyph="generatedAssets"
        title={t('生成资产', 'Generated Assets')}
        bytes={generatedAssetTotalBytes}
        rowDetail={generatedAssetCount
          ? t(`${generatedAssetCount} 项 ImageGen 与 Visualization 资产，在生成资产页管理`, `${generatedAssetCount} ImageGen and Visualization assets, managed on the Generated Assets page`)
          : t('没有扫描到本地生成资产', 'No local generated assets found')}
        value={generatedAssetCount ? formatBytes(generatedAssetTotalBytes) : '—'}
        onOpen={onOpenGeneratedAssets}
      />

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
                  onNavigate={category.kind === 'pluginRuntime' ? onOpenPlugins : undefined}
                />
              ))}
            </div>
          </section>
        )
      })}

      {snapshot.categories.length === 0 && <p className="empty-panel">{t('没有扫描到可清理的内容', 'No cleanable content found')}</p>}
    </div>
  )
}

const SectionGlyph: Record<StorageSection, string> = {
  caches: 'M3 5.5c0-1.4 2.7-2.5 6-2.5s6 1.1 6 2.5S12.3 8 9 8 3 6.9 3 5.5Zm0 3.1C4.3 9.5 6.5 10 9 10s4.7-.5 6-1.4v3.9c0 1.4-2.7 2.5-6 2.5s-6-1.1-6-2.5V8.6Z',
  logs: 'M4.5 2.5h6.2L14 5.8v9.7H4.5V2.5Zm5.8 1.3v2.4h2.4M6.6 8.8h5M6.6 11.4h5',
  plugins: 'M7.4 2.6h3.2v1.9a1.6 1.6 0 1 0 3.2 0v1.9h1.7v3.2h-1.9a1.6 1.6 0 1 0 0 3.2h1.9v2.6H7.4v-1.9a1.6 1.6 0 1 0-3.2 0v-3.9h1.9a1.6 1.6 0 1 0 0-3.2H4.2V6.4h3.2V2.6Z',
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

/**
 * Nothing to show and nothing to clean: Codex has never run here, or it keeps its home
 * somewhere this scan does not look. Say which, and name the path that was searched —
 * an empty overview full of zeroes reads like a broken scan.
 */
function NothingFound({ snapshot, onRescan }: { snapshot: ScanSnapshot; onRescan: () => void }) {
  const { t } = usePreferences()
  return (
    <section className="nothing-found">
      <span className="nothing-found-glyph" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </span>
      <h2>{snapshot.codexHomeExists
        ? t('这里还没有 Codex 数据', 'No Codex data here yet')
        : t('没有找到 Codex', 'Codex was not found')}</h2>
      <p>{snapshot.codexHomeExists
        ? t('Codex 目录存在，但里面还没有缓存、会话或插件。用过 Codex 之后再回来扫描。', 'The Codex directory exists but holds no caches, sessions, or plugins yet. Come back and scan after using Codex.')
        : t('这台电脑上没有 Codex 的数据目录，所以没有可以统计或清理的内容。', 'This computer has no Codex data directory, so there is nothing to measure or clean.')}</p>
      <p className="nothing-found-path"><code>{snapshot.codexHome}</code></p>
      <p className="nothing-found-hint">{t('如果 Codex 的数据放在别处，设置环境变量 CODEX_HOME 指向它，然后重新扫描。', 'If Codex keeps its data elsewhere, point the CODEX_HOME environment variable at it and scan again.')}</p>
      <button className="btn primary btn-large" onClick={onRescan}>{t('重新扫描', 'Scan Again')}</button>
    </section>
  )
}

/**
 * Sessions and workspace output stand beside the storage sections rather than inside
 * them: they are cleaned per item on their own page, so the row here only leads there.
 */
function PageSection({ glyph, title, bytes, rowDetail, value, onOpen }: {
  glyph: NavGlyphName
  title: string
  bytes: number
  rowDetail: string
  value: string
  onOpen: () => void
}) {
  const { t } = usePreferences()
  return (
    <section className={`section section-${glyph}`}>
      <div className="section-head">
        <span className="section-icon" aria-hidden="true"><NavIcon name={glyph} /></span>
        <h2>{title}</h2>
        <span className="section-total">{t('共', 'Total')} {formatBytes(bytes)}</span>
      </div>
      <div className="card">
        <div className="row-block row-navigation">
          <div className="row">
            <span className="checkbox-space" />
            <button className="row-main" onClick={onOpen}>
              <span className="row-text">
                <span className="row-title">{title}</span>
                <span className="row-detail">{rowDetail}</span>
              </span>
              <span className="row-meta"><span className="row-bytes">{value}</span></span>
              <span className="chevron">›</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

function CategoryRow({ category, selected, expanded, onExpand, onSelectAll, onToggleEntry, onNavigate }: {
  category: StorageCategory
  selected: Set<string>
  expanded: boolean
  onExpand: () => void
  onSelectAll: (on: boolean) => void
  onToggleEntry: (entry: StorageEntry) => void
  onNavigate?: () => void
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
        <button className="row-main" onClick={onNavigate ?? onExpand} aria-expanded={onNavigate ? undefined : expanded}>
          <span className="row-text">
            <span className="row-title">{m(message(`category.${category.kind}.title`))}</span>
            <span className="row-detail">{m(message(`category.${category.kind}.detail`))}</span>
          </span>
          <span className="row-meta">
            <span className="row-bytes">{formatBytes(categoryBytes(category))}</span>
            <span className={`advice advice-${category.group}`}>{m(message(`group.${category.group}`))}</span>
          </span>
          <span className="chevron">{onNavigate ? '›' : expanded ? '⌃' : '⌄'}</span>
        </button>
      </div>
      {expanded && !onNavigate && <ul className="entries">
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
