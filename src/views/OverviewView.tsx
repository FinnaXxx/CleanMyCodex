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
  const { t, language } = usePreferences()
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
      label: sectionLabel(section, language),
      bytes: categories.reduce((sum, category) => sum + categoryBytes(category), 0)
    })).filter((item) => item.bytes > 0).sort((a, b) => b.bytes - a.bytes)
    const classified = grouped.reduce((sum, item) => sum + item.bytes, 0)
    const remainder = Math.max(0, snapshot.totalCodexBytes - classified)
    if (remainder) grouped.push({ label: t('会话与其他', 'Sessions & Other'), bytes: remainder })
    const visible = grouped.slice(0, 3)
    const rest = grouped.slice(3).reduce((sum, item) => sum + item.bytes, 0)
    if (rest) visible.push({ label: t('其他', 'Other'), bytes: rest })
    return visible
  }, [language, sections, snapshot.totalCodexBytes, t])

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
            <div className="distribution-bar" aria-label={t('空间占用分布', 'Storage distribution')}>
              {distribution.map((item, index) => <span key={item.label} className={`distribution-tone-${index + 1}`}
                style={{ width: `${item.bytes / Math.max(snapshot.totalCodexBytes, 1) * 100}%` }} />)}
            </div>
          </div>
        </div>
      </section>

      {scanProgress && <div className="progress overview-progress"><progress value={scanProgress.fraction} max={1}/><span>{scanProgress.stage} · {scanProgress.currentPath}</span></div>}

      {appInfo?.codexRunning && <p className="notice warning">{language === 'zh-CN' ? (appInfo.runtimeSummary ?? 'Codex 正在运行') : 'Codex is running'}{t('，需要独占文件的项目本次会跳过；退出 Codex 后需重新清理。', '. Items requiring exclusive file access will be skipped; quit Codex and run cleanup again.')}</p>}
      {snapshot.notes.map((note) => <p className="notice" key={note}>{note}</p>)}

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
              {selectable.length > 0 && <input type="checkbox" aria-label={t(`选择全部${sectionLabel(section, language)}`, `Select all ${sectionLabel(section, language)}`)} checked={allSelected}
                ref={(input) => { if (input) input.indeterminate = someSelected && !allSelected }}
                onChange={(event) => setMany(selectable, event.target.checked)} />}
              <SectionIcon section={section} />
              <h2>{sectionLabel(section, language)}</h2>
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
  const { t, language } = usePreferences()
  const selectableEntries = category.entries.filter((entry) => isSelectable(entry.risk))
  const allSelected = selectableEntries.length > 0 && selectableEntries.every((entry) => selected.has(entry.id))
  const someSelected = selectableEntries.some((entry) => selected.has(entry.id))
  const reclaimable = categoryReclaimable(category)
  return (
    <div className={`row-block${expanded ? ' expanded' : ''}`}>
      <div className="row">
        {selectableEntries.length > 0
          ? <input type="checkbox" aria-label={categoryTitle(category, language)} checked={allSelected}
              ref={(input) => { if (input) input.indeterminate = someSelected && !allSelected }}
              onChange={(event) => onSelectAll(event.target.checked)} />
          : <span className="checkbox-space" />}
        <button className="row-main" onClick={onExpand} aria-expanded={expanded}>
          <span className="row-text">
            <span className="row-title">{categoryTitle(category, language)}</span>
            <span className="row-detail">{categoryDetail(category, language)}</span>
          </span>
          <span className="row-meta">
            <span className="row-bytes">{formatBytes(categoryBytes(category))}</span>
            <span className={`advice advice-${category.group}`}>{language === 'zh-CN'
              ? ({ recommended: '建议清理', review: '谨慎清理', protectedData: '受保护' } as const)[category.group]
              : ({ recommended: 'Recommended', review: 'Review', protectedData: 'Protected' } as const)[category.group]}</span>
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
  const { language } = usePreferences()
  return (
    <span className="entry-text">
      <span className="entry-title">
        {entry.title}
        {entry.tags.map((tag) => <span key={tag.label} className={`pill tone-${tag.tone}`}>{language === 'zh-CN' ? tag.label : knownText(tag.label)}</span>)}
      </span>
      {entry.detail && <span className="entry-detail">{language === 'zh-CN' ? entry.detail : knownText(entry.detail)}</span>}
    </span>
  )
}

const sectionNames: Record<StorageSection, [string, string]> = {
  caches: ['缓存与临时文件', 'Caches & Temporary Files'],
  logs: ['日志与数据库', 'Logs & Databases'],
  plugins: ['插件与组件', 'Plugins & Components'],
  assets: ['会话资产', 'Session Assets'],
  protectedData: ['受保护的数据', 'Protected Data']
}

const categoryNames: Record<StorageKind, [string, string, string, string]> = {
  logDatabase: ['日志数据库', 'Log Databases', '压缩数据库回收空闲空间，日志内容保留', 'Compact databases to reclaim free space while keeping log content'],
  sessionDatabase: ['会话投影数据库', 'Session Projection Database', 'Codex 加载会话使用的 SQLite 投影', 'SQLite projection used by Codex to load sessions'],
  temporary: ['过期临时目录', 'Stale Temporary Folders', '安装和更新过程留下的临时目录，Codex 退出后清理', 'Temporary folders left by installation and updates; cleaned after Codex quits'],
  marketplaceCache: ['插件市场缓存', 'Marketplace Cache', '可重新下载，离线时会影响插件安装', 'Can be downloaded again; removing may affect offline plugin installation'],
  pluginRemnants: ['老版本插件与卸载残留', 'Old Plugins & Leftovers', '旧版本与卸载残留', 'Old versions and uninstall leftovers'],
  pluginRuntime: ['当前插件与运行组件', 'Current Plugins & Runtime', '已统计但不会自动删除', 'Counted but never removed automatically'],
  browserCache: ['浏览器与渲染缓存', 'Browser & Rendering Cache', '桌面应用按需重建的浏览器缓存', 'Browser cache rebuilt by the desktop app as needed'],
  appCache: ['应用缓存', 'App Cache', '桌面应用的本地缓存目录', 'Local cache folders used by the desktop app'],
  appLogs: ['旧应用日志', 'Old App Logs', '保留最近 10 天，其余可以清理', 'Keeps the latest 10 days; older logs can be removed'],
  computerUse: ['Computer Use 资产', 'Computer Use Assets', 'Computer Use 会话留下的资产', 'Assets left by Computer Use sessions'],
  activeSessions: ['未归档会话', 'Active Sessions', '当前会话记录与内嵌资产', 'Current session records and embedded assets'],
  archivedSessions: ['已归档会话', 'Archived Sessions', '已归档的会话记录与内嵌资产', 'Archived session records and embedded assets'],
  protectedConfig: ['受保护的配置', 'Protected Configuration', '凭据、配置和状态数据库', 'Credentials, configuration, and state databases'],
  protectedUserData: ['受保护的用户数据', 'Protected User Data', '登录状态和浏览器用户数据', 'Sign-in state and browser user data']
}

function sectionLabel(section: StorageSection, language: 'zh-CN' | 'en'): string {
  return sectionNames[section][language === 'zh-CN' ? 0 : 1]
}

function categoryTitle(category: StorageCategory, language: 'zh-CN' | 'en'): string {
  return language === 'zh-CN' ? category.title : categoryNames[category.kind][1]
}

function categoryDetail(category: StorageCategory, language: 'zh-CN' | 'en'): string {
  return language === 'zh-CN' ? category.detail : categoryNames[category.kind][3]
}

function knownText(value: string): string {
  const texts: Record<string, string> = {
    '卸载残留': 'Uninstall leftover', '旧版本': 'Old version', '缓存目录，可重新生成': 'Cache folder; can be rebuilt',
    '插件市场的本地副本，可重新下载': 'Local marketplace copy; can be downloaded again',
    '安装或更新时留下的目录': 'Folder left by installation or update', '超过 3 天没有改动': 'Not modified for over 3 days',
    '早于 10 天的应用日志': 'App log older than 10 days', '配置、凭据或用户规则': 'Configuration, credentials, or user rules',
    'Codex 状态数据库': 'Codex state database', '浏览器配置与登录状态': 'Browser configuration and sign-in state'
  }
  if (texts[value]) return texts[value]
  return value.replace(/^已使用 /, 'Used ')
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
