import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export type SortDir = 'asc' | 'desc'

/** Sort state plus a cycle handler: clicking the active column flips direction,
 *  clicking a new column applies that column's default direction. */
export function useSortState<K extends string>(initialKey: K, defaultDir: (key: K) => SortDir) {
  const [sortKey, setSortKey] = useState<K>(initialKey)
  const [sortDir, setSortDir] = useState<SortDir>(defaultDir(initialKey))
  const cycleSort = (key: K): void => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir(defaultDir(key)) }
  }
  return { sortKey, sortDir, cycleSort }
}

/** Direction arrow on a sortable header: solid + accent when active (pointing the
 *  current way), a faint double-chevron when idle so every column reads as sortable. */
export function SortArrow({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) {
    return <svg className="sort-arrow idle" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
      <path d="M5 1.4 2.6 4 7.4 4Z" /><path d="M5 8.6 2.6 6 7.4 6Z" />
    </svg>
  }
  return <svg className={`sort-arrow ${dir}`} viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
    <path d={dir === 'asc' ? 'M5 1.4 2 6.4 8 6.4Z' : 'M5 8.6 2 3.6 8 3.6Z'} />
  </svg>
}

/** A sortable column header: label + arrow, click to cycle. `align="end"` right-aligns
 *  the label/arrow (for numeric columns). */
export function SortHeader({ active, dir, onClick, align = 'start', children }: {
  active: boolean
  dir: SortDir
  onClick: () => void
  align?: 'start' | 'end'
  children: ReactNode
}) {
  return (
    <button type="button"
      className={`sort-header${align === 'end' ? ' sort-header-num' : ''}`}
      onClick={onClick}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <span>{children}</span>
      <SortArrow active={active} dir={dir} />
    </button>
  )
}

export interface FunnelOption<V extends string> { value: V; label: string; count: number }

/** A funnel icon that toggles a small filter popover; filled while a non-default
 *  filter is applied. Manages its own open/closed state and outside-click backdrop. */
export function FunnelFilter<V extends string>({ ariaLabel, active, options, value, onChange }: {
  ariaLabel: string
  active: boolean
  options: FunnelOption<V>[]
  value: V
  onChange: (value: V) => void
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)

  // The popover is `position: fixed` so it isn't clipped by the table card's
  // `overflow: hidden` (which would otherwise cut it off on short, one-row lists).
  // We measure the funnel button each time the menu opens.
  useLayoutEffect(() => {
    if (!open) { setMenuPos(null); return }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const MENU_WIDTH = 156
    setMenuPos({ top: rect.bottom + 6, left: Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8) })
  }, [open])

  return (
    <span className="funnel-wrap">
      <button ref={buttonRef} className="funnel-button" type="button" aria-label={ariaLabel} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}>
        <FunnelIcon active={active} />
      </button>
      {open && menuPos && <>
        <div className="funnel-backdrop" onClick={() => setOpen(false)} />
        <div className="funnel-menu" role="menu" style={{ top: menuPos.top, left: menuPos.left }}>
          {options.map((opt) => (
            <button key={opt.value} type="button" role="menuitemradio" aria-checked={value === opt.value}
              className={`funnel-item ${value === opt.value ? 'selected' : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false) }}>
              <span>{opt.label}</span><span className="funnel-count">{opt.count}</span>
            </button>
          ))}
        </div>
      </>}
    </span>
  )
}

function FunnelIcon({ active }: { active: boolean }) {
  return <svg className={`funnel-icon ${active ? 'active' : ''}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 3.5h11l-4.2 5v4l-2.6 1.3v-5.3Z" fill={active ? 'currentColor' : 'none'} />
  </svg>
}