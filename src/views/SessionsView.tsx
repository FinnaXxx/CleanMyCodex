import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import {
  type ScanSnapshot,
  type SessionItem,
  type CleanupSelection,
  type CleanupProgress,
  type SessionTranscript,
  SessionTagLabel,
  sessionDisplayName,
  sessionProjectName,
  sessionTotalBytes,
  sessionMatchesSuggestedArchivePreset,
  SUGGESTED_ARCHIVED_SESSION_AGE_DAYS,
  listableSessions,
  formatBytes
} from '../../shared/types'
import { message } from '../../shared/messages'
import { FolderIcon, PreviewIcon } from '../icons'
import { formatShortDate } from '../format'
import { usePreferences } from '../preferences'
import { CleanupSelectionBar, DetailSummary, FunnelFilter, SelectAllCheckbox, SortHeader, useListSelection, useSortState, type SortDir } from '../components/list-controls'

interface Props {
  snapshot: ScanSnapshot
  cleaning: boolean
  actionsDisabled: boolean
  cleanProgress: CleanupProgress | null
  onCleanup: (selection: CleanupSelection) => void
  initialSelection: SessionInitialSelection
}

type Scope = 'all' | 'active' | 'archived'
type SortKey = 'total' | 'date' | 'name'
export type SessionInitialSelection = 'none' | 'suggested-archives'

const defaultSortDir = (key: SortKey): SortDir => (key === 'name' ? 'asc' : 'desc')
const sessionID = (session: SessionItem): string => session.id

export default function SessionsView({ snapshot, cleaning, actionsDisabled, cleanProgress, onCleanup, initialSelection }: Props) {
  const { t, e, locale } = usePreferences()
  const listable = useMemo(() => listableSessions(snapshot), [snapshot])
  const selection = useListSelection({
    items: listable,
    getID: sessionID,
    initialSelectedIDs: () => {
      if (initialSelection !== 'suggested-archives') return []
      const now = Date.now()
      return listable.filter((session) => sessionMatchesSuggestedArchivePreset(session, now)).map(sessionID)
    }
  })
  const [scope, setScope] = useState<Scope>(initialSelection === 'suggested-archives' ? 'archived' : 'all')
  const { sortKey, sortDir, cycleSort } = useSortState<SortKey>('total', defaultSortDir)
  const [query, setQuery] = useState('')
  /** Empty keeps every session; otherwise it is "last active more than N days ago". */
  const [olderThanDays, setOlderThanDays] = useState(initialSelection === 'suggested-archives'
    ? String(SUGGESTED_ARCHIVED_SESSION_AGE_DAYS)
    : '')

  const [leftovers, setLeftovers] = useState<{ count: number; logPath: string } | null>(null)
  const [repairing, setRepairing] = useState(false)
  const [repairError, setRepairError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState<SessionItem | null>(null)

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
      let cmp: number
      if (sortKey === 'date') cmp = a.modifiedAt - b.modifiedAt
      else if (sortKey === 'name') cmp = sessionDisplayName(a).localeCompare(sessionDisplayName(b))
      else cmp = sessionTotalBytes(a) - sessionTotalBytes(b)
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [olderThanDays, query, scope, listable, sortKey, sortDir])

  const selectedSessions = selection.selectedItems
  const selectedBytes = selectedSessions.reduce((sum, session) => sum + sessionTotalBytes(session), 0)
  const allVisibleSelected = selection.allSelected(visible)
  const totalBytes = listable.reduce((sum, session) => sum + sessionTotalBytes(session), 0)

  const scopeOptions: { value: Scope; label: string; count: number }[] = [
    { value: 'all', label: t('全部', 'All'), count: listable.length },
    { value: 'active', label: t('未归档', 'Active'), count: listable.filter((session) => session.location === 'active').length },
    { value: 'archived', label: t('已归档', 'Archived'), count: listable.filter((session) => session.location === 'archived').length },
  ]

  return <>
    <div className="detail-content">
    <DetailSummary items={[
      { label: t('总占用', 'Total'), value: formatBytes(totalBytes) },
      ...scopeOptions.slice(1).map((option) => ({ label: option.label, value: option.count })),
    ]} />
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
      <label className="filter-days">
        <input className="number" type="number" min="0" max="3650" placeholder={t('不限', 'Any')} value={olderThanDays}
          onChange={(event) => setOlderThanDays(event.target.value.replace(/[^0-9]/g, ''))} />
        {t('天前', 'days ago')}
      </label>
      <input className="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索标题或项目', 'Search title or project')} />
    </section>

    <div className="card session-table">
      <div className="table-head">
        <SelectAllCheckbox ariaLabel={t('全选', 'Select all')} allSelected={allVisibleSelected}
          someSelected={selection.someSelected(visible)} onToggle={() => selection.toggleAll(visible)} />
        <span className="col-sortable">
          <SortHeader active={sortKey === 'name'} dir={sortDir} onClick={() => cycleSort('name')}>
            {t('会话', 'Session')}
          </SortHeader>
        </span>
        <span className="col-status">
          <span className="status-head">
            {t('状态', 'Status')}
            <FunnelFilter ariaLabel={t('筛选状态', 'Filter status')} active={scope !== 'all'}
              options={scopeOptions} value={scope} onChange={setScope} />
          </span>
        </span>
        <span className="col-date col-sortable">
          <SortHeader active={sortKey === 'date'} dir={sortDir} onClick={() => cycleSort('date')}>
            {t('最后修改', 'Last modified')}
          </SortHeader>
        </span>
        <span className="col-num">{t('会话文件', 'Session file')}</span>
        <span className="col-num">
          <SortHeader align="end" active={sortKey === 'total'} dir={sortDir} onClick={() => cycleSort('total')}>
            {t('总占用', 'Total')}
          </SortHeader>
        </span>
        <span />
      </div>
      <ul className="session-list">
        {visible.map((session) => <SessionRow key={session.id} session={session} checked={selection.isSelected(session)} active={previewing?.id === session.id}
          onToggle={() => selection.toggle(session)} onPreview={() => setPreviewing(session)} locale={locale} />)}
      </ul>
      {!visible.length && <p className="empty-inline">{listable.length
        ? t('没有符合筛选条件的会话', 'No sessions match these filters')
        : t('没有扫描到本地会话', 'No local conversations found')}</p>}
    </div>
    </div>

    <CleanupSelectionBar count={selectedSessions.length}
      summary={<>{t(`已选 ${selectedSessions.length} 项会话记录`, `${selectedSessions.length} sessions selected`)} · {formatBytes(selectedBytes)}</>}
      cleaning={cleaning} actionsDisabled={actionsDisabled} progress={cleanProgress}
      onDelete={() => onCleanup({ kind: 'sessions-delete', ids: selectedSessions.map(sessionID) })} />

    {previewing && <TranscriptDialog session={previewing} locale={locale} onClose={() => setPreviewing(null)}
      checked={selection.isSelected(previewing)} onToggle={() => selection.toggle(previewing)}
      position={visible.indexOf(previewing)} count={visible.length}
      onNavigate={(step) => {
        const next = visible[visible.indexOf(previewing) + step]
        if (next) setPreviewing(next)
      }} />}
  </>
}

/** Clicks and keys that land on the row's own controls must not also open the preview. */
const fromControl = (event: ReactMouseEvent | ReactKeyboardEvent): boolean =>
  event.target instanceof Element && event.target.closest('input, button, label') !== null

function SessionRow({ session, checked, active, locale, onToggle, onPreview }: {
  session: SessionItem; checked: boolean; active: boolean; locale: string; onToggle: () => void; onPreview: () => void
}) {
  const { t, m } = usePreferences()
  // Clicking a row opens its conversation; only the checkbox selects, so browsing a
  // deletion list can never quietly add a conversation to what gets deleted.
  return <li className={`session-row clickable ${session.isUnstable ? 'unstable' : ''} ${checked ? 'selected' : ''} ${active ? 'active' : ''}`}
    tabIndex={0} title={t('点击查看聊天内容', 'Click to view the conversation')}
    onClick={(event) => { if (!fromControl(event)) onPreview() }}
    onKeyDown={(event) => {
      if (fromControl(event) || (event.key !== 'Enter' && event.key !== ' ')) return
      event.preventDefault()
      onPreview()
    }}>
    <label className="row-check" onClick={(event) => event.stopPropagation()}>
      <input type="checkbox" aria-label={sessionDisplayName(session)} checked={checked} onChange={onToggle} />
    </label>
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
    <span className="row-actions">
      <button className="icon-button" title={t('查看聊天内容', 'View conversation')} aria-label={t('查看聊天内容', 'View conversation')} onClick={onPreview}><PreviewIcon /></button>
      <button className="icon-button" title={t('在文件管理器中显示', 'Show in file manager')} aria-label={t('在文件管理器中显示', 'Show in file manager')} onClick={() => window.cleanmycodex.revealPath(session.fileURL)}><FolderIcon /></button>
    </span>
  </li>
}

/** Read-only look at a conversation's messages, so it can be recognised before it is deleted. */
function TranscriptDialog({ session, locale, onClose, checked, onToggle, position, count, onNavigate }: {
  session: SessionItem; locale: string; onClose: () => void
  checked: boolean; onToggle: () => void
  /** Index within the filtered list, or -1 once filters hide the conversation. */
  position: number; count: number; onNavigate: (step: -1 | 1) => void
}) {
  const { t, e } = usePreferences()
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoomed, setZoomed] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setTranscript(null)
    setError(null)
    window.cleanmycodex.sessionTranscript(session.id)
      .then((result) => { if (!cancelled) setTranscript(result) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [session.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Captured first and stopped, so the app's own Escape (back to the overview) waits for the next press.
        event.stopImmediatePropagation()
        if (zoomed) setZoomed(null)
        else onClose()
      } else if (!zoomed && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        if (event.target instanceof HTMLInputElement && event.target.type !== 'checkbox') return
        event.preventDefault()
        onNavigate(event.key === 'ArrowLeft' ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, onNavigate, zoomed])

  const notes: string[] = []
  if (transcript?.toolCalls) notes.push(t(`另有 ${transcript.toolCalls} 次工具调用未显示`, `${transcript.toolCalls} tool calls not shown`))
  if (transcript?.truncated) notes.push(t(`只显示前 ${transcript.messages.length} 条消息`, `Showing the first ${transcript.messages.length} messages`))
  if (transcript?.unreadableSegments) notes.push(t(`${transcript.unreadableSegments} 个会话文件无法读取`, `${transcript.unreadableSegments} session files could not be read`))
  if (session.childThreadCount) notes.push(t(`${session.childThreadCount} 个子代理会话未显示`, `${session.childThreadCount} subagent conversations not shown`))

  return <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="cleanup-dialog transcript-dialog" role="dialog" aria-modal="true" aria-labelledby="transcript-title">
      <header className="transcript-header">
        <h2 id="transcript-title">{sessionDisplayName(session)}</h2>
        <p className="dialog-lead">{[sessionProjectName(session), new Date(session.modifiedAt).toLocaleString(locale), formatBytes(sessionTotalBytes(session))].filter(Boolean).join(' · ')}</p>
      </header>
      <div className="transcript-body">
        {error && <p className="error">{e(error)}</p>}
        {!error && !transcript && <p className="empty-inline">{t('正在读取…', 'Loading…')}</p>}
        {transcript && !transcript.messages.length && !transcript.generatedImages.length && <p className="empty-inline">{t('这个会话里没有可显示的消息', 'No messages to show in this conversation')}</p>}
        {transcript && transcript.messages.length > 0 && <ol className="transcript-list">
          {transcript.messages.map((item, index) => <li key={index} className={`transcript-message role-${item.role}`}>
            <span className="transcript-meta">
              {item.role === 'user' ? t('你', 'You') : 'Codex'}
              {item.timestamp !== null && <time>{new Date(item.timestamp).toLocaleString(locale)}</time>}
            </span>
            {item.text && <p>{item.text}</p>}
            {item.images.length > 0 && <div className="transcript-images">
              {item.images.map((src, imageIndex) => <img key={imageIndex} src={src} alt={t(`图片 ${imageIndex + 1}`, `Image ${imageIndex + 1}`)}
                loading="lazy" onClick={() => setZoomed(src)} />)}
            </div>}
            {item.omittedImages > 0 && <p className="transcript-omitted">{t(`${item.omittedImages} 张图片过大，未在预览中显示`, `${item.omittedImages} images too large to preview`)}</p>}
          </li>)}
        </ol>}
        {transcript && (transcript.generatedImages.length > 0 || transcript.omittedGeneratedImages > 0) && <section className="transcript-generated">
          <h3>{t(`生成的图片（${transcript.generatedImages.length + transcript.omittedGeneratedImages}）`, `Generated images (${transcript.generatedImages.length + transcript.omittedGeneratedImages})`)}</h3>
          <div className="transcript-images">
            {transcript.generatedImages.map((image) => <img key={image.name + image.modifiedAt} src={image.src} alt={image.name}
              title={`${image.name} · ${new Date(image.modifiedAt).toLocaleString(locale)}`} loading="lazy" onClick={() => setZoomed(image.src)} />)}
          </div>
          {transcript.omittedGeneratedImages > 0 && <p className="transcript-omitted">{t(`${transcript.omittedGeneratedImages} 张图片过大，未在预览中显示`, `${transcript.omittedGeneratedImages} images too large to preview`)}</p>}
        </section>}
      </div>
      {notes.length > 0 && <p className="transcript-notes">{notes.join(' · ')}</p>}
      <div className="dialog-actions transcript-actions">
        <label className={`transcript-select ${checked ? 'selected' : ''}`}>
          <input type="checkbox" checked={checked} onChange={onToggle} />
          {t('选中此会话', 'Select this conversation')}
        </label>
        <span className="transcript-nav">
          <button className="btn btn-quiet" disabled={position <= 0} title="←" onClick={() => onNavigate(-1)}>{t('上一个', 'Previous')}</button>
          {position >= 0 && <span className="transcript-position">{position + 1} / {count}</span>}
          <button className="btn btn-quiet" disabled={position < 0 || position >= count - 1} title="→" onClick={() => onNavigate(1)}>{t('下一个', 'Next')}</button>
        </span>
        <button className="btn btn-quiet" onClick={() => void window.cleanmycodex.revealPath(session.fileURL)}>{t('在文件管理器中显示', 'Show in File Manager')}</button>
        <button className="btn" onClick={onClose}>{t('关闭', 'Close')}</button>
      </div>
    </section>
    {zoomed && <div className="image-zoom" role="presentation" onClick={() => setZoomed(null)}><img src={zoomed} alt="" /></div>}
  </div>
}
