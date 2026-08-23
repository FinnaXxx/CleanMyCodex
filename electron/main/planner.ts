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
  WorkspaceSnapshot
} from '../../shared/types'
import {
  isSelectable,
  listableSessions,
  pluginStatusIsRemovable,
  tasksForSessionDeletion,
  tasksForWorkspace,
  tasksFromEntries,
  workspaceDeletionTargets
} from '../../shared/types'
import { ProtectedPaths } from './guard'
import type { CodexEnvironment } from './platform-services'
import { MessageError, message, type Message } from '../../shared/messages'

const AUTOMATIC_CACHE_KINDS = new Set(['temporary', 'browserCache', 'appCache', 'appLogs'])

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
    case 'plugins': {
      const index = new Map(snapshot.pluginVersions.map((plugin) => [plugin.directoryURL, plugin]))
      const selected = ids.map((id) => index.get(id)).filter((plugin): plugin is PluginVersionItem => !!plugin && pluginStatusIsRemovable(plugin.status))
      return tasksFromEntries(selected.map((plugin) => ({
        id: `remove:${plugin.directoryURL}`,
        title: `${plugin.plugin} · ${plugin.version}`,
        note: message(`pluginStatus.${plugin.status}`),
        tags: [],
        url: plugin.directoryURL,
        bytes: plugin.bytes,
        reclaimableBytes: plugin.bytes,
        minimumIdleSeconds: null,
        requiresCodexStopped: false,
        risk: 'safe' as const
      })))
    }
    case 'workspace': {
      const all = flattenWorkspace(workspace.entries)
      const selected = ids.map((id) => all.find((entry) => entry.id === id)).filter((entry): entry is WorkspaceFolder => !!entry)
      // Containment is judged on what each choice actually deletes: a date folder gives
      // up only its loose files, so choosing it no longer swallows the outputs below it.
      const outermost = selected.filter((entry) => !selected.some((other) => other !== entry &&
        workspaceDeletionTargets(other).some((target) => ProtectedPaths.contains(target, entry.path))))
      return tasksForWorkspace(outermost)
    }
    default:
      throw new MessageError(message('error.unsupportedSelection'))
  }
}

export function makeCleanupPreview(
  selection: CleanupSelection,
  tasks: CleanupTask[],
  environment: CodexEnvironment,
  snapshot: ScanSnapshot | null = null
): CleanupPreview {
  const blocked = environment.running
    ? tasks.filter((task) => task.requiresCodexStopped)
    : []
  // Deletion is permanent for every selection, so the preview always says so first.
  const warnings: Message[] = [message('warning.permanent')]
  if (selection.kind === 'workspace') warnings.push(message('warning.workspaceGit'))
  // Pinning only holds off the scheduled run. Deleting one by hand is allowed, but the
  // confirmation says so rather than letting a pin quietly disappear.
  const pinned = pinnedSelection(selection, tasks, snapshot)
  if (pinned) warnings.push(message('warning.pinnedSessions', { count: pinned }))
  return {
    selection,
    items: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      detail: task.detail,
      expectedBytes: task.expectedBytes
    })),
    expectedBytes: tasks.reduce((sum, task) => sum + task.expectedBytes, 0),
    blockedTitles: blocked.map((task) => task.title),
    codexRunning: environment.running,
    canRestartCodex: environment.canRestart,
    blockers: environment.blockers,
    warnings
  }
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

function pinnedSelection(selection: CleanupSelection, tasks: CleanupTask[], snapshot: ScanSnapshot | null): number {
  if (selection.kind !== 'sessions-delete' || !snapshot) return 0
  const selected = new Set(tasks.map((task) => task.id))
  return snapshot.sessions.filter((session) => session.isPinned && selected.has(session.id)).length
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
