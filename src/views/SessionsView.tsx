import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type ScanSnapshot,
  type SessionItem,
  type CleanupSelection,
  type CleanupProgress,
  type SessionSlimMode,
  SessionLocationLabel,
  SessionSlimModeDetail,
  SessionSlimModeLabel,
  SessionTagLabel,
  sessionDisplayName,
  sessionProjectName,
  sessionTotalBytes,
  formatBytes
} from '../../shared/types'

interface Props {
  snapshot: ScanSnapshot
  appServerAvailable: boolean
  cleaning: boolean
  actionsDisabled: boolean
  cleanProgress: CleanupProgress | null
  onCleanup: (selection: CleanupSelection) => void
}

type Scope = 'all' | 'active' | 'archived'
type Sort = 'total' | 'images' | 'date' | 'name' | 'slimmable'

/** Filter by last activity: 0 keeps everything, otherwise "older than N days". */
const AgeFilters: Array<{ days: number; label: string }> = [
  { days: 0, label: '不限时间' },
  { days: 7, label: '7 天前' },
  { days: 30, label: '30 天前' },
  { days: 90, label: '90 天前' },
  { days: 180, label: '180 天前' },
  { days: 365, label: '1 年前' }
]

/** Compact enough for one line: this year keeps the time, older entries keep the year. */
function formatDate(ms: number): string {
  if (!ms) return '—'
  const date = new Date(ms)
  return date.getFullYear() === new Date().getFullYear()
    ? date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export default function SessionsView({ snapshot, appServerAvailable, cleaning, actionsDisabled, cleanProgress, onCleanup }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scope, setScope] = useState<Scope>('all')
  const [sort, setSort] = useState<Sort>('total')
  const [query, setQuery] = useState('')
  const [olderThanDays, setOlderThanDays] = useState(0)
  const [confirmStripAll, setConfirmStripAll] = useState(false)

  useEffect(() => {
    const current = new Set(snapshot.sessions.map((session) => session.id))
    setSelected((previous) => new Set([...previous].filter((id) => current.has(id))))
  }, [snapshot.scannedAt, snapshot.sessions])

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const cutoff = olderThanDays ? Date.now() - olderThanDays * 86_400_000 : null
    const items = snapshot.sessions.filter((session) => {
      if (scope !== 'all' && session.location !== scope) return false
      if (cutoff !== null && session.modifiedAt > cutoff) return false
      if (!needle) return true
      return [sessionDisplayName(session), sessionProjectName(session), session.workingDirectory, session.threadID]
        .filter(Boolean).join(' ').toLocaleLowerCase().includes(needle)
    })
    return items.sort((a, b) => {
      if (sort === 'images') return b.embeddedImageBytes - a.embeddedImageBytes
      if (sort === 'date') return b.modifiedAt - a.modifiedAt
      if (sort === 'name') return sessionDisplayName(a).localeCompare(sessionDisplayName(b))
      if (sort === 'slimmable') return b.duplicateImageBytes - a.duplicateImageBytes
      return sessionTotalBytes(b) - sessionTotalBytes(a)
    })
  }, [olderThanDays, query, scope, snapshot.sessions, sort])

  const selectedSessions = useMemo(() => snapshot.sessions.filter((session) => selected.has(session.id)), [snapshot.sessions, selected])
  const selectedBytes = selectedSessions.reduce((sum, session) => sum + sessionTotalBytes(session), 0)
  const allVisibleSelected = visible.length > 0 && visible.every((session) => selected.has(session.id))

  const slimTargets = (mode: SessionSlimMode): SessionItem[] => selectedSessions.filter((session) =>
    !session.isCompressed && !session.isUnstable &&
    (mode === 'deduplicate' ? session.duplicateImageBytes > 0 : session.embeddedImageBytes > 0))
  const slimBytes = (mode: SessionSlimMode): number => slimTargets(mode)
    .reduce((sum, session) => sum + (mode === 'deduplicate' ? session.duplicateImageBytes : session.embeddedImageBytes), 0)

  const toggle = (id: string): void => setSelected((previous) => {
    const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next
  })

  const runSlim = (mode: SessionSlimMode): void =>
    onCleanup({ kind: 'sessions-slim', ids: slimTargets(mode).map((session) => session.id), mode })

  useEffect(() => {
    if (!confirmStripAll) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setConfirmStripAll(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [confirmStripAll])

  return <>
    <section className="page-heading">
      <div><h2>会话记录</h2></div>
    </section>

    <section className="filters">
      <select value={scope} onChange={(event) => setScope(event.target.value as Scope)}>
        <option value="all">全部 {snapshot.sessions.length}</option>
        <option value="active">未归档 {snapshot.sessions.filter((session) => session.location === 'active').length}</option>
        <option value="archived">已归档 {snapshot.sessions.filter((session) => session.location === 'archived').length}</option>
      </select>
      <select value={olderThanDays} onChange={(event) => setOlderThanDays(Number(event.target.value))} aria-label="最后活动时间">
        {AgeFilters.map((option) => <option key={option.days} value={option.days}>{option.days ? `最后活动早于 ${option.label}` : option.label}</option>)}
      </select>
      <select value={sort} onChange={(event) => setSort(event.target.value as Sort)} aria-label="排序方式">
        <option value="total">按总占用</option><option value="images">按内嵌图片</option><option value="date">按最后活动</option>
        <option value="name">按名称</option><option value="slimmable">按重复图片</option>
      </select>
      <input className="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或项目" />
    </section>

    {snapshotEmbeddedNotice(snapshot)}

    <div className="card session-table">
      <div className="table-head">
        <input type="checkbox" aria-label="全选" checked={allVisibleSelected}
          ref={(input) => { if (input) input.indeterminate = visible.some((session) => selected.has(session.id)) && !allVisibleSelected }}
          onChange={() => setSelected((previous) => {
            const next = new Set(previous)
            for (const session of visible) allVisibleSelected ? next.delete(session.id) : next.add(session.id)
            return next
          })} />
        <span>会话</span><span className="col-status">状态</span><span className="col-date">最后活动</span>
        <span className="col-num">会话文件</span><span className="col-num">内嵌图片</span><span className="col-num">总占用</span><span />
      </div>
      <ul className="session-list">
        {visible.map((session) => <SessionRow key={session.id} session={session} checked={selected.has(session.id)} onToggle={() => toggle(session.id)} />)}
      </ul>
      {!visible.length && <p className="empty-inline">没有符合筛选条件的会话</p>}
    </div>

    {selectedSessions.length > 0 && <div className="action-bar">
      <span>已选 {selectedSessions.length} 个会话 · {formatBytes(selectedBytes)}</span>
      <div className="action-buttons">
        <ImageCleanupMenu disabled={cleaning || actionsDisabled} bytesFor={slimBytes} countFor={(mode) => slimTargets(mode).length}
          onPick={(mode) => mode === 'stripAll' ? setConfirmStripAll(true) : runSlim('deduplicate')} />
        <button className="btn danger" disabled={cleaning || actionsDisabled}
          onClick={() => onCleanup({ kind: 'sessions-delete', ids: selectedSessions.map((session) => session.id), mode: appServerAvailable ? 'appServer' : 'trash' })}>
          {cleaning ? `删除中… ${cleanProgress?.completed ?? 0}/${selectedSessions.length}` : '删除所选会话'}
        </button>
      </div>
    </div>}

    {confirmStripAll && <div className="modal-backdrop" onMouseDown={() => setConfirmStripAll(false)}>
      <section className="cleanup-dialog confirm-dialog" role="alertdialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <h2>清理所有图片</h2>
        <p className="dialog-lead">
          将从 {slimTargets('stripAll').length} 个会话里删除全部图片，可回收 {formatBytes(slimBytes('stripAll'))}。
        </p>
        <p className="notice warning">图片删除后无法恢复，会话的文字记录保持不变。</p>
        <div className="dialog-actions">
          <button className="btn" onClick={() => setConfirmStripAll(false)}>取消</button>
          <button className="btn danger" onClick={() => { setConfirmStripAll(false); runSlim('stripAll') }}>确认删除</button>
        </div>
      </section>
    </div>}
  </>
}

/** Two strengths of the same action, so the button owns the choice instead of a stray dropdown. */
function ImageCleanupMenu({ disabled, bytesFor, countFor, onPick }: {
  disabled: boolean
  bytesFor: (mode: SessionSlimMode) => number
  countFor: (mode: SessionSlimMode) => number
  onPick: (mode: SessionSlimMode) => void
}) {
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const modes: SessionSlimMode[] = ['deduplicate', 'stripAll']
  const available = modes.some((mode) => countFor(mode) > 0)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!container.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  return <div className="menu-anchor" ref={container}>
    <button className="btn" disabled={disabled || !available} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      清理图片 <span className="chevron">⌄</span>
    </button>
    {open && <div className="menu" role="menu">
      {modes.map((mode) => {
        const count = countFor(mode)
        return <button key={mode} className={`menu-item${mode === 'stripAll' ? ' menu-item-caution' : ''}`} role="menuitem" disabled={!count}
          onClick={() => { setOpen(false); onPick(mode) }}>
          <span className="menu-item-title">{SessionSlimModeLabel[mode]}<b>{count ? `可回收 ${formatBytes(bytesFor(mode))}` : '无可处理项'}</b></span>
          <span className="menu-item-detail">{count ? `${count} 个会话 · ` : ''}{SessionSlimModeDetail[mode]}</span>
        </button>
      })}
    </div>}
  </div>
}

function SessionRow({ session, checked, onToggle }: { session: SessionItem; checked: boolean; onToggle: () => void }) {
  const duplicates = session.embeddedImageCount - session.distinctImageCount
  return <li className={`session-row ${session.isUnstable ? 'unstable' : ''}`}>
    <input type="checkbox" aria-label={sessionDisplayName(session)} checked={checked} onChange={onToggle} />
    <div className="session-title">
      <span className="session-name">{sessionDisplayName(session)}</span>
      {session.tags.length > 0 && <span className="session-tags">{session.tags.map((tag) => <span key={tag} className={`tag tag-${tag}`}>{SessionTagLabel[tag]}</span>)}</span>}
      <span className="session-path">{sessionProjectName(session) ? `${sessionProjectName(session)} · ` : ''}{session.fileURL}{session.isUnstable ? ' · 正在写入' : ''}</span>
    </div>
    <span className="col-status"><span className={`pill loc-${session.location}`}>{SessionLocationLabel[session.location]}</span></span>
    <span className="col-date" title={new Date(session.modifiedAt).toLocaleString()}>{formatDate(session.modifiedAt)}</span>
    <span className="col-num">{formatBytes(session.fileBytes)}</span>
    <span className="col-num">{session.embeddedImageCount ? <>{formatBytes(session.embeddedImageBytes)}{duplicates > 0 && <small> · 重复 {duplicates}</small>}</> : '—'}</span>
    <span className="col-num">{formatBytes(sessionTotalBytes(session))}</span>
    <button className="icon-button" title="在文件管理器中显示" onClick={() => window.cleanmycodex.revealPath(session.fileURL)}>⌕</button>
  </li>
}

function snapshotEmbeddedNotice(snapshot: ScanSnapshot) {
  const embedded = snapshot.sessions.reduce((sum, session) => sum + session.embeddedImageBytes, 0)
  const duplicate = snapshot.sessions.reduce((sum, session) => sum + session.duplicateImageBytes, 0)
  if (!embedded) return null
  return <p className="notice">会话内嵌图片共 {formatBytes(embedded)}{duplicate ? `，其中重复图片约 ${formatBytes(duplicate)}` : '，没有重复图片'}。</p>
}
