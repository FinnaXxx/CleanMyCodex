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
  pluginStatusIsRemovable,
  tasksForSessionDeletion,
  tasksForSessionSlimming,
  tasksForWorkspace,
  tasksFromEntries
} from '../../shared/types'
import { ProtectedPaths } from './guard'
import type { CodexEnvironment } from './platform-services'

const AUTOMATIC_CACHE_KINDS = new Set(['temporary', 'logDatabase', 'browserCache', 'appCache', 'appLogs'])

export function buildTrustedTasks(
  selection: CleanupSelection,
  snapshot: ScanSnapshot,
  workspace: WorkspaceSnapshot,
  appServerAvailable: boolean
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
      if (selection.mode !== 'appServer' && selection.mode !== 'trash') throw new Error('会话删除方式无效')
      const sessions = selectedSessions(ids, snapshot.sessions)
      const mode = selection.mode === 'appServer' && appServerAvailable ? 'appServer' : 'trash'
      return tasksForSessionDeletion(sessions, mode)
    }
    case 'sessions-slim': {
      if (selection.mode !== 'deduplicate' && selection.mode !== 'stripAll') throw new Error('会话瘦身方式无效')
      const sessions = selectedSessions(ids, snapshot.sessions).filter((session) => !session.isCompressed && !session.isUnstable)
      return tasksForSessionSlimming(sessions, selection.mode).filter((task) => task.expectedBytes > 0)
    }
    case 'plugins': {
      const index = new Map(snapshot.pluginVersions.map((plugin) => [plugin.directoryURL, plugin]))
      const selected = ids.map((id) => index.get(id)).filter((plugin): plugin is PluginVersionItem => !!plugin && pluginStatusIsRemovable(plugin.status))
      const entries = selected.map((plugin) => ({
        id: `trash:${plugin.directoryURL}`,
        title: `${plugin.plugin} · ${plugin.version}`,
        detail: plugin.status,
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
    ? tasks.filter((task) => task.requiresCodexStopped || task.method === 'compactDatabase')
    : []
  const warnings: string[] = []
  if (selection.kind === 'sessions-delete' && tasks.some((task) => task.method === 'trash')) {
    warnings.push('直接移到废纸篓不会更新 Codex 的会话索引，历史列表里可能暂时保留打不开的记录。')
  }
  if (selection.kind === 'sessions-slim') {
    warnings.push('会话文件会被改写；原文件先移到废纸篓，校验通过后才替换。')
  }
  if (selection.kind === 'workspace') warnings.push('这些目录是用户成果，不是缓存；请确认未提交和未推送的内容已经妥善保存。')
  if (tasks.some((task) => task.method === 'compactDatabase')) warnings.push('日志数据库只做 checkpoint 与 VACUUM，不删除诊断记录。')
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
  appServerAvailable: boolean,
  now = Date.now()
): CleanupTask[] {
  const entries = snapshot.categories.flatMap((category) => {
    if (settings.cleanOldPlugins && category.kind === 'pluginRemnants') return category.entries
    if (settings.cleanCaches && category.group === 'recommended' && AUTOMATIC_CACHE_KINDS.has(category.kind)) return category.entries
    return []
  })
  const sessions = snapshot.sessions.filter((session) => {
    if (session.isUnstable) return false
    if (settings.skipRecentSessions && now - session.modifiedAt < 86_400_000) return false
    const days = Math.max(1, session.location === 'archived' ? settings.archivedRetentionDays : settings.activeRetentionDays)
    const enabled = session.location === 'archived' ? settings.cleanArchivedSessions : settings.cleanActiveSessions
    return enabled && now - session.modifiedAt >= days * 86_400_000
  })
  return [
    ...tasksFromEntries(entries.filter((entry) => isSelectable(entry.risk))),
    ...tasksForSessionDeletion(sessions, appServerAvailable ? 'appServer' : 'trash')
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
