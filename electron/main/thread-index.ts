import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WorkspaceThreadReference } from '../../shared/types'
import { cleanPreview } from './preview'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface CodexWorkspaceThread extends WorkspaceThreadReference {
  cwd: string
}

export class CodexThreadIndex {
  private readonly byID = new Map<string, string>()
  private readonly byRollout = new Map<string, string>()
  private readonly workspaceRows: CodexWorkspaceThread[] = []
  private readonly cleanupBlockers = new Set<string>()
  private readonly pinned = new Set<string>()

  get size(): number { return Math.max(this.byID.size, this.byRollout.size, this.workspaceRows.length) }

  title(threadID: string, rolloutPath: string): string | null {
    return this.byID.get(threadID) ?? this.byRollout.get(normalize(rolloutPath)) ?? null
  }

  workspaceThreads(root: string): CodexWorkspaceThread[] {
    const base = normalize(root)
    return this.workspaceRows.filter((thread) => {
      const rel = relative(base, normalize(thread.cwd))
      return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    })
  }

  cleanupBlocked(threadID: string): boolean { return this.cleanupBlockers.has(threadID) }

  isPinned(threadID: string): boolean { return this.pinned.has(threadID) }

  static load(codexHome: string): CodexThreadIndex {
    const generatedNames = readSessionNames(codexHome)
    for (const path of stateDatabases(codexHome).slice(0, 3)) {
      const direct = readIndex(path, true)
      if (direct && direct.size) {
        direct.applyGeneratedNames(generatedNames)
        direct.applyPinned(readPinnedThreadIDs(codexHome))
        direct.applyCleanupBlockers(readAuxiliaryCleanupBlockers(codexHome))
        return direct
      }
      const copied = readCopiedIndex(path)
      if (copied && copied.size) {
        copied.applyGeneratedNames(generatedNames)
        copied.applyPinned(readPinnedThreadIDs(codexHome))
        copied.applyCleanupBlockers(readAuxiliaryCleanupBlockers(codexHome))
        return copied
      }
    }
    const index = new CodexThreadIndex()
    index.applyGeneratedNames(generatedNames)
    index.applyPinned(readPinnedThreadIDs(codexHome))
    index.applyCleanupBlockers(readAuxiliaryCleanupBlockers(codexHome))
    return index
  }

  add(id: string | null, rollout: string | null, title: string): void {
    if (id) this.byID.set(id, title)
    if (rollout) this.byRollout.set(normalize(rollout), title)
  }

  addWorkspace(thread: CodexWorkspaceThread): void {
    this.workspaceRows.push({ ...thread, cwd: normalize(thread.cwd) })
  }

  blockCleanup(threadID: string): void { this.cleanupBlockers.add(threadID) }

  /** Pinning is both a reason to skip automatic cleanup and something the list shows. */
  markPinned(threadID: string): void {
    this.pinned.add(threadID)
    this.cleanupBlockers.add(threadID)
  }

  private applyGeneratedNames(names: Map<string, string>): void {
    for (const [id, title] of names) this.byID.set(id, title)
    for (const thread of this.workspaceRows) thread.title = names.get(thread.id) ?? thread.title
  }

  private applyCleanupBlockers(ids: Set<string>): void {
    for (const id of ids) this.cleanupBlockers.add(id)
  }

  private applyPinned(ids: Set<string>): void {
    for (const id of ids) this.markPinned(id)
  }
}

/**
 * Pins live in the desktop's own state file, not only in the state database's `pinned`
 * column — `~/.codex/.codex-global-state.json` keeps `pinned-thread-ids`, and a
 * per-host list for threads migrated to the app server. Reading only the column means a
 * pinned conversation can look unprotected to automatic cleanup.
 */
function readPinnedThreadIDs(home: string): Set<string> {
  const result = new Set<string>()
  const path = join(home, '.codex-global-state.json')
  try {
    if (statSync(path).size > 64 * 1024 * 1024) return result
    const state = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    for (const key of ['pinned-thread-ids', 'app-server-migrated-pinned-thread-ids-by-host']) {
      collectThreadIDs(state[key], result)
    }
  } catch { /* the desktop state file is optional and its shape may change */ }
  return result
}

/** Thread ids wherever they sit in that value: a list, or per-host lists of them. */
function collectThreadIDs(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') { if (UUID_RE.test(value)) into.add(value) ; return }
  if (Array.isArray(value)) { for (const item of value) collectThreadIDs(item, into); return }
  if (value && typeof value === 'object') for (const item of Object.values(value)) collectThreadIDs(item, into)
}

function readAuxiliaryCleanupBlockers(home: string): Set<string> {
  const result = new Set<string>()
  const queries: Array<[string, string]> = [
    ['goals_', "SELECT thread_id FROM thread_goals WHERE status <> 'complete'"],
    ['queue_', 'SELECT DISTINCT thread_id FROM queued_items']
  ]
  for (const [prefix, sql] of queries) {
    const path = stateDatabases(home, prefix)[0]
    if (!path) continue
    let db: Database.Database | null = null
    try {
      db = new Database(path, { readonly: true, fileMustExist: true, timeout: 2_000 })
      for (const id of db.prepare(sql).pluck().all() as unknown[]) if (typeof id === 'string') result.add(id)
    } catch { /* auxiliary state is optional and schema-versioned */ } finally { db?.close() }
  }
  return result
}

/** Codex writes its final generated/edited sidebar titles here even when the
 * state database's `name` column is still null. Later rows win. */
function readSessionNames(home: string): Map<string, string> {
  const names = new Map<string, string>()
  const path = join(home, 'session_index.jsonl')
  try {
    if (statSync(path).size > 16 * 1024 * 1024) return names
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line) as Record<string, unknown>
        const id = stringValue(row['id'])
        const title = cleanPreview(row['thread_name'])
        if (id && title) names.set(id, title)
      } catch { /* ignore one corrupt index row */ }
    }
  } catch { /* index is optional */ }
  return names
}

function stateDatabases(home: string, prefix = 'state'): string[] {
  try {
    return readdirSync(home)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.sqlite'))
      .sort((a, b) => version(b) - version(a) || b.localeCompare(a))
      .map((name) => join(home, name))
  } catch { return [] }
}

function version(name: string): number {
  return Number(name.match(/\d+/)?.[0] ?? -1)
}

function readCopiedIndex(path: string): CodexThreadIndex | null {
  try {
    if (statSync(path).size > 64 * 1024 * 1024) return null
    const directory = join(tmpdir(), `cleanmycodex-state-${randomUUID()}`)
    mkdirSync(directory, { recursive: true })
    const copy = join(directory, basename(path))
    try {
      copyFileSync(path, copy)
      for (const suffix of ['-wal', '-shm']) if (existsSync(`${path}${suffix}`)) copyFileSync(`${path}${suffix}`, `${copy}${suffix}`)
      return readIndex(copy, false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  } catch { return null }
}

function readIndex(path: string, readonly: boolean): CodexThreadIndex | null {
  let db: Database.Database | null = null
  try {
    db = new Database(path, { readonly, fileMustExist: true, timeout: 2_000 })
    const table = findThreadTable(db)
    if (!table) return new CodexThreadIndex()
    const selected = [...new Set([
      table.id, table.generatedName, table.title, table.rollout, table.cwd, table.preview, table.firstUserMessage,
      table.threadSource, table.source, table.archived, table.archivedAt, table.updatedAtMs, table.updatedAt,
      table.pinned
    ].filter((value): value is string => !!value))]
    const rows = db.prepare(`SELECT ${selected.map(quote).join(', ')} FROM ${quote(table.name)} LIMIT 50000`).all() as Record<string, unknown>[]
    const index = new CodexThreadIndex()
    for (const row of rows) {
      const id = stringValue(table.id ? row[table.id] : null)
      // `name` is the concise title generated (or edited) by Codex. `title` and
      // `preview` commonly contain the full first user message, so use them only
      // when a generated name is unavailable.
      const title = cleanPreview(table.generatedName ? row[table.generatedName] : null) ??
        cleanPreview(table.title ? row[table.title] : null) ??
        cleanPreview(table.preview ? row[table.preview] : null) ??
        cleanPreview(table.firstUserMessage ? row[table.firstUserMessage] : null)
      if (title) index.add(id, stringValue(table.rollout ? row[table.rollout] : null), title)
      if (id && booleanValue(rowValue(table.pinned, row))) index.markPinned(id)
      const cwd = stringValue(table.cwd ? row[table.cwd] : null)
      if (id && cwd) {
        const threadSource = stringValue(table.threadSource ? row[table.threadSource] : null)
        const source = stringValue(table.source ? row[table.source] : null)
        index.addWorkspace({
          id,
          cwd,
          title: title ?? id.slice(0, 12),
          archived: booleanValue(table.archived ? row[table.archived] : null) || rowValue(table.archivedAt, row) !== null,
          isSubagent: threadSource === 'subagent' || (!threadSource && !!source?.includes('"subagent"')),
          modifiedAt: epochMilliseconds(rowValue(table.updatedAtMs, row) ?? rowValue(table.updatedAt, row))
        })
      }
    }
    return index
  } catch { return null } finally { db?.close() }
}

interface ThreadTable {
  name: string
  id: string | null
  generatedName: string | null
  title: string | null
  rollout: string | null
  cwd: string | null
  preview: string | null
  firstUserMessage: string | null
  threadSource: string | null
  source: string | null
  archived: string | null
  archivedAt: string | null
  updatedAtMs: string | null
  updatedAt: string | null
  pinned: string | null
}

function findThreadTable(db: Database.Database): ThreadTable | null {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>).map((row) => row.name)
  const ordered = [...names.filter((name) => name === 'threads'), ...names.filter((name) => name !== 'threads')]
  for (const name of ordered) {
    const columns = new Set((db.prepare(`PRAGMA table_info(${quote(name)})`).all() as Array<{ name: string }>).map((row) => row.name))
    const nameColumn = firstColumn(columns, ['name'])
    const title = firstColumn(columns, ['title', 'summary'])
    const id = ['id', 'thread_id', 'conversation_id', 'uuid'].find((column) => columns.has(column)) ?? null
    const rollout = ['rollout_path', 'rollout', 'path', 'file_path'].find((column) => columns.has(column)) ?? null
    if ((nameColumn || title) && (id || rollout)) return {
      name,
      id,
      generatedName: nameColumn,
      title,
      rollout,
      cwd: firstColumn(columns, ['cwd', 'working_directory', 'workingDirectory']),
      preview: firstColumn(columns, ['preview']),
      firstUserMessage: firstColumn(columns, ['first_user_message', 'firstUserMessage']),
      threadSource: firstColumn(columns, ['thread_source', 'threadSource']),
      source: firstColumn(columns, ['source']),
      archived: firstColumn(columns, ['archived']),
      archivedAt: firstColumn(columns, ['archived_at', 'archivedAt']),
      updatedAtMs: firstColumn(columns, ['updated_at_ms', 'updatedAtMs']),
      updatedAt: firstColumn(columns, ['updated_at', 'updatedAt']),
      pinned: firstColumn(columns, ['is_pinned', 'pinned'])
    }
  }
  return null
}

function firstColumn(columns: Set<string>, candidates: string[]): string | null {
  return candidates.find((column) => columns.has(column)) ?? null
}

function quote(identifier: string): string { return `"${identifier.replaceAll('"', '""')}"` }
function stringValue(value: unknown): string | null { return typeof value === 'string' && value.length ? value : null }
function booleanValue(value: unknown): boolean { return value === true || value === 1 || value === '1' }
function rowValue(column: string | null, row: Record<string, unknown>): unknown { return column ? row[column] : null }
function epochMilliseconds(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return number >= 1_000_000_000_000 ? number : number * 1000
}
