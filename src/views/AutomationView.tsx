import { useEffect, useState } from 'react'
import type { AutomationSettings, AutomationState } from '../../shared/types'
import { formatBytes } from '../../shared/types'

export default function AutomationView() {
  const [state, setState] = useState<AutomationState | null>(null)
  const [settings, setSettings] = useState<AutomationSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => { void window.cleanmycodex.getAutomation().then((next) => { setState(next); setSettings(next.settings) }) }, [])
  if (!settings || !state) return <p className="empty-panel">正在读取自动清理设置…</p>
  const update = <K extends keyof AutomationSettings>(key: K, value: AutomationSettings[K]) => setSettings((current) => current ? { ...current, [key]: value } : current)
  const save = async () => { setSaving(true); setMessage(null); try { const next = await window.cleanmycodex.saveAutomation(settings); setState(next); setSettings(next.settings); setMessage('设置已保存') } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setSaving(false) } }
  return <>
    <section className="page-heading"><div><h2>自动清理</h2><p>通过系统任务调度器定期运行；需要独占文件的项目会自动推迟。</p></div><span className={`pill ${state.loaded ? 'status-current' : ''}`}>{settings.enabled ? state.loaded ? '已安装' : '未加载' : '已关闭'}</span></section>
    {!state.supported && <p className="notice warning">定时后台清理目前支持 macOS 和 Windows。</p>}
    <section className="panel form-card"><label className="strong"><input type="checkbox" checked={settings.enabled} onChange={(event) => update('enabled', event.target.checked)}/> 定期自动清理</label><label>每 <input className="number" type="number" min="1" max="180" value={settings.intervalDays} onChange={(event) => update('intervalDays', Number(event.target.value))}/> 天运行一次</label>{state.nextRunAt && <small>预计下次运行：{new Date(state.nextRunAt).toLocaleString()}</small>}{state.lastRun && <small>上次运行：{new Date(state.lastRun.finishedAt).toLocaleString()} · 释放 {formatBytes(state.lastRun.freedBytes)} · 成功 {state.lastRun.succeeded} 项 · 失败 {state.lastRun.failed} 项</small>}</section>
    <section className="panel form-card"><h3>自动清理范围</h3><label><input type="checkbox" checked={settings.cleanCaches} onChange={(event) => update('cleanCaches', event.target.checked)}/> 缓存、日志数据库和过期临时文件</label><label><input type="checkbox" checked={settings.cleanOldPlugins} onChange={(event) => update('cleanOldPlugins', event.target.checked)}/> 老版本插件，只保留当前版本</label><label><input type="checkbox" checked={settings.cleanArchivedSessions} onChange={(event) => update('cleanArchivedSessions', event.target.checked)}/> 已归档会话，保留 <input className="number" type="number" value={settings.archivedRetentionDays} disabled={!settings.cleanArchivedSessions} onChange={(event) => update('archivedRetentionDays', Number(event.target.value))}/> 天</label><label><input type="checkbox" checked={settings.cleanActiveSessions} onChange={(event) => update('cleanActiveSessions', event.target.checked)}/> 未归档会话，保留 <input className="number" type="number" value={settings.activeRetentionDays} disabled={!settings.cleanActiveSessions} onChange={(event) => update('activeRetentionDays', Number(event.target.value))}/> 天</label></section>
    <section className="panel form-card"><h3>安全规则</h3><label><input type="checkbox" checked={settings.skipRecentSessions} onChange={(event) => update('skipRecentSessions', event.target.checked)}/> 跳过 24 小时内活动过的会话</label><label><input type="checkbox" checked={settings.notifyWhenFinished} onChange={(event) => update('notifyWhenFinished', event.target.checked)}/> 完成后显示通知</label><label><input type="checkbox" checked={settings.launchAtLogin} onChange={(event) => update('launchAtLogin', event.target.checked)}/> 登录时打开 CleanMyCodex</label><small>配置、凭据、状态库、当前插件版本和 Documents/Codex 永远不会被自动清理。</small></section>
    <div className="page-footer"><span>{message ?? '修改后保存才会更新系统任务。'}</span><button className="clean" disabled={saving || (settings.enabled && !state.supported)} onClick={save}>{saving ? '保存中…' : '保存设置'}</button></div>
  </>
}
