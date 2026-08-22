import { lstatSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CleanupTask,
  CleanupOutcome,
  CleanupReport,
  CleanupStatus
} from '../../shared/types'
import { ProtectedPaths, ProtectedPathError } from './guard'
import { directoryAllocatedSize } from './fs-size'

export interface CleanupDeps {
  /** Move a file or directory to the OS trash. Injected so the engine stays testable. */
  trash: (path: string) => Promise<void>
  /** Whether Codex is currently running — gates work that needs it fully stopped. */
  isCodexRunning: () => boolean
  sessionDatabase?: {
    preflightDelete?: (threadID: string, relatedURLs: string[]) => void
    deleteThreadWithProtocol?: (threadID: string, relatedURLs: string[]) => Promise<boolean>
    deleteThreadLocally: (threadID: string, relatedURLs: string[]) => { removedRows: number; freedBytes: number }
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
 * Database compaction is deliberately narrow and runs only after the same protected-path
 * validation as trash cleanup.
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
  }
}

async function runTrash(
  task: CleanupTask,
  guards: ProtectedPaths,
  deps: CleanupDeps,
  codexRunning: boolean
): Promise<CleanupOutcome> {
  if (task.requiresCodexStopped && codexRunning) {
    return outcome(task, { kind: 'skipped', reason: 'Codex 正在运行，请退出后重新清理' }, 0)
  }
  if (task.minimumIdleSeconds !== null && Date.now() - latestActivity(task.url) < task.minimumIdleSeconds * 1000) {
    return outcome(task, { kind: 'skipped', reason: '扫描后路径又有写入，请稍后重新扫描并清理' }, 0)
  }

  const targets = [task.url, ...task.companionURLs]
  try {
    for (const target of targets) guards.validate(target)
  } catch (err) {
    return outcome(task, { kind: 'failed', reason: errorMessage(err) }, 0)
  }
  let freed = 0
  const bytesBefore = new Map(targets.map((target) => [target, fileAllocated(target)]))
  let protocolDeleted = false
  if (task.threadID && deps.sessionDatabase?.deleteThreadWithProtocol) {
    try {
      // Codex's protocol needs the rollout to still exist and permanently deletes it.
      protocolDeleted = await deps.sessionDatabase.deleteThreadWithProtocol(task.threadID, targets)
    } catch { /* use the compatibility path below */ }
  }
  if (task.threadID && deps.sessionDatabase && !protocolDeleted) {
    try {
      // Only the direct-database fallback depends on our known SQLite schemas.
      // A newer official protocol must not be blocked by an older local preflight.
      deps.sessionDatabase.preflightDelete?.(task.threadID, targets)
    } catch (err) {
      return outcome(task, { kind: 'failed', reason: errorMessage(err) }, 0)
    }
  }
  for (const target of targets) {
    if (!pathExists(target)) {
      // The official thread/delete protocol may already have removed the rollout.
      if (protocolDeleted) freed += bytesBefore.get(target) ?? 0
      continue
    }
    try {
      await deps.trash(target)
      freed += bytesBefore.get(target) ?? 0
    } catch (err) {
      if (err instanceof ProtectedPathError) {
        return outcome(task, { kind: 'failed', reason: err.message }, freed)
      }
      return outcome(task, { kind: 'failed', reason: errorMessage(err) }, freed)
    }
  }
  let removedRows = protocolDeleted ? 1 : 0
  if (task.threadID && deps.sessionDatabase && !protocolDeleted) {
    try {
      const report = deps.sessionDatabase.deleteThreadLocally(task.threadID, targets)
      removedRows = report.removedRows
      freed += report.freedBytes
    } catch (err) {
      return outcome(task, { kind: 'failed', reason: `会话文件已处理，但本地索引清理失败：${errorMessage(err)}` }, freed)
    }
  }
  if (freed === 0 && removedRows === 0) {
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
