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
  PluginStatusLabel,
  pluginStatusIsRemovable,
  tasksForSessionDeletion,
  tasksForWorkspace,
  tasksFromEntries
} from '../../shared/types'
import { ProtectedPaths } from './guard'
import type { CodexEnvironment } from './platform-services'

const AUTOMATIC_CACHE_KINDS = new Set(['temporary', 'browserCache', 'appCache', 'appLogs'])

export function buildTrustedTasks(
  selection: CleanupSelection,
  snapshot: ScanSnapshot,
  workspace: WorkspaceSnapshot
): CleanupTask[] {
  if (!selection || typeof selection !== 'object' || typeof selection.kind !== 'string') throw new Error('清理选择无效')
  const ids = safeIDs(selection.ids)
  switch (selection.kind) {
    case 'storage': {
      const index = new Map(snapshot.categories.flatMap((category) => category.entries).map((entry) => [entry.id, entry]))
      const entries = ids.map((id) => index.get(id)).filter((entry): entry is StorageEntry => !!entry && isSelectable(entry.risk))
      return tasksFromEntries(entries)
    }
    case 'sessions-delete': {
      const sessions = selectedSessions(ids, snapshot.sessions)
      return tasksForSessionDeletion(sessions)
    }
    case 'plugins': {
      const index = new Map(snapshot.pluginVersions.map((plugin) => [plugin.directoryURL, plugin]))
      const selected = ids.map((id) => index.get(id)).filter((plugin): plugin is PluginVersionItem => !!plugin && pluginStatusIsRemovable(plugin.status))
      const entries = selected.map((plugin) => ({
        id: `trash:${plugin.directoryURL}`,
        title: `${plugin.plugin} · ${plugin.version}`,
        detail: PluginStatusLabel[plugin.status],
        tags: [],
        url: plugin.directoryURL,
        bytes: plugin.bytes,
        reclaimableBytes: plugin.bytes,
        minimumIdleSeconds: null,
        requiresCodexStopped: false,
        method: 'trash' as const,
        risk: 'safe' as const
      }))
      return tasksFromEntries(entries)
    }
    case 'workspace': {
      const all = flattenWorkspace(workspace.entries)
      const selected = ids.map((id) => all.find((entry) => entry.id === id)).filter((entry): entry is WorkspaceFolder => !!entry)
      const outermost = selected.filter((entry) => !selected.some((parent) => parent !== entry && ProtectedPaths.contains(parent.path, entry.path)))
      return tasksForWorkspace(outermost)
    }
    default:
      throw new Error('不支持的清理类型')
  }
}

export function makeCleanupPreview(
  selection: CleanupSelection,
  tasks: CleanupTask[],
  environment: CodexEnvironment
): CleanupPreview {
  const blocked = environment.running
    ? tasks.filter((task) => task.requiresCodexStopped)
    : []
  const warnings: string[] = []
  if (selection.kind === 'sessions-delete') {
    warnings.push('会话文件、生成资产和 SQLite 索引记录会一并清理。')
  }
  if (selection.kind === 'workspace') warnings.push('请确认未提交或未推送的内容已经保存。')
  return {
    selection,
    items: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      detail: task.detail,
      method: task.method,
      expectedBytes: task.expectedBytes
    })),
    expectedBytes: tasks.reduce((sum, task) => sum + task.expectedBytes, 0),
    blockedTitles: blocked.map((task) => task.title),
    codexRunning: environment.running,
    canRestartCodex: environment.canRestart,
    blockerSummary: environment.blockerSummary,
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

function safeIDs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10_000 || value.some((id) => typeof id !== 'string')) {
    throw new Error('清理选择无效')
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
