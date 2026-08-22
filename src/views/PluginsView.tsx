import { useMemo, useState } from 'react'
import type { CleanupProgress, CleanupTask, PluginVersionItem, ScanSnapshot } from '../../shared/types'
import { formatBytes, PluginStatusLabel, pluginStatusIsRemovable, tasksFromEntries } from '../../shared/types'

interface Props {
  snapshot: ScanSnapshot
  cleaning: boolean
  cleanProgress: CleanupProgress | null
  onCleanup: (tasks: CleanupTask[]) => void
}

export default function PluginsView({ snapshot, cleaning, cleanProgress, onCleanup }: Props) {
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
  const cleanup = () => window.confirm(`确认清理 ${chosen.length} 个非当前插件版本，预计释放 ${formatBytes(bytes)}？`) && onCleanup(tasksFromEntries(chosen.map((item) => ({
    id: `trash:${item.directoryURL}`, title: `${item.plugin} · ${item.version}`,
    detail: PluginStatusLabel[item.status], url: item.directoryURL, bytes: item.bytes,
    reclaimableBytes: item.bytes, minimumIdleSeconds: null, requiresCodexStopped: false,
    method: 'trash', risk: 'safe'
  }))))

  return <>
    <section className="page-heading">
      <div><h2>插件版本</h2><p>当前启用的版本始终受保护，只清理旧版本和卸载残留。</p></div>
      <button className="secondary" disabled={!removable.length} onClick={() => setSelected(new Set(removable.map((item) => item.directoryURL)))}>选择全部可清理版本</button>
    </section>
    {snapshot.pluginVersions.some((item) => item.status === 'unconfirmed') && <p className="notice">没有连接到 codex app server，未确认的版本已锁定，不能清理。</p>}
    {!groups.length && <p className="empty-panel">没有找到本地插件</p>}
    <div className="card-stack">
      {groups.map(([name, versions]) => <section className="panel" key={name}>
        <div className="panel-title"><strong>◫ {name}</strong><span>{versions.length} 个版本 · {formatBytes(versions.reduce((sum, item) => sum + item.bytes, 0))}</span></div>
        {versions.sort((a, b) => b.modifiedAt - a.modifiedAt).map((item) => <div className="plugin-row" key={item.directoryURL}>
          <input type="checkbox" disabled={!pluginStatusIsRemovable(item.status)} checked={selected.has(item.directoryURL)} onChange={() => toggle(item.directoryURL)} />
          <div className="grow"><code>{item.version}</code><small>最后改动 {new Date(item.modifiedAt).toLocaleDateString()}{item.environmentBytes ? ` · Python 环境 ${formatBytes(item.environmentBytes)}` : ''}</small></div>
          <span className={`pill status-${item.status}`}>{PluginStatusLabel[item.status]}</span>
          <span className="fixed-bytes">{formatBytes(item.bytes)}</span>
          <button className="icon-button" title="在文件管理器中显示" onClick={() => window.cleanmycodex.revealPath(item.directoryURL)}>⌕</button>
        </div>)}
      </section>)}
    </div>
    <div className="page-footer"><span>{chosen.length ? `已选择 ${chosen.length} 个版本 · ${formatBytes(bytes)}` : `可清理 ${removable.length} 个版本`}</span><button className="clean" disabled={!chosen.length || cleaning} onClick={cleanup}>{cleaning ? `清理中… ${cleanProgress?.completed ?? 0}/${chosen.length}` : '清理所选版本'}</button></div>
  </>
}
