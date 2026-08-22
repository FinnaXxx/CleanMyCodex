import { useEffect, useState } from 'react'
import type { AutomationSettings, AutomationState } from '../../shared/types'
import { formatBytes } from '../../shared/types'

const formatMoment = (ms: number): string =>
  new Date(ms).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

export default function AutomationView() {
  const [state, setState] = useState<AutomationState | null>(null)
  const [settings, setSettings] = useState<AutomationSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => { void window.cleanmycodex.getAutomation().then((next) => { setState(next); setSettings(next.settings) }) }, [])
  if (!settings || !state) return <p className="empty-panel">正在读取自动清理设置…</p>
  /** Saving reinstalls the system task, so it stays inert until something actually changed. */
  const changed = JSON.stringify(settings) !== JSON.stringify(state.settings)
  const update = <K extends keyof AutomationSettings>(key: K, value: AutomationSettings[K]) => { setMessage(null); setSettings((current) => current ? { ...current, [key]: value } : current) }
  const save = async () => { setSaving(true); setMessage(null); try { const next = await window.cleanmycodex.saveAutomation(settings); setState(next); setSettings(next.settings); setMessage('设置已保存') } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setSaving(false) } }
  return <>
    <section className="page-heading"><div><h2>自动清理</h2></div></section>
    {!state.supported && <p className="notice warning">定时后台清理目前支持 macOS 和 Windows。</p>}
    {state.supported && state.settings.enabled && !state.loaded && <p className="notice warning">定时任务没有在系统里运行，保存一次设置可以重新安装。</p>}
    <section className="card form-card"><label className="strong"><input type="checkbox" checked={settings.enabled} onChange={(event) => update('enabled', event.target.checked)}/> 定期自动清理</label><label>每 <input className="number" type="number" min="1" max="180" value={settings.intervalDays} onChange={(event) => update('intervalDays', Number(event.target.value))}/> 天运行一次</label>{state.nextRunAt && <small>预计下次运行：{formatMoment(state.nextRunAt)}</small>}{state.lastRun && <small>上次运行：{formatMoment(state.lastRun.finishedAt)} · 释放 {formatBytes(state.lastRun.freedBytes)} · 成功 {state.lastRun.succeeded} 项 · 跳过 {state.lastRun.deferred} 项 · 失败 {state.lastRun.failed} 项</small>}</section>
    <section className="card form-card"><h3>自动清理范围</h3><label><input type="checkbox" checked={settings.cleanCaches} onChange={(event) => update('cleanCaches', event.target.checked)}/> 缓存、日志数据库和过期临时文件</label><label><input type="checkbox" checked={settings.cleanOldPlugins} onChange={(event) => update('cleanOldPlugins', event.target.checked)}/> 老版本插件，只保留当前版本</label><label><input type="checkbox" checked={settings.cleanArchivedSessions} onChange={(event) => update('cleanArchivedSessions', event.target.checked)}/> 已归档会话，保留 <input className="number" type="number" value={settings.archivedRetentionDays} disabled={!settings.cleanArchivedSessions} onChange={(event) => update('archivedRetentionDays', Number(event.target.value))}/> 天</label><label><input type="checkbox" checked={settings.cleanActiveSessions} onChange={(event) => update('cleanActiveSessions', event.target.checked)}/> 未归档会话，保留 <input className="number" type="number" value={settings.activeRetentionDays} disabled={!settings.cleanActiveSessions} onChange={(event) => update('activeRetentionDays', Number(event.target.value))}/> 天</label></section>
    <section className="card form-card"><h3>安全规则</h3><label><input type="checkbox" checked={settings.skipRecentSessions} onChange={(event) => update('skipRecentSessions', event.target.checked)}/> 跳过 24 小时内活动过的会话</label><label><input type="checkbox" checked={settings.notifyWhenFinished} onChange={(event) => update('notifyWhenFinished', event.target.checked)}/> 完成后显示通知</label><label><input type="checkbox" checked={settings.launchAtLogin} onChange={(event) => update('launchAtLogin', event.target.checked)}/> 登录时打开 CleanMyCodex</label></section>
    <div className="page-footer"><span>{message ?? (changed ? '有未保存的修改' : '')}</span><button className="btn primary" disabled={!changed || saving || (settings.enabled && !state.supported)} onClick={save}>{saving ? '保存中…' : '保存设置'}</button></div>
  </>
}
