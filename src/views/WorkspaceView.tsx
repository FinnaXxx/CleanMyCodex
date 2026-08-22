import { useEffect, useMemo, useState } from 'react'
import type { CleanupProgress, CleanupSelection, WorkspaceFolder, WorkspaceSnapshot } from '../../shared/types'
import { formatBytes, workspaceBytes, workspaceFolderFileCount, workspaceFolderIsUnsafe, WorkspaceRepositoryStateLabel } from '../../shared/types'

interface Props { snapshot: WorkspaceSnapshot; scanning: boolean; cleaning: boolean; actionsDisabled: boolean; cleanProgress: CleanupProgress | null; onScan: () => void; onCleanup: (selection: CleanupSelection) => void }

export default function WorkspaceView({ snapshot, scanning, cleaning, actionsDisabled, cleanProgress, onScan, onCleanup }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  useEffect(() => { setSelected(new Set()) }, [snapshot])
  const all = useMemo(() => snapshot.entries.flatMap((entry) => [entry, ...entry.children]), [snapshot])
  const targets = all.filter((entry) => selected.has(entry.id) && !all.some((parent) => selected.has(parent.id) && parent.children.some((child) => child.id === entry.id)))
  const chosenBytes = targets.reduce((sum, item) => sum + item.bytes, 0)
  const toggle = (entry: WorkspaceFolder) => setSelected((previous) => {
    const next = new Set(previous); const ids = [entry.id, ...entry.children.map((child) => child.id)]
    const enable = !ids.every((id) => next.has(id)); for (const id of ids) enable ? next.add(id) : next.delete(id); return next
  })
  const toggleExpand = (id: string) => setExpanded((previous) => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next })
  return <>
    <section className="page-heading"><div><h2>工作产出</h2><p>Codex 会话的工作目录和产出文件，按日期分组。</p></div><button className="btn" disabled={scanning} onClick={onScan}>{scanning ? '正在统计…' : snapshot.isScanned ? '重新统计' : '开始统计'}</button></section>
    <section className="workspace-metrics card"><div><small>总占用</small><strong>{formatBytes(workspaceBytes(snapshot))}</strong></div><div><small>已选择</small><strong>{formatBytes(chosenBytes)}</strong></div><div><small>目录</small><strong>{snapshot.entries.length}</strong></div></section>
    {!snapshot.isScanned && <p className="empty-panel">第一次读取可能请求“文稿”文件夹访问权限<br/><code>{snapshot.root}</code></p>}
    {snapshot.isScanned && !snapshot.entries.length && <p className="empty-panel">没有找到工作产出目录<br/><code>{snapshot.root}</code></p>}
    <section className="card workspace-tree">
      {snapshot.entries.map((entry) => <div key={entry.id}>
        <WorkspaceRow entry={entry} checked={selected.has(entry.id)} depth={0} onToggle={() => toggle(entry)} expanded={expanded.has(entry.id)} onExpand={() => toggleExpand(entry.id)} />
        {expanded.has(entry.id) && entry.children.map((child) => <WorkspaceRow key={child.id} entry={child} checked={selected.has(child.id)} depth={1} onToggle={() => toggle(child)} expanded={false} onExpand={() => undefined} />)}
      </div>)}
    </section>
    <div className="page-footer"><span className={targets.some(workspaceFolderIsUnsafe) ? 'unsafe' : ''}>{targets.some(workspaceFolderIsUnsafe) ? '⚠ 所选内容包含未提交、未推送或状态未知的 git 仓库' : snapshot.root}</span><button className="btn danger" disabled={!targets.length || cleaning || actionsDisabled} onClick={() => onCleanup({ kind: 'workspace', ids: targets.map((entry) => entry.id) })}>{cleaning ? `处理中… ${cleanProgress?.completed ?? 0}/${targets.length}` : `移到废纸篓 · ${formatBytes(chosenBytes)}`}</button></div>
  </>
}

function WorkspaceRow({ entry, checked, depth, onToggle, expanded, onExpand }: { entry: WorkspaceFolder; checked: boolean; depth: number; onToggle: () => void; expanded: boolean; onExpand: () => void }) {
  const display = workspaceDisplay(entry, depth)
  return <div className="workspace-row" style={{ paddingLeft: 16 + depth * 28 }}>
    <input type="checkbox" checked={checked} onChange={onToggle}/>{!depth && <span>▣</span>}
    <div className="grow"><strong title={display.tooltip}>{display.name}</strong><small>{workspaceFolderFileCount(entry)} 个文件 {entry.repositories.map((repo) => <span className={`repo ${repo.state === 'clean' ? 'safe' : 'unsafe'}`} key={repo.id}>{repo.name} · {WorkspaceRepositoryStateLabel[repo.state]}</span>)}</small></div>
    {workspaceFolderIsUnsafe(entry) && <span className="unsafe">⚠</span>}<span className="fixed-bytes">{formatBytes(entry.bytes)}</span>
    <button className="icon-button" title="在文件管理器中显示" aria-label="在文件管理器中显示" onClick={() => window.cleanmycodex.revealPath(entry.path)}><FolderIcon /></button>
    {entry.children.length ? <button className="icon-button" onClick={onExpand}>{expanded ? '⌃' : '⌄'}</button> : <span className="icon-space"/>}
  </div>
}

function workspaceDisplay(entry: WorkspaceFolder, depth: number): { name: string; tooltip?: string } {
  if (!depth || !entry.sourceThreads.length) return { name: entry.name }
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

function FolderIcon() {
  return <svg className="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>
  </svg>
}
