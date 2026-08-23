import { useEffect, useMemo, useState } from 'react'
import {
  type ScanSnapshot,
  type SessionItem,
  type CleanupSelection,
  type CleanupProgress,
  SessionTagLabel,
  sessionDisplayName,
  sessionProjectName,
  sessionTotalBytes,
  listableSessions,
  formatBytes
} from '../../shared/types'
import { message } from '../../shared/messages'
import { FolderIcon } from '../icons'
import { formatShortDate } from '../format'
import { usePreferences } from '../preferences'

interface Props {
  snapshot: ScanSnapshot
  cleaning: boolean
  actionsDisabled: boolean
  cleanProgress: CleanupProgress | null
  onCleanup: (selection: CleanupSelection) => void
}

type Scope = 'all' | 'active' | 'archived'
type Sort = 'total' | 'date' | 'name'

export default function SessionsView({ snapshot, cleaning, actionsDisabled, cleanProgress, onCleanup }: Props) {
  const { t, locale } = usePreferences()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scope, setScope] = useState<Scope>('all')
  const [sort, setSort] = useState<Sort>('total')
  const [query, setQuery] = useState('')
  /** Empty keeps every session; otherwise it is "last active more than N days ago". */
  const [olderThanDays, setOlderThanDays] = useState('')

  useEffect(() => {
    const current = new Set(snapshot.sessions.map((session) => session.id))
    setSelected((previous) => new Set([...previous].filter((id) => current.has(id))))
  }, [snapshot.scannedAt, snapshot.sessions])

  const listable = useMemo(() => listableSessions(snapshot), [snapshot])

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const days = Number(olderThanDays)
    const cutoff = days > 0 ? Date.now() - days * 86_400_000 : null
    const items = listable.filter((session) => {
      if (scope !== 'all' && session.location !== scope) return false
      if (cutoff !== null && session.modifiedAt > cutoff) return false
      if (!needle) return true
      return [sessionDisplayName(session), sessionProjectName(session), session.workingDirectory, session.threadID]
        .filter(Boolean).join(' ').toLocaleLowerCase().includes(needle)
    })
    return items.sort((a, b) => {
      if (sort === 'date') return b.modifiedAt - a.modifiedAt
      if (sort === 'name') return sessionDisplayName(a).localeCompare(sessionDisplayName(b))
      return sessionTotalBytes(b) - sessionTotalBytes(a)
    })
  }, [olderThanDays, query, scope, listable, sort])

  const selectedSessions = useMemo(() => snapshot.sessions.filter((session) => selected.has(session.id)), [snapshot.sessions, selected])
  const selectedBytes = selectedSessions.reduce((sum, session) => sum + sessionTotalBytes(session), 0)
  const allVisibleSelected = visible.length > 0 && visible.every((session) => selected.has(session.id))

  const toggle = (id: string): void => setSelected((previous) => {
    const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next
  })

  return <>
    <div className="detail-content">
    <section className="filters">
      <select value={scope} onChange={(event) => setScope(event.target.value as Scope)}>
        <option value="all">{t('全部', 'All')} {listable.length}</option>
        <option value="active">{t('未归档', 'Active')} {listable.filter((session) => session.location === 'active').length}</option>
        <option value="archived">{t('已归档', 'Archived')} {listable.filter((session) => session.location === 'archived').length}</option>
      </select>
      <label className="filter-days">
        <input className="number" type="number" min="0" max="3650" placeholder={t('不限', 'Any')} value={olderThanDays}
          onChange={(event) => setOlderThanDays(event.target.value.replace(/[^0-9]/g, ''))} />
        {t('天前', 'days ago')}
      </label>
      <select value={sort} onChange={(event) => setSort(event.target.value as Sort)} aria-label={t('排序方式', 'Sort by')}>
        <option value="total">{t('按总占用', 'Total size')}</option><option value="date">{t('按最后活动', 'Last active')}</option>
        <option value="name">{t('按名称', 'Name')}</option>
      </select>
      <input className="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索标题或项目', 'Search title or project')} />
    </section>

    <div className="card session-table">
      <div className="table-head">
        <input type="checkbox" aria-label={t('全选', 'Select all')} checked={allVisibleSelected}
          ref={(input) => { if (input) input.indeterminate = visible.some((session) => selected.has(session.id)) && !allVisibleSelected }}
          onChange={() => setSelected((previous) => {
            const next = new Set(previous)
            for (const session of visible) allVisibleSelected ? next.delete(session.id) : next.add(session.id)
            return next
          })} />
        <span>{t('会话', 'Session')}</span><span className="col-status">{t('状态', 'Status')}</span><span className="col-date">{t('最后活动', 'Last active')}</span>
        <span className="col-num">{t('会话文件', 'Session file')}</span><span className="col-num">{t('总占用', 'Total')}</span><span />
      </div>
      <ul className="session-list">
        {visible.map((session) => <SessionRow key={session.id} session={session} checked={selected.has(session.id)} onToggle={() => toggle(session.id)} locale={locale} />)}
      </ul>
      {!visible.length && <p className="empty-inline">{t('没有符合筛选条件的会话', 'No sessions match these filters')}</p>}
    </div>
    </div>

    {selectedSessions.length > 0 && <div className="action-bar">
      <span>{t(`已选 ${selectedSessions.length} 个会话`, `${selectedSessions.length} sessions selected`)} · {formatBytes(selectedBytes)}</span>
      <div className="action-buttons">
        <button className="btn danger" disabled={cleaning || actionsDisabled}
          onClick={() => onCleanup({ kind: 'sessions-delete', ids: selectedSessions.map((session) => session.id) })}>
          {cleaning ? t(`删除中… ${cleanProgress?.completed ?? 0}/${selectedSessions.length}`, `Deleting… ${cleanProgress?.completed ?? 0}/${selectedSessions.length}`) : t('删除所选会话', 'Delete Selected Sessions')}
        </button>
      </div>
    </div>}

  </>
}

function SessionRow({ session, checked, locale, onToggle }: { session: SessionItem; checked: boolean; locale: string; onToggle: () => void }) {
  const { t, m } = usePreferences()
  return <li className={`session-row ${session.isUnstable ? 'unstable' : ''}`}>
    <input type="checkbox" aria-label={sessionDisplayName(session)} checked={checked} onChange={onToggle} />
    <div className="session-title">
      <span className="session-name">{sessionDisplayName(session)}</span>
      {session.tags.length > 0 && <span className="session-tags">{session.tags.map((tag) => <span key={tag} className={`tag tag-${tag}`}>{SessionTagLabel[tag]}</span>)}</span>}
      <span className="session-path">{sessionProjectName(session) ? `${sessionProjectName(session)} · ` : ''}{session.fileURL}{session.isUnstable ? t(' · 正在写入', ' · Being written') : ''}</span>
    </div>
    <span className="col-status"><span className={`pill loc-${session.location}`}>{m(message(`location.${session.location}`))}</span></span>
    <span className="col-date" title={new Date(session.modifiedAt).toLocaleString(locale)}>{formatShortDate(session.modifiedAt, locale)}</span>
    <span className="col-num">{formatBytes(session.fileBytes)}</span>
    <span className="col-num">{formatBytes(sessionTotalBytes(session))}</span>
    <button className="icon-button" title={t('在文件管理器中显示', 'Show in file manager')} aria-label={t('在文件管理器中显示', 'Show in file manager')} onClick={() => window.cleanmycodex.revealPath(session.fileURL)}><FolderIcon /></button>
  </li>
}
