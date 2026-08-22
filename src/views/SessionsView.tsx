import { useEffect, useMemo, useState } from 'react'
import {
  type ScanSnapshot,
  type SessionItem,
  type CleanupSelection,
  type CleanupProgress,
  type SessionDeletionMode,
  type SessionSlimMode,
  SessionDeletionModeDetail,
  SessionLocationLabel,
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

function formatDate(ms: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function SessionsView({ snapshot, appServerAvailable, cleaning, actionsDisabled, cleanProgress, onCleanup }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scope, setScope] = useState<Scope>('all')
  const [sort, setSort] = useState<Sort>('total')
  const [query, setQuery] = useState('')
  const [retentionDays, setRetentionDays] = useState(180)
  const [deletionMode, setDeletionMode] = useState<SessionDeletionMode>('appServer')
  const [slimMode, setSlimMode] = useState<SessionSlimMode>('deduplicate')

  useEffect(() => {
    const current = new Set(snapshot.sessions.map((session) => session.id))
    setSelected((previous) => new Set([...previous].filter((id) => current.has(id))))
  }, [snapshot.scannedAt, snapshot.sessions])
  useEffect(() => { if (!appServerAvailable) setDeletionMode('trash') }, [appServerAvailable])

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const items = snapshot.sessions.filter((session) => {
      if (scope !== 'all' && session.location !== scope) return false
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
  }, [query, scope, snapshot.sessions, sort])

  const selectedSessions = useMemo(() => snapshot.sessions.filter((session) => selected.has(session.id)), [snapshot.sessions, selected])
  const selectedBytes = selectedSessions.reduce((sum, session) => sum + sessionTotalBytes(session), 0)
  const slimCandidates = selectedSessions.filter((session) => !session.isCompressed && !session.isUnstable &&
    (slimMode === 'deduplicate' ? session.duplicateImageBytes > 0 : session.embeddedImageBytes > 0))
  const slimBytes = slimCandidates.reduce((sum, session) => sum + (slimMode === 'deduplicate' ? session.duplicateImageBytes : session.embeddedImageBytes), 0)
  const expired = visible.filter((session) => !session.isUnstable && Date.now() - session.modifiedAt >= retentionDays * 86_400_000)
  const allVisibleSelected = visible.length > 0 && visible.every((session) => selected.has(session.id))

  const toggle = (id: string): void => setSelected((previous) => {
    const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next
  })

  return <>
    <section className="page-heading"><div><h2>会话记录</h2><p>归档只是隐藏，不释放空间；这里统一列出全部会话。</p></div>
      <button className="secondary" disabled={!expired.length} onClick={() => setSelected((previous) => new Set([...previous, ...expired.map((session) => session.id)]))}>选择 {retentionDays} 天前 · {expired.length} 项</button>
    </section>
    <section className="panel session-filters">
      <select value={scope} onChange={(event) => setScope(event.target.value as Scope)}><option value="all">全部 {snapshot.sessions.length}</option><option value="active">未归档 {snapshot.sessions.filter((session) => session.location === 'active').length}</option><option value="archived">已归档 {snapshot.sessions.filter((session) => session.location === 'archived').length}</option></select>
      <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}><option value="total">按总占用</option><option value="images">按内嵌图片</option><option value="date">按最后活动</option><option value="name">按名称</option><option value="slimmable">按可瘦身空间</option></select>
      <input className="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或项目"/>
      <label>早于 <input className="number" type="number" min="1" max="3650" value={retentionDays} onChange={(event) => setRetentionDays(Math.max(1, Number(event.target.value) || 1))}/> 天</label>
    </section>
    {snapshotEmbeddedNotice(snapshot)}
    <div className="table-head"><input type="checkbox" checked={allVisibleSelected} ref={(input) => { if (input) input.indeterminate = visible.some((session) => selected.has(session.id)) && !allVisibleSelected }} onChange={() => setSelected((previous) => { const next = new Set(previous); for (const session of visible) allVisibleSelected ? next.delete(session.id) : next.add(session.id); return next })}/><span>会话</span><span className="col-status">状态</span><span className="col-date">最后活动</span><span className="col-num">会话文件</span><span className="col-num">内嵌图片</span><span className="col-num">总占用</span><span/></div>
    <ul className="session-list">{visible.map((session) => <SessionRow key={session.id} session={session} checked={selected.has(session.id)} onToggle={() => toggle(session.id)}/>)}</ul>
    {!visible.length && <p className="empty-panel">没有符合筛选条件的会话</p>}
    {selectedSessions.length > 0 && <div className="action-bar session-actions"><span>已选 {selectedSessions.length} 个会话 · {formatBytes(selectedBytes)}</span><div className="action-options">
      <select value={slimMode} onChange={(event) => setSlimMode(event.target.value as SessionSlimMode)} title="瘦身方式"><option value="deduplicate">{SessionSlimModeLabel.deduplicate}</option><option value="stripAll">{SessionSlimModeLabel.stripAll}</option></select>
      <button className="secondary" disabled={cleaning || actionsDisabled || !slimCandidates.length} onClick={() => onCleanup({ kind: 'sessions-slim', ids: slimCandidates.map((session) => session.id), mode: slimMode })}>瘦身 · {formatBytes(slimBytes)}</button>
      <select value={deletionMode} disabled={!appServerAvailable} onChange={(event) => setDeletionMode(event.target.value as SessionDeletionMode)} title={SessionDeletionModeDetail[deletionMode]}><option value="appServer">通过 Codex 删除</option><option value="trash">直接移到废纸篓</option></select>
      <button className="clean danger" disabled={cleaning || actionsDisabled} onClick={() => onCleanup({ kind: 'sessions-delete', ids: selectedSessions.map((session) => session.id), mode: deletionMode })}>{cleaning ? `删除中… ${cleanProgress?.completed ?? 0}/${selectedSessions.length}` : '删除所选会话'}</button>
    </div></div>}
  </>
}

function SessionRow({ session, checked, onToggle }: { session: SessionItem; checked: boolean; onToggle: () => void }) {
  const duplicates = session.embeddedImageCount - session.distinctImageCount
  return <li className={`session-row ${session.isUnstable ? 'unstable' : ''}`}>
    <input type="checkbox" checked={checked} onChange={onToggle}/><div className="session-title"><span className="session-name">{sessionDisplayName(session)}</span>
      {session.tags.length > 0 && <span className="session-tags">{session.tags.map((tag) => <span key={tag} className="tag">{SessionTagLabel[tag]}</span>)}</span>}
      <span className="session-path">{sessionProjectName(session) ? `${sessionProjectName(session)} · ` : ''}{session.fileURL}{session.isUnstable ? ' · 正在写入' : ''}</span></div>
    <span className="col-status">{SessionLocationLabel[session.location]}</span><span className="col-date">{formatDate(session.modifiedAt)}</span><span className="col-num">{formatBytes(session.fileBytes)}</span>
    <span className="col-num">{session.embeddedImageCount ? <>{formatBytes(session.embeddedImageBytes)}{duplicates > 0 && <small> · 重复 {duplicates}</small>}</> : '—'}</span><span className="col-num">{formatBytes(sessionTotalBytes(session))}</span><button className="icon-button" title="在文件管理器中显示" onClick={() => window.cleanmycodex.revealPath(session.fileURL)}>⌕</button>
  </li>
}

function snapshotEmbeddedNotice(snapshot: ScanSnapshot) {
  const embedded = snapshot.sessions.reduce((sum, session) => sum + session.embeddedImageBytes, 0)
  const duplicate = snapshot.sessions.reduce((sum, session) => sum + session.duplicateImageBytes, 0)
  if (!embedded) return null
  return <p className="notice">会话内嵌图片共 {formatBytes(embedded)}{duplicate ? `，其中重复图片约 ${formatBytes(duplicate)}，可通过“会话瘦身”处理。` : '，没有发现重复图片。'}</p>
}
