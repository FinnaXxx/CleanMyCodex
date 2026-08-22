import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, normalize } from 'node:path'
import { randomUUID } from 'node:crypto'

export class CodexThreadIndex {
  private readonly byID = new Map<string, string>()
  private readonly byRollout = new Map<string, string>()

  get size(): number { return Math.max(this.byID.size, this.byRollout.size) }

  title(threadID: string, rolloutPath: string): string | null {
    return this.byRollout.get(normalize(rolloutPath)) ?? this.byID.get(threadID) ?? null
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
    const selected = [table.id, table.title, table.rollout].filter((value): value is string => !!value)
    const rows = db.prepare(`SELECT ${selected.map(quote).join(', ')} FROM ${quote(table.name)} LIMIT 50000`).all() as Record<string, unknown>[]
    const index = new CodexThreadIndex()
    for (const row of rows) {
      const title = cleanTitle(row[table.title])
      if (!title) continue
      index.add(stringValue(table.id ? row[table.id] : null), stringValue(table.rollout ? row[table.rollout] : null), title)
    }
    return index
  } catch { return null } finally { db?.close() }
}

function findThreadTable(db: Database.Database): { name: string; id: string | null; title: string; rollout: string | null } | null {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>).map((row) => row.name)
  const ordered = [...names.filter((name) => name === 'threads'), ...names.filter((name) => name !== 'threads')]
  for (const name of ordered) {
    const columns = new Set((db.prepare(`PRAGMA table_info(${quote(name)})`).all() as Array<{ name: string }>).map((row) => row.name))
    const title = ['title', 'name', 'summary'].find((column) => columns.has(column))
    const id = ['id', 'thread_id', 'conversation_id', 'uuid'].find((column) => columns.has(column)) ?? null
    const rollout = ['rollout_path', 'rollout', 'path', 'file_path'].find((column) => columns.has(column)) ?? null
    if (title && (id || rollout)) return { name, id, title, rollout }
  }
  return null
}

function quote(identifier: string): string { return `"${identifier.replaceAll('"', '""')}"` }
function stringValue(value: unknown): string | null { return typeof value === 'string' && value.length ? value : null }
function cleanTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const collapsed = value.trim().replace(/\s+/g, ' ')
  if (!collapsed) return null
  return collapsed.length > 90 ? `${collapsed.slice(0, 90)}…` : collapsed
}
