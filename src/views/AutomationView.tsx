import { useEffect, useState } from 'react'
import type { AutomationSettings, AutomationState } from '../../shared/types'
import { formatBytes } from '../../shared/types'
import { BackIcon, SaveIcon } from '../icons'
import { usePreferences } from '../preferences'

const formatMoment = (ms: number, locale: string): string =>
  new Date(ms).toLocaleString(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

export default function AutomationView({ onBack }: { onBack: () => void }) {
  const { t, locale } = usePreferences()
  const [state, setState] = useState<AutomationState | null>(null)
  const [settings, setSettings] = useState<AutomationSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => { void window.cleanmycodex.getAutomation().then((next) => { setState(next); setSettings(next.settings) }) }, [])
  if (!settings || !state) return <div className="detail-content"><section className="page-heading"><div className="page-title"><button className="icon-button detail-back-button" title={t('返回设置', 'Back to Settings')} aria-label={t('返回设置', 'Back to Settings')} onClick={onBack}><BackIcon /></button><div><h2>{t('定时清理', 'Scheduled Cleanup')}</h2></div></div></section><p className="empty-panel">{t('正在读取定时清理设置…', 'Loading scheduled cleanup settings…')}</p></div>

  /** Saving reinstalls the system task, so it stays inert until something actually changed. */
  const changed = JSON.stringify(settings) !== JSON.stringify(state.settings)
  const update = <K extends keyof AutomationSettings>(key: K, value: AutomationSettings[K]) => { setMessage(null); setSettings((current) => current ? { ...current, [key]: value } : current) }
  const save = async () => { setSaving(true); setMessage(null); try { const next = await window.cleanmycodex.saveAutomation(settings); setState(next); setSettings(next.settings); setMessage(t('设置已保存', 'Settings saved')) } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setSaving(false) } }
  return <div className="detail-content">
    <section className="page-heading"><div className="page-title"><button className="icon-button detail-back-button" title={t('返回设置', 'Back to Settings')} aria-label={t('返回设置', 'Back to Settings')} onClick={onBack}><BackIcon /></button><div className="automation-heading"><h2>{t('定时清理', 'Scheduled Cleanup')}</h2>{(message || changed) && <span>{message ?? t('有未保存的修改', 'Unsaved changes')}</span>}</div></div><button className="icon-button save-icon-button" title={saving ? t('保存中…', 'Saving…') : t('保存', 'Save')} aria-label={saving ? t('保存中…', 'Saving…') : t('保存', 'Save')} disabled={!changed || saving || (settings.enabled && !state.supported)} onClick={save}><SaveIcon /></button></section>
    {!state.supported && <p className="notice warning">{t('定时后台清理目前支持 macOS 和 Windows。', 'Scheduled background cleanup is currently supported on macOS and Windows.')}</p>}
    {state.supported && state.settings.enabled && !state.loaded && <p className="notice warning">{t('定时任务没有在系统里运行，保存一次设置可以重新安装。', 'The scheduled task is not running. Save the settings to reinstall it.')}</p>}
    <section className="card form-card">
      <label className="strong"><input type="checkbox" checked={settings.enabled} onChange={(event) => update('enabled', event.target.checked)}/> {t('开启定时清理', 'Enable scheduled cleanup')}</label>
      <label>{t('每', 'Run every')} <input className="number" type="number" min="1" max="180" value={settings.intervalDays} onChange={(event) => update('intervalDays', Number(event.target.value))}/> {t('天运行一次', 'days')}</label>
      {state.nextRunAt && <small>{t('预计下次运行：', 'Next run: ')}{formatMoment(state.nextRunAt, locale)}</small>}
      {state.lastRun && <small>{t('上次运行：', 'Last run: ')}{formatMoment(state.lastRun.finishedAt, locale)} · {t('释放', 'Freed')} {formatBytes(state.lastRun.freedBytes)} · {t('成功', 'Succeeded')} {state.lastRun.succeeded} · {t('跳过', 'Skipped')} {state.lastRun.deferred} · {t('失败', 'Failed')} {state.lastRun.failed}</small>}
    </section>
    <section className="card form-card"><h3>{t('定时清理范围', 'Cleanup Scope')}</h3>
      <label><input type="checkbox" checked={settings.cleanCaches} onChange={(event) => update('cleanCaches', event.target.checked)}/> {t('缓存和过期临时文件', 'Caches and stale temporary files')}</label>
      <label><input type="checkbox" checked={settings.cleanOldPlugins} onChange={(event) => update('cleanOldPlugins', event.target.checked)}/> {t('老版本插件，只保留当前版本', 'Old plugins, keeping only the current version')}</label>
      <label><input type="checkbox" checked={settings.cleanArchivedSessions} onChange={(event) => update('cleanArchivedSessions', event.target.checked)}/> {t('已归档会话，保留', 'Archived sessions, keep for')} <input className="number" type="number" min="7" max="1825" value={settings.archivedRetentionDays} disabled={!settings.cleanArchivedSessions} onChange={(event) => update('archivedRetentionDays', Number(event.target.value))}/> {t('天', 'days')}</label>
      <label><input type="checkbox" checked={settings.cleanActiveSessions} onChange={(event) => update('cleanActiveSessions', event.target.checked)}/> {t('未归档会话，保留', 'Active sessions, keep for')} <input className="number" type="number" min="7" max="3650" value={settings.activeRetentionDays} disabled={!settings.cleanActiveSessions} onChange={(event) => update('activeRetentionDays', Number(event.target.value))}/> {t('天', 'days')}</label>
    </section>
    <section className="card form-card"><h3>{t('安全规则', 'Safety Rules')}</h3>
      <label><input type="checkbox" checked={settings.skipRecentSessions} onChange={(event) => update('skipRecentSessions', event.target.checked)}/> {t('跳过 24 小时内活动过的会话', 'Skip sessions active within the last 24 hours')}</label>
      <label><input type="checkbox" checked={settings.notifyWhenFinished} onChange={(event) => update('notifyWhenFinished', event.target.checked)}/> {t('完成后显示通知', 'Show a notification when finished')}</label>
      <label><input type="checkbox" checked={settings.launchAtLogin} onChange={(event) => update('launchAtLogin', event.target.checked)}/> {t('登录时打开 Clean My Codex', 'Open Clean My Codex at login')}</label>
    </section>
  </div>
}
