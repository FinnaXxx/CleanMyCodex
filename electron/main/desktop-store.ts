import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import Database from 'better-sqlite3'

/**
 * ChatGPT/Codex Desktop keeps its own copy of the conversation list, separate from the
 * rollouts and from the core databases the app server maintains. `thread/delete` does not
 * touch it: a thread deleted through the protocol disappears from `state_*.sqlite` and
 * `thread_history_*.sqlite` while the desktop still lists it and fails to open it.
 *
 * - `~/.codex/sqlite/*.db` — `local_thread_catalog` is the sidebar list itself; sibling
 *   databases hold per-thread summaries and history snapshots.
 * - `~/.codex/.codex-global-state.json` (and its `.bak`) — the desktop's persisted state,
 *   including maps and lists keyed by thread id.
 */

export interface DesktopThreadRow {
  threadID: string
  title: string | null
  modifiedAt: number
  /** `local` for a conversation stored on this machine; a host id for a remote one. */
  host: string | null
}

export interface DesktopSweepReport {
  removedRows: number
  /** `database.table.column` for every place rows were removed, for the cleanup log. */
  locations: string[]
}

const DESKTOP_STATE_FILES = ['.codex-global-state.json', '.codex-global-state.json.bak']
/**
 * Interface state: drafts, tab order, panel sizes. A stale thread id in here is inert,
 * and rewriting half a megabyte of unrelated atoms to remove one is not worth the risk.
 */
const UNTOUCHED_STATE_KEYS = new Set(['electron-persisted-atom-state'])
const THREAD_ID_COLUMN_RE = /^(thread_?id|conversation_?id)$/i
const TIMESTAMP_COLUMN_RE = /(updated|modified|created|activity|accessed)/i
const TITLE_COLUMNS = ['title', 'name', 'preview', 'summary']
const HOST_COLUMNS = ['host', 'host_id', 'hostId']

function quote(identifier: string): string { return `"${identifier.replaceAll('"', '""')}"` }
function placeholders(values: string[]): string { return values.map(() => '?').join(',') }

export function desktopDatabases(home: string): string[] {
  const directory = join(home, 'sqlite')
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith('.db') || name.endsWith('.sqlite'))
      .sort()
      .map((name) => join(directory, name))
  } catch { return [] }
}

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => !name.startsWith('sqlite_'))
}

function columnNames(db: Database.Database, table: string): string[] {
  try {
    return (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string }>).map((row) => row.name)
  } catch { return [] }
}

/**
 * Columns that hold a thread id: either named as one, or the primary `id` of a table
 * whose name says its rows are threads. Anything else is left alone, so an unrelated
 * `id` column can never be matched against a thread id.
 */
function threadColumns(db: Database.Database, table: string): string[] {
  const columns = columnNames(db, table)
  const named = columns.filter((column) => THREAD_ID_COLUMN_RE.test(column))
  if (named.length) return named
  return /thread/i.test(table) ? columns.filter((column) => column.toLowerCase() === 'id') : []
}

/** Remove every trace of these threads from the desktop's own databases. */
export function deleteDesktopThreadRows(home: string, threadIDs: string[]): DesktopSweepReport {
  const report: DesktopSweepReport = { removedRows: 0, locations: [] }
  if (!threadIDs.length) return report
  for (const path of desktopDatabases(home)) {
    let db: Database.Database | null = null
    try {
      db = new Database(path, { fileMustExist: true, timeout: 8_000 })
      const connection = db
      const changed = connection.transaction(() => {
        let count = 0
        for (const table of tableNames(connection)) {
          for (const column of threadColumns(connection, table)) {
            const removed = connection.prepare(
              `DELETE FROM ${quote(table)} WHERE ${quote(column)} IN (${placeholders(threadIDs)})`
            ).run(...threadIDs).changes
            if (removed > 0) report.locations.push(`${basenameOf(path)}.${table}.${column}=${removed}`)
            count += removed
          }
        }
        return count
      })()
      report.removedRows += changed
    } catch { /* an unknown or locked desktop database is not fatal to a deletion */ } finally { db?.close() }
  }
  return report
}

function basenameOf(path: string): string { return path.split(/[\\/]/).pop() ?? path }

/** The desktop's own conversation list — what the sidebar shows. */
export function desktopThreadRows(home: string): DesktopThreadRow[] {
  const rows: DesktopThreadRow[] = []
  for (const path of desktopDatabases(home)) {
    let db: Database.Database | null = null
    try {
      db = new Database(path, { readonly: true, fileMustExist: true, timeout: 4_000 })
      for (const table of tableNames(db)) {
        if (!/catalog/i.test(table)) continue
        const idColumn = threadColumns(db, table)[0]
        if (!idColumn) continue
        const columns = columnNames(db, table)
        const title = TITLE_COLUMNS.find((candidate) => columns.includes(candidate)) ?? null
        const host = HOST_COLUMNS.find((candidate) => columns.includes(candidate)) ?? null
        const stamps = columns.filter((column) => TIMESTAMP_COLUMN_RE.test(column))
        const selected = [...new Set([idColumn, ...(title ? [title] : []), ...(host ? [host] : []), ...stamps])]
        for (const row of db.prepare(`SELECT ${selected.map(quote).join(', ')} FROM ${quote(table)} LIMIT 50000`).all() as Record<string, unknown>[]) {
          const threadID = row[idColumn]
          if (typeof threadID !== 'string' || !threadID.length) continue
          rows.push({
            threadID,
            title: title && typeof row[title] === 'string' ? row[title] as string : null,
            modifiedAt: Math.max(0, ...stamps.map((stamp) => epochMilliseconds(row[stamp]))),
            host: host && typeof row[host] === 'string' ? row[host] as string : null
          })
        }
      }
    } catch { /* an unknown desktop schema simply reports nothing */ } finally { db?.close() }
  }
  return rows
}

function epochMilliseconds(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return number >= 1_000_000_000_000 ? number : number * 1000
}

interface PruneCount { removed: number }

/**
 * Drop these threads from the desktop's persisted state: keys of a map keyed by thread
 * id, entries of a list of thread ids, and list items that name one in a `…threadId`
 * field. Nothing else is rewritten.
 */
function prune(value: unknown, ids: Set<string>, counter: PruneCount): unknown {
  if (Array.isArray(value)) {
    const kept = value.filter((item) => !namesThread(item, ids))
    counter.removed += value.length - kept.length
    return kept.map((item) => prune(item, ids, counter))
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (ids.has(key)) { counter.removed += 1; continue }
      result[key] = prune(inner, ids, counter)
    }
    return result
  }
  return value
}

function namesThread(item: unknown, ids: Set<string>): boolean {
  if (typeof item === 'string') return ids.has(item)
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false
  return Object.entries(item as Record<string, unknown>).some(([key, value]) =>
    /thread/i.test(key) && /id$/i.test(key) && typeof value === 'string' && ids.has(value))
}

export interface StatePruneReport {
  removed: number
  files: string[]
}

/**
 * Rewrite the desktop state files without these threads. The `.bak` is rewritten too:
 * the desktop restores from it, so a thread left there comes back.
 *
 * A copy of each file is kept in `backupDirectory` before the first change, because this
 * file also holds window bounds, project lists and workspace roots.
 */
export function pruneDesktopState(home: string, threadIDs: string[], backupDirectory: string | null = null): StatePruneReport {
  const report: StatePruneReport = { removed: 0, files: [] }
  if (!threadIDs.length) return report
  const ids = new Set(threadIDs)
  for (const name of DESKTOP_STATE_FILES) {
    const path = join(home, name)
    if (!existsSync(path)) continue
    let parsed: Record<string, unknown>
    let original: string
    try {
      original = readFileSync(path, 'utf8')
      parsed = JSON.parse(original) as Record<string, unknown>
    } catch { continue }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    if (!threadIDs.some((id) => original.includes(id))) continue

    const counter: PruneCount = { removed: 0 }
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(parsed)) {
      next[key] = UNTOUCHED_STATE_KEYS.has(key) ? value : prune(value, ids, counter)
    }
    if (!counter.removed) continue
    backup(path, backupDirectory)
    writeAtomically(path, JSON.stringify(next))
    report.removed += counter.removed
    report.files.push(`${name}=${counter.removed}`)
  }
  return report
}

function backup(path: string, directory: string | null): void {
  if (!directory) return
  try {
    mkdirSync(directory, { recursive: true })
    const stamp = new Date().toISOString().replaceAll(':', '-')
    copyFileSync(path, join(directory, `${basenameOf(path)}.${stamp}.backup`))
  } catch { /* the rewrite below is atomic; a missing copy must not block it */ }
}

function writeAtomically(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, contents, { mode: statSync(path).mode })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true })
  }
}
