import Database from 'better-sqlite3'
import { fileAllocatedSize } from './fs-size'

export interface SQLiteInspection {
  fileBytes: number
  walBytes: number
  pageSize: number
  pageCount: number
  freeListCount: number
  usedBytes: number
  reclaimableBytes: number
}

export interface SQLiteCompactionReport {
  beforeBytes: number
  afterBytes: number
  freedBytes: number
  integrityOK: boolean
}

const totalFootprint = (path: string): number =>
  fileAllocatedSize(path) + fileAllocatedSize(`${path}-wal`) + fileAllocatedSize(`${path}-shm`)

function pragmaNumber(db: Database.Database, name: string): number {
  const row = db.pragma(name, { simple: true })
  return typeof row === 'number' ? row : Number(row) || 0
}

/** Reads only SQLite metadata. The writable connection is needed for WAL databases. */
export function inspectDatabase(path: string, busyTimeout = 4_000): SQLiteInspection {
  let db: Database.Database
  try {
    db = new Database(path, { fileMustExist: true, timeout: busyTimeout })
  } catch {
    db = new Database(path, { readonly: true, fileMustExist: true, timeout: busyTimeout })
  }
  try {
    const pageSize = pragmaNumber(db, 'page_size')
    const pageCount = pragmaNumber(db, 'page_count')
    const freeListCount = pragmaNumber(db, 'freelist_count')
    const walBytes = fileAllocatedSize(`${path}-wal`)
    return {
      fileBytes: fileAllocatedSize(path),
      walBytes,
      pageSize,
      pageCount,
      freeListCount,
      usedBytes: Math.max(0, pageCount - freeListCount) * pageSize,
      reclaimableBytes: Math.max(0, freeListCount * pageSize + walBytes)
    }
  } finally {
    db.close()
  }
}

/** Checkpoints, vacuums, and verifies a log database without deleting any rows. */
export function compactDatabase(path: string, busyTimeout = 4_000): SQLiteCompactionReport {
  const beforeBytes = totalFootprint(path)
  const db = new Database(path, { fileMustExist: true, timeout: busyTimeout })
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
    if (pragmaNumber(db, 'auto_vacuum') === 2) db.exec('PRAGMA incremental_vacuum;')
    db.exec('VACUUM;')
    db.pragma('wal_checkpoint(TRUNCATE)')
    const integrity = String(db.pragma('integrity_check', { simple: true })).toLowerCase()
    if (integrity !== 'ok') throw new Error(`完整性检查未通过：${integrity}`)
  } finally {
    db.close()
  }
  const afterBytes = totalFootprint(path)
  return { beforeBytes, afterBytes, freedBytes: Math.max(0, beforeBytes - afterBytes), integrityOK: true }
}
