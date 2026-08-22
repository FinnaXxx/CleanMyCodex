/** Compact enough for one line: this year keeps the time, older entries keep the year. */
export function formatShortDate(ms: number, locale: string): string {
  if (!ms) return '—'
  const date = new Date(ms)
  return date.getFullYear() === new Date().getFullYear()
    ? date.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' })
}
