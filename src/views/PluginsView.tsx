import { useEffect, useMemo, useState } from 'react'
import type { CleanupProgress, CleanupSelection, PluginStatus, PluginVersionItem, ScanSnapshot } from '../../shared/types'
import { formatBytes, pluginStatusIsRemovable, pluginVersionCanUninstall } from '../../shared/types'
import { message } from '../../shared/messages'
import { FolderIcon } from '../icons'
import { usePreferences } from '../preferences'

interface Props {
  snapshot: ScanSnapshot
  cleaning: boolean
  actionsDisabled: boolean
  canUninstall: boolean
  cleanProgress: CleanupProgress | null
  onCleanup: (selection: CleanupSelection) => void
}

type Scope = 'all' | 'current' | 'cleanable' | 'official' | 'nonBuiltin'

const selectable = (plugin: PluginVersionItem, canUninstall: boolean): boolean =>
  pluginStatusIsRemovable(plugin.status) || (canUninstall && pluginVersionCanUninstall(plugin))

export default function PluginsView({ snapshot, cleaning, actionsDisabled, canUninstall, cleanProgress, onCleanup }: Props) {
  const { t, m, locale } = usePreferences()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scope, setScope] = useState<Scope>('all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    const current = new Set(snapshot.pluginVersions.filter((item) => selectable(item, canUninstall)).map((item) => item.directoryURL))
    setSelected((previous) => new Set([...previous].filter((id) => current.has(id))))
  }, [canUninstall, snapshot.pluginVersions, snapshot.scannedAt])

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return snapshot.pluginVersions.filter((plugin) => {
      if (scope === 'current' && plugin.status !== 'current' && plugin.status !== 'builtin') return false
      if (scope === 'cleanable' && !pluginStatusIsRemovable(plugin.status)) return false
      if (scope === 'official' && plugin.status !== 'builtin') return false
      if (scope === 'nonBuiltin' && plugin.status === 'builtin') return false
      if (needle && ![plugin.plugin, plugin.marketplace, plugin.version, plugin.directoryURL]
        .filter(Boolean).join(' ').toLocaleLowerCase().includes(needle)) return false
      return true
    })
  }, [query, scope, snapshot.pluginVersions])

  const groups = useMemo(() => {
    const map = new Map<string, PluginVersionItem[]>()
    for (const plugin of visible) {
      const key = plugin.marketplace ? `${plugin.marketplace} / ${plugin.plugin}` : plugin.plugin
      map.set(key, [...(map.get(key) ?? []), plugin])
    }
    return [...map.entries()]
      .map(([name, versions]) => ({
        name,
        official: versions.every((item) => item.status === 'builtin'),
        versions: versions.slice().sort((a, b) => statusRank(a.status) - statusRank(b.status) || b.modifiedAt - a.modifiedAt)
      }))
      .sort((a, b) => Number(a.official) - Number(b.official) || a.name.localeCompare(b.name))
  }, [visible])

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
  const totalBytes = total(snapshot.pluginVersions)
  const uninstallCount = selectedUninstalls.size

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

  return <>
    <div className="detail-content">
      <section className="workspace-metrics plugin-metrics card">
        <div><small>{t('总占用', 'Total')}</small><strong>{formatBytes(totalBytes)}</strong></div>
        <div><small>{t('已选择', 'Selected')}</small><strong>{formatBytes(selectedBytes)}</strong></div>
      </section>

      <section className="filters">
        <select value={scope} onChange={(event) => setScope(event.target.value as Scope)}>
          <option value="all">{t('全部状态', 'All statuses')} {snapshot.pluginVersions.length}</option>
          <option value="current">{t('当前版本', 'Current versions')} {statusCount(snapshot.pluginVersions, ['current', 'builtin'])}</option>
          <option value="cleanable">{t('可清理版本', 'Cleanable versions')} {statusCount(snapshot.pluginVersions, ['outdated', 'orphaned'])}</option>
          <option value="official">{t('官方插件', 'Official plugins')} {statusCount(snapshot.pluginVersions, ['builtin'])}</option>
          <option value="nonBuiltin">{t('非内置插件', 'Non-built-in plugins')} {snapshot.pluginVersions.filter((item) => item.status !== 'builtin').length}</option>
        </select>
        <input className="search" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder={t('搜索插件、市场或版本', 'Search plugin, marketplace, or version')} />
      </section>

      {snapshot.pluginVersions.some((item) => item.status === 'unconfirmed') && <p className="notice">{t('Codex 未提供部分插件市场的权威状态；相关版本已锁定，不会参与管理。', 'Codex did not provide authoritative status for some plugin marketplaces. Those versions are locked and cannot be managed.')}</p>}
      {!canUninstall && snapshot.pluginVersions.some(pluginVersionCanUninstall) && <p className="notice warning">{t('没有找到 Codex CLI；当前插件不可卸载，但旧版本和卸载残留仍可清理。', 'The Codex CLI was not found. Current plugins cannot be uninstalled, but old versions and uninstalled leftovers can still be cleaned.')}</p>}
      {!snapshot.pluginVersions.length && <p className="empty-panel">{t('没有找到本地插件', 'No local plugins found')}</p>}
      {!!snapshot.pluginVersions.length && !groups.length && <p className="empty-panel">{t('没有符合筛选条件的插件', 'No plugins match these filters')}</p>}
      <div className="card-stack">
        {groups.map(({ name, versions }) => <section className="card" key={name}>
          <div className="panel-title"><strong>{name}</strong><span>{t(`${versions.length} 个版本`, `${versions.length} versions`)} · {formatBytes(total(versions))}</span></div>
          {versions.map((item) => {
            const uninstallSelected = selectedUninstalls.has(pluginIdentity(item))
            return <div className="plugin-row" key={item.directoryURL}>
            {canUninstall && pluginVersionCanUninstall(item)
              ? <input type="checkbox" aria-label={`${item.plugin} ${item.version}`} checked={uninstallSelected} onChange={() => toggleUninstall(item)} />
              : pluginStatusIsRemovable(item.status)
                ? <input type="checkbox" aria-label={`${item.plugin} ${item.version}`} checked={uninstallSelected || selected.has(item.directoryURL)} disabled={uninstallSelected} onChange={() => toggle(item.directoryURL)} />
              : <span className="checkbox-space" />}
            <div className="grow"><code>{item.version}</code><small>{t('最后改动', 'Modified')} {new Date(item.modifiedAt).toLocaleDateString(locale)}{item.environmentBytes ? ` · ${t('Python 环境', 'Python environment')} ${formatBytes(item.environmentBytes)}` : ''}</small></div>
            <span className={`pill status-${item.status}`}>{m(message(`pluginStatus.${item.status}`))}</span>
            <span className="fixed-bytes">{formatBytes(item.bytes)}</span>
            <button className="icon-button" title={t('在文件管理器中显示', 'Show in file manager')} aria-label={t('在文件管理器中显示', 'Show in file manager')} onClick={() => window.cleanmycodex.revealPath(item.directoryURL)}><FolderIcon /></button>
          </div>})}
        </section>)}
      </div>
    </div>
    <div className="page-footer"><span>{chosen.length
      ? t(`已选择 ${chosen.length} 项${uninstallCount ? `，其中卸载 ${uninstallCount} 个插件` : ''}`, `${chosen.length} selected${uninstallCount ? `, including ${uninstallCount} plugin uninstalls` : ''}`)
      : t('选择当前插件以卸载，或选择旧版本与残留以清理', 'Select current plugins to uninstall, or old versions and leftovers to clean')}</span>
      <button className="btn danger" disabled={!chosen.length || cleaning || actionsDisabled}
        onClick={() => onCleanup({ kind: 'plugins', ids: chosen.map((item) => item.directoryURL) })}>
        {cleaning
          ? t(`处理中… ${cleanProgress?.completed ?? 0}/${chosen.length}`, `Processing… ${cleanProgress?.completed ?? 0}/${chosen.length}`)
          : t(`删除 · ${formatBytes(selectedBytes)}`, `Delete Permanently · ${formatBytes(selectedBytes)}`)}
      </button></div>
  </>
}

const total = (items: PluginVersionItem[]): number => items.reduce((sum, item) => sum + item.bytes, 0)
const statusCount = (items: PluginVersionItem[], statuses: PluginStatus[]): number =>
  items.filter((item) => statuses.includes(item.status)).length
const statusRank = (status: PluginStatus): number => ({ current: 0, builtin: 0, outdated: 1, orphaned: 2, unconfirmed: 3 })[status]
const pluginIdentity = (plugin: PluginVersionItem): string => `${plugin.marketplace ?? ''}\0${plugin.plugin}`
