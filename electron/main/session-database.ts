import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import Database from 'better-sqlite3'
import { fileAllocatedSize } from './fs-size'

export interface SessionDatabaseReport {
  removedRows: number
  freedBytes: number
}

const footprint = (path: string | null): number => path
  ? fileAllocatedSize(path) + fileAllocatedSize(`${path}-wal`) + fileAllocatedSize(`${path}-shm`)
  : 0

const ROLLOUT_NAME_RE = /^rollout-.*\.jsonl(?:\.zst)?$/i
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig

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

function descendants(statePath: string | null, rootID: string): string[] {
  if (!statePath) return [rootID]
  const db = new Database(statePath, { readonly: true, fileMustExist: true, timeout: 4_000 })
  try {
    if (!hasTable(db, 'thread_spawn_edges')) return [rootID]
    const edges = db.prepare('SELECT parent_thread_id AS parent, child_thread_id AS child FROM thread_spawn_edges').all() as Array<{ parent: string; child: string }>
    const byParent = new Map<string, string[]>()
    for (const edge of edges) byParent.set(edge.parent, [...(byParent.get(edge.parent) ?? []), edge.child])
    const result = new Set([rootID])
    const queue = [rootID]
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
 * from the selected root/segment/subagent rollout names explicitly.
 */
function sessionThreadIDs(statePath: string | null, rootID: string, relatedURLs: string[]): string[] {
  const result = new Set(descendants(statePath, rootID))
  for (const url of relatedURLs) {
    const name = basename(url)
    if (!ROLLOUT_NAME_RE.test(name)) continue
    for (const match of name.matchAll(UUID_RE)) result.add(match[0])
  }
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

function preflightDatabase(path: string | null, requiredTable: string): void {
  if (!path) return
  const db = new Database(path, { fileMustExist: true, timeout: 8_000 })
  try {
    const integrity = db.pragma('quick_check(1)', { simple: true })
    if (integrity !== 'ok') throw new Error(`${path} 完整性检查失败：${String(integrity)}`)
    if (!hasTable(db, requiredTable)) throw new Error(`${path} 缺少 ${requiredTable}，暂不支持这个数据库版本`)
    db.exec('BEGIN IMMEDIATE; ROLLBACK;')
  } finally { db.close() }
}

/** Validate supported schemas and acquire each write lock before any rollout is trashed. */
export function preflightSessionRecords(home: string, threadID: string, relatedURLs: string[] = []): void {
  const statePath = latestDatabase(home, 'state_')
  const historyPath = latestDatabase(home, 'thread_history_')
  preflightDatabase(statePath, 'threads')
  preflightDatabase(historyPath, 'thread_items')
  sessionThreadIDs(statePath, threadID, relatedURLs)
}

/** Remove a thread and its spawned descendants from both Codex session databases. */
export function deleteSessionRecords(home: string, threadID: string, relatedURLs: string[] = []): SessionDatabaseReport {
  const statePath = latestDatabase(home, 'state_')
  const historyPath = latestDatabase(home, 'thread_history_')
  const before = footprint(statePath) + footprint(historyPath)
  const threadIDs = sessionThreadIDs(statePath, threadID, relatedURLs)
  let removedRows = deleteHistoryRows(historyPath, threadIDs)
  removedRows += rewriteDatabase(statePath, (db) => {
    const list = placeholders(threadIDs)
    let changed = 0
    if (hasTable(db, 'thread_dynamic_tools')) changed += db.prepare(`DELETE FROM thread_dynamic_tools WHERE thread_id IN (${list})`).run(...threadIDs).changes
    if (hasTable(db, 'thread_spawn_edges')) {
      changed += db.prepare(`DELETE FROM thread_spawn_edges WHERE parent_thread_id IN (${list}) OR child_thread_id IN (${list})`).run(...threadIDs, ...threadIDs).changes
    }
    if (hasTable(db, 'threads')) changed += db.prepare(`DELETE FROM threads WHERE id IN (${list})`).run(...threadIDs).changes
    return changed
  })
  const after = footprint(statePath) + footprint(historyPath)
  return { removedRows, freedBytes: Math.max(0, before - after) }
}
