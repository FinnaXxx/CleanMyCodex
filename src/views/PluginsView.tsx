import { useEffect, useMemo, useState } from 'react'
import type { CleanupProgress, CleanupSelection, PluginStatus, PluginVersionItem, ScanSnapshot } from '../../shared/types'
import { formatBytes, pluginStatusIsRemovable, pluginVersionCanUninstall } from '../../shared/types'
import { message } from '../../shared/messages'
import { FolderIcon } from '../icons'
import { formatShortDate } from '../format'
import { usePreferences } from '../preferences'
import { CleanupSelectionBar, DetailSummary, FunnelFilter, SelectAllCheckbox, SortHeader, useSortState, type SortDir } from '../components/list-controls'

interface Props {
  snapshot: ScanSnapshot
  cleaning: boolean
  actionsDisabled: boolean
  canUninstall: boolean
  cleanProgress: CleanupProgress | null
  onCleanup: (selection: CleanupSelection) => void
}

type OriginScope = 'all' | 'official' | 'personal'
type VersionScope = 'all' | Exclude<PluginStatus, 'builtin'>
type SortKey = 'name' | 'date' | 'size'

const VERSION_STATUSES: Array<Exclude<PluginStatus, 'builtin'>> = ['current', 'outdated', 'orphaned', 'unconfirmed']
const defaultSortDir = (key: SortKey): SortDir => (key === 'name' ? 'asc' : 'desc')

const selectable = (plugin: PluginVersionItem, canUninstall: boolean): boolean =>
  pluginStatusIsRemovable(plugin.status) || (canUninstall && pluginVersionCanUninstall(plugin))

const pluginName = (item: PluginVersionItem): string =>
  item.marketplace ? `${item.marketplace} / ${item.plugin}` : item.plugin

/** The scanner's `builtin` status is the authoritative official-marketplace signal. */
const pluginIsOfficial = (item: PluginVersionItem): boolean => item.status === 'builtin'

const pluginMatchesVersionScope = (item: PluginVersionItem, scope: VersionScope): boolean => {
  if (scope === 'all') return true
  if (scope === 'current') return item.status === 'current' || pluginIsOfficial(item)
  return item.status === scope
}

export default function PluginsView({ snapshot, cleaning, actionsDisabled, canUninstall, cleanProgress, onCleanup }: Props) {
  const { t, m, locale } = usePreferences()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [originScope, setOriginScope] = useState<OriginScope>('all')
  const [versionScope, setVersionScope] = useState<VersionScope>('all')
  const { sortKey, sortDir, cycleSort } = useSortState<SortKey>('size', defaultSortDir)
  const [query, setQuery] = useState('')

  useEffect(() => {
    const current = new Set(snapshot.pluginVersions.filter((item) => selectable(item, canUninstall)).map((item) => item.directoryURL))
    setSelected((previous) => new Set([...previous].filter((id) => current.has(id))))
  }, [canUninstall, snapshot.pluginVersions, snapshot.scannedAt])

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const filtered = snapshot.pluginVersions.filter((plugin) => {
      if (originScope === 'official' && !pluginIsOfficial(plugin)) return false
      if (originScope === 'personal' && pluginIsOfficial(plugin)) return false
      if (!pluginMatchesVersionScope(plugin, versionScope)) return false
      if (needle && ![plugin.plugin, plugin.marketplace, plugin.version, plugin.directoryURL]
        .filter(Boolean).join(' ').toLocaleLowerCase().includes(needle)) return false
      return true
    })
    return [...filtered].sort((a, b) => {
      let cmp: number
      if (sortKey === 'date') cmp = a.modifiedAt - b.modifiedAt
      else if (sortKey === 'name') cmp = pluginName(a).localeCompare(pluginName(b))
      else cmp = a.bytes - b.bytes
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [originScope, query, snapshot.pluginVersions, sortKey, sortDir, versionScope])

  const selectedUninstalls = useMemo(() => {
    const map = new Map<string, PluginVersionItem>()
    for (const item of snapshot.pluginVersions) {
      if (selected.has(item.directoryURL) && canUninstall && pluginVersionCanUninstall(item)) map.set(pluginIdentity(item), item)
    }
    return map
  }, [canUninstall, selected, snapshot.pluginVersions])
  const selectedVersions = snapshot.pluginVersions.filter((item) =>
    selected.has(item.directoryURL) && pluginStatusIsRemovable(item.status) && !selectedUninstalls.has(pluginIdentity(item)))
  const chosen = [...selectedVersions, ...selectedUninstalls.values()]
  const selectedBytes = total(selectedVersions) + snapshot.pluginVersions
    .filter((item) => selectedUninstalls.has(pluginIdentity(item)))
    .reduce((sum, item) => sum + item.bytes, 0)
  const uninstallCount = selectedUninstalls.size

  const isItemSelected = (item: PluginVersionItem): boolean =>
    pluginStatusIsRemovable(item.status) ? selected.has(item.directoryURL) : selectedUninstalls.has(pluginIdentity(item))
  const selectableVisible = visible.filter((item) => selectable(item, canUninstall))
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every(isItemSelected)

  const toggle = (id: string): void => setSelected((previous) => {
    const next = new Set(previous)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const toggleUninstall = (plugin: PluginVersionItem): void => setSelected((previous) => {
    const next = new Set(previous)
    const key = pluginIdentity(plugin)
    const currentIDs = snapshot.pluginVersions
      .filter((item) => pluginIdentity(item) === key && pluginVersionCanUninstall(item))
      .map((item) => item.directoryURL)
    if (currentIDs.some((id) => previous.has(id))) currentIDs.forEach((id) => next.delete(id))
    else next.add(plugin.directoryURL)
    return next
  })

  const toggleAll = (): void => setSelected((previous) => {
    const next = new Set(previous)
    for (const item of selectableVisible) {
      if (allVisibleSelected) {
        if (pluginStatusIsRemovable(item.status)) next.delete(item.directoryURL)
        else snapshot.pluginVersions
          .filter((v) => pluginIdentity(v) === pluginIdentity(item) && pluginVersionCanUninstall(v))
          .forEach((v) => next.delete(v.directoryURL))
      } else {
        next.add(item.directoryURL)
      }
    }
    return next
  })

  const officialPlugins = snapshot.pluginVersions.filter(pluginIsOfficial)
  const personalPlugins = snapshot.pluginVersions.filter((item) => !pluginIsOfficial(item))
  const originOptions: { value: OriginScope; label: string; count: number }[] = [
    { value: 'all', label: t('全部来源', 'All sources'), count: snapshot.pluginVersions.length },
    { value: 'official', label: t('官方', 'Official'), count: officialPlugins.length },
    { value: 'personal', label: t('个人', 'Personal'), count: personalPlugins.length },
  ]
  const versionOptions: { value: VersionScope; label: string; count: number }[] = [
    { value: 'all', label: t('全部状态', 'All statuses'), count: snapshot.pluginVersions.length },
    ...VERSION_STATUSES.map((status) => ({
      value: status,
      label: m(message(`pluginStatus.${status}`)),
      count: snapshot.pluginVersions.filter((item) => pluginMatchesVersionScope(item, status)).length
    })),
  ]

  return <>
    <div className="detail-content">
      <DetailSummary items={[
        { label: t('总占用', 'Total'), value: formatBytes(total(snapshot.pluginVersions)) },
        { label: t('官方', 'Official'), value: formatBytes(total(officialPlugins)) },
        { label: t('个人', 'Personal'), value: formatBytes(total(personalPlugins)) },
      ]} />

      <section className="filters">
        <input className="search" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder={t('搜索插件、市场或版本', 'Search plugin, marketplace, or version')} />
      </section>

      {snapshot.pluginVersions.some((item) => item.status === 'unconfirmed') && <p className="notice">{t('Codex 未提供部分插件市场的权威状态；相关版本已锁定，不会参与管理。', 'Codex did not provide authoritative status for some plugin marketplaces. Those versions are locked and cannot be managed.')}</p>}
      {!canUninstall && snapshot.pluginVersions.some(pluginVersionCanUninstall) && <p className="notice warning">{t('没有找到 Codex CLI；当前插件不可卸载，但旧版本和卸载残留仍可清理。', 'The Codex CLI was not found. Current plugins cannot be uninstalled, but old versions and uninstalled leftovers can still be cleaned.')}</p>}

      <div className="card plugin-table">
        <div className="table-head plugin-head">
          <SelectAllCheckbox ariaLabel={t('全选', 'Select all')} allSelected={allVisibleSelected}
            someSelected={selectableVisible.some(isItemSelected)} onToggle={toggleAll} />
          <span className="col-sortable">
            <SortHeader active={sortKey === 'name'} dir={sortDir} onClick={() => cycleSort('name')}>
              {t('插件', 'Plugin')}
            </SortHeader>
          </span>
          <span>{t('版本', 'Version')}</span>
          <span className="col-status plugin-origin">
            <span className="status-head">
              {t('来源', 'Source')}
              <FunnelFilter ariaLabel={t('筛选来源', 'Filter source')} active={originScope !== 'all'}
                options={originOptions} value={originScope} onChange={setOriginScope} />
            </span>
          </span>
          <span className="col-status">
            <span className="status-head">
              {t('版本状态', 'Version status')}
              <FunnelFilter ariaLabel={t('筛选版本状态', 'Filter version status')} active={versionScope !== 'all'}
                options={versionOptions} value={versionScope} onChange={setVersionScope} />
            </span>
          </span>
          <span className="col-date col-sortable">
            <SortHeader active={sortKey === 'date'} dir={sortDir} onClick={() => cycleSort('date')}>
              {t('最后修改', 'Last modified')}
            </SortHeader>
          </span>
          <span className="col-num">
            <SortHeader align="end" active={sortKey === 'size'} dir={sortDir} onClick={() => cycleSort('size')}>
              {t('占用', 'Size')}
            </SortHeader>
          </span>
          <span />
        </div>
        <ul className="plugin-list">
          {visible.map((item) => <PluginRow key={item.directoryURL} item={item} locale={locale}
            uninstallSelected={selectedUninstalls.has(pluginIdentity(item))}
            removableSelected={pluginStatusIsRemovable(item.status) && selected.has(item.directoryURL)}
            canUninstall={canUninstall}
            onToggle={() => toggle(item.directoryURL)} onToggleUninstall={() => toggleUninstall(item)} />)}
        </ul>
        {!visible.length && <p className="empty-inline">{snapshot.pluginVersions.length
          ? t('没有符合筛选条件的插件', 'No plugins match these filters')
          : t('没有找到本地插件', 'No local plugins found')}</p>}
      </div>
    </div>
    <CleanupSelectionBar count={chosen.length} summary={<>{t(
      `已选 ${chosen.length} 项插件版本${uninstallCount ? `，其中卸载 ${uninstallCount} 个插件` : ''}`,
      `${chosen.length} plugin versions selected${uninstallCount ? `, including ${uninstallCount} plugin uninstalls` : ''}`
    )} · {formatBytes(selectedBytes)}</>}
      cleaning={cleaning} actionsDisabled={actionsDisabled} progress={cleanProgress}
      onDelete={() => onCleanup({ kind: 'plugins', ids: chosen.map((item) => item.directoryURL) })} />
  </>
}

function PluginRow({ item, locale, uninstallSelected, removableSelected, canUninstall, onToggle, onToggleUninstall }: {
  item: PluginVersionItem
  locale: string
  uninstallSelected: boolean
  removableSelected: boolean
  canUninstall: boolean
  onToggle: () => void
  onToggleUninstall: () => void
}) {
  const { t, m } = usePreferences()
  const label = `${item.plugin} ${item.version}`
  const detail = [item.marketplace, item.environmentBytes ? `${t('Python 环境', 'Python env')} ${formatBytes(item.environmentBytes)}` : null]
    .filter(Boolean).join(' · ')
  return <li className="plugin-row">
    {canUninstall && pluginVersionCanUninstall(item)
      ? <input type="checkbox" aria-label={label} checked={uninstallSelected} onChange={onToggleUninstall} />
      : pluginStatusIsRemovable(item.status)
        ? <input type="checkbox" aria-label={label} checked={uninstallSelected || removableSelected} disabled={uninstallSelected} onChange={onToggle} />
        : <span className="checkbox-space" />}
    <div className="grow">
      <strong>{pluginName(item)}</strong>
      {detail && <small>{detail}</small>}
    </div>
    <span className="plugin-version" title={item.version}><code>{item.version}</code></span>
    <span className="col-status plugin-origin"><span className={`pill${pluginIsOfficial(item) ? ' status-builtin' : ''}`}>
      {pluginIsOfficial(item) ? t('官方', 'Official') : t('个人', 'Personal')}
    </span></span>
    <span className="col-status">{pluginIsOfficial(item)
      ? <span className="pill status-current">{m(message('pluginStatus.current'))}</span>
      : <span className={`pill status-${item.status}`}>{m(message(`pluginStatus.${item.status}`))}</span>}
    </span>
    <span className="col-date" title={new Date(item.modifiedAt).toLocaleString(locale)}>{formatShortDate(item.modifiedAt, locale)}</span>
    <span className="col-num">{formatBytes(item.bytes)}</span>
    <button className="icon-button" title={t('在文件管理器中显示', 'Show in file manager')} aria-label={t('在文件管理器中显示', 'Show in file manager')} onClick={() => window.cleanmycodex.revealPath(item.directoryURL)}><FolderIcon /></button>
  </li>
}

const total = (items: PluginVersionItem[]): number => items.reduce((sum, item) => sum + item.bytes, 0)
const pluginIdentity = (plugin: PluginVersionItem): string => `${plugin.marketplace ?? ''}\0${plugin.plugin}`
