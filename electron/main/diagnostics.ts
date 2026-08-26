import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * A plain-text diagnostic record of normal operations and every surfaced exceptional
 * path. Cleanup entries retain which targets were handled and exception entries retain
 * their operation and stack, so a submitted log can explain both incorrect results and
 * failures that happened before an operation produced a result.
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
    const timestamp = new Date().toISOString()
    const lines = line.replaceAll('\r\n', '\n').split('\n')
    appendFileSync(path, lines.map((item) => `[${timestamp}] ${item}`).join('\n') + '\n', 'utf8')
  } catch { /* diagnostics must never break a cleanup */ }
}

/**
 * Records an exceptional path with enough context to diagnose it from a submitted log.
 * Callers should describe the operation, not repeat the error text: Error stacks already
 * carry the concrete failure and this keeps every entry searchable by operation name.
 */
export function logException(context: string, error: unknown): void {
  logCleanup(`ERROR ${context}\n${describeError(error, new Set())}`)
}

function describeError(error: unknown, seen: Set<unknown>): string {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    if (seen.has(error)) return '[circular error cause]'
    seen.add(error)
  }
  if (error instanceof Error) {
    const stack = error.stack?.trim() || `${error.name}: ${error.message}`
    const cause = 'cause' in error && error.cause !== undefined
      ? `\nCaused by: ${describeError(error.cause, seen)}`
      : ''
    return `${stack}${cause}`
  }
  try {
    const serialized = typeof error === 'string' ? error : JSON.stringify(error)
    return serialized ?? String(error)
  } catch {
    return String(error)
  }
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
