import { lstatSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CleanupTask,
  CleanupOutcome,
  CleanupReport,
  CleanupStatus
} from '../../shared/types'
import { ProtectedPaths, ProtectedPathError } from './guard'
import { compactDatabase } from './sqlite-maintenance'
import { slimSession } from './session-slimmer'
import { directoryAllocatedSize } from './fs-size'
import type { FileUsage } from './platform-services'

export interface CleanupDeps {
  /** Move a file or directory to the OS trash. Injected so the engine stays testable. */
  trash: (path: string) => Promise<void>
  /** Whether Codex is currently running — gates work that needs it fully stopped. */
  isCodexRunning: () => boolean
  /** Whether one exact rollout/database is open. */
  fileUsage?: (path: string) => FileUsage
  /** Codex app server, used to delete threads cleanly (drops derived metadata + children). */
  appServer: {
    isAvailable: boolean
    deleteThread: (threadID: string) => Promise<void>
  }
}

export interface CleanupProgress {
  completed: number
  total: number
  currentTitle: string
}

function pathExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function latestActivity(path: string): number {
  let stats
  try { stats = lstatSync(path) } catch { return 0 }
  if (stats.isSymbolicLink()) return stats.mtimeMs
  let latest = stats.mtimeMs
  if (!stats.isDirectory()) return latest
  let names: string[] = []
  try { names = readdirSync(path) } catch { return latest }
  for (const name of names) latest = Math.max(latest, latestActivity(join(path, name)))
  return latest
}

/**
 * Performs the cleanup. Every task passes the protected-path guard first, and ordinary
 * files are moved to the trash so a mistake is always recoverable.
 *
 * Database compaction and rollout rewriting are deliberately narrow operations and run
 * only after the same protected-path validation as trash cleanup.
 */
export async function runCleanup(
  tasks: CleanupTask[],
  guards: ProtectedPaths,
  deps: CleanupDeps,
  onProgress?: (progress: CleanupProgress) => void
): Promise<CleanupReport> {
  const startedAt = Date.now()
  const outcomes: CleanupOutcome[] = []
  const running = deps.isCodexRunning()

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]
    onProgress?.({ completed: i, total: tasks.length, currentTitle: task.title })

    outcomes.push(await runOne(task, guards, deps, running))
  }

  onProgress?.({ completed: tasks.length, total: tasks.length, currentTitle: '' })
  return { startedAt, finishedAt: Date.now(), outcomes }
}

async function runOne(
  task: CleanupTask,
  guards: ProtectedPaths,
  deps: CleanupDeps,
  codexRunning: boolean
): Promise<CleanupOutcome> {
  switch (task.method) {
    case 'trash':
      return runTrash(task, guards, deps, codexRunning)
    case 'compactDatabase':
      return runCompactDatabase(task, guards, deps, codexRunning)
    case 'deleteThread':
      return runDeleteThread(task, guards, deps)
    case 'slimSession':
      return runSlimSession(task, guards, deps, codexRunning)
  }
}

async function runTrash(
  task: CleanupTask,
  guards: ProtectedPaths,
  deps: CleanupDeps,
  codexRunning: boolean
): Promise<CleanupOutcome> {
  if (task.requiresCodexStopped && codexRunning) {
    return outcome(task, { kind: 'skipped', reason: 'Codex 正在运行，暂存目录可能正在使用' }, 0)
  }
  if (task.minimumIdleSeconds !== null && Date.now() - latestActivity(task.url) < task.minimumIdleSeconds * 1000) {
    return outcome(task, { kind: 'skipped', reason: '扫描后路径又有写入，已推迟清理' }, 0)
  }

  const targets = [task.url, ...task.companionURLs]
  let freed = 0
  for (const target of targets) {
    if (!pathExists(target)) continue
    try {
      guards.validate(target)
      const bytes = fileAllocated(target)
      await deps.trash(target)
      freed += bytes
    } catch (err) {
      if (err instanceof ProtectedPathError) {
        return outcome(task, { kind: 'failed', reason: err.message }, freed)
      }
      return outcome(task, { kind: 'failed', reason: errorMessage(err) }, freed)
    }
  }
  if (freed === 0) {
    return outcome(task, { kind: 'skipped', reason: '路径已不存在' }, 0)
  }
  return outcome(task, { kind: 'succeeded' }, freed)
}

function runCompactDatabase(
  task: CleanupTask,
  guards: ProtectedPaths,
  deps: CleanupDeps,
  codexRunning: boolean
): CleanupOutcome {
  if (!pathExists(task.url)) return outcome(task, { kind: 'skipped', reason: '路径已不存在' }, 0)
  const usage = deps.fileUsage?.(task.url) ?? { kind: 'unknown' as const }
  if (usage.kind === 'inUse') {
    return outcome(task, { kind: 'skipped', reason: `数据库正在被使用（${usage.processes.join('、')}）` }, 0)
  }
  if (usage.kind === 'unknown' && codexRunning) {
    return outcome(task, { kind: 'skipped', reason: '无法确认数据库是否被占用，Codex 正在运行，压缩已推迟' }, 0)
  }
  try {
    guards.validate(task.url)
    const report = compactDatabase(task.url)
    return outcome(task, { kind: 'succeeded' }, report.freedBytes)
  } catch (err) {
    return outcome(task, { kind: 'failed', reason: errorMessage(err) }, 0)
  }
}

async function runSlimSession(
  task: CleanupTask,
  guards: ProtectedPaths,
  deps: CleanupDeps,
  codexRunning: boolean
): Promise<CleanupOutcome> {
  if (!task.slimMode) return outcome(task, { kind: 'failed', reason: '缺少会话瘦身模式' }, 0)
  if (!pathExists(task.url)) return outcome(task, { kind: 'skipped', reason: '路径已不存在' }, 0)
  const usage = deps.fileUsage?.(task.url) ?? { kind: 'unknown' as const }
  if (usage.kind === 'inUse') {
    return outcome(task, { kind: 'skipped', reason: `这个会话正在被使用（${usage.processes.join('、')}）` }, 0)
  }
  if (usage.kind === 'unknown' && codexRunning) {
    return outcome(task, { kind: 'skipped', reason: '无法确认会话是否正在写入，Codex 正在运行，本次跳过' }, 0)
  }
  try {
    guards.validate(task.url)
    const report = await slimSession(task.url, task.slimMode, deps.trash)
    return outcome(task, { kind: 'succeeded' }, report.freedBytes)
  } catch (err) {
    return outcome(task, { kind: 'failed', reason: errorMessage(err) }, 0)
  }
}

/**
 * Delete a session through the app server when available — that also drops the derived
 * metadata and spawned child threads — then trash anything left behind (the rollout file
 * and its generated-image assets). Falls back to trashing directly when there is no
 * `codex` CLI.
 */
async function runDeleteThread(
  task: CleanupTask,
  guards: ProtectedPaths,
  deps: CleanupDeps
): Promise<CleanupOutcome> {
  const targets = [task.url, ...task.companionURLs]
  const beforeBytes = targets.filter(pathExists).reduce((sum, t) => sum + fileAllocated(t), 0)
  let deletedThroughAppServer = false

  try {
    for (const target of targets) guards.validate(target)
  } catch (err) {
    return outcome(task, { kind: 'failed', reason: errorMessage(err) }, 0)
  }

  if (!task.threadID) return outcome(task, { kind: 'failed', reason: '缺少会话 ID' }, 0)
  if (!deps.appServer.isAvailable) return outcome(task, { kind: 'failed', reason: '没有连接到 codex app server' }, 0)
  try {
    await deps.appServer.deleteThread(task.threadID)
    deletedThroughAppServer = true
  } catch (err) {
    return outcome(task, { kind: 'failed', reason: errorMessage(err) }, 0)
  }

  let freed = 0
  for (const target of targets) {
    if (!pathExists(target)) continue
    try {
      guards.validate(target)
      const bytes = fileAllocated(target)
      await deps.trash(target)
      freed += bytes
    } catch (err) {
      if (err instanceof ProtectedPathError) {
        return outcome(task, { kind: 'failed', reason: err.message }, freed)
      }
      return outcome(task, { kind: 'failed', reason: errorMessage(err) }, freed)
    }
  }

  const afterBytes = targets.filter(pathExists).reduce((sum, t) => sum + fileAllocated(t), 0)
  freed = Math.max(0, beforeBytes - afterBytes)
  if (freed === 0 && !deletedThroughAppServer) {
    return outcome(task, { kind: 'skipped', reason: '路径已不存在' }, 0)
  }
  return outcome(task, { kind: 'succeeded' }, freed)
}

function outcome(task: CleanupTask, status: CleanupStatus, freedBytes: number): CleanupOutcome {
  return {
    id: task.id,
    title: task.title,
    detail: task.detail,
    method: task.method,
    status,
    freedBytes
  }
}

function fileAllocated(path: string): number {
  try {
    const stats = lstatSync(path)
    if (stats.isDirectory()) return directoryAllocatedSize(path)
    const allocated = stats.blocks * 512
    return allocated > 0 ? allocated : stats.size
  } catch { return 0 }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
