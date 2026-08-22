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
    const task: CleanupTask = { id: target, title: 'stale', detail: target, url: target, method: 'trash', expectedBytes: 8192, threadID: null, companionURLs: [], slimMode: null, minimumIdleSeconds: null, requiresCodexStopped: false }
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      trash: async (path) => renameSync(path, `${path}.trashed`), isCodexRunning: () => false,
      appServer: { isAvailable: false, deleteThread: async () => undefined }
    })
    expect(report.outcomes[0].status.kind).toBe('succeeded')
    expect(report.outcomes[0].freedBytes).toBeGreaterThan(0)
  })

  it('rechecks minimum idle time immediately before cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    const target = join(locations.home, '.tmp', 'active')
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'payload'), 'active')
    const task: CleanupTask = { id: target, title: 'active', detail: target, url: target, method: 'trash', expectedBytes: 1, threadID: null, companionURLs: [], slimMode: null, minimumIdleSeconds: 3600, requiresCodexStopped: false }
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      trash: async () => { throw new Error('must not trash') }, isCodexRunning: () => false,
      appServer: { isAvailable: false, deleteThread: async () => undefined }
    })
    expect(report.outcomes[0].status.kind).toBe('skipped')
  })

  it('gates compaction and slimming on the exact file usage result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    const database = join(locations.home, 'logs_1.sqlite')
    const rollout = join(locations.sessions, 'rollout.jsonl')
    mkdirSync(locations.sessions, { recursive: true })
    writeFileSync(database, 'not opened because usage gate runs first')
    writeFileSync(rollout, '{"image":"data:image/png;base64,AAAA"}\n')
    const compact: CleanupTask = { id: 'db', title: 'db', detail: '', url: database, method: 'compactDatabase', expectedBytes: 1, threadID: null, companionURLs: [], slimMode: null, minimumIdleSeconds: null, requiresCodexStopped: false }
    const slim: CleanupTask = { id: 'slim', title: 'slim', detail: '', url: rollout, method: 'slimSession', expectedBytes: 1, threadID: 'thread', companionURLs: [], slimMode: 'stripAll', minimumIdleSeconds: null, requiresCodexStopped: false }
    const report = await runCleanup([compact, slim], new ProtectedPaths(locations), {
      trash: async () => undefined, isCodexRunning: () => false, fileUsage: () => ({ kind: 'inUse', processes: ['Codex'] }),
      appServer: { isAvailable: false, deleteThread: async () => undefined }
    })
    expect(report.outcomes.map((item) => item.status.kind)).toEqual(['skipped', 'skipped'])
    expect(report.outcomes.map((item) => item.status.kind === 'skipped' ? item.status.reason : '').join(' ')).toContain('Codex')
  })

  it('uses the running-process fallback only when exact usage is unknown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    mkdirSync(locations.sessions, { recursive: true })
    const unknownPath = join(locations.sessions, 'unknown.jsonl')
    const freePath = join(locations.sessions, 'free.jsonl')
    const line = '{"image":"data:image/png;base64,AAAA"}\n'
    writeFileSync(unknownPath, line); writeFileSync(freePath, line)
    const makeSlim = (path: string): CleanupTask => ({ id: path, title: path, detail: '', url: path, method: 'slimSession', expectedBytes: 1, threadID: 'thread', companionURLs: [], slimMode: 'stripAll', minimumIdleSeconds: null, requiresCodexStopped: false })
    const report = await runCleanup([makeSlim(unknownPath), makeSlim(freePath)], new ProtectedPaths(locations), {
      trash: async (path) => renameSync(path, `${path}.trashed`), isCodexRunning: () => true,
      fileUsage: (path) => path === freePath ? { kind: 'free' } : { kind: 'unknown' },
      appServer: { isAvailable: false, deleteThread: async () => undefined }
    })
    expect(report.outcomes.map((item) => item.status.kind)).toEqual(['skipped', 'succeeded'])
    expect(existsSync(freePath)).toBe(true)
    expect(existsSync(`${freePath}.trashed`)).toBe(true)
  })

  it('does not silently downgrade an app-server deletion after confirmation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    const rollout = join(locations.sessions, 'thread.jsonl')
    mkdirSync(locations.sessions, { recursive: true }); writeFileSync(rollout, '{}\n')
    const task: CleanupTask = { id: rollout, title: 'thread', detail: '', url: rollout, method: 'deleteThread', expectedBytes: 1, threadID: 'thread', companionURLs: [], slimMode: null, minimumIdleSeconds: null, requiresCodexStopped: false }
    let trashed = false
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      trash: async () => { trashed = true }, isCodexRunning: () => false,
      appServer: { isAvailable: false, deleteThread: async () => undefined }
    })
    expect(report.outcomes[0].status.kind).toBe('failed')
    expect(trashed).toBe(false)
    expect(existsSync(rollout)).toBe(true)
  })

  it('validates every companion before asking the app server to delete a thread', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    const rollout = join(locations.sessions, 'thread.jsonl')
    const protectedCompanion = join(locations.home, 'auth.json')
    mkdirSync(locations.sessions, { recursive: true }); writeFileSync(rollout, '{}\n'); writeFileSync(protectedCompanion, '{}')
    const task: CleanupTask = { id: rollout, title: 'thread', detail: '', url: rollout, method: 'deleteThread', expectedBytes: 1, threadID: 'thread', companionURLs: [protectedCompanion], slimMode: null, minimumIdleSeconds: null, requiresCodexStopped: false }
    let called = false
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      trash: async () => undefined, isCodexRunning: () => false,
      appServer: { isAvailable: true, deleteThread: async () => { called = true } }
    })
    expect(report.outcomes[0].status.kind).toBe('failed')
    expect(called).toBe(false)
  })

  it('reports app-server deletion as successful even when it already removed every file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    const rollout = join(locations.sessions, 'thread.jsonl')
    mkdirSync(locations.sessions, { recursive: true }); writeFileSync(rollout, '{}\n')
    const task: CleanupTask = { id: rollout, title: 'thread', detail: '', url: rollout, method: 'deleteThread', expectedBytes: 1, threadID: 'thread', companionURLs: [], slimMode: null, minimumIdleSeconds: null, requiresCodexStopped: false }
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      trash: async () => undefined, isCodexRunning: () => false,
      appServer: { isAvailable: true, deleteThread: async () => renameSync(rollout, `${rollout}.deleted`) }
    })
    expect(report.outcomes[0].status.kind).toBe('succeeded')
    expect(report.outcomes[0].freedBytes).toBeGreaterThan(0)
  })
})
