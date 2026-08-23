import { useEffect, useState, type ReactNode } from 'react'
import { usePreferences, type LanguagePreference, type ThemePreference } from '../preferences'

export default function SettingsView({ onOpenScheduledCleanup }: {
  onOpenScheduledCleanup: () => void
}) {
  const { theme, language, setTheme, setLanguage, t, e } = usePreferences()
  const [logPath, setLogPath] = useState<string | null>(null)
  const [logError, setLogError] = useState<string | null>(null)

  // The folder is made on demand, so its path is worth showing only once it is known.
  useEffect(() => {
    let cancelled = false
    window.cleanmycodex.logDirectory()
      .then((path) => { if (!cancelled) setLogPath(path) })
      .catch(() => { if (!cancelled) setLogPath(null) })
    return () => { cancelled = true }
  }, [])

  const openLogs = async (): Promise<void> => {
    setLogError(null)
    try {
      const path = logPath ?? await window.cleanmycodex.logDirectory()
      setLogPath(path)
      await window.cleanmycodex.openPath(path)
    } catch (err) {
      setLogError(e(err instanceof Error ? err.message : String(err)))
    }
  }

  return <div className="detail-content settings-content">
    <SettingsGroup title={t('外观', 'Appearance')}>
      <SettingsRow title={t('主题', 'Theme')} detail={t('选择界面的明暗外观', 'Choose how the interface looks')}>
        <SegmentedControl value={theme} onChange={(value) => setTheme(value as ThemePreference)} options={[
          { value: 'light', label: t('浅色', 'Light') },
          { value: 'dark', label: t('深色', 'Dark') },
          { value: 'system', label: t('跟随系统', 'System') }
        ]} label={t('主题', 'Theme')} />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title={t('通用', 'General')}>
      <SettingsRow title={t('语言', 'Language')} detail={t('切换应用显示语言', 'Change the app display language')}>
        <SegmentedControl value={language} onChange={(value) => setLanguage(value as LanguagePreference)} options={[
          { value: 'zh-CN', label: '中文' },
          { value: 'en', label: 'English' }
        ]} label={t('语言', 'Language')} />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title={t('诊断', 'Diagnostics')}>
      <button className="settings-navigation-row" onClick={() => void openLogs()}>
        <span><strong>{t('日志', 'Logs')}</strong>
          <small className={logError ? 'settings-error' : undefined}>{logError ?? t('打开应用日志目录，其中记录了清理与定时任务的执行过程', 'Open the app log folder, which records what cleanups and scheduled runs did')}</small></span>
        <span className="settings-navigation-value">
          {logPath && <span className="settings-path" title={logPath}>{logPath}</span>}
          <i className="settings-chevron" aria-hidden="true">›</i>
        </span>
      </button>
    </SettingsGroup>

    <SettingsGroup title={t('清理', 'Cleanup')}>
      <button className="settings-navigation-row" onClick={onOpenScheduledCleanup}>
        <span><strong>{t('定时清理', 'Scheduled Cleanup')}</strong><small>{t('设置运行周期、清理范围和安全规则', 'Set the schedule, cleanup scope, and safety rules')}</small></span>
        <span className="settings-navigation-value"><i className="settings-chevron" aria-hidden="true">›</i></span>
      </button>
    </SettingsGroup>
  </div>
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className="settings-group"><h3>{title}</h3><div className="card settings-card">{children}</div></section>
}

function SettingsRow({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return <div className="settings-row"><span><strong>{title}</strong><small>{detail}</small></span>{children}</div>
}

function SegmentedControl({ value, options, label, onChange }: {
  value: string
  options: { value: string; label: string }[]
  label: string
  onChange: (value: string) => void
}) {
  return <div className="segmented-control" role="radiogroup" aria-label={label}>
    {options.map((option) => <button key={option.value} role="radio" aria-checked={value === option.value}
      className={value === option.value ? 'selected' : ''} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>
}
