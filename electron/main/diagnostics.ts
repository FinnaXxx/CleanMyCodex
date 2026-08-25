import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * A plain-text record of what session deletion actually did: which thread ids were
 * resolved, whether Codex' own protocol handled the thread, and how many metadata rows
 * were left for this app to remove. Session deletion touches three stores that only
 * Codex writes otherwise, so when a conversation survives it, this file is the evidence.
 *
 * macOS: ~/Library/Logs/CleanMyCodex/cleanup.log
 * Windows: %APPDATA%\CleanMyCodex\logs\cleanup.log
 */
const MAX_BYTES = 1024 * 1024

/** Where this app writes its own logs; the settings page offers to open it. */
export function logDirectory(): string {
  return app.getPath('logs')
}

/** The folder only appears once something has been logged, so make it before showing it. */
export function ensureLogDirectory(): string {
  const path = logDirectory()
  try { mkdirSync(path, { recursive: true }) } catch { /* the settings page still shows the path */ }
  return path
}

export function cleanupLogPath(): string {
  return join(logDirectory(), 'cleanup.log')
}

export function logCleanup(line: string): void {
  const path = cleanupLogPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    rotate(path)
    appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch { /* diagnostics must never break a cleanup */ }
}

/** One generation of history is enough to explain a deletion that just went wrong. */
function rotate(path: string): void {
  try {
    if (statSync(path).size < MAX_BYTES) return
  } catch { return }
  try {
    rmSync(`${path}.1`, { force: true })
    renameSync(path, `${path}.1`)
  } catch { /* keep appending to the current file */ }
}
