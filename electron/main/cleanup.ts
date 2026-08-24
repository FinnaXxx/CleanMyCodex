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
  /** Permanently delete a file or directory. Injected so the engine stays testable. */
  remove: (path: string) => Promise<void>
  /**
   * Take down a git worktree through git itself. The checkout cannot simply be deleted:
   * git keeps its administrative data inside the user's own repository, outside every
   * root this app may write to, so removing the directory alone would leave the
   * repository listing a worktree that is no longer there.
   */
  removeWorktree?: (path: string, repositoryPath: string | null) => Promise<void>
  /** Whether Codex is currently running — gates work that needs it fully stopped. */
  isCodexRunning: () => boolean
  sessionDatabase?: {
    preflightDelete?: (threadID: string, relatedURLs: string[]) => void
    deleteThreadWithProtocol?: (threadID: string, relatedURLs: string[]) => Promise<boolean>
    deleteThreadLocally: (threadID: string, relatedURLs: string[]) => { removedRows: number; freedBytes: number }
    /** Reports metadata the protocol claimed to delete but left behind. */
    reportProtocolLeftovers?: (threadID: string, removedRows: number, reason: string | null) => void
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
 * Performs the cleanup. Deletion is permanent, so the protected-path guard is the safety
 * net: every target, including every companion, is validated before anything is removed,
 * and a task naming even one protected path fails as a whole without deleting.
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

    outcomes.push(await runRemoval(task, guards, deps, running))
  }

  onProgress?.({ completed: tasks.length, total: tasks.length, currentTitle: '' })
  return { startedAt, finishedAt: Date.now(), outcomes }
}

async function runRemoval(
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
  } catch (err) {
    return outcome(task, { kind: 'failed', reason: failure(err) }, 0)
  }
  let freed = 0
  // Counts targets this task actually removed, by protocol or directly. Bytes cannot
  // stand in for that: an emptied directory is removed while freeing nothing.
  let removed = 0
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
      return outcome(task, { kind: 'failed', reason: failure(err) }, 0)
    }
  }
  for (const target of targets) {
    if (!pathExists(target)) {
      // The official thread/delete protocol may already have removed the rollout.
      if (protocolDeleted) { removed += 1; freed += bytesBefore.get(target) ?? 0 }
      continue
    }
    try {
      if (task.removal === 'gitWorktree' && deps.removeWorktree) {
        await deps.removeWorktree(target, task.repositoryPath ?? null)
      } else {
        await deps.remove(target)
      }
      removed += 1
      freed += bytesBefore.get(target) ?? 0
    } catch (err) {
      return outcome(task, { kind: 'failed', reason: failure(err) }, freed)
    }
  }
  let removedRows = protocolDeleted ? 1 : 0
  if (task.threadID && deps.sessionDatabase && !protocolDeleted) {
    try {
      const report = deps.sessionDatabase.deleteThreadLocally(task.threadID, targets)
      removedRows = report.removedRows
      freed += report.freedBytes
    } catch (err) {
      return outcome(task, { kind: 'failed', reason: message('cleanup.localIndexFailed', { reason: errorText(err) }) }, freed)
    }
  } else if (task.threadID && deps.sessionDatabase && protocolDeleted) {
    // The protocol reporting success is not proof that every row is gone: a desktop
    // thread pointing at the deleted rollout survives it and keeps the conversation in
    // the sidebar, where opening it fails. Sweeping the same thread set again removes
    // nothing when Codex did its part, so a leftover row never outlives the rollout.
    try {
      const report = deps.sessionDatabase.deleteThreadLocally(task.threadID, targets)
      freed += report.freedBytes
      deps.sessionDatabase.reportProtocolLeftovers?.(task.threadID, report.removedRows, null)
    } catch (err) {
      // A future Codex release may change these schemas. That must not turn a deletion
      // Codex itself confirmed into a failure — it is recorded for diagnosis instead.
      deps.sessionDatabase.reportProtocolLeftovers?.(task.threadID, 0, errorText(err))
    }
  }
  if (removed === 0 && removedRows === 0) {
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
