import type { ReactNode } from 'react'
import { BackIcon } from '../icons'
import { usePreferences, type LanguagePreference, type ThemePreference } from '../preferences'

export default function SettingsView({ onBack, onOpenScheduledCleanup }: {
  onBack: () => void
  onOpenScheduledCleanup: () => void
}) {
  const { theme, language, setTheme, setLanguage, t } = usePreferences()
  return <div className="detail-content settings-content">
    <section className="page-heading">
      <div className="page-title">
        <button className="icon-button detail-back-button" title={t('返回', 'Back')} aria-label={t('返回', 'Back')} onClick={onBack}><BackIcon /></button>
        <div><h2>{t('设置', 'Settings')}</h2></div>
      </div>
    </section>

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
