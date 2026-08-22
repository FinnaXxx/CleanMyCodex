import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import type { SessionTag } from '../../shared/types'

export interface CachedSessionContent {
  size: number
  modifiedAt: number
  threadID: string | null
  cwd: string | null
  metadataTitle: string | null
  preview: string | null
  imageCount: number
  imageBytes: number
  distinctCount: number
  duplicateBytes: number
  tags: SessionTag[]
  parseWarnings: number
}

interface Payload { version: number; records: Record<string, CachedSessionContent> }

export class SessionScanCache {
  private readonly records: Record<string, CachedSessionContent>
  private readonly seen = new Set<string>()
  private dirty = false

  private constructor(records: Record<string, CachedSessionContent>) { this.records = records }

  static load(directory: string): SessionScanCache {
    try {
      const payload = JSON.parse(readFileSync(join(directory, 'session-scan.json'), 'utf8')) as Payload
      return new SessionScanCache(payload.version === 2 ? payload.records : {})
    } catch { return new SessionScanCache({}) }
  }

  get(path: string, size: number, modifiedAt: number): CachedSessionContent | null {
    const key = normalize(path)
    this.seen.add(key)
    const record = this.records[key]
    return record && record.size === size && Math.abs(record.modifiedAt - modifiedAt) < 0.5 ? record : null
  }

  set(path: string, record: CachedSessionContent): void {
    const key = normalize(path)
    this.seen.add(key)
    this.records[key] = record
    this.dirty = true
  }

  save(directory: string): void {
    for (const key of Object.keys(this.records)) {
      if (!this.seen.has(key)) { delete this.records[key]; this.dirty = true }
    }
    if (!this.dirty) return
    const target = join(directory, 'session-scan.json')
    const temporary = `${target}.tmp`
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(temporary, JSON.stringify({ version: 2, records: this.records } satisfies Payload), 'utf8')
      replaceFile(temporary, target)
      this.dirty = false
    } catch { /* cache failure must never fail a scan */ }
  }
}

function replaceFile(temporary: string, target: string): void {
  try { renameSync(temporary, target) }
  catch (error) {
    if (process.platform !== 'win32') throw error
    rmSync(target, { force: true })
    renameSync(temporary, target)
  }
}
