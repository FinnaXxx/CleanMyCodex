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
      sessions: [{ id: 'session', fileBytes: 300, assetBytes: 20, childBytes: 30, isSubagent: false, parentThreadID: null }],
      generatedAssets: [{ bytes: 20, sourceSessionID: 'session' }],
      workspace: { root: '/workspace', isScanned: true, entries: [{ bytes: 500, children: [] }] }
    } as unknown as ScanSnapshot

    const result = storageDistribution(snapshot)
    expect(Object.fromEntries(result.items.map((item) => [item.kind, item.bytes]))).toMatchObject({
      workspace: 500,
      sessions: 380,
      generatedAssets: 20,
      protectedData: 100,
      other: 500
    })
    expect(result.total).toBe(1_500)
    expect(result.items.reduce((sum, item) => sum + item.bytes / result.total, 0)).toBeCloseTo(1)
    expect(result.items.map((item) => item.bytes)).toEqual([500, 500, 380, 100, 20])
  })

  it('gives worktrees a slice of their own instead of leaving them in other', () => {
    const snapshot = {
      totalCodexBytes: 1_000,
      categories: [category('appCache', 100)],
      sessions: [],
      generatedAssets: [],
      worktrees: [{ bytes: 600 }, { bytes: 200 }],
      workspace: { root: '/workspace', isScanned: true, entries: [] }
    } as unknown as ScanSnapshot

    const result = storageDistribution(snapshot)
    const byKind = Object.fromEntries(result.items.map((item) => [item.kind, item.bytes]))
    expect(byKind['worktrees']).toBe(800)
    // 800 of worktrees plus the 100 cache leaves 100 unaccounted for, not 900.
    expect(byKind['other']).toBe(100)
  })

  it('keeps the slices inside the total when a worktree root sits outside CODEX_HOME', () => {
    const snapshot = {
      // Roots outside the home are counted in externalBytes, which is part of this total.
      totalCodexBytes: 900,
      categories: [],
      sessions: [],
      generatedAssets: [],
      worktrees: [{ bytes: 900 }],
      workspace: { root: '/workspace', isScanned: true, entries: [] }
    } as unknown as ScanSnapshot

    const result = storageDistribution(snapshot)
    expect(result.total).toBe(900)
    expect(result.items.some((item) => item.kind === 'other')).toBe(false)
  })
})
