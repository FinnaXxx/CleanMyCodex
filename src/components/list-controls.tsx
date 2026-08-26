import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CleanupProgress } from '../../shared/types'
import { usePreferences } from '../preferences'

export type SortDir = 'asc' | 'desc'

/** Selection behavior shared by ordinary resource lists: retain valid choices across
 *  rescans, preserve hidden choices across filters, and bulk-toggle only visible rows. */
export function useListSelection<T>({ items, getID, initialSelectedIDs }: {
  items: T[]
  getID: (item: T) => string
  initialSelectedIDs?: () => Iterable<string>
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelectedIDs?.()))

  useEffect(() => {
    const current = new Set(items.map(getID))
    setSelected((previous) => {
      const next = new Set([...previous].filter((id) => current.has(id)))
      return next.size === previous.size ? previous : next
    })
  }, [getID, items])

  const selectedItems = useMemo(() => items.filter((item) => selected.has(getID(item))), [getID, items, selected])
  const isSelected = (item: T): boolean => selected.has(getID(item))
  const allSelected = (candidates: T[]): boolean => candidates.length > 0 && candidates.every(isSelected)
  const someSelected = (candidates: T[]): boolean => candidates.some(isSelected)

  const toggle = (item: T): void => setSelected((previous) => {
    const next = new Set(previous)
    const id = getID(item)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const toggleAll = (candidates: T[]): void => setSelected((previous) => {
    const next = new Set(previous)
    const remove = candidates.length > 0 && candidates.every((item) => previous.has(getID(item)))
    for (const item of candidates) remove ? next.delete(getID(item)) : next.add(getID(item))
    return next
  })

  return { selected, selectedItems, isSelected, allSelected, someSelected, toggle, toggleAll }
}

/** Checkbox with the native mixed state used by every filterable resource table. */
export function SelectAllCheckbox({ allSelected, someSelected, ariaLabel, onToggle }: {
  allSelected: boolean
  someSelected: boolean
  ariaLabel: string
  onToggle: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = someSelected && !allSelected
  }, [allSelected, someSelected])
  return <input ref={inputRef} type="checkbox" aria-label={ariaLabel} checked={allSelected} onChange={onToggle} />
}

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

export interface DetailSummaryItem {
  label: ReactNode
  value: ReactNode
}

/** Shared overview card for resource detail pages. Pages supply their own useful
 *  status/type breakdown; selection state belongs in SelectionActionBar instead. */
export function DetailSummary({ items }: { items: DetailSummaryItem[] }) {
  return <section className="detail-summary card" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
    {items.map((item, index) => <div key={index}>
      <small>{item.label}</small>
      <strong>{item.value}</strong>
    </div>)}
  </section>
}

/** Presentational bottom bar that keeps selection feedback next to its action. */
export function SelectionActionBar({ summary, warning = false, children }: {
  summary: ReactNode
  warning?: boolean
  children: ReactNode
}) {
  return <div className="selection-action-bar" aria-live="polite">
    <span className={warning ? 'unsafe' : undefined}>{summary}</span>
    <div className="selection-actions">{children}</div>
  </div>
}

export function CleanupSelectionBar({ count, summary, warning = false, cleaning, actionsDisabled, progress, onDelete }: {
  count: number
  summary: ReactNode
  warning?: boolean
  cleaning: boolean
  actionsDisabled: boolean
  progress: CleanupProgress | null
  onDelete: () => void
}) {
  const { t } = usePreferences()
  if (count <= 0) return null
  return <SelectionActionBar summary={summary} warning={warning}>
    <button className="btn danger" disabled={cleaning || actionsDisabled} onClick={onDelete}>
      {cleaning
        ? t(`处理中… ${progress?.completed ?? 0}/${count}`, `Processing… ${progress?.completed ?? 0}/${count}`)
        : t('删除', 'Delete')}
    </button>
  </SelectionActionBar>
}

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
