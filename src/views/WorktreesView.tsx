import { useEffect, useMemo, useState } from 'react'
import type { CleanupProgress, CleanupSelection, ScanSnapshot, WorktreeItem } from '../../shared/types'
import { formatBytes, repositoryStateIsSafe, worktreeBytes, worktreeDisplayName, worktreeIsRemovable, worktreeIsUnsafe } from '../../shared/types'
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

export default function WorktreesView({ snapshot, cleaning, actionsDisabled, cleanProgress, onCleanup }: Props) {
  const { t } = usePreferences()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  useEffect(() => { setSelected(new Set()) }, [snapshot])

  const worktrees = useMemo(() => snapshot.worktrees ?? [], [snapshot])
  // Grouped by the repository they were cut from, which is how someone thinks about
  // them: several checkouts of one project, not a flat list of hex directories.
  const groups = useMemo(() => {
    const map = new Map<string, WorktreeItem[]>()
    for (const worktree of worktrees) {
      const key = worktree.repositoryPath ?? worktree.project
      map.set(key, [...(map.get(key) ?? []), worktree])
    }
    return [...map.entries()]
      .map(([key, items]) => ({ key, items: items.slice().sort((a, b) => b.bytes - a.bytes) }))
      .sort((a, b) => total(b.items) - total(a.items))
  }, [worktrees])

  const removable = worktrees.filter(worktreeIsRemovable)
  const chosen = removable.filter((worktree) => selected.has(worktree.id))
  const chosenBytes = total(chosen)
  const artifactBytes = worktrees.reduce((sum, worktree) => sum + worktree.artifactBytes, 0)

  const toggle = (worktree: WorktreeItem) => setSelected((previous) => {
    const next = new Set(previous)
    next.has(worktree.id) ? next.delete(worktree.id) : next.add(worktree.id)
    return next
  })

  return <>
    <div className="detail-content">
    <section className="workspace-metrics worktree-metrics card">
      <div><small>{t('总占用', 'Total')}</small><strong>{formatBytes(worktreeBytes(worktrees))}</strong></div>
      <div><small>{t('其中构建产物', 'Build output')}</small><strong>{formatBytes(artifactBytes)}</strong></div>
      <div><small>{t('已选择', 'Selected')}</small><strong>{formatBytes(chosenBytes)}</strong></div>
    </section>
    {!!worktrees.length && <p className="notice">{t(
      'Codex 会自动删除较早的 worktree，保留数量可在 Codex 设置 → Worktrees 中调整。',
      'Codex deletes older worktrees on its own; how many it keeps is set in Codex under Settings → Worktrees.'
    )}</p>}
    {!worktrees.length && <p className="empty-panel">{t('没有找到 Codex worktree', 'No Codex worktrees found')}</p>}
    <div className="card-stack">
      {groups.map((group) => <section className="card" key={group.key}>
        <div className="panel-title">
          <strong>{group.items[0].project}</strong>
          <span>{t(`${group.items.length} 个 worktree`, `${group.items.length} worktrees`)} · {formatBytes(total(group.items))}</span>
        </div>
        {group.items.map((worktree) => <WorktreeRow key={worktree.id} worktree={worktree}
          checked={selected.has(worktree.id)} onToggle={() => toggle(worktree)} />)}
      </section>)}
    </div>
    </div>
    <div className="page-footer">
      <span className={chosen.some(worktreeIsUnsafe) ? 'unsafe' : ''}>{chosen.some(worktreeIsUnsafe)
        ? t('⚠ 所选 worktree 有未提交、未推送或状态未知的改动', '⚠ Selected worktrees have uncommitted, unpushed, or unknown changes')
        : chosen.length
          ? t(`已选择 ${chosen.length} 个`, `${chosen.length} selected`)
          : t(`可清理 ${removable.length} 个`, `${removable.length} cleanable`)}</span>
      <button className="btn danger" disabled={!chosen.length || cleaning || actionsDisabled}
        onClick={() => onCleanup({ kind: 'worktrees', ids: chosen.map((worktree) => worktree.id) })}>
        {cleaning
          ? t(`处理中… ${cleanProgress?.completed ?? 0}/${chosen.length}`, `Processing… ${cleanProgress?.completed ?? 0}/${chosen.length}`)
          : t(`永久删除 · ${formatBytes(chosenBytes)}`, `Delete Permanently · ${formatBytes(chosenBytes)}`)}
      </button>
    </div>
  </>
}

const total = (items: WorktreeItem[]): number => items.reduce((sum, item) => sum + item.bytes, 0)

function WorktreeRow({ worktree, checked, onToggle }: { worktree: WorktreeItem; checked: boolean; onToggle: () => void }) {
  const { t, m, locale } = usePreferences()
  const name = worktreeDisplayName(worktree)
  const extraThreads = Math.max(0, worktree.sourceThreads.length - 1)
  return <div className="worktree-row">
    {worktreeIsRemovable(worktree)
      ? <input type="checkbox" aria-label={name} checked={checked} onChange={onToggle} />
      : <span className="checkbox-space" />}
    <div className="grow">
      <strong>{name}{extraThreads > 0 && <span className="muted"> {t(`+${extraThreads} 个会话`, `+${extraThreads} conversations`)}</span>}</strong>
      <small>
        <code>{worktree.branch ?? (worktree.headCommit
          ? t(`游离 HEAD · ${worktree.headCommit}`, `detached at ${worktree.headCommit}`)
          : t('游离 HEAD', 'detached HEAD'))}</code>
        {worktree.artifactBytes > 0 && t(` · 构建产物 ${formatBytes(worktree.artifactBytes)}`, ` · ${formatBytes(worktree.artifactBytes)} build output`)}
        {worktree.status === 'unmanaged' && <span className="pill status-unconfirmed">{m(message('tag.unmanagedWorktree'))}</span>}
        {worktree.isOrphaned && <span className="pill status-orphaned">{m(message('tag.orphanedWorktree'))}</span>}
      </small>
    </div>
    <span className="col-status">
      <span className={`repo ${repositoryStateIsSafe(worktree.state) ? 'safe' : 'unsafe'}`}>{m(message(`repoState.${worktree.state}`))}</span>
    </span>
    <span className="col-date" title={worktree.modifiedAt ? new Date(worktree.modifiedAt).toLocaleString(locale) : undefined}>
      {formatShortDate(worktree.modifiedAt, locale)}
    </span>
    <span className="col-num">{formatBytes(worktree.bytes)}</span>
    <button className="icon-button" title={t('在文件管理器中显示', 'Show in file manager')}
      aria-label={t('在文件管理器中显示', 'Show in file manager')}
      onClick={() => window.cleanmycodex.revealPath(worktree.projectPath)}><FolderIcon /></button>
  </div>
}
