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
  const { t, e, locale } = usePreferences()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scope, setScope] = useState<Scope>('all')
  const [sort, setSort] = useState<Sort>('total')
  const [query, setQuery] = useState('')
  /** Empty keeps every session; otherwise it is "last active more than N days ago". */
  const [olderThanDays, setOlderThanDays] = useState('')

  const [leftovers, setLeftovers] = useState<{ count: number; logPath: string } | null>(null)
  const [repairing, setRepairing] = useState(false)
  const [repairError, setRepairError] = useState<string | null>(null)

  useEffect(() => {
    const current = new Set(snapshot.sessions.map((session) => session.id))
    setSelected((previous) => new Set([...previous].filter((id) => current.has(id))))
  }, [snapshot.scannedAt, snapshot.sessions])

  // Leftover rows are metadata, not files, so they are looked up separately from the
  // scan — and again after every scan, because a deletion may have produced new ones.
  useEffect(() => {
    let cancelled = false
    window.cleanmycodex.sessionLeftovers()
      .then((result) => { if (!cancelled) setLeftovers(result) })
      .catch(() => { if (!cancelled) setLeftovers(null) })
    return () => { cancelled = true }
  }, [snapshot.scannedAt])

  const repairLeftovers = async (): Promise<void> => {
    setRepairing(true)
    setRepairError(null)
    try {
      await window.cleanmycodex.repairSessionLeftovers()
      setLeftovers(await window.cleanmycodex.sessionLeftovers())
    } catch (err) {
      setRepairError(e(err instanceof Error ? err.message : String(err)))
    } finally {
      setRepairing(false)
    }
  }

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
    {leftovers && leftovers.count > 0 && <div className="notice warning leftover-notice">
      <div>
        <strong>{t(`发现 ${leftovers.count} 条残留会话记录`, `${leftovers.count} leftover session records`)}</strong>
        <p>{t(
          '这些会话的文件和数据库记录都已经删除，但 ChatGPT/Codex 桌面端自己的会话列表里还留着条目：它们仍会出现在左侧边栏，点开时提示 “no rollout found for thread id”。清理需要先退出 ChatGPT/Codex；远端会话不在清理范围内。',
          'Their files and database records are gone, but the ChatGPT/Codex desktop still lists them: they keep appearing in the sidebar and fail to open with “no rollout found for thread id”. Quit ChatGPT/Codex before cleaning them up; remote conversations are never touched.'
        )}</p>
      </div>
      <div className="leftover-actions">
        <button className="btn" disabled={repairing || cleaning || actionsDisabled} onClick={() => void repairLeftovers()}>
          {repairing ? t('清理中…', 'Cleaning…') : t('清理残留记录', 'Clean Up Records')}
        </button>
        <button className="btn btn-quiet" onClick={() => void window.cleanmycodex.revealPath(leftovers.logPath)}>
          {t('查看清理日志', 'Show Cleanup Log')}
        </button>
      </div>
    </div>}
    {repairError && <p className="error">{repairError}</p>}
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
      {(session.isPinned || session.tags.length > 0) && <span className="session-tags">
        {session.isPinned && <span className="tag tag-pinned" title={t('置顶会话不会被定时清理，手动删除仍然可以', 'Pinned conversations are skipped by scheduled cleanup; deleting one by hand still works')}>{t('置顶', 'Pinned')}</span>}
        {session.tags.map((tag) => <span key={tag} className={`tag tag-${tag}`}>{SessionTagLabel[tag]}</span>)}
      </span>}
      <span className="session-path">{sessionProjectName(session) ? `${sessionProjectName(session)} · ` : ''}{session.fileURL}{session.isUnstable ? t(' · 正在写入', ' · Being written') : ''}</span>
    </div>
    <span className="col-status"><span className={`pill loc-${session.location}`}>{m(message(`location.${session.location}`))}</span></span>
    <span className="col-date" title={new Date(session.modifiedAt).toLocaleString(locale)}>{formatShortDate(session.modifiedAt, locale)}</span>
    <span className="col-num">{formatBytes(session.fileBytes)}</span>
    <span className="col-num">{formatBytes(sessionTotalBytes(session))}</span>
    <button className="icon-button" title={t('在文件管理器中显示', 'Show in file manager')} aria-label={t('在文件管理器中显示', 'Show in file manager')} onClick={() => window.cleanmycodex.revealPath(session.fileURL)}><FolderIcon /></button>
  </li>
}
