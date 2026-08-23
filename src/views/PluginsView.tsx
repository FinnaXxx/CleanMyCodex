import { useMemo, useState } from 'react'
import type { CleanupProgress, CleanupSelection, PluginVersionItem, ScanSnapshot } from '../../shared/types'
import { formatBytes, pluginStatusIsRemovable } from '../../shared/types'
import { message } from '../../shared/messages'
import { FolderIcon } from '../icons'
import { usePreferences } from '../preferences'

interface Props {
  snapshot: ScanSnapshot
  cleaning: boolean
  actionsDisabled: boolean
  cleanProgress: CleanupProgress | null
  onCleanup: (selection: CleanupSelection) => void
}

export default function PluginsView({ snapshot, cleaning, actionsDisabled, cleanProgress, onCleanup }: Props) {
  const { t, m, locale } = usePreferences()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const groups = useMemo(() => {
    const map = new Map<string, PluginVersionItem[]>()
    for (const plugin of snapshot.pluginVersions) {
      const key = plugin.marketplace ? `${plugin.marketplace} / ${plugin.plugin}` : plugin.plugin
      map.set(key, [...(map.get(key) ?? []), plugin])
    }
    return [...map.entries()].sort((a, b) => b[1].reduce((n, x) => n + x.bytes, 0) - a[1].reduce((n, x) => n + x.bytes, 0))
  }, [snapshot.pluginVersions])
  const removable = snapshot.pluginVersions.filter((item) => pluginStatusIsRemovable(item.status))
  const chosen = removable.filter((item) => selected.has(item.directoryURL))
  const bytes = chosen.reduce((sum, item) => sum + item.bytes, 0)
  const toggle = (id: string) => setSelected((previous) => {
    const next = new Set(previous)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const cleanup = () => onCleanup({ kind: 'plugins', ids: chosen.map((item) => item.directoryURL) })

  return <>
    <div className="detail-content">
    <section className="view-toolbar">
      <span className="view-toolbar-hint">{t(`${groups.length} 个插件 · ${snapshot.pluginVersions.length} 个版本`, `${groups.length} plugins · ${snapshot.pluginVersions.length} versions`)}</span>
      <button className="btn" disabled={!removable.length} onClick={() => setSelected(new Set(removable.map((item) => item.directoryURL)))}>{t('选择全部可清理版本', 'Select All Cleanable Versions')}</button>
    </section>
    {snapshot.pluginVersions.some((item) => item.status === 'unconfirmed') && <p className="notice">{t('Codex 未提供部分插件市场的权威状态；相关版本已锁定，不会参与清理。', 'Codex did not provide authoritative status for some plugin marketplaces. Those versions are locked and will not be cleaned.')}</p>}
    {!groups.length && <p className="empty-panel">{t('没有找到本地插件', 'No local plugins found')}</p>}
    <div className="card-stack">
      {groups.map(([name, versions]) => <section className="card" key={name}>
        <div className="panel-title"><strong>{name}</strong><span>{t(`${versions.length} 个版本`, `${versions.length} versions`)} · {formatBytes(versions.reduce((sum, item) => sum + item.bytes, 0))}</span></div>
        {versions.sort((a, b) => b.modifiedAt - a.modifiedAt).map((item) => <div className="plugin-row" key={item.directoryURL}>
          {pluginStatusIsRemovable(item.status)
            ? <input type="checkbox" aria-label={`${item.plugin} ${item.version}`} checked={selected.has(item.directoryURL)} onChange={() => toggle(item.directoryURL)} />
            : <span className="checkbox-space" />}
          <div className="grow"><code>{item.version}</code><small>{t('最后改动', 'Modified')} {new Date(item.modifiedAt).toLocaleDateString(locale)}{item.environmentBytes ? ` · ${t('Python 环境', 'Python environment')} ${formatBytes(item.environmentBytes)}` : ''}</small></div>
          <span className={`pill status-${item.status}`}>{m(message(`pluginStatus.${item.status}`))}</span>
          <span className="fixed-bytes">{formatBytes(item.bytes)}</span>
          <button className="icon-button" title={t('在文件管理器中显示', 'Show in file manager')} aria-label={t('在文件管理器中显示', 'Show in file manager')} onClick={() => window.cleanmycodex.revealPath(item.directoryURL)}><FolderIcon /></button>
        </div>)}
      </section>)}
    </div>
    </div>
    <div className="page-footer"><span>{chosen.length ? t(`已选择 ${chosen.length} 个版本 · ${formatBytes(bytes)}`, `${chosen.length} versions selected · ${formatBytes(bytes)}`) : t(`可清理 ${removable.length} 个版本`, `${removable.length} cleanable versions`)}</span><button className="btn primary" disabled={!chosen.length || cleaning || actionsDisabled} onClick={cleanup}>{cleaning ? t(`清理中… ${cleanProgress?.completed ?? 0}/${chosen.length}`, `Cleaning… ${cleanProgress?.completed ?? 0}/${chosen.length}`) : t('清理所选版本', 'Clean Selected Versions')}</button></div>
  </>
}
