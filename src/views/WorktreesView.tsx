import { useMemo } from 'react'
import type { CleanupProgress, CleanupSelection, ScanSnapshot, WorktreeItem } from '../../shared/types'
import { formatBytes, repositoryStateIsSafe, worktreeBytes, worktreeDisplayName, worktreeIsRemovable, worktreeIsUnsafe } from '../../shared/types'
import { message } from '../../shared/messages'
import { FolderIcon } from '../icons'
import { formatShortDate } from '../format'
import { usePreferences } from '../preferences'
import { CleanupSelectionBar, DetailSummary, useListSelection } from '../components/list-controls'

interface Props {
  snapshot: ScanSnapshot
  cleaning: boolean
  actionsDisabled: boolean
  cleanProgress: CleanupProgress | null
  onCleanup: (selection: CleanupSelection) => void
}

const worktreeID = (worktree: WorktreeItem): string => worktree.id

export default function WorktreesView({ snapshot, cleaning, actionsDisabled, cleanProgress, onCleanup }: Props) {
  const { t } = usePreferences()

  const worktrees = useMemo(() => snapshot.worktrees ?? [], [snapshot])
  // Grouped by the repository they were cut from, which is how someone thinks about
  // them: several checkouts of one project, not a flat list of hex directories.
  const groups = useMemo(() => {
    const map = new Map<string, WorktreeItem[]>()
    for (const worktree of worktrees) {
      // Without a repository path there is no evidence that two same-named orphaned
      // checkouts came from the same project, so keep each one in its own group.
      const key = worktree.repositoryPath ?? worktree.path
      map.set(key, [...(map.get(key) ?? []), worktree])
    }
    return [...map.entries()]
      .map(([key, items]) => ({ key, items: items.slice().sort((a, b) => b.bytes - a.bytes) }))
      .sort((a, b) => total(b.items) - total(a.items))
  }, [worktrees])

  const removable = useMemo(() => worktrees.filter(worktreeIsRemovable), [worktrees])
  const selection = useListSelection({ items: removable, getID: worktreeID })
  const chosen = selection.selectedItems
  const chosenBytes = total(chosen)
  const artifactBytes = worktrees.reduce((sum, worktree) => sum + worktree.artifactBytes, 0)

  return <>
    <div className="detail-content">
    <DetailSummary items={[
      { label: t('总占用', 'Total'), value: formatBytes(worktreeBytes(worktrees)) },
      { label: t('构建产物', 'Build output'), value: formatBytes(artifactBytes) },
    ]} />
    {!!worktrees.length && <p className="notice">{t(
      'Codex 会自动删除较早的 worktree，保留数量可在 Codex 设置 → Worktrees 中调整。',
      'Codex deletes older worktrees on its own; how many it keeps is set in Codex under Settings → Worktrees.'
    )}</p>}
    {!worktrees.length && <p className="empty-panel">{t('没有找到 Codex worktree', 'No Codex worktrees found')}</p>}
    <div className="card-stack">
      {groups.map((group) => <section className="card" key={group.key}>
        <div className="panel-title">
          <strong>{group.items[0].project} <span className="muted">· {t(`${group.items.length} 个 worktree`, `${group.items.length} worktrees`)}</span></strong>
          <span>{formatBytes(total(group.items))}</span>
        </div>
        {group.items.map((worktree) => <WorktreeRow key={worktree.id} worktree={worktree}
          checked={selection.isSelected(worktree)} onToggle={() => selection.toggle(worktree)} />)}
      </section>)}
    </div>
    </div>
    <CleanupSelectionBar count={chosen.length} warning={chosen.some(worktreeIsUnsafe)}
      summary={chosen.some(worktreeIsUnsafe)
        ? t(`⚠ 已选 ${chosen.length} 个 worktree · ${formatBytes(chosenBytes)} · 包含未提交、未推送或状态未知的改动`, `⚠ ${chosen.length} worktrees selected · ${formatBytes(chosenBytes)} · Contains uncommitted, unpushed, or unknown changes`)
        : t(`已选 ${chosen.length} 个 worktree`, `${chosen.length} worktrees selected`) + ` · ${formatBytes(chosenBytes)}`}
      cleaning={cleaning} actionsDisabled={actionsDisabled} progress={cleanProgress}
      onDelete={() => onCleanup({ kind: 'worktrees', ids: chosen.map(worktreeID), deleteRelatedSessions: false })} />
  </>
}

const total = (items: WorktreeItem[]): number => items.reduce((sum, item) => sum + item.bytes, 0)

function WorktreeRow({ worktree, checked, onToggle }: { worktree: WorktreeItem; checked: boolean; onToggle: () => void }) {
  const { t, m, locale } = usePreferences()
  const name = worktreeDisplayName(worktree)
  const worktreeID = worktree.id.split(/[\\/]/).filter(Boolean).at(-1) ?? worktree.id
  // The desktop index also contains guardian/subagent threads created while one
  // conversation is running. They remain attached for complete cleanup, but they are
  // not separate conversations in the sidebar and must not inflate this count.
  const mainThreads = worktree.sourceThreads.filter((thread) => !thread.isSubagent)
  const conversationCount = mainThreads.length || (worktree.sourceThreads.length ? 1 : 0)
  const label = `${name} · Worktree ${worktreeID}`
  return <div className="worktree-row">
    {worktreeIsRemovable(worktree)
      ? <input type="checkbox" aria-label={label} checked={checked} onChange={onToggle} />
      : <span className="checkbox-space" />}
    <div className="grow">
      <strong>{name} <span className="muted">· Worktree {worktreeID}</span></strong>
      <small>
        {t(
          `${conversationCount} 个关联会话`,
          `${conversationCount} related ${conversationCount === 1 ? 'conversation' : 'conversations'}`
        )}
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
