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
import { decodeMessage, message, type Message } from '../../shared/messages'

export interface CleanupDeps {
  /** Move a file or directory to the OS trash. Injected so the engine stays testable. */
  trash: (path: string) => Promise<void>
  /** Whether Codex is currently running — gates work that needs it fully stopped. */
  isCodexRunning: () => boolean
  sessionDatabase?: {
    preflightDelete?: (threadID: string, relatedURLs: string[]) => void
    deleteThread: (threadID: string, relatedURLs: string[]) => { removedRows: number; freedBytes: number }
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
 * Performs the cleanup. Every task passes the protected-path guard first, and files are
 * moved to the trash so a mistake is always recoverable.
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

    outcomes.push(await runTrash(task, guards, deps, running))
  }

  onProgress?.({ completed: tasks.length, total: tasks.length, currentTitle: '' })
  return { startedAt, finishedAt: Date.now(), outcomes }
}

async function runTrash(
  task: CleanupTask,
  guards: ProtectedPaths,
  deps: CleanupDeps,
  codexRunning: boolean
): Promise<CleanupOutcome> {
  if (task.requiresCodexStopped && codexRunning) {
    return outcome(task, { kind: 'skipped', reason: message('cleanup.skipCodexRunning') }, 0)
  }
  if (task.minimumIdleSeconds !== null && Date.now() - latestActivity(task.url) < task.minimumIdleSeconds * 1000) {
    return outcome(task, { kind: 'skipped', reason: message('cleanup.skipRecentlyWritten') }, 0)
  }

  const targets = [task.url, ...task.companionURLs]
  try {
    for (const target of targets) guards.validate(target)
    if (task.threadID) deps.sessionDatabase?.preflightDelete?.(task.threadID, targets)
  } catch (err) {
    return outcome(task, { kind: 'failed', reason: failure(err) }, 0)
  }
  let freed = 0
  let trashed = 0
  for (const target of targets) {
    if (!pathExists(target)) continue
    try {
      const bytes = fileAllocated(target)
      await deps.trash(target)
      trashed += 1
      freed += bytes
    } catch (err) {
      return outcome(task, { kind: 'failed', reason: failure(err) }, freed)
    }
  }
  let removedRows = 0
  if (task.threadID && deps.sessionDatabase) {
    try {
      const report = deps.sessionDatabase.deleteThread(task.threadID, targets)
      removedRows = report.removedRows
      freed += report.freedBytes
    } catch (err) {
      return outcome(task, { kind: 'failed', reason: message('cleanup.sqliteFailed', { reason: errorText(err) }) }, freed)
    }
  }
  if (trashed === 0 && removedRows === 0) {
    return outcome(task, { kind: 'skipped', reason: message('cleanup.skipMissing') }, 0)
  }
  return outcome(task, { kind: 'succeeded' }, freed)
}

function outcome(task: CleanupTask, status: CleanupStatus, freedBytes: number): CleanupOutcome {
  return {
    id: task.id,
    title: task.title,
    detail: task.detail,
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

/** A guard rejection already carries a `Message`; anything else keeps its own text. */
function failure(err: unknown): Message {
  if (err instanceof ProtectedPathError) return err.info
  const decoded = err instanceof Error ? decodeMessage(err.message) : null
  return decoded ?? message('error.verbatim', { text: errorText(err) })
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
