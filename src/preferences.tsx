import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { formatErrorText, formatMessage, type Language, type Message } from '../shared/messages'

export type ThemePreference = 'light' | 'dark' | 'system'
export type LanguagePreference = Language

interface PreferencesValue {
  theme: ThemePreference
  language: LanguagePreference
  locale: string
  setTheme: (theme: ThemePreference) => void
  setLanguage: (language: LanguagePreference) => void
  /** Inline literals that only exist in the renderer. */
  t: (chinese: string, english: string) => string
  /** Anything the main process sent as a `Message`. */
  m: (value: Message) => string
  /** An `Error.message` that crossed IPC, resolved back to its `Message` when possible. */
  e: (text: string) => string
}

const THEME_KEY = 'cleanmycodex.theme'
const LANGUAGE_KEY = 'cleanmycodex.language'

function storedTheme(): ThemePreference {
  const value = localStorage.getItem(THEME_KEY)
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

function storedLanguage(): LanguagePreference {
  const value = localStorage.getItem(LANGUAGE_KEY)
  if (value === 'zh-CN' || value === 'en') return value
  return 'zh-CN'
}

const PreferencesContext = createContext<PreferencesValue | null>(null)

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemePreference>(storedTheme)
  const [language, setLanguage] = useState<LanguagePreference>(storedLanguage)

  useLayoutEffect(() => {
    document.documentElement.dataset.platform = window.cleanmycodex.platform
  }, [])

  useLayoutEffect(() => {
    localStorage.setItem(THEME_KEY, theme)
    if (theme === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.dataset.theme = theme

    // The window backdrop is painted natively, so it has to follow the same choice the
    // interface does, including while "follow the system" is switching underneath.
    const system = window.matchMedia('(prefers-color-scheme: dark)')
    const report = (): void => { void window.cleanmycodex.applyWindowTheme(theme === 'system' ? system.matches : theme === 'dark') }
    report()
    if (theme !== 'system') return
    system.addEventListener('change', report)
    return () => system.removeEventListener('change', report)
  }, [theme])

  useEffect(() => {
    localStorage.setItem(LANGUAGE_KEY, language)
    document.documentElement.lang = language
    // The scheduled cleanup runs without a window, so mirror the choice into the main
    // process for its log lines and completion notification.
    void window.cleanmycodex.saveLanguage(language)
  }, [language])

  const value = useMemo<PreferencesValue>(() => ({
    theme,
    language,
    locale: language === 'zh-CN' ? 'zh-CN' : 'en-US',
    setTheme,
    setLanguage,
    t: (chinese, english) => language === 'zh-CN' ? chinese : english,
    m: (item) => formatMessage(item, language),
    e: (text) => formatErrorText(text, language)
  }), [language, theme])

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>
}

export function usePreferences(): PreferencesValue {
  const value = useContext(PreferencesContext)
  if (!value) throw new Error('usePreferences must be used inside PreferencesProvider')
  return value
}
