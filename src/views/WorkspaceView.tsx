import { useEffect, useMemo, useState } from 'react'
import type { CleanupProgress, CleanupSelection, SessionLocation, WorkspaceFolder, WorkspaceSnapshot } from '../../shared/types'
import { formatBytes, repositoryStateIsSafe, workspaceBytes, workspaceDisplayName, workspaceFolderIsUnsafe } from '../../shared/types'
import { message } from '../../shared/messages'
import { FolderIcon } from '../icons'
import { formatShortDate } from '../format'
import { usePreferences } from '../preferences'

interface Props { snapshot: WorkspaceSnapshot; cleaning: boolean; actionsDisabled: boolean; cleanProgress: CleanupProgress | null; onCleanup: (selection: CleanupSelection) => void }

export default function WorkspaceView({ snapshot, cleaning, actionsDisabled, cleanProgress, onCleanup }: Props) {
  const { t, locale } = usePreferences()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  useEffect(() => { setSelected(new Set()) }, [snapshot])

  /** Codex files outputs under a date folder; the date is a column here, not a level.
   *  A date folder earns a row only when files lie loose in it, and that row stands for
   *  those files alone — the outputs are rows of their own, so every row is disjoint. */
  const rows = useMemo(() => snapshot.entries
    .flatMap((entry) => entry.children.length
      ? [...entry.children, ...(entry.fileCount ? [entry] : [])]
      : [entry])
    .sort((a, b) => b.modifiedAt - a.modifiedAt || b.bytes - a.bytes), [snapshot])

  const targets = rows.filter((entry) => selected.has(entry.id))
  const chosenBytes = targets.reduce((sum, item) => sum + item.bytes, 0)
  const allSelected = rows.length > 0 && rows.every((entry) => selected.has(entry.id))

  const toggle = (entry: WorkspaceFolder) => setSelected((previous) => {
    const next = new Set(previous); next.has(entry.id) ? next.delete(entry.id) : next.add(entry.id); return next
  })

  return <>
    <div className="detail-content">
    <section className="workspace-metrics card"><div><small>{t('总占用', 'Total')}</small><strong>{formatBytes(workspaceBytes(snapshot))}</strong></div><div><small>{t('已选择', 'Selected')}</small><strong>{formatBytes(chosenBytes)}</strong></div></section>
    {snapshot.isScanned && <p className="notice">{t('这里是你的工作成果：Codex 在该目录产出的文件与仓库。工作区不参与定时清理，仅在你手动勾选时删除。', 'Your work product lives here — the files and repositories Codex produced under this directory. The workspace is never part of scheduled cleanup and is only removed when you tick it yourself.')}</p>}
    {!snapshot.isScanned && <p className="empty-panel">{t('工作区尚未完成统计，请在首页重新扫描', 'Workspace has not been scanned. Scan again from Home.')}<br/><code>{snapshot.root}</code></p>}
    {snapshot.isScanned && !rows.length && <p className="empty-panel">{t('没有找到工作区目录', 'No workspace folders found')}<br/><code>{snapshot.root}</code></p>}
    {!!rows.length && <section className="card workspace-tree">
      <div className="table-head workspace-head">
        <input type="checkbox" aria-label={t('全选', 'Select all')} checked={allSelected}
          ref={(input) => { if (input) input.indeterminate = rows.some((entry) => selected.has(entry.id)) && !allSelected }}
          onChange={() => setSelected(() => allSelected ? new Set() : new Set(rows.map((entry) => entry.id)))}/>
        <span>{t('产出', 'Output')}</span><span className="col-status">{t('状态', 'Status')}</span><span className="col-date">{t('最后改动', 'Modified')}</span><span className="col-num">{t('占用', 'Size')}</span><span/>
      </div>
      {rows.map((entry) => <WorkspaceRow key={entry.id} entry={entry} checked={selected.has(entry.id)} onToggle={() => toggle(entry)} date={formatShortDate(entry.modifiedAt, locale)} />)}
    </section>}
    </div>
    <div className="page-footer"><span className={targets.some(workspaceFolderIsUnsafe) ? 'unsafe' : ''}>{targets.some(workspaceFolderIsUnsafe) ? t('⚠ 所选内容包含未提交、未推送或状态未知的 git 仓库', '⚠ Selection contains uncommitted, unpushed, or unknown Git repositories') : snapshot.root}</span><button className="btn danger" disabled={!targets.length || cleaning || actionsDisabled} onClick={() => onCleanup({ kind: 'workspace', ids: targets.map((entry) => entry.id), deleteRelatedSessions: false })}>{cleaning ? t(`处理中… ${cleanProgress?.completed ?? 0}/${targets.length}`, `Processing… ${cleanProgress?.completed ?? 0}/${targets.length}`) : t(`删除 · ${formatBytes(chosenBytes)}`, `Delete · ${formatBytes(chosenBytes)}`)}</button></div>
  </>
}

function WorkspaceRow({ entry, checked, date, onToggle }: { entry: WorkspaceFolder; checked: boolean; date: string; onToggle: () => void }) {
  const { t, m, locale } = usePreferences()
  const displayName = workspaceDisplayName(entry)
  const status = workspaceStatus(entry)
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
    <span className="col-status">{status ? <span className={`pill loc-${status.location}`}>{m(message(`location.${status.location}`))}</span> : <span className="muted">—</span>}</span>
    <span className="col-date" title={entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString(locale) : undefined}>{date}</span>
    <span className="col-num">{formatBytes(entry.bytes)}</span>
    <button className="icon-button" title={t('在文件管理器中显示', 'Show in file manager')} aria-label={t('在文件管理器中显示', 'Show in file manager')} onClick={() => window.cleanmycodex.revealPath(entry.path)}><FolderIcon /></button>
  </div>
}

/** Outputs inherit the state of the session that produced them, like the session list. */
function workspaceStatus(entry: WorkspaceFolder): { location: SessionLocation } | null {
  if (!entry.sourceThreads.length) return null
  const main = entry.sourceThreads.filter((thread) => !thread.isSubagent)
  const shown = main.length ? main : entry.sourceThreads
  return { location: shown.every((thread) => thread.archived) ? 'archived' : 'active' }
}
