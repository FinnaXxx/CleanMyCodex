import { useEffect, useState } from 'react'
import type { AutomationSettings, AutomationState } from '../../shared/types'
import { formatBytes } from '../../shared/types'
import { SaveIcon } from '../icons'
import { usePreferences } from '../preferences'

const formatMoment = (ms: number, locale: string): string =>
  new Date(ms).toLocaleString(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

export default function AutomationView() {
  const { t, m, locale } = usePreferences()
  const [state, setState] = useState<AutomationState | null>(null)
  const [settings, setSettings] = useState<AutomationSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => { void window.cleanmycodex.getAutomation().then((next) => { setState(next); setSettings(next.settings) }) }, [])
  if (!settings || !state) return <div className="detail-content"><p className="empty-panel">{t('正在读取定时清理设置…', 'Loading scheduled cleanup settings…')}</p></div>

  /** Saving reinstalls the system task, so it stays inert until something actually changed. */
  const changed = JSON.stringify(settings) !== JSON.stringify(state.settings)
  const update = <K extends keyof AutomationSettings>(key: K, value: AutomationSettings[K]) => { setMessage(null); setSettings((current) => current ? { ...current, [key]: value } : current) }
  const save = async () => { setSaving(true); setMessage(null); try { const next = await window.cleanmycodex.saveAutomation(settings); setState(next); setSettings(next.settings); setMessage(t('设置已保存', 'Settings saved')) } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setSaving(false) } }
  return <div className="detail-content">
    <section className="view-toolbar"><span className="view-toolbar-hint">{(message || changed) ? (message ?? t('有未保存的修改', 'Unsaved changes')) : t('修改后需要保存才会生效', 'Changes take effect once saved')}</span><button className="btn" disabled={!changed || saving || (settings.enabled && !state.supported)} onClick={save}><SaveIcon /><span>{saving ? t('保存中…', 'Saving…') : t('保存', 'Save')}</span></button></section>
    {!state.supported && <p className="notice warning">{t('定时后台清理目前支持 macOS 和 Windows。', 'Scheduled background cleanup is currently supported on macOS and Windows.')}</p>}
    {state.supported && state.settings.enabled && !state.loaded && <p className="notice warning">{t('定时任务没有在系统里运行，保存一次设置可以重新安装。', 'The scheduled task is not running. Save the settings to reinstall it.')}</p>}
    <section className="card form-card">
      <label className="strong"><input type="checkbox" checked={settings.enabled} onChange={(event) => update('enabled', event.target.checked)}/> {t('开启定时清理', 'Enable scheduled cleanup')}</label>
      <label>{t('每', 'Run every')} <input className="number" type="number" min="1" max="180" value={settings.intervalDays} onChange={(event) => update('intervalDays', Number(event.target.value))}/> {t('天运行一次', 'days')}</label>
      {state.nextRunAt && <small>{t('预计下次运行：', 'Next run: ')}{formatMoment(state.nextRunAt, locale)}</small>}
      {state.lastRun && <small>{t('上次运行：', 'Last run: ')}{formatMoment(state.lastRun.finishedAt, locale)} · {t('释放', 'Freed')} {formatBytes(state.lastRun.freedBytes)} · {t('成功', 'Succeeded')} {state.lastRun.succeeded} · {t('跳过', 'Skipped')} {state.lastRun.deferred} · {t('失败', 'Failed')} {state.lastRun.failed}</small>}
      {state.lastRun?.note && <small>{m(state.lastRun.note)}</small>}
      <label><input type="checkbox" checked={settings.launchAtLogin} onChange={(event) => update('launchAtLogin', event.target.checked)}/> {t('登录时打开 Clean My Codex', 'Open Clean My Codex at login')}</label>
    </section>
    <section className="card form-card"><h3>{t('定时清理范围', 'Cleanup Scope')}</h3>
      <small>{t('每一项都需要 Codex 已退出。定时运行不会替你退出 Codex，所以触发时 Codex 开着的话，这一轮会全部跳过，下次再试。',
        'Every item here needs Codex to have quit. A scheduled run never quits it for you, so a run that fires while Codex is open skips everything and waits for the next one.')}</small>
      <label><input type="checkbox" checked={settings.cleanCaches} onChange={(event) => update('cleanCaches', event.target.checked)}/> {t('过期临时目录（安装和更新残留）', 'Stale temporary folders (install and update leftovers)')}</label>
      <label><input type="checkbox" checked={settings.cleanOldPlugins} onChange={(event) => update('cleanOldPlugins', event.target.checked)}/> {t('老版本插件，只保留当前版本', 'Old plugins, keeping only the current version')}</label>
      <label><input type="checkbox" checked={settings.cleanArchivedSessions} onChange={(event) => update('cleanArchivedSessions', event.target.checked)}/> {t('已归档会话，保留', 'Archived sessions, keep for')} <input className="number" type="number" min="7" max="1825" value={settings.archivedRetentionDays} disabled={!settings.cleanArchivedSessions} onChange={(event) => update('archivedRetentionDays', Number(event.target.value))}/> {t('天', 'days')}</label>
      <label><input type="checkbox" checked={settings.cleanActiveSessions} onChange={(event) => update('cleanActiveSessions', event.target.checked)}/> {t('未归档会话，保留', 'Active sessions, keep for')} <input className="number" type="number" min="7" max="3650" value={settings.activeRetentionDays} disabled={!settings.cleanActiveSessions} onChange={(event) => update('activeRetentionDays', Number(event.target.value))}/> {t('天', 'days')}</label>
    </section>
    <section className="card form-card"><h3>{t('安全规则', 'Safety Rules')}</h3>
      <label><input type="checkbox" checked={settings.skipRecentSessions} onChange={(event) => update('skipRecentSessions', event.target.checked)}/> {t('跳过 24 小时内活动过的会话', 'Skip sessions active within the last 24 hours')}</label>
      <label><input type="checkbox" checked={settings.notifyWhenFinished} onChange={(event) => update('notifyWhenFinished', event.target.checked)}/> {t('完成后显示通知', 'Show a notification when finished')}</label>
    </section>
  </div>
}
