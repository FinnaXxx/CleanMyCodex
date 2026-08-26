import { useMemo, useState } from 'react'
import type { CleanupProgress, CleanupSelection, WorkspaceFolder, WorkspaceSnapshot } from '../../shared/types'
import { formatBytes, repositoryStateIsSafe, workspaceBytes, workspaceDisplayName, workspaceFolderIsUnsafe } from '../../shared/types'
import { message } from '../../shared/messages'
import { FolderIcon } from '../icons'
import { formatShortDate } from '../format'
import { usePreferences } from '../preferences'
import { FunnelFilter, SortHeader, useSortState, type SortDir } from '../components/list-controls'

interface Props { snapshot: WorkspaceSnapshot; cleaning: boolean; actionsDisabled: boolean; cleanProgress: CleanupProgress | null; onCleanup: (selection: CleanupSelection) => void }

type Scope = 'all' | 'active' | 'archived' | 'unlinked'
type SortKey = 'date' | 'size'
type WsStatus = Exclude<Scope, 'all'>

/** Always desc: newest first by default for date, largest first for size. */
const defaultSortDir = (_key: SortKey): SortDir => 'desc'

export default function WorkspaceView({ snapshot, cleaning, actionsDisabled, cleanProgress, onCleanup }: Props) {
  const { t, locale } = usePreferences()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scope, setScope] = useState<Scope>('all')
  const { sortKey, sortDir, cycleSort } = useSortState<SortKey>('size', defaultSortDir)

  /** Codex files outputs under a date folder; the date is a column here, not a level.
   *  A date folder earns a row only when files lie loose in it, and that row stands for
   *  those files alone — the outputs are rows of their own, so every row is disjoint. */
  const baseRows = useMemo(() => snapshot.entries
    .flatMap((entry) => entry.children.length
      ? [...entry.children, ...(entry.fileCount ? [entry] : [])]
      : [entry])
    .map((entry) => ({ entry, status: workspaceStatusKey(entry) })), [snapshot])

  const scopeOptions = [
    { value: 'all' as const, label: t('全部', 'All'), count: baseRows.length },
    { value: 'active' as const, label: t('未归档', 'Active'), count: baseRows.filter((r) => r.status === 'active').length },
    { value: 'archived' as const, label: t('已归档', 'Archived'), count: baseRows.filter((r) => r.status === 'archived').length },
    { value: 'unlinked' as const, label: t('未关联', 'Unlinked'), count: baseRows.filter((r) => r.status === 'unlinked').length },
  ]

  const rows = useMemo(() => {
    const filtered = scope === 'all' ? baseRows : baseRows.filter((r) => r.status === scope)
    return [...filtered].sort((a, b) => {
      const cmp = sortKey === 'date' ? a.entry.modifiedAt - b.entry.modifiedAt : a.entry.bytes - b.entry.bytes
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [baseRows, scope, sortKey, sortDir])

  const targets = rows.filter((r) => selected.has(r.entry.id)).map((r) => r.entry)
  const chosenBytes = targets.reduce((sum, item) => sum + item.bytes, 0)
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.entry.id))

  const toggle = (entry: WorkspaceFolder) => setSelected((previous) => {
    const next = new Set(previous); next.has(entry.id) ? next.delete(entry.id) : next.add(entry.id); return next
  })

  return <>
    <div className="detail-content">
    <section className="workspace-metrics card"><div><small>{t('总占用', 'Total')}</small><strong>{formatBytes(workspaceBytes(snapshot))}</strong></div><div><small>{t('已选择', 'Selected')}</small><strong>{formatBytes(chosenBytes)}</strong></div></section>
    {!snapshot.isScanned && <p className="empty-panel">{t('工作区尚未完成统计，请在首页重新扫描', 'Workspace has not been scanned. Scan again from Home.')}<br/><code>{snapshot.root}</code></p>}
    {snapshot.isScanned && !rows.length && <p className="empty-panel">{scope === 'all'
      ? t('没有找到工作区目录', 'No workspace folders found')
      : t('没有符合筛选条件的工作区目录', 'No workspace folders match these filters')}<br/><code>{snapshot.root}</code></p>}
    {!!rows.length && <section className="card workspace-tree">
      <div className="table-head workspace-head">
        <input type="checkbox" aria-label={t('全选', 'Select all')} checked={allSelected}
          ref={(input) => { if (input) input.indeterminate = rows.some((r) => selected.has(r.entry.id)) && !allSelected }}
          onChange={() => setSelected(() => allSelected ? new Set() : new Set(rows.map((r) => r.entry.id)))}/>
        <span>{t('产出', 'Output')}</span>
        <span className="col-status">
          <span className="status-head">
            {t('状态', 'Status')}
            <FunnelFilter ariaLabel={t('筛选状态', 'Filter status')} active={scope !== 'all'}
              options={scopeOptions} value={scope} onChange={setScope} />
          </span>
        </span>
        <span className="col-date col-sortable">
          <SortHeader active={sortKey === 'date'} dir={sortDir} onClick={() => cycleSort('date')}>
            {t('最后改动', 'Modified')}
          </SortHeader>
        </span>
        <span className="col-num">
          <SortHeader align="end" active={sortKey === 'size'} dir={sortDir} onClick={() => cycleSort('size')}>
            {t('占用', 'Size')}
          </SortHeader>
        </span>
        <span/>
      </div>
      {rows.map((r) => <WorkspaceRow key={r.entry.id} entry={r.entry} status={r.status} checked={selected.has(r.entry.id)} onToggle={() => toggle(r.entry)} date={formatShortDate(r.entry.modifiedAt, locale)} />)}
    </section>}
    </div>
    <div className="page-footer"><span className={targets.some(workspaceFolderIsUnsafe) ? 'unsafe' : ''}>{targets.some(workspaceFolderIsUnsafe) ? t('⚠ 所选内容包含未提交、未推送或状态未知的 git 仓库', '⚠ Selection contains uncommitted, unpushed, or unknown Git repositories') : snapshot.root}</span><button className="btn danger" disabled={!targets.length || cleaning || actionsDisabled} onClick={() => onCleanup({ kind: 'workspace', ids: targets.map((entry) => entry.id), deleteRelatedSessions: false })}>{cleaning ? t(`处理中… ${cleanProgress?.completed ?? 0}/${targets.length}`, `Processing… ${cleanProgress?.completed ?? 0}/${targets.length}`) : t(`删除 · ${formatBytes(chosenBytes)}`, `Delete · ${formatBytes(chosenBytes)}`)}</button></div>
  </>
}

function WorkspaceRow({ entry, status, checked, date, onToggle }: { entry: WorkspaceFolder; status: WsStatus; checked: boolean; date: string; onToggle: () => void }) {
  const { t, m, locale } = usePreferences()
  const displayName = workspaceDisplayName(entry)
  return <div className="workspace-row">
    <input type="checkbox" aria-label={displayName} checked={checked} onChange={onToggle}/>
    <div className="grow">
      <strong>{displayName}</strong>
      <small>
        {t(`${entry.fileCount} 个文件`, `${entry.fileCount} files`)}
        {entry.children.length > 0 && t(` · 仅日期目录下的散落文件，不含下方 ${entry.children.length} 项产出`, ` · Loose files in the date folder only, not the ${entry.children.length} outputs below`)}
        {workspaceFolderIsUnsafe(entry) && <span className="unsafe" title={t('有未提交、未推送或状态未知的 git 仓库', 'Contains uncommitted, unpushed, or unknown Git repositories')}> ⚠</span>}
        {' '}
        {entry.repositories.map((repo) => <span className={`repo ${repositoryStateIsSafe(repo.state) ? 'safe' : 'unsafe'}`} key={repo.id}>{repo.name} · {m(message(`repoState.${repo.state}`))}</span>)}
      </small>
    </div>
    <span className="col-status">{status === 'unlinked'
      ? <span className="pill loc-unlinked">{t('未关联', 'Unlinked')}</span>
      : <span className={`pill loc-${status}`}>{m(message(`location.${status}`))}</span>}</span>
    <span className="col-date" title={entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString(locale) : undefined}>{date}</span>
    <span className="col-num">{formatBytes(entry.bytes)}</span>
    <button className="icon-button" title={t('在文件管理器中显示', 'Show in file manager')} aria-label={t('在文件管理器中显示', 'Show in file manager')} onClick={() => window.cleanmycodex.revealPath(entry.path)}><FolderIcon /></button>
  </div>
}

/** Outputs inherit the state of the session that produced them, like the session list;
 *  entries with no source thread are "unlinked" rather than shown as a bare dash. */
function workspaceStatusKey(entry: WorkspaceFolder): WsStatus {
  if (!entry.sourceThreads.length) return 'unlinked'
  const main = entry.sourceThreads.filter((thread) => !thread.isSubagent)
  const shown = main.length ? main : entry.sourceThreads
  return shown.every((thread) => thread.archived) ? 'archived' : 'active'
}