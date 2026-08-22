import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CleanupTask } from '../shared/types'
import { runCleanup } from '../electron/main/cleanup'
import { ProtectedPaths } from '../electron/main/guard'
import { CodexLocations } from '../electron/main/locations'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('cleanup engine', () => {
  it('counts directory contents and moves an allowed target to trash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    const target = join(locations.home, '.tmp', 'stale')
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'payload'), Buffer.alloc(8192))
    const task: CleanupTask = { id: target, title: 'stale', detail: target, url: target, method: 'trash', expectedBytes: 8192, threadID: null, companionURLs: [], minimumIdleSeconds: null, requiresCodexStopped: false }
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      trash: async (path) => renameSync(path, `${path}.trashed`), isCodexRunning: () => false
    })
    expect(report.outcomes[0].status.kind).toBe('succeeded')
    expect(report.outcomes[0].freedBytes).toBeGreaterThan(0)
  })

  it('moves a dedicated app cache root to trash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    const target = locations.appCaches[0]
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'payload'), Buffer.alloc(8192))
    const task: CleanupTask = { id: target, title: 'Codex', detail: target, url: target, method: 'trash', expectedBytes: 8192, threadID: null, companionURLs: [], minimumIdleSeconds: null, requiresCodexStopped: false }
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      trash: async (path) => renameSync(path, `${path}.trashed`), isCodexRunning: () => false
    })

    expect(report.outcomes[0].status.kind).toBe('succeeded')
    expect(report.outcomes[0].freedBytes).toBeGreaterThan(0)
    expect(existsSync(`${target}.trashed`)).toBe(true)
  })

  it('rechecks minimum idle time immediately before cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    const target = join(locations.home, '.tmp', 'active')
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'payload'), 'active')
    const task: CleanupTask = { id: target, title: 'active', detail: target, url: target, method: 'trash', expectedBytes: 1, threadID: null, companionURLs: [], minimumIdleSeconds: 3600, requiresCodexStopped: false }
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      trash: async () => { throw new Error('must not trash') }, isCodexRunning: () => false
    })
    expect(report.outcomes[0].status.kind).toBe('skipped')
  })

  it('deletes every rollout and asset companion before removing SQLite records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    const parent = join(locations.sessions, 'parent.jsonl')
    const resumed = join(locations.sessions, 'parent-resumed.jsonl')
    const child = join(locations.sessions, 'child.jsonl')
    const generated = join(locations.generatedImages, 'parent-thread')
    const visualization = join(locations.visualizations, '2026', '08', '23', 'parent-thread')
    for (const path of [parent, resumed, child]) {
      mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, '{}\n')
    }
    for (const directory of [generated, visualization]) {
      mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'asset'), Buffer.alloc(4096))
    }
    const deletedThreads: Array<{ threadID: string; relatedURLs: string[] }> = []
    const task: CleanupTask = {
      id: parent, title: 'thread', detail: '', url: parent, method: 'trash', expectedBytes: 1,
      threadID: 'parent-thread', companionURLs: [resumed, child, generated, visualization],
      minimumIdleSeconds: null, requiresCodexStopped: false
    }
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      trash: async (path) => renameSync(path, `${path}.trashed`),
      isCodexRunning: () => false,
      sessionDatabase: {
        deleteThread: (threadID, relatedURLs) => { deletedThreads.push({ threadID, relatedURLs }); return { removedRows: 11, freedBytes: 8192 } }
      }
    })
    expect(report.outcomes[0].status.kind).toBe('succeeded')
    for (const path of [parent, resumed, child, generated, visualization]) expect(existsSync(`${path}.trashed`)).toBe(true)
    expect(deletedThreads).toEqual([{ threadID: 'parent-thread', relatedURLs: [parent, resumed, child, generated, visualization] }])
    expect(report.outcomes[0].freedBytes).toBeGreaterThanOrEqual(8192)
  })

  it('validates every companion before trashing a session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    const rollout = join(locations.sessions, 'thread.jsonl')
    const protectedCompanion = join(locations.home, 'auth.json')
    mkdirSync(locations.sessions, { recursive: true }); writeFileSync(rollout, '{}\n'); writeFileSync(protectedCompanion, '{}')
    const task: CleanupTask = { id: rollout, title: 'thread', detail: '', url: rollout, method: 'trash', expectedBytes: 1, threadID: 'thread', companionURLs: [protectedCompanion], minimumIdleSeconds: null, requiresCodexStopped: false }
    let trashed = false
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      trash: async () => { trashed = true }, isCodexRunning: () => false
    })
    expect(report.outcomes[0].status.kind).toBe('failed')
    expect(trashed).toBe(false)
  })

  it('does not trash rollout files when the SQLite preflight fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    const rollout = join(locations.sessions, 'thread.jsonl')
    mkdirSync(locations.sessions, { recursive: true }); writeFileSync(rollout, '{}\n')
    const task: CleanupTask = { id: rollout, title: 'thread', detail: '', url: rollout, method: 'trash', expectedBytes: 1, threadID: 'thread', companionURLs: [], minimumIdleSeconds: null, requiresCodexStopped: false }
    let trashed = false
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      trash: async () => { trashed = true }, isCodexRunning: () => false,
      sessionDatabase: {
        preflightDelete: () => { throw new Error('unsupported schema') },
        deleteThread: () => ({ removedRows: 0, freedBytes: 0 })
      }
    })
    expect(report.outcomes[0].status.kind).toBe('failed')
    expect(trashed).toBe(false)
  })
})
