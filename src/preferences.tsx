import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'
export type LanguagePreference = 'zh-CN' | 'en'

interface PreferencesValue {
  theme: ThemePreference
  language: LanguagePreference
  locale: string
  setTheme: (theme: ThemePreference) => void
  setLanguage: (language: LanguagePreference) => void
  t: (chinese: string, english: string) => string
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
    localStorage.setItem(THEME_KEY, theme)
    if (theme === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    localStorage.setItem(LANGUAGE_KEY, language)
    document.documentElement.lang = language
  }, [language])

  const value = useMemo<PreferencesValue>(() => ({
    theme,
    language,
    locale: language === 'zh-CN' ? 'zh-CN' : 'en-US',
    setTheme,
    setLanguage,
    t: (chinese, english) => language === 'zh-CN' ? chinese : english
  }), [language, theme])

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>
}

export function usePreferences(): PreferencesValue {
  const value = useContext(PreferencesContext)
  if (!value) throw new Error('usePreferences must be used inside PreferencesProvider')
  return value
}
