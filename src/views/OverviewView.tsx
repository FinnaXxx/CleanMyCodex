import { useMemo, useState } from 'react'
import {
  type ScanSnapshot,
  type CleanupTask,
  type CleanupProgress,
  type StorageEntry,
  StorageGroupLabel,
  categoryBytes,
  categoryReclaimable,
  categoryIsEmpty,
  isSelectable,
  tasksFromEntries,
  formatBytes
} from '../../shared/types'

interface Props {
  snapshot: ScanSnapshot
  cleaning: boolean
  cleanProgress: CleanupProgress | null
  onCleanup: (tasks: CleanupTask[]) => void
}

export default function OverviewView({ snapshot, cleaning, cleanProgress, onCleanup }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const allEntries = useMemo<StorageEntry[]>(
    () => snapshot.categories.flatMap((c) => c.entries),
    [snapshot]
  )
  const selectedEntries = useMemo(
    () => allEntries.filter((e) => selected.has(e.id)),
    [allEntries, selected]
  )
  const selectedBytes = selectedEntries.reduce((sum, e) => sum + e.reclaimableBytes, 0)

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const groups: Array<keyof typeof StorageGroupLabel> = ['recommended', 'review', 'protectedData']

  return (
    <>
      <section className="total">
        <span className="total-label">Codex 总占用</span>
        <span className="total-value">{formatBytes(snapshot.totalCodexBytes)}</span>
      </section>

      {groups.map((group) => {
        const cats = snapshot.categories.filter((c) => c.group === group && !categoryIsEmpty(c))
        if (cats.length === 0) return null
        const meta = StorageGroupLabel[group]
        const selectableGroup = group !== 'protectedData'
        return (
          <section key={group} className="group">
            <h2>{meta.title}</h2>
            <p className="group-subtitle">{meta.subtitle}</p>
            {cats.map((c) => (
              <article key={c.kind} className="category">
                <div className="category-head">
                  <span className="category-title">{c.title}</span>
                  <span className="category-bytes">{formatBytes(categoryBytes(c))}</span>
                </div>
                <p className="category-detail">{c.detail}</p>
                {selectableGroup && <p className="category-reclaimable">可回收 {formatBytes(categoryReclaimable(c))}</p>}
                <ul className="entries">
                  {c.entries.map((e) => (
                    <EntryRow
                      key={e.id}
                      entry={e}
                      selectable={selectableGroup && isSelectable(e.risk)}
                      checked={selected.has(e.id)}
                      onToggle={() => toggle(e.id)}
                    />
                  ))}
                </ul>
              </article>
            ))}
          </section>
        )
      })}

      {snapshot.categories.length === 0 && <p className="empty">没有扫描到可清理的内容。</p>}

      {selectedEntries.length > 0 && (
        <div className="action-bar">
          <span>
            已选 {selectedEntries.length} 项 · 可回收 {formatBytes(selectedBytes)}
          </span>
          <button className="clean" onClick={() => onCleanup(tasksFromEntries(selectedEntries))} disabled={cleaning}>
            {cleaning ? `清理中… (${cleanProgress?.completed ?? 0}/${selectedEntries.length})` : '清理已选'}
          </button>
        </div>
      )}
    </>
  )
}

function EntryRow({
  entry,
  selectable,
  checked,
  onToggle
}: {
  entry: StorageEntry
  selectable: boolean
  checked: boolean
  onToggle: () => void
}) {
  return (
    <li className="entry">
      <label>
        <input type="checkbox" disabled={!selectable} checked={checked} onChange={onToggle} />
        <span className="entry-title">{entry.title}</span>
      </label>
      <span className="entry-bytes">{formatBytes(entry.reclaimableBytes)}</span>
    </li>
  )
}