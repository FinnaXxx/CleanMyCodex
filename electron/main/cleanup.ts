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
import { directoryAllocatedSize } from './fs-size'
import type { FileUsage } from './platform-services'

export interface CleanupDeps {
  /** Move a file or directory to the OS trash. Injected so the engine stays testable. */
  trash: (path: string) => Promise<void>
  /** Whether Codex is currently running — gates work that needs it fully stopped. */
  isCodexRunning: () => boolean
  /** Whether one exact rollout/database is open. */
  fileUsage?: (path: string) => FileUsage
  sessionDatabase?: {
    preflightDelete?: (threadID: string) => void
    deleteThread: (threadID: string) => { removedRows: number; freedBytes: number }
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
    case 'compactDatabase':
      return runCompactDatabase(task, guards, deps, codexRunning)
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
    if (task.threadID) deps.sessionDatabase?.preflightDelete?.(task.threadID)
  } catch (err) {
    return outcome(task, { kind: 'failed', reason: errorMessage(err) }, 0)
  }
  let freed = 0
  for (const target of targets) {
    if (!pathExists(target)) continue
    try {
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
  let removedRows = 0
  if (task.threadID && deps.sessionDatabase) {
    try {
      const report = deps.sessionDatabase.deleteThread(task.threadID)
      removedRows = report.removedRows
      freed += report.freedBytes
    } catch (err) {
      return outcome(task, { kind: 'failed', reason: `会话文件已处理，但 SQLite 记录清理失败：${errorMessage(err)}` }, freed)
    }
  }
  if (freed === 0 && removedRows === 0) {
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
    return outcome(task, { kind: 'skipped', reason: '无法确认数据库是否被占用，请退出 Codex 后重新清理' }, 0)
  }
  try {
    guards.validate(task.url)
    const report = compactDatabase(task.url)
    return outcome(task, { kind: 'succeeded' }, report.freedBytes)
  } catch (err) {
    return outcome(task, { kind: 'failed', reason: errorMessage(err) }, 0)
  }
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
