import { useMemo, useState } from 'react'
import {
  type ScanSnapshot,
  type SessionItem,
  type CleanupTask,
  type CleanupProgress,
  SessionLocationLabel,
  SessionTagLabel,
  sessionDisplayName,
  sessionTotalBytes,
  sessionHasDuplicateImages,
  tasksForSessionDeletion,
  tasksForSessionSlimming,
  formatBytes
} from '../../shared/types'

interface Props {
  snapshot: ScanSnapshot
  cleaning: boolean
  cleanProgress: CleanupProgress | null
  onCleanup: (tasks: CleanupTask[]) => void
}

function formatDate(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function SessionsView({ snapshot, cleaning, cleanProgress, onCleanup }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const sessions = snapshot.sessions
  const selectedSessions = useMemo(() => sessions.filter((s) => selected.has(s.id)), [sessions, selected])
  const selectedBytes = selectedSessions.reduce((sum, s) => sum + sessionTotalBytes(s), 0)
  const slimmable = selectedSessions.filter((s) => !s.isCompressed && !s.isUnstable && s.duplicateImageBytes > 0)
  const strippable = selectedSessions.filter((s) => !s.isCompressed && !s.isUnstable && s.embeddedImageBytes > 0)

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const allSelected = sessions.length > 0 && selected.size === sessions.length
  const toggleAll = (): void => setSelected(allSelected ? new Set() : new Set(sessions.map((s) => s.id)))

  return (
    <>
      <div className="table-head">
        <input type="checkbox" checked={allSelected} onChange={toggleAll} />
        <span>会话</span>
        <span className="col-status">状态</span>
        <span className="col-date">最后活动</span>
        <span className="col-num">会话文件</span>
        <span className="col-num">内嵌图片</span>
        <span className="col-num">总占用</span>
      </div>

      <ul className="session-list">
        {sessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            checked={selected.has(s.id)}
            onToggle={() => toggle(s.id)}
          />
        ))}
      </ul>

      {selectedSessions.length > 0 && (
        <div className="action-bar">
          <span>
            已选 {selectedSessions.length} 个会话 · {formatBytes(selectedBytes)}
          </span>
          <div className="action-buttons">
          <button className="secondary" onClick={() => window.confirm('去重会改写 rollout；每个原文件会保留在废纸篓。继续吗？') && onCleanup(tasksForSessionSlimming(slimmable, 'deduplicate'))} disabled={cleaning || !slimmable.length} title="保留每张图片第一次出现的位置，只替换后续重复副本">
            去重图片 · {formatBytes(slimmable.reduce((sum, s) => sum + s.duplicateImageBytes, 0))}
          </button>
          <button className="secondary warning-button" onClick={() => window.confirm('将剥离所选会话中的全部内嵌图片。原 rollout 会保留在废纸篓，继续吗？') && onCleanup(tasksForSessionSlimming(strippable, 'stripAll'))} disabled={cleaning || !strippable.length} title="把所有内嵌图片替换为 1×1 透明占位图">
            剥离全部图片
          </button>
          <button
            className="clean danger"
            onClick={() => window.confirm(`确认删除 ${selectedSessions.length} 个会话？关联资产也会移到废纸篓。`) && onCleanup(tasksForSessionDeletion(selectedSessions))}
            disabled={cleaning}
          >
            {cleaning ? `删除中… (${cleanProgress?.completed ?? 0}/${selectedSessions.length})` : '删除所选会话'}
          </button>
          </div>
        </div>
      )}
    </>
  )
}

function SessionRow({
  session,
  checked,
  onToggle
}: {
  session: SessionItem
  checked: boolean
  onToggle: () => void
}) {
  return (
    <li className="session-row">
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <div className="session-title">
        <span className="session-name">{sessionDisplayName(session)}</span>
        {session.tags.length > 0 && (
          <span className="session-tags">
            {session.tags.map((t) => (
              <span key={t} className="tag">{SessionTagLabel[t]}</span>
            ))}
          </span>
        )}
        <span className="session-path">{session.fileURL}</span>
      </div>
      <span className="col-status">{SessionLocationLabel[session.location]}</span>
      <span className="col-date">{formatDate(session.modifiedAt)}</span>
      <span className="col-num">{formatBytes(session.fileBytes)}</span>
      <span className="col-num">
        {session.embeddedImageCount > 0
          ? `${formatBytes(session.embeddedImageBytes)}${sessionHasDuplicateImages(session) ? ' ⚠' : ''}`
          : '—'}
      </span>
      <span className="col-num">{formatBytes(sessionTotalBytes(session))}</span>
    </li>
  )
}
