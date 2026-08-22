import { useEffect, useMemo, useState } from 'react'
import type { CleanupProgress, CleanupSelection, SessionLocation, WorkspaceFolder, WorkspaceSnapshot } from '../../shared/types'
import { formatBytes, workspaceBytes, workspaceFolderFileCount, workspaceFolderIsUnsafe } from '../../shared/types'
import { BackIcon, FolderIcon } from '../icons'
import { usePreferences } from '../preferences'

interface Props { snapshot: WorkspaceSnapshot; cleaning: boolean; actionsDisabled: boolean; cleanProgress: CleanupProgress | null; onBack: () => void; onCleanup: (selection: CleanupSelection) => void }

function formatDate(ms: number, locale: string): string {
  if (!ms) return '—'
  const date = new Date(ms)
  return date.getFullYear() === new Date().getFullYear()
    ? date.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export default function WorkspaceView({ snapshot, cleaning, actionsDisabled, cleanProgress, onBack, onCleanup }: Props) {
  const { t, locale } = usePreferences()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  useEffect(() => { setSelected(new Set()) }, [snapshot])

  /** Codex files outputs under a date folder; the date is a column here, not a level. */
  const rows = useMemo(() => snapshot.entries
    .flatMap((entry) => entry.children.length
      ? [...entry.children, ...(entry.fileCount ? [entry] : [])]
      : [entry])
    .sort((a, b) => b.modifiedAt - a.modifiedAt || b.bytes - a.bytes), [snapshot])

  const all = useMemo(() => snapshot.entries.flatMap((entry) => [entry, ...entry.children]), [snapshot])
  const targets = all.filter((entry) => selected.has(entry.id) && !all.some((parent) => selected.has(parent.id) && parent.children.some((child) => child.id === entry.id)))
  const chosenBytes = targets.reduce((sum, item) => sum + item.bytes, 0)
  const allSelected = rows.length > 0 && rows.every((entry) => selected.has(entry.id))

  const toggle = (entry: WorkspaceFolder) => setSelected((previous) => {
    const next = new Set(previous); const ids = [entry.id, ...entry.children.map((child) => child.id)]
    const enable = !ids.every((id) => next.has(id)); for (const id of ids) enable ? next.add(id) : next.delete(id); return next
  })

  return <>
    <div className="detail-content">
    <section className="page-heading"><div className="page-title"><button className="icon-button detail-back-button" title={t('返回', 'Back')} aria-label={t('返回', 'Back')} onClick={onBack}><BackIcon /></button><div><h2>{t('工作产出', 'Workspace Output')}</h2></div></div></section>
    <section className="workspace-metrics card"><div><small>{t('总占用', 'Total')}</small><strong>{formatBytes(workspaceBytes(snapshot))}</strong></div><div><small>{t('已选择', 'Selected')}</small><strong>{formatBytes(chosenBytes)}</strong></div></section>
    {!snapshot.isScanned && <p className="empty-panel">{t('工作产出尚未完成统计，请在首页重新扫描', 'Workspace output has not been scanned. Scan again from Home.')}<br/><code>{snapshot.root}</code></p>}
    {snapshot.isScanned && !rows.length && <p className="empty-panel">{t('没有找到工作产出目录', 'No workspace output folders found')}<br/><code>{snapshot.root}</code></p>}
    {!!rows.length && <section className="card workspace-tree">
      <div className="table-head workspace-head">
        <input type="checkbox" aria-label={t('全选', 'Select all')} checked={allSelected}
          ref={(input) => { if (input) input.indeterminate = rows.some((entry) => selected.has(entry.id)) && !allSelected }}
          onChange={() => setSelected(() => allSelected ? new Set() : new Set(rows.flatMap((entry) => [entry.id, ...entry.children.map((child) => child.id)])))}/>
        <span>{t('产出', 'Output')}</span><span className="col-status">{t('状态', 'Status')}</span><span className="col-date">{t('最后改动', 'Modified')}</span><span className="col-num">{t('占用', 'Size')}</span><span/>
      </div>
      {rows.map((entry) => <WorkspaceRow key={entry.id} entry={entry} checked={selected.has(entry.id)} onToggle={() => toggle(entry)} date={formatDate(entry.modifiedAt, locale)} />)}
    </section>}
    </div>
    <div className="page-footer"><span className={targets.some(workspaceFolderIsUnsafe) ? 'unsafe' : ''}>{targets.some(workspaceFolderIsUnsafe) ? t('⚠ 所选内容包含未提交、未推送或状态未知的 git 仓库', '⚠ Selection contains uncommitted, unpushed, or unknown Git repositories') : snapshot.root}</span><button className="btn danger" disabled={!targets.length || cleaning || actionsDisabled} onClick={() => onCleanup({ kind: 'workspace', ids: targets.map((entry) => entry.id) })}>{cleaning ? t(`处理中… ${cleanProgress?.completed ?? 0}/${targets.length}`, `Processing… ${cleanProgress?.completed ?? 0}/${targets.length}`) : t(`移到废纸篓 · ${formatBytes(chosenBytes)}`, `Move to Trash · ${formatBytes(chosenBytes)}`)}</button></div>
  </>
}

function WorkspaceRow({ entry, checked, date, onToggle }: { entry: WorkspaceFolder; checked: boolean; date: string; onToggle: () => void }) {
  const { t, language, locale } = usePreferences()
  const display = workspaceDisplay(entry)
  const status = workspaceStatus(entry)
  return <div className="workspace-row">
    <input type="checkbox" aria-label={display.name} checked={checked} onChange={onToggle}/>
    <div className="grow">
      <strong title={display.tooltip}>{display.name}</strong>
      <small>
        {t(`${workspaceFolderFileCount(entry)} 个文件`, `${workspaceFolderFileCount(entry)} files`)}
        {entry.children.length > 0 && t(` · 含下方 ${entry.children.length} 项产出`, ` · Includes ${entry.children.length} outputs below`)}
        {workspaceFolderIsUnsafe(entry) && <span className="unsafe" title={t('有未提交、未推送或状态未知的 git 仓库', 'Contains uncommitted, unpushed, or unknown Git repositories')}> ⚠</span>}
        {' '}
        {entry.repositories.map((repo) => <span className={`repo ${repo.state === 'clean' ? 'safe' : 'unsafe'}`} key={repo.id}>{repo.name} · {language === 'zh-CN' ? ({ clean: '已同步', dirty: '有未提交改动', unpushed: '有未推送提交', unknown: '状态未知' } as const)[repo.state] : ({ clean: 'Synced', dirty: 'Uncommitted changes', unpushed: 'Unpushed commits', unknown: 'Unknown' } as const)[repo.state]}</span>)}
      </small>
    </div>
    <span className="col-status">{status ? <span className={`pill loc-${status.location}`}>{status.location === 'active' ? t('未归档', 'Active') : t('已归档', 'Archived')}</span> : <span className="muted">—</span>}</span>
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

function workspaceDisplay(entry: WorkspaceFolder): { name: string; tooltip?: string } {
  if (!entry.sourceThreads.length) return { name: entry.name }
  const main = entry.sourceThreads.filter((thread) => !thread.isSubagent)
  const shown = main.length ? main : entry.sourceThreads
  return { name: shown[0].title }
}
