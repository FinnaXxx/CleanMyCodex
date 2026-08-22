import { statSync } from 'node:fs'
import type {
  CleanupTask,
  CleanupOutcome,
  CleanupReport,
  CleanupStatus,
  StorageEntry
} from '../../shared/types'
import { ProtectedPaths, ProtectedPathError } from './guard'

export interface CleanupDeps {
  /** Move a file or directory to the OS trash. Injected so the engine stays testable. */
  trash: (path: string) => Promise<void>
  /** Whether Codex is currently running — gates work that needs it fully stopped. */
  isCodexRunning: () => boolean
}

export interface CleanupProgress {
  completed: number
  total: number
  currentTitle: string
}

/** Build cleanup tasks from the entries the user selected in the UI. */
export function tasksFromEntries(entries: StorageEntry[]): CleanupTask[] {
  return entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    detail: entry.detail,
    url: entry.url,
    method: entry.method,
    expectedBytes: entry.reclaimableBytes,
    threadID: null,
    companionURLs: [],
    slimMode: null,
    minimumIdleSeconds: entry.minimumIdleSeconds,
    requiresCodexStopped: entry.requiresCodexStopped
  }))
}

function pathExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Performs the cleanup. Every task passes the protected-path guard first, and ordinary
 * files are moved to the trash so a mistake is always recoverable.
 *
 * Compaction, thread deletion and session slimming are gated on Codex' app server and
 * SQLite, which arrive in a later pass; until then those methods report "deferred" rather
 * than pretending to run.
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
      return deferred(task, '压缩数据库将在后续版本支持')
    case 'deleteThread':
      return deferred(task, '会话删除将在后续版本支持')
    case 'slimSession':
      return deferred(task, '会话瘦身将在后续版本支持')
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

function deferred(task: CleanupTask, reason: string): CleanupOutcome {
  return outcome(task, { kind: 'skipped', reason }, 0)
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
    const st = statSync(path)
    const allocated = st.blocks * 512
    return allocated > 0 ? allocated : st.size
  } catch {
    return 0
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}