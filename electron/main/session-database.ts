import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, join, normalize, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { fileAllocatedSize } from './fs-size'
import { MessageError, message } from '../../shared/messages'

export interface SessionDatabaseReport {
  removedRows: number
  freedBytes: number
}

/** A thread row whose rollout file is gone: Codex still lists it, but cannot open it. */
export interface OrphanThreadRecord {
  threadID: string
  rolloutPath: string
}

const footprint = (path: string | null): number => path
  ? fileAllocatedSize(path) + fileAllocatedSize(`${path}-wal`) + fileAllocatedSize(`${path}-shm`)
  : 0

const ROLLOUT_NAME_RE = /^rollout-.*\.jsonl(?:\.zst)?$/i
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig
const ID_COLUMNS = ['id', 'thread_id', 'conversation_id', 'uuid']
const ROLLOUT_COLUMNS = ['rollout_path', 'rollout', 'path', 'file_path']
const FRESHNESS_COLUMNS = ['updated_at_ms', 'updated_at', 'created_at_ms', 'created_at']
/** A thread row this new is likely a conversation Codex has not written a rollout for yet. */
const ORPHAN_GRACE_MS = 3_600_000

function latestDatabase(home: string, prefix: string): string | null {
  try {
    return readdirSync(home)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.sqlite'))
      .sort((a, b) => version(b) - version(a) || b.localeCompare(a))
      .map((name) => join(home, name))
      .find(existsSync) ?? null
  } catch { return null }
}

function version(name: string): number { return Number(name.match(/\d+/)?.[0] ?? -1) }

function hasTable(db: Database.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
}

function placeholders(values: string[]): string { return values.map(() => '?').join(',') }
function quote(identifier: string): string { return `"${identifier.replaceAll('"', '""')}"` }

interface RolloutTable {
  name: string
  id: string
  rollout: string
  freshness: string | null
}

/**
 * The table that maps a thread to the rollout file it reads back. Codex Desktop keys it
 * by its own thread id, which is not always the session id in the rollout's filename, so
 * this mapping is the only reliable link between the two.
 */
function findRolloutTable(db: Database.Database): RolloutTable | null {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name)
  for (const name of [...names.filter((n) => n === 'threads'), ...names.filter((n) => n !== 'threads')]) {
    let columns: Set<string>
    try {
      columns = new Set((db.prepare(`PRAGMA table_info(${quote(name)})`).all() as Array<{ name: string }>).map((row) => row.name))
    } catch { continue }
    const id = ID_COLUMNS.find((column) => columns.has(column))
    const rollout = ROLLOUT_COLUMNS.find((column) => columns.has(column))
    if (id && rollout) return { name, id, rollout, freshness: FRESHNESS_COLUMNS.find((column) => columns.has(column)) ?? null }
  }
  return null
}

interface RolloutRow { id: string; rollout: string; modifiedAt: number }

function readRolloutRows(db: Database.Database, table: RolloutTable): RolloutRow[] {
  const columns = [table.id, table.rollout, ...(table.freshness ? [table.freshness] : [])]
  const rows = db.prepare(
    `SELECT ${columns.map(quote).join(', ')} FROM ${quote(table.name)} WHERE ${quote(table.rollout)} IS NOT NULL LIMIT 200000`
  ).all() as Record<string, unknown>[]
  return rows.flatMap((row): RolloutRow[] => {
    const id = row[table.id]
    const rollout = row[table.rollout]
    if (typeof id !== 'string' || !id.length || typeof rollout !== 'string' || !rollout.length) return []
    return [{ id, rollout, modifiedAt: epochMilliseconds(table.freshness ? row[table.freshness] : null) }]
  })
}

function epochMilliseconds(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return number >= 1_000_000_000_000 ? number : number * 1000
}

function openReadonly(path: string | null): Database.Database | null {
  if (!path) return null
  try { return new Database(path, { readonly: true, fileMustExist: true, timeout: 4_000 }) } catch { return null }
}

/** Rollout paths a task is about to delete, as both full paths and file names. */
function rolloutTargets(relatedURLs: string[]): { paths: Set<string>; names: Set<string> } {
  const paths = new Set<string>()
  const names = new Set<string>()
  for (const url of relatedURLs) {
    const name = basename(url)
    if (!ROLLOUT_NAME_RE.test(name)) continue
    paths.add(normalize(url))
    names.add(name)
  }
  return { paths, names }
}

/**
 * Thread ids whose stored rollout path is one of the files being deleted. A continued or
 * resumed desktop thread keeps an id of its own while still pointing at the rollout named
 * after the original session, so its row survives an id-only deletion and Codex keeps
 * listing a conversation whose file is gone.
 */
function threadIDsForRollouts(statePath: string | null, home: string, relatedURLs: string[]): string[] {
  const targets = rolloutTargets(relatedURLs)
  if (!targets.paths.size) return []
  const db = openReadonly(statePath)
  if (!db) return []
  try {
    const table = findRolloutTable(db)
    if (!table) return []
    return readRolloutRows(db, table)
      .filter((row) => targets.paths.has(normalize(absolutePath(row.rollout, home))) || targets.names.has(basename(row.rollout)))
      .map((row) => row.id)
  } catch { return [] } finally { db.close() }
}

function absolutePath(path: string, home: string): string {
  return isAbsolute(path) ? path : resolve(home, path)
}

/** Every thread spawned, directly or indirectly, by one of `roots`. */
function expandDescendants(statePath: string | null, roots: Iterable<string>): string[] {
  const result = new Set(roots)
  const db = openReadonly(statePath)
  if (!db) return [...result]
  try {
    if (!hasTable(db, 'thread_spawn_edges')) return [...result]
    const edges = db.prepare('SELECT parent_thread_id AS parent, child_thread_id AS child FROM thread_spawn_edges').all() as Array<{ parent: string; child: string }>
    const byParent = new Map<string, string[]>()
    for (const edge of edges) byParent.set(edge.parent, [...(byParent.get(edge.parent) ?? []), edge.child])
    const queue = [...result]
    while (queue.length) {
      for (const child of byParent.get(queue.shift()!) ?? []) {
        if (result.has(child)) continue
        result.add(child)
        queue.push(child)
      }
    }
    return [...result]
  } finally { db.close() }
}

/**
 * Continued desktop threads keep the root session id in `session_meta`, while
 * thread_history may key newer projected items by UUID suffixes in the rollout
 * filename. Those suffixes are not thread_spawn_edges, so include every UUID
 * from the selected root/segment/subagent rollout names explicitly, plus every
 * desktop thread row that points at one of those files.
 */
function sessionThreadIDs(statePath: string | null, home: string, rootID: string, relatedURLs: string[]): string[] {
  const seeds = new Set([rootID, ...threadIDsForRollouts(statePath, home, relatedURLs)])
  for (const url of relatedURLs) {
    const name = basename(url)
    if (!ROLLOUT_NAME_RE.test(name)) continue
    for (const match of name.matchAll(UUID_RE)) seeds.add(match[0])
  }
  return expandDescendants(statePath, seeds)
}

/**
 * IDs that must each receive an official thread/delete request. A root request
 * removes all of that thread's continuation rollouts, while spawned subagents are
 * independent threads. Rollout filenames always lead with their owning thread ID;
 * any later UUID is only a continuation projection ID. The desktop's own thread ids
 * come from the state database, because they never appear in a filename.
 */
export function sessionProtocolThreadIDs(home: string, rootID: string, relatedURLs: string[]): string[] {
  const result = new Set<string>()
  for (const url of relatedURLs) {
    const name = basename(url)
    if (!ROLLOUT_NAME_RE.test(name)) continue
    const ownerID = name.match(UUID_RE)?.[0]
    if (ownerID && ownerID !== rootID) result.add(ownerID)
  }
  for (const id of threadIDsForRollouts(latestDatabase(home, 'state_'), home, relatedURLs)) {
    if (id !== rootID) result.add(id)
  }
  result.add(rootID)
  return [...result]
}

function rewriteDatabase(path: string | null, operation: (db: Database.Database) => number): number {
  if (!path) return 0
  const db = new Database(path, { fileMustExist: true, timeout: 8_000 })
  try {
    db.pragma('foreign_keys = ON')
    db.pragma('wal_checkpoint(TRUNCATE)')
    const changed = db.transaction(() => operation(db))()
    if (changed > 0) db.pragma('wal_checkpoint(TRUNCATE)')
    return changed
  } finally { db.close() }
}

function deleteHistoryRows(path: string | null, threadIDs: string[]): number {
  return rewriteDatabase(path, (db) => {
    const list = placeholders(threadIDs)
    let changed = 0
    for (const table of ['thread_items', 'thread_turns', 'thread_history_projection_state']) {
      if (hasTable(db, table)) changed += db.prepare(`DELETE FROM ${table} WHERE thread_id IN (${list})`).run(...threadIDs).changes
    }
    return changed
  })
}

/** Rows still pointing at a deleted rollout, whatever thread id they carry. */
function deleteRowsByRollout(db: Database.Database, home: string, rolloutPaths: string[]): number {
  const targets = rolloutTargets(rolloutPaths)
  if (!targets.paths.size) return 0
  const table = findRolloutTable(db)
  if (!table) return 0
  const doomed = readRolloutRows(db, table)
    .filter((row) => targets.paths.has(normalize(absolutePath(row.rollout, home))) || targets.names.has(basename(row.rollout)))
    .map((row) => row.rollout)
  if (!doomed.length) return 0
  return db.prepare(`DELETE FROM ${quote(table.name)} WHERE ${quote(table.rollout)} IN (${placeholders(doomed)})`).run(...doomed).changes
}

/**
 * Codex uses session_index.jsonl as more than a title cache: an otherwise deleted
 * thread can remain visible in the desktop session list while its index row exists.
 * Rewrite it atomically so a crash cannot leave a truncated index behind.
 */
function deleteSessionIndexRows(home: string, threadIDs: string[]): number {
  const path = join(home, 'session_index.jsonl')
  if (!existsSync(path)) return 0
  const ids = new Set(threadIDs)
  const original = readFileSync(path, 'utf8')
  let removed = 0
  const kept = original.split(/(?<=\n)/).filter((line) => {
    if (!line.trim()) return true
    try {
      const row = JSON.parse(line) as Record<string, unknown>
      if (typeof row['id'] !== 'string' || !ids.has(row['id'])) return true
      removed += 1
      return false
    } catch {
      // Preserve malformed rows rather than risking unrelated metadata loss.
      return true
    }
  })
  if (removed === 0) return 0

  const temporary = join(home, `.session_index.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, kept.join(''), { mode: statSync(path).mode })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true })
  }
  return removed
}

function preflightDatabase(path: string | null, requiredTable: string): void {
  if (!path) return
  const db = new Database(path, { fileMustExist: true, timeout: 8_000 })
  try {
    const integrity = db.pragma('quick_check(1)', { simple: true })
    if (integrity !== 'ok') throw new MessageError(message('error.integrityCheckFailed', { path, reason: String(integrity) }))
    if (!hasTable(db, requiredTable)) throw new MessageError(message('error.unsupportedDatabase', { path, table: requiredTable }))
    db.exec('BEGIN IMMEDIATE; ROLLBACK;')
  } finally { db.close() }
}

/** Validate supported schemas and acquire each write lock before any rollout is deleted. */
export function preflightSessionRecords(home: string, threadID: string, relatedURLs: string[] = []): void {
  const statePath = latestDatabase(home, 'state_')
  const historyPath = latestDatabase(home, 'thread_history_')
  preflightDatabase(statePath, 'threads')
  preflightDatabase(historyPath, 'thread_items')
  // Resolve the same thread set the deletion will use, so an unreadable spawn-edge
  // table surfaces here rather than after the rollouts are already gone.
  void sessionThreadIDs(statePath, home, threadID, relatedURLs)
}

/** Remove a thread and its spawned descendants from both Codex session databases. */
export function deleteSessionRecords(home: string, threadID: string, relatedURLs: string[] = []): SessionDatabaseReport {
  const statePath = latestDatabase(home, 'state_')
  return removeThreadRecords(home, sessionThreadIDs(statePath, home, threadID, relatedURLs), relatedURLs)
}

function removeThreadRecords(home: string, threadIDs: string[], rolloutPaths: string[]): SessionDatabaseReport {
  const statePath = latestDatabase(home, 'state_')
  const historyPath = latestDatabase(home, 'thread_history_')
  const before = footprint(statePath) + footprint(historyPath)
  let removedRows = deleteHistoryRows(historyPath, threadIDs)
  removedRows += rewriteDatabase(statePath, (db) => {
    const list = placeholders(threadIDs)
    let changed = 0
    if (hasTable(db, 'thread_dynamic_tools')) changed += db.prepare(`DELETE FROM thread_dynamic_tools WHERE thread_id IN (${list})`).run(...threadIDs).changes
    if (hasTable(db, 'thread_spawn_edges')) {
      changed += db.prepare(`DELETE FROM thread_spawn_edges WHERE parent_thread_id IN (${list}) OR child_thread_id IN (${list})`).run(...threadIDs, ...threadIDs).changes
    }
    if (hasTable(db, 'threads')) changed += db.prepare(`DELETE FROM threads WHERE id IN (${list})`).run(...threadIDs).changes
    changed += deleteRowsByRollout(db, home, rolloutPaths)
    return changed
  })
  removedRows += deleteSessionIndexRows(home, threadIDs)
  const after = footprint(statePath) + footprint(historyPath)
  return { removedRows, freedBytes: Math.max(0, before - after) }
}

function rolloutExists(path: string): boolean {
  const candidates = path.toLowerCase().endsWith('.zst')
    ? [path, path.slice(0, -4)]
    : [path, `${path}.zst`]
  return candidates.some(existsSync)
}

function containsRollout(directory: string, depth = 4): boolean {
  let entries
  try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return false }
  for (const item of entries) {
    if (item.isFile() && ROLLOUT_NAME_RE.test(item.name)) return true
    if (item.isDirectory() && depth > 0 && containsRollout(join(directory, item.name), depth - 1)) return true
  }
  return false
}

/**
 * Thread rows Codex still lists although their rollout file is gone — what an incomplete
 * deletion (by this app, an older release, or by hand) leaves behind. Opening one fails
 * with "no rollout found for thread id …".
 *
 * Rows younger than the grace period are left alone: a conversation that has just been
 * created may legitimately have no rollout on disk yet. If nothing in the table resolves
 * to a file while rollouts do exist, the stored paths are not what this code assumes, and
 * it reports nothing rather than guessing.
 */
export function findOrphanSessionRecords(home: string, now = Date.now()): OrphanThreadRecord[] {
  const db = openReadonly(latestDatabase(home, 'state_'))
  if (!db) return []
  try {
    const table = findRolloutTable(db)
    if (!table) return []
    const rows = readRolloutRows(db, table).filter((row) => ROLLOUT_NAME_RE.test(basename(row.rollout)))
    const alive = rows.filter((row) => rolloutExists(absolutePath(row.rollout, home)))
    if (!alive.length && rows.length && containsRollout(join(home, 'sessions'))) return []
    return rows
      .filter((row) => !rolloutExists(absolutePath(row.rollout, home)))
      .filter((row) => !row.modifiedAt || now - row.modifiedAt >= ORPHAN_GRACE_MS)
      .map((row) => ({ threadID: row.id, rolloutPath: absolutePath(row.rollout, home) }))
  } catch { return [] } finally { db.close() }
}

/** Remove those leftovers, together with anything they spawned and their projected rows. */
export function deleteOrphanSessionRecords(home: string): SessionDatabaseReport & { threadIDs: string[] } {
  const orphans = findOrphanSessionRecords(home)
  if (!orphans.length) return { threadIDs: [], removedRows: 0, freedBytes: 0 }
  const threadIDs = expandDescendants(latestDatabase(home, 'state_'), orphans.map((orphan) => orphan.threadID))
  return { threadIDs, ...removeThreadRecords(home, threadIDs, orphans.map((orphan) => orphan.rolloutPath)) }
}
