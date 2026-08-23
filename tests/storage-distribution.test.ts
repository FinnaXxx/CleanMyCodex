import { describe, expect, it } from 'vitest'
import { storageDistribution } from '../src/storage-distribution'
import type { ScanSnapshot, StorageCategory, StorageEntry } from '../shared/types'

function entry(id: string, bytes: number): StorageEntry {
  return {
    id, title: id, note: null, tags: [], url: `/${id}`, bytes, reclaimableBytes: 0,
    minimumIdleSeconds: null, requiresCodexStopped: false, risk: 'shielded'
  }
}

function category(kind: StorageCategory['kind'], bytes: number): StorageCategory {
  return { kind, group: 'protectedData', risk: 'shielded', entries: [entry(kind, bytes)] }
}

describe('overview storage distribution', () => {
  it('separates workspace and sessions while reserving other for unclassified Codex data', () => {
    const snapshot = {
      totalCodexBytes: 1_000,
      categories: [category('appCache', 100), category('sessionDatabase', 50)],
      sessions: [{ fileBytes: 300, assetBytes: 20, childBytes: 30, isSubagent: false, parentThreadID: null }],
      workspace: { root: '/workspace', isScanned: true, entries: [{ bytes: 500, children: [] }] }
    } as unknown as ScanSnapshot

    const result = storageDistribution(snapshot)
    expect(Object.fromEntries(result.items.map((item) => [item.kind, item.bytes]))).toMatchObject({
      workspace: 500,
      sessions: 400,
      protectedData: 100,
      other: 500
    })
    expect(result.total).toBe(1_500)
    expect(result.items.reduce((sum, item) => sum + item.bytes / result.total, 0)).toBeCloseTo(1)
  })
})
