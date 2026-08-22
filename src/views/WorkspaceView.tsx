import { useEffect, useMemo, useState } from 'react'
import type { CleanupProgress, CleanupSelection, WorkspaceFolder, WorkspaceSnapshot } from '../../shared/types'
import { formatBytes, workspaceBytes, workspaceFolderFileCount, workspaceFolderIsUnsafe, WorkspaceRepositoryStateLabel } from '../../shared/types'
import { FolderIcon } from '../icons'

interface Props { snapshot: WorkspaceSnapshot; scanning: boolean; cleaning: boolean; actionsDisabled: boolean; cleanProgress: CleanupProgress | null; onScan: () => void; onCleanup: (selection: CleanupSelection) => void }

function formatDate(ms: number): string {
  if (!ms) return '—'
  const date = new Date(ms)
  return date.getFullYear() === new Date().getFullYear()
    ? date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export default function WorkspaceView({ snapshot, scanning, cleaning, actionsDisabled, cleanProgress, onScan, onCleanup }: Props) {
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
    <section className="page-heading"><div><h2>工作产出</h2><p>Codex 会话的工作目录和产出文件。</p></div><button className="btn" disabled={scanning} onClick={onScan}>{scanning ? '正在统计…' : snapshot.isScanned ? '重新统计' : '开始统计'}</button></section>
    <section className="workspace-metrics card"><div><small>总占用</small><strong>{formatBytes(workspaceBytes(snapshot))}</strong></div><div><small>已选择</small><strong>{formatBytes(chosenBytes)}</strong></div><div><small>产出</small><strong>{rows.length}</strong></div></section>
    {!snapshot.isScanned && <p className="empty-panel">第一次读取可能请求“文稿”文件夹访问权限<br/><code>{snapshot.root}</code></p>}
    {snapshot.isScanned && !rows.length && <p className="empty-panel">没有找到工作产出目录<br/><code>{snapshot.root}</code></p>}
    {!!rows.length && <section className="card workspace-tree">
      <div className="table-head workspace-head">
        <input type="checkbox" aria-label="全选" checked={allSelected}
          ref={(input) => { if (input) input.indeterminate = rows.some((entry) => selected.has(entry.id)) && !allSelected }}
          onChange={() => setSelected(() => allSelected ? new Set() : new Set(rows.flatMap((entry) => [entry.id, ...entry.children.map((child) => child.id)])))}/>
        <span/><span>产出</span><span className="col-date">最后改动</span><span className="col-num">占用</span><span/>
      </div>
      {rows.map((entry) => <WorkspaceRow key={entry.id} entry={entry} checked={selected.has(entry.id)} onToggle={() => toggle(entry)} date={formatDate(entry.modifiedAt)} />)}
    </section>}
    <div className="page-footer"><span className={targets.some(workspaceFolderIsUnsafe) ? 'unsafe' : ''}>{targets.some(workspaceFolderIsUnsafe) ? '⚠ 所选内容包含未提交、未推送或状态未知的 git 仓库' : snapshot.root}</span><button className="btn danger" disabled={!targets.length || cleaning || actionsDisabled} onClick={() => onCleanup({ kind: 'workspace', ids: targets.map((entry) => entry.id) })}>{cleaning ? `处理中… ${cleanProgress?.completed ?? 0}/${targets.length}` : `移到废纸篓 · ${formatBytes(chosenBytes)}`}</button></div>
  </>
}

function WorkspaceRow({ entry, checked, date, onToggle }: { entry: WorkspaceFolder; checked: boolean; date: string; onToggle: () => void }) {
  const display = workspaceDisplay(entry)
  return <div className="workspace-row">
    <input type="checkbox" aria-label={display.name} checked={checked} onChange={onToggle}/>
    <span className="row-glyph"><FolderIcon /></span>
    <div className="grow">
      <strong title={display.tooltip}>{display.name}</strong>
      <small>
        {workspaceFolderFileCount(entry)} 个文件
        {entry.children.length > 0 && ` · 含下方 ${entry.children.length} 项产出`}
        {' '}
        {entry.repositories.map((repo) => <span className={`repo ${repo.state === 'clean' ? 'safe' : 'unsafe'}`} key={repo.id}>{repo.name} · {WorkspaceRepositoryStateLabel[repo.state]}</span>)}
      </small>
    </div>
    <span className="col-date" title={entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : undefined}>{date}</span>
    {workspaceFolderIsUnsafe(entry) && <span className="unsafe">⚠</span>}
    <span className="col-num fixed-bytes">{formatBytes(entry.bytes)}</span>
    <button className="icon-button" title="在文件管理器中显示" aria-label="在文件管理器中显示" onClick={() => window.cleanmycodex.revealPath(entry.path)}><FolderIcon /></button>
  </div>
}

function workspaceDisplay(entry: WorkspaceFolder): { name: string; tooltip?: string } {
  if (!entry.sourceThreads.length) return { name: entry.name }
  const main = entry.sourceThreads.filter((thread) => !thread.isSubagent)
  const shown = main.length ? main : entry.sourceThreads
  const subagents = entry.sourceThreads.filter((thread) => thread.isSubagent).length
  const status = shown.every((thread) => thread.archived) ? ' · 已归档' : ''
  const first = shown[0].title
  const others = shown.length > 1 ? ` · 另 ${shown.length - 1} 个会话` : ''
  const children = main.length && subagents ? ` · ${subagents} 个子会话` : ''
  return {
    name: `${first}${others}${children}${status}`,
    tooltip: entry.sourceThreads.map((thread) => `${thread.title}\n${thread.id}${thread.archived ? ' · 已归档' : ''}${thread.isSubagent ? ' · 子会话' : ''}`).join('\n\n')
  }
}
