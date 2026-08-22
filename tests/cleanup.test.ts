import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
})
