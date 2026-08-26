import type {
  CleanupPreview,
  CleanupSelection,
  CleanupTask,
  AutomationSettings,
  PluginVersionItem,
  ScanSnapshot,
  SessionItem,
  StorageEntry,
  WorkspaceFolder,
  WorkspaceSnapshot,
  WorktreeItem
} from '../../shared/types'
import {
  isSelectable,
  listableSessions,
  pluginStatusIsRemovable,
  pluginVersionCanUninstall,
  tasksForGeneratedAssets,
  tasksForSessionDeletion,
  tasksForWorkspace,
  tasksForWorktrees,
  tasksFromEntries,
  workspaceDeletionTargets,
  worktreeIsRemovable,
  worktreeIsUnsafe
} from '../../shared/types'
import { ProtectedPaths } from './guard'
import type { CodexEnvironment } from './platform-services'
import { MessageError, message, type Message } from '../../shared/messages'

// Scheduled cache cleanup is intentionally narrower than the UI. Desktop caches and
// logs remain manual-review items even if a future scanner accidentally changes groups.
const AUTOMATIC_CACHE_KINDS = new Set(['temporary'])

export function buildTrustedTasks(
  selection: CleanupSelection,
  snapshot: ScanSnapshot,
  workspace: WorkspaceSnapshot
): CleanupTask[] {
  if (!selection || typeof selection !== 'object' || typeof selection.kind !== 'string') throw new MessageError(message('error.invalidSelection'))
  const ids = safeIDs(selection.ids)
  switch (selection.kind) {
    case 'storage': {
      const pluginDirectories = new Set(snapshot.pluginVersions
        .filter((plugin) => pluginStatusIsRemovable(plugin.status))
        .map((plugin) => plugin.directoryURL))
      const index = new Map(snapshot.categories.flatMap((category) => category.entries.map((entry) => [entry.id, {
        entry,
        isPlugin: category.kind === 'pluginRemnants' || category.kind === 'pluginOrphans'
      }] as const)))
      const entries = ids.map((id) => index.get(id)).filter((item): item is { entry: StorageEntry; isPlugin: boolean } =>
        !!item && isSelectable(item.entry.risk) && (!item.isPlugin || pluginDirectories.has(item.entry.url)))
        .map((item) => item.entry)
      return tasksFromEntries(entries)
    }
    case 'sessions-delete': {
      const sessions = selectedSessions(ids, snapshot.sessions)
      return tasksForSessionDeletion(sessions)
    }
    case 'generated-assets': {
      const index = new Map((snapshot.generatedAssets ?? []).map((asset) => [asset.id, asset]))
      return tasksForGeneratedAssets(ids.map((id) => index.get(id)).filter((asset) => asset !== undefined), snapshot.sessions)
    }
    case 'plugins': {
      const index = new Map(snapshot.pluginVersions.map((plugin) => [plugin.directoryURL, plugin]))
      const selected = ids.map((id) => index.get(id)).filter((plugin): plugin is PluginVersionItem =>
        !!plugin && (pluginStatusIsRemovable(plugin.status) || pluginVersionCanUninstall(plugin)))
      const uninstall = new Map<string, PluginVersionItem>()
      for (const plugin of selected.filter(pluginVersionCanUninstall)) {
        uninstall.set(pluginIdentity(plugin), plugin)
      }
      // Uninstall operates on the plugin identity, not one version directory. Do not
      // also schedule selected sibling versions for direct deletion: Codex owns the
      // plugin's complete cache once an uninstall has been selected.
      const versionTasks = tasksFromEntries(selected.filter((plugin) =>
        pluginStatusIsRemovable(plugin.status) && !uninstall.has(pluginIdentity(plugin))).map((plugin) => ({
        id: `remove:${plugin.directoryURL}`,
        title: `${plugin.plugin} · ${plugin.version}`,
        note: message(`pluginStatus.${plugin.status}`),
        tags: [],
        url: plugin.directoryURL,
        bytes: plugin.bytes,
        reclaimableBytes: plugin.bytes,
        minimumIdleSeconds: null,
        requiresCodexStopped: true,
        risk: 'safe' as const
      })))
      const uninstallTasks: CleanupTask[] = [...uninstall.values()].map((plugin) => ({
        id: `uninstall:${plugin.marketplace}:${plugin.plugin}`,
        title: plugin.plugin,
        detail: plugin.marketplace ?? '',
        url: plugin.directoryURL,
        expectedBytes: snapshot.pluginVersions
          .filter((candidate) => pluginIdentity(candidate) === pluginIdentity(plugin))
          .reduce((sum, candidate) => sum + candidate.bytes, 0),
        threadID: null,
        companionURLs: snapshot.pluginVersions
          .filter((candidate) => pluginIdentity(candidate) === pluginIdentity(plugin) && candidate.directoryURL !== plugin.directoryURL)
          .map((candidate) => candidate.directoryURL),
        minimumIdleSeconds: null,
        requiresCodexStopped: true,
        removal: 'codexPlugin',
        pluginName: plugin.plugin,
        pluginMarketplace: plugin.marketplace ?? undefined
      }))
      return [...versionTasks, ...uninstallTasks]
    }
    case 'worktrees': {
      if (typeof selection.deleteRelatedSessions !== 'boolean') throw new MessageError(message('error.invalidSelection'))
      // Only worktrees the latest scan proved Codex created; the guard checks the marker
      // again on disk before anything is removed.
      const index = new Map(snapshot.worktrees.map((worktree) => [worktree.id, worktree]))
      const selected = ids.map((id) => index.get(id))
        .filter((worktree): worktree is WorktreeItem => !!worktree && worktreeIsRemovable(worktree))
      const worktreeTasks = tasksForWorktrees(selected)
      if (!selection.deleteRelatedSessions) return worktreeTasks

      // Resolve references back to the latest trusted session snapshot. The renderer
      // chooses only whether related conversations are included; it never supplies a
      // rollout path or thread identity. Worktrees go first because thread/delete may
      // itself alter Codex's worktree metadata.
      const relatedSessions = snapshot.sessions.filter((session) =>
        selected.some((worktree) => sessionBelongsToWorktree(session, worktree)))
      const sessionTasks = groupedSessionDeletionTasks(
        relatedSessions, selected, sessionBelongsToWorktree, (worktree) => `worktree:${worktree.id}`)
      return [...worktreeTasks, ...sessionTasks]
    }
    case 'workspace': {
      if (typeof selection.deleteRelatedSessions !== 'boolean') throw new MessageError(message('error.invalidSelection'))
      const all = flattenWorkspace(workspace.entries)
      const selected = ids.map((id) => all.find((entry) => entry.id === id)).filter((entry): entry is WorkspaceFolder => !!entry)
      // Containment is judged on what each choice actually deletes: a date folder gives
      // up only its loose files, so choosing it no longer swallows the outputs below it.
      const outermost = selected.filter((entry) => !selected.some((other) => other !== entry &&
        workspaceDeletionTargets(other).some((target) => ProtectedPaths.contains(target, entry.path))))
      const workspaceTasks = tasksForWorkspace(outermost)
      if (!selection.deleteRelatedSessions) return workspaceTasks
      // Resolve related conversations against what is actually being deleted (`outermost`),
      // not the raw selection: a date folder chosen beside one of its outputs drops out of
      // `outermost`, so the conversation that ran in that output is not dragged in through
      // a folder whose deletion only takes loose files.
      const relatedSessions = snapshot.sessions.filter((session) =>
        outermost.some((entry) => sessionBelongsToWorkspaceFolder(session, entry)))
      const sessionTasks = groupedSessionDeletionTasks(
        relatedSessions, outermost, sessionBelongsToWorkspaceFolder, (entry) => `workspace:${entry.id}`)
      return [...workspaceTasks, ...sessionTasks]
    }
    default:
      throw new MessageError(message('error.unsupportedSelection'))
  }
}

function groupedSessionDeletionTasks<T>(
  sessions: SessionItem[],
  containers: T[],
  belongsTo: (session: SessionItem, container: T) => boolean,
  groupID: (container: T) => string
): CleanupTask[] {
  const sessionsByThreadID = new Map(sessions.map((session) => [session.threadID, session]))
  return tasksForSessionDeletion(sessions).map((task) => {
    const session = task.threadID ? sessionsByThreadID.get(task.threadID) : undefined
    const container = session ? containers.find((candidate) => belongsTo(session, candidate)) : undefined
    return container === undefined ? task : { ...task, resultGroupID: groupID(container) }
  })
}

function pluginIdentity(plugin: PluginVersionItem): string {
  return `${plugin.marketplace ?? ''}\0${plugin.plugin}`
}

export function makeCleanupPreview(
  selection: CleanupSelection,
  tasks: CleanupTask[],
  environment: CodexEnvironment,
  snapshot: ScanSnapshot | null = null,
  workspace: WorkspaceSnapshot | null = null
): CleanupPreview {
  const blocked = environment.running
    ? tasks.filter((task) => task.requiresCodexStopped)
    : []
  const unsafeWorktree = selection.kind === 'worktrees' && selectedWorktreesAreUnsafe(selection, snapshot)
  const uninstallsPlugin = selection.kind === 'plugins' && tasks.some((task) => task.removal === 'codexPlugin')
  // Keep the resource-specific consequence in the permanent-deletion notice so the
  // confirmation reads as one warning rather than two competing lines.
  const warning = selection.kind === 'workspace' || unsafeWorktree
    ? 'warning.permanentGit'
    : selection.kind === 'generated-assets'
      ? 'warning.permanentGeneratedAssetLocalCopy'
      : uninstallsPlugin
        ? 'warning.pluginManagement'
        : 'warning.permanent'
  const warnings: Message[] = [message(warning)]
  // A plan whose conversation is already gone may be the only surviving copy of that plan,
  // so say so before a manual delete removes it alongside the rest of the selection.
  if (selection.kind === 'generated-assets' && snapshot) {
    const ids = new Set(selection.ids)
    if (snapshot.generatedAssets.some((asset) => ids.has(asset.id) && asset.kind === 'plan' && asset.sourceSessionID === null)) {
      warnings.push(message('warning.planOnlyCopy'))
    }
  }
  // Pinning only holds off the scheduled run. Deleting one by hand is allowed, but the
  // confirmation says so rather than letting a pin quietly disappear.
  const pinned = pinnedSelection(selection, tasks, snapshot)
  if (pinned) warnings.push(message('warning.pinnedSessions', { count: pinned }))
  const items = cleanupPreviewItems(selection, tasks, snapshot, workspace)
  return {
    selection,
    items,
    expectedBytes: tasks.reduce((sum, task) => sum + task.expectedBytes, 0),
    blockedTitles: blocked.map((task) => task.title),
    codexRunning: environment.running,
    canQuitCodex: environment.canQuit,
    blockers: environment.blockers,
    warnings
  }
}

/**
 * Related conversations are an option on a worktree or workspace deletion, not separate
 * choices in the confirmation dialog. Keep one preview row per container (worktree or
 * workspace folder) and roll the bytes of each conversation deletion into the container
 * that referenced it.
 */
function cleanupPreviewItems(
  selection: CleanupSelection,
  tasks: CleanupTask[],
  snapshot: ScanSnapshot | null,
  workspace: WorkspaceSnapshot | null
): CleanupPreview['items'] {
  const item = (task: CleanupTask, expectedBytes = task.expectedBytes) => ({
    id: task.id,
    title: task.title,
    detail: task.detail,
    expectedBytes
  })
  const config = relatedContainerConfig(selection, snapshot, workspace)
  if (!config || !snapshot) return tasks.map((task) => item(task))

  const sessions = new Map(snapshot.sessions.map((session) => [session.threadID, session]))
  const conversationTasks = tasks.filter((task) => task.threadID !== null)
  const claimed = new Set<string>()
  return tasks.filter(config.isContainer).map((task) => {
    const container = config.resolve(task)
    const relatedBytes = conversationTasks.reduce((sum, conversation) => {
      const session = conversation.threadID ? sessions.get(conversation.threadID) : undefined
      if (!container || !session || !config.belongsTo(session, container) || claimed.has(conversation.id)) return sum
      claimed.add(conversation.id)
      return sum + conversation.expectedBytes
    }, 0)
    return item(task, task.expectedBytes + relatedBytes)
  })
}

interface RelatedContainer {
  isContainer: (task: CleanupTask) => boolean
  resolve: (task: CleanupTask) => WorktreeItem | WorkspaceFolder | undefined
  belongsTo: (session: SessionItem, container: WorktreeItem | WorkspaceFolder) => boolean
}

/** Tells `cleanupPreviewItems` how to find the container each related conversation rolls
 *  into. Worktrees resolve by `task.url`; workspace folders by the `workspace:`-prefixed
 *  task id, because a workspace row is identified by its path, not a single URL. Each
 *  branch's `resolve` only ever returns its own container type, so the cast inside
 *  `belongsTo` is narrowed to that type. */
function relatedContainerConfig(
  selection: CleanupSelection,
  snapshot: ScanSnapshot | null,
  workspace: WorkspaceSnapshot | null
): RelatedContainer | null {
  if (selection.kind === 'worktrees' && selection.deleteRelatedSessions && snapshot) {
    const worktrees = new Map(snapshot.worktrees.map((worktree) => [worktree.id, worktree]))
    return {
      isContainer: (task) => task.removal === 'gitWorktree',
      resolve: (task) => worktrees.get(task.url),
      belongsTo: (session, container) => sessionBelongsToWorktree(session, container as WorktreeItem)
    }
  }
  if (selection.kind === 'workspace' && selection.deleteRelatedSessions && workspace) {
    const entries = new Map(flattenWorkspace(workspace.entries).map((entry) => [entry.id, entry]))
    return {
      isContainer: (task) => task.id.startsWith('workspace:'),
      resolve: (task) => entries.get(task.id.slice('workspace:'.length)),
      belongsTo: (session, container) => sessionBelongsToWorkspaceFolder(session, container as WorkspaceFolder)
    }
  }
  return null
}

/** Match both indexes Codex gives us. The state database supplies thread IDs for labels,
 * while the rollout is the authority for the working directory that will be deleted. */
function sessionBelongsToWorktree(session: SessionItem, worktree: WorktreeItem): boolean {
  if (worktree.sourceThreads.some((thread) => thread.id === session.threadID)) return true
  return !!session.workingDirectory && ProtectedPaths.contains(worktree.path, session.workingDirectory)
}

/** A conversation belongs to a workspace row when the thread index put it there, or when
 *  its working directory sits inside what that row's checkbox actually removes. The path
 *  test uses `workspaceDeletionTargets`, not `entry.path`, on purpose: a date folder gives
 *  up only its loose files, and a conversation whose output is a child directory below it
 *  must not be dragged in — its working directory cannot lie beneath one of those loose
 *  files, so the date row correctly only takes conversations the index tied to it directly. */
function sessionBelongsToWorkspaceFolder(session: SessionItem, entry: WorkspaceFolder): boolean {
  if (entry.sourceThreads.some((thread) => thread.id === session.threadID)) return true
  return !!session.workingDirectory && workspaceDeletionTargets(entry)
    .some((target) => ProtectedPaths.contains(target, session.workingDirectory!))
}

export function buildAutomaticTasks(
  snapshot: ScanSnapshot,
  settings: AutomationSettings,
  now = Date.now()
): CleanupTask[] {
  const entries = snapshot.categories.flatMap((category) => {
    if (settings.cleanOldPlugins && category.kind === 'pluginRemnants') return category.entries
    if (settings.cleanCaches && category.group === 'recommended' && AUTOMATIC_CACHE_KINDS.has(category.kind)) return category.entries
    return []
  })
  // Subagents are part of their visible root conversation and must never be aged out
  // independently. The root deletion task already carries every descendant path.
  const sessions = listableSessions(snapshot).filter((session) => {
    if (session.isUnstable) return false
    if (session.blocksAutomaticCleanup) return false
    if (settings.skipRecentSessions && now - session.modifiedAt < 86_400_000) return false
    const days = Math.max(1, session.location === 'archived' ? settings.archivedRetentionDays : settings.activeRetentionDays)
    const enabled = session.location === 'archived' ? settings.cleanArchivedSessions : settings.cleanActiveSessions
    return enabled && now - session.modifiedAt >= days * 86_400_000
  })
  return [
    ...tasksFromEntries(entries.filter((entry) => isSelectable(entry.risk))),
    ...tasksForSessionDeletion(sessions)
  ]
}

function selectedWorktreesAreUnsafe(selection: CleanupSelection, snapshot: ScanSnapshot | null): boolean {
  if (selection.kind !== 'worktrees' || !snapshot) return false
  const ids = new Set(selection.ids)
  return snapshot.worktrees.some((worktree) => ids.has(worktree.id) && worktreeIsUnsafe(worktree))
}

function pinnedSelection(selection: CleanupSelection, tasks: CleanupTask[], snapshot: ScanSnapshot | null): number {
  if (!snapshot) return 0
  const relatedDeletion = (selection.kind === 'worktrees' && selection.deleteRelatedSessions) ||
    (selection.kind === 'workspace' && selection.deleteRelatedSessions)
  if (selection.kind !== 'sessions-delete' && !relatedDeletion) return 0
  const selected = new Set(tasks.flatMap((task) => task.threadID ? [task.threadID] : []))
  return snapshot.sessions.filter((session) => session.isPinned && selected.has(session.threadID)).length
}

function safeIDs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10_000 || value.some((id) => typeof id !== 'string')) {
    throw new MessageError(message('error.invalidSelection'))
  }
  return [...new Set(value as string[])]
}

function selectedSessions(ids: string[], sessions: SessionItem[]): SessionItem[] {
  const index = new Map(sessions.map((session) => [session.id, session]))
  return ids.map((id) => index.get(id)).filter((session): session is SessionItem => !!session)
}

function flattenWorkspace(entries: WorkspaceFolder[]): WorkspaceFolder[] {
  return entries.flatMap((entry) => [entry, ...flattenWorkspace(entry.children)])
}
