import { useMemo, useState } from 'react'
import type { CleanupProgress, CleanupSelection, PluginVersionItem, ScanSnapshot } from '../../shared/types'
import { formatBytes, PluginStatusLabel, pluginStatusIsRemovable } from '../../shared/types'

interface Props {
  snapshot: ScanSnapshot
  cleaning: boolean
  actionsDisabled: boolean
  cleanProgress: CleanupProgress | null
  onCleanup: (selection: CleanupSelection) => void
}

export default function PluginsView({ snapshot, cleaning, actionsDisabled, cleanProgress, onCleanup }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const groups = useMemo(() => {
    const map = new Map<string, PluginVersionItem[]>()
    for (const plugin of snapshot.pluginVersions) {
      const key = `${plugin.marketplace} / ${plugin.plugin}`
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
    <section className="page-heading">
      <div><h2>插件版本</h2><p>只清理旧版本和卸载残留。</p></div>
      <button className="btn" disabled={!removable.length} onClick={() => setSelected(new Set(removable.map((item) => item.directoryURL)))}>选择全部可清理版本</button>
    </section>
    {snapshot.pluginVersions.some((item) => item.status === 'unconfirmed') && <p className="notice">未连接 codex app server，无法确认当前版本，已全部锁定。</p>}
    {!groups.length && <p className="empty-panel">没有找到本地插件</p>}
    <div className="card-stack">
      {groups.map(([name, versions]) => <section className="card" key={name}>
        <div className="panel-title"><strong>◫ {name}</strong><span>{versions.length} 个版本 · {formatBytes(versions.reduce((sum, item) => sum + item.bytes, 0))}</span></div>
        {versions.sort((a, b) => b.modifiedAt - a.modifiedAt).map((item) => <div className="plugin-row" key={item.directoryURL}>
          {pluginStatusIsRemovable(item.status)
            ? <input type="checkbox" aria-label={`${item.plugin} ${item.version}`} checked={selected.has(item.directoryURL)} onChange={() => toggle(item.directoryURL)} />
            : <span className="checkbox-space" />}
          <div className="grow"><code>{item.version}</code><small>最后改动 {new Date(item.modifiedAt).toLocaleDateString()}{item.environmentBytes ? ` · Python 环境 ${formatBytes(item.environmentBytes)}` : ''}</small></div>
          <span className={`pill status-${item.status}`}>{PluginStatusLabel[item.status]}</span>
          <span className="fixed-bytes">{formatBytes(item.bytes)}</span>
          <button className="icon-button" title="在文件管理器中显示" onClick={() => window.cleanmycodex.revealPath(item.directoryURL)}>⌕</button>
        </div>)}
      </section>)}
    </div>
    <div className="page-footer"><span>{chosen.length ? `已选择 ${chosen.length} 个版本 · ${formatBytes(bytes)}` : `可清理 ${removable.length} 个版本`}</span><button className="btn primary" disabled={!chosen.length || cleaning || actionsDisabled} onClick={cleanup}>{cleaning ? `清理中… ${cleanProgress?.completed ?? 0}/${chosen.length}` : '清理所选版本'}</button></div>
  </>
}
