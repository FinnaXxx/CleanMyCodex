import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WorkspaceThreadReference } from '../../shared/types'

export interface CodexWorkspaceThread extends WorkspaceThreadReference {
  cwd: string
}

export class CodexThreadIndex {
  private readonly byID = new Map<string, string>()
  private readonly byRollout = new Map<string, string>()
  private readonly workspaceRows: CodexWorkspaceThread[] = []

  get size(): number { return Math.max(this.byID.size, this.byRollout.size, this.workspaceRows.length) }

  title(threadID: string, rolloutPath: string): string | null {
    return this.byRollout.get(normalize(rolloutPath)) ?? this.byID.get(threadID) ?? null
  }

  workspaceThreads(root: string): CodexWorkspaceThread[] {
    const base = normalize(root)
    return this.workspaceRows.filter((thread) => {
      const rel = relative(base, normalize(thread.cwd))
      return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    })
  }

  static load(codexHome: string): CodexThreadIndex {
    for (const path of stateDatabases(codexHome).slice(0, 3)) {
      const direct = readIndex(path, true)
      if (direct && direct.size) return direct
      const copied = readCopiedIndex(path)
      if (copied && copied.size) return copied
    }
    return new CodexThreadIndex()
  }

  add(id: string | null, rollout: string | null, title: string): void {
    if (id) this.byID.set(id, title)
    if (rollout) this.byRollout.set(normalize(rollout), title)
  }

  addWorkspace(thread: CodexWorkspaceThread): void {
    this.workspaceRows.push({ ...thread, cwd: normalize(thread.cwd) })
  }
}

function stateDatabases(home: string): string[] {
  try {
    return readdirSync(home)
      .filter((name) => name.startsWith('state') && name.endsWith('.sqlite'))
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
      table.id, table.title, table.rollout, table.cwd, table.preview, table.firstUserMessage,
      table.threadSource, table.source, table.archived, table.archivedAt, table.updatedAtMs, table.updatedAt
    ].filter((value): value is string => !!value))]
    const rows = db.prepare(`SELECT ${selected.map(quote).join(', ')} FROM ${quote(table.name)} LIMIT 50000`).all() as Record<string, unknown>[]
    const index = new CodexThreadIndex()
    for (const row of rows) {
      const id = stringValue(table.id ? row[table.id] : null)
      const title = cleanTitle(row[table.title]) ??
        cleanTitle(table.preview ? row[table.preview] : null) ??
        cleanTitle(table.firstUserMessage ? row[table.firstUserMessage] : null)
      if (title) index.add(id, stringValue(table.rollout ? row[table.rollout] : null), title)
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
  title: string
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
}

function findThreadTable(db: Database.Database): ThreadTable | null {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>).map((row) => row.name)
  const ordered = [...names.filter((name) => name === 'threads'), ...names.filter((name) => name !== 'threads')]
  for (const name of ordered) {
    const columns = new Set((db.prepare(`PRAGMA table_info(${quote(name)})`).all() as Array<{ name: string }>).map((row) => row.name))
    const title = ['title', 'name', 'summary'].find((column) => columns.has(column))
    const id = ['id', 'thread_id', 'conversation_id', 'uuid'].find((column) => columns.has(column)) ?? null
    const rollout = ['rollout_path', 'rollout', 'path', 'file_path'].find((column) => columns.has(column)) ?? null
    if (title && (id || rollout)) return {
      name,
      id,
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
      updatedAt: firstColumn(columns, ['updated_at', 'updatedAt'])
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
function cleanTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const collapsed = value.trim().replace(/\s+/g, ' ')
  if (!collapsed) return null
  return collapsed.length > 90 ? `${collapsed.slice(0, 90)}…` : collapsed
}
