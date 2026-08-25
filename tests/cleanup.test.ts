import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { CleanupTask } from '../shared/types'
import { runCleanup } from '../electron/main/cleanup'
import { ProtectedPaths } from '../electron/main/guard'
import { CodexLocations } from '../electron/main/locations'
import { readWorktreeAdmin, removeCodexWorktree } from '../electron/main/worktrees'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('cleanup engine', () => {
  it('uninstalls a current plugin through Codex without directly deleting its protected path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const target = join(locations.plugins, 'cache', 'personal', 'demo', '1.0.0')
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'plugin.json'), 'x')
    const task: CleanupTask = {
      id: 'uninstall:personal:demo', title: 'demo', detail: 'personal', url: target,
      expectedBytes: 1, threadID: null, companionURLs: [], minimumIdleSeconds: null,
      requiresCodexStopped: true, removal: 'codexPlugin', pluginName: 'demo', pluginMarketplace: 'personal'
    }
    const calls: string[] = []
    const report = await runCleanup([task], new ProtectedPaths(locations, [target]), {
      remove: async () => { throw new Error('must not delete directly') },
      removePlugin: async (plugin, marketplace) => { calls.push(`${plugin}@${marketplace}`) },
      isCodexRunning: () => false
    })

    expect(calls).toEqual(['demo@personal'])
    expect(report.outcomes[0].status.kind).toBe('succeeded')
    expect(existsSync(target)).toBe(true)
  })

  it('measures every cached version removed by a plugin uninstall', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const current = join(locations.plugins, 'cache', 'personal', 'demo', '2.0.0')
    const old = join(locations.plugins, 'cache', 'personal', 'demo', '1.0.0')
    for (const target of [current, old]) {
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'payload.bin'), Buffer.alloc(8192))
    }
    const task: CleanupTask = {
      id: 'uninstall:personal:demo', title: 'demo', detail: 'personal', url: current,
      expectedBytes: 16_384, threadID: null, companionURLs: [old], minimumIdleSeconds: null,
      requiresCodexStopped: true, removal: 'codexPlugin', pluginName: 'demo', pluginMarketplace: 'personal'
    }
    const report = await runCleanup([task], new ProtectedPaths(locations, [current, old]), {
      remove: async () => { throw new Error('must not delete directly') },
      removePlugin: async () => { rmSync(join(locations.plugins, 'cache', 'personal', 'demo'), { recursive: true, force: true }) },
      isCodexRunning: () => false
    })

    expect(report.outcomes[0].status.kind).toBe('succeeded')
    expect(report.outcomes[0].freedBytes).toBeGreaterThanOrEqual(16_384)
  })

  it('counts directory contents and permanently deletes an allowed target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const target = join(locations.home, '.tmp', 'stale')
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'payload'), Buffer.alloc(8192))
    const task: CleanupTask = { id: target, title: 'stale', detail: target, url: target, expectedBytes: 8192, threadID: null, companionURLs: [], minimumIdleSeconds: null, requiresCodexStopped: false }
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      remove: async (path) => rmSync(path, { recursive: true, force: true }), isCodexRunning: () => false
    })
    expect(report.outcomes[0].status.kind).toBe('succeeded')
    expect(report.outcomes[0].freedBytes).toBeGreaterThan(0)
  })

  it('refuses a named application cache directory and leaves it in place', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const target = locations.appCaches[0]
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'payload'), Buffer.alloc(8192))
    const task: CleanupTask = { id: target, title: 'Codex', detail: target, url: target, expectedBytes: 8192, threadID: null, companionURLs: [], minimumIdleSeconds: null, requiresCodexStopped: false }
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      remove: async (path) => rmSync(path, { recursive: true, force: true }), isCodexRunning: () => false
    })

    expect(report.outcomes[0].status.kind).toBe('failed')
    expect(existsSync(target)).toBe(true)
  })

  it('removes an exact source-known Codex cache leaf while preserving the container boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const target = locations.codexCaches[0]
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'catalog.json'), Buffer.alloc(8192))
    const task: CleanupTask = { id: target, title: 'remote_plugin_catalog', detail: target, url: target, expectedBytes: 8192, threadID: null, companionURLs: [], minimumIdleSeconds: null, requiresCodexStopped: true }
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      remove: async (path) => rmSync(path, { recursive: true, force: true }), isCodexRunning: () => false
    })

    expect(report.outcomes[0].status.kind).toBe('succeeded')
    expect(existsSync(target)).toBe(false)
    expect(existsSync(locations.codexCache)).toBe(true)
  })

  it('removes an ImageGen local-copy directory without touching its conversation rollout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const threadID = '11111111-1111-1111-1111-111111111111'
    const rollout = join(locations.sessions, `rollout-${threadID}.jsonl`)
    const copy = join(locations.generatedImages, threadID)
    mkdirSync(locations.sessions, { recursive: true }); writeFileSync(rollout, '{}\n')
    mkdirSync(copy, { recursive: true }); writeFileSync(join(copy, 'ig_123.png'), Buffer.alloc(8192))
    const task: CleanupTask = {
      id: `remove:${copy}`, title: 'ImageGen', detail: copy, url: copy, expectedBytes: 8192,
      threadID: null, companionURLs: [], minimumIdleSeconds: null, requiresCodexStopped: true
    }
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      remove: async (path) => rmSync(path, { recursive: true, force: true }), isCodexRunning: () => false
    })

    expect(report.outcomes[0].status.kind).toBe('succeeded')
    expect(existsSync(copy)).toBe(false)
    expect(existsSync(rollout)).toBe(true)
    expect(existsSync(locations.generatedImages)).toBe(true)
  })

  it('refuses a whole application cache container and leaves it in place', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const target = locations.appCacheContainers[0]
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'session-state'), Buffer.alloc(8192))
    const task: CleanupTask = { id: target, title: 'Codex', detail: target, url: target, expectedBytes: 8192, threadID: null, companionURLs: [], minimumIdleSeconds: null, requiresCodexStopped: false }
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      remove: async (path) => rmSync(path, { recursive: true, force: true }), isCodexRunning: () => false
    })

    expect(report.outcomes[0].status.kind).toBe('failed')
    expect(existsSync(target)).toBe(true)
  })

  it('reports an emptied directory as cleaned even though it frees no bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const target = join(locations.home, '.tmp', 'empty')
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'zero-length'), '')
    const task: CleanupTask = { id: target, title: 'empty', detail: target, url: target, expectedBytes: 0, threadID: null, companionURLs: [], minimumIdleSeconds: null, requiresCodexStopped: false }
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      remove: async (path) => rmSync(path, { recursive: true, force: true }), isCodexRunning: () => false
    })
    expect(report.outcomes[0].status.kind).toBe('succeeded')
    expect(existsSync(target)).toBe(false)
  })

  it('rechecks minimum idle time immediately before cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const target = join(locations.home, '.tmp', 'active')
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'payload'), 'active')
    const task: CleanupTask = { id: target, title: 'active', detail: target, url: target, expectedBytes: 1, threadID: null, companionURLs: [], minimumIdleSeconds: 3600, requiresCodexStopped: false }
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      remove: async () => { throw new Error('must not delete') }, isCodexRunning: () => false
    })
    expect(report.outcomes[0].status.kind).toBe('skipped')
  })

  it('removes every rollout and asset companion before the local compatibility cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
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
      id: parent, title: 'thread', detail: '', url: parent, expectedBytes: 1,
      threadID: 'parent-thread', companionURLs: [resumed, child, generated, visualization],
      minimumIdleSeconds: null, requiresCodexStopped: false
    }
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      remove: async (path) => rmSync(path, { recursive: true, force: true }),
      isCodexRunning: () => false,
      sessionDatabase: {
        deleteThreadWithProtocol: async () => false,
        deleteThreadLocally: (threadID, relatedURLs) => {
          expect(existsSync(parent)).toBe(false)
          deletedThreads.push({ threadID, relatedURLs })
          return { removedRows: 11, freedBytes: 8192 }
        }
      }
    })
    expect(report.outcomes[0].status.kind).toBe('succeeded')
    for (const path of [parent, resumed, child, generated, visualization]) expect(existsSync(path)).toBe(false)
    expect(deletedThreads).toEqual([{ threadID: 'parent-thread', relatedURLs: [parent, resumed, child, generated, visualization] }])
    expect(report.outcomes[0].freedBytes).toBeGreaterThanOrEqual(8192)
  })

  it('counts a rollout permanently removed by the preferred session protocol', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    const rollout = join(locations.sessions, 'thread.jsonl')
    mkdirSync(locations.sessions, { recursive: true }); writeFileSync(rollout, Buffer.alloc(8192))
    const task: CleanupTask = { id: rollout, title: 'thread', detail: '', url: rollout, expectedBytes: 8192, threadID: 'thread', companionURLs: [], minimumIdleSeconds: null, requiresCodexStopped: false }
    let removeCalled = false
    let preflighted = false
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      remove: async () => { removeCalled = true },
      isCodexRunning: () => false,
      sessionDatabase: {
        preflightDelete: () => { preflighted = true },
        deleteThreadWithProtocol: async () => { rmSync(rollout); return true },
        deleteThreadLocally: () => ({ removedRows: 0, freedBytes: 0 })
      }
    })
    expect(report.outcomes[0].status.kind).toBe('succeeded')
    expect(report.outcomes[0].freedBytes).toBeGreaterThan(0)
    expect(removeCalled).toBe(false)
    // The local preflight belongs to the fallback: a newer protocol must not be
    // blocked by this app's understanding of the current schemas.
    expect(preflighted).toBe(false)
  })

  it('sweeps metadata the session protocol claimed to delete but left behind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    const rollout = join(locations.sessions, 'thread.jsonl')
    mkdirSync(locations.sessions, { recursive: true }); writeFileSync(rollout, Buffer.alloc(8192))
    const task: CleanupTask = { id: rollout, title: 'thread', detail: '', url: rollout, expectedBytes: 8192, threadID: 'thread', companionURLs: [], minimumIdleSeconds: null, requiresCodexStopped: false }
    const swept: string[] = []
    const leftovers: Array<{ threadID: string; removedRows: number; reason: string | null }> = []
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      remove: async () => undefined,
      isCodexRunning: () => false,
      sessionDatabase: {
        deleteThreadWithProtocol: async () => { rmSync(rollout); return true },
        deleteThreadLocally: (threadID) => { swept.push(threadID); return { removedRows: 2, freedBytes: 0 } },
        reportProtocolLeftovers: (threadID, removedRows, reason) => leftovers.push({ threadID, removedRows, reason })
      }
    })
    expect(report.outcomes[0].status.kind).toBe('succeeded')
    expect(swept).toEqual(['thread'])
    expect(leftovers).toEqual([{ threadID: 'thread', removedRows: 2, reason: null }])
  })

  it('keeps a protocol deletion successful when the leftover sweep cannot run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    const rollout = join(locations.sessions, 'thread.jsonl')
    mkdirSync(locations.sessions, { recursive: true }); writeFileSync(rollout, Buffer.alloc(8192))
    const task: CleanupTask = { id: rollout, title: 'thread', detail: '', url: rollout, expectedBytes: 8192, threadID: 'thread', companionURLs: [], minimumIdleSeconds: null, requiresCodexStopped: false }
    const reasons: Array<string | null> = []
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      remove: async () => undefined,
      isCodexRunning: () => false,
      sessionDatabase: {
        deleteThreadWithProtocol: async () => { rmSync(rollout); return true },
        deleteThreadLocally: () => { throw new Error('unsupported schema') },
        reportProtocolLeftovers: (_threadID, _rows, reason) => reasons.push(reason)
      }
    })
    expect(report.outcomes[0].status.kind).toBe('succeeded')
    expect(reasons).toEqual(['unsupported schema'])
  })

  it('validates every companion before deleting a session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const rollout = join(locations.sessions, 'thread.jsonl')
    const protectedCompanion = join(locations.home, 'auth.json')
    mkdirSync(locations.sessions, { recursive: true }); writeFileSync(rollout, '{}\n'); writeFileSync(protectedCompanion, '{}')
    const task: CleanupTask = { id: rollout, title: 'thread', detail: '', url: rollout, expectedBytes: 1, threadID: 'thread', companionURLs: [protectedCompanion], minimumIdleSeconds: null, requiresCodexStopped: false }
    let removed = false
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      remove: async () => { removed = true }, isCodexRunning: () => false
    })
    expect(report.outcomes[0].status.kind).toBe('failed')
    expect(removed).toBe(false)
  })

  it('does not delete rollout files when the SQLite preflight fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const rollout = join(locations.sessions, 'thread.jsonl')
    mkdirSync(locations.sessions, { recursive: true }); writeFileSync(rollout, '{}\n')
    const task: CleanupTask = { id: rollout, title: 'thread', detail: '', url: rollout, expectedBytes: 1, threadID: 'thread', companionURLs: [], minimumIdleSeconds: null, requiresCodexStopped: false }
    let removed = false
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      remove: async () => { removed = true }, isCodexRunning: () => false,
      sessionDatabase: {
        preflightDelete: () => { throw new Error('unsupported schema') },
        deleteThreadLocally: () => ({ removedRows: 0, freedBytes: 0 })
      }
    })
    expect(report.outcomes[0].status.kind).toBe('failed')
    expect(removed).toBe(false)
  })

  it('takes a worktree down through git, leaving the repository with nothing to prune', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const repository = join(root, 'repo')
    const worktree = join(locations.defaultWorktrees, '44af')
    const checkout = join(worktree, 'repo')

    // A real repository and a real worktree: git's own bookkeeping is the thing under
    // test, so nothing here is faked.
    const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' })
    mkdirSync(repository, { recursive: true })
    git(repository, 'init', '--quiet', '--initial-branch=main')
    git(repository, 'config', 'user.email', 'test@example.com')
    git(repository, 'config', 'user.name', 'Test')
    writeFileSync(join(repository, 'README.md'), 'hello')
    git(repository, 'add', '.')
    git(repository, 'commit', '--quiet', '-m', 'first')
    mkdirSync(worktree, { recursive: true })
    git(repository, 'worktree', 'add', '--quiet', '-b', 'work', checkout)
    // Codex' marker, without which nothing here may be removed.
    writeFileSync(join(repository, '.git', 'worktrees', 'repo', 'codex-thread.json'),
      '{"version":1,"ownerThreadId":"t"}')
    const worktreeRel = relative(root, checkout).replace(/\\/g, '/')
    const listStdout = () => git(repository, 'worktree', 'list').stdout.replace(/\\/g, '/')
    expect(listStdout()).toContain(worktreeRel)

    // The scan sets `task.repositoryPath` from the worktree's git admin dir (git's own
    // `commondir`/`gitdir` pointer), not from `os.tmpdir()`. On the Windows runner
    // `os.tmpdir()` returns an 8.3 short-name path (`C:\Users\RUNNER~1\...`) while git
    // resolves and stores the long name (`C:\Users\runneradmin\...`), and Node's
    // `realpathSync` does not expand the short name — so a `tmpdir()`-derived path would
    // fail the production "repository changed since the last scan" guard that this task
    // path is meant to mirror. Derive it the same way the scan does.
    const task: CleanupTask = {
      id: worktree, title: 'work', detail: worktree, url: worktree, expectedBytes: 0,
      threadID: null, companionURLs: [], minimumIdleSeconds: null, requiresCodexStopped: false,
      removal: 'gitWorktree', repositoryPath: readWorktreeAdmin(checkout)?.repositoryPath ?? repository
    }
    const guards = new ProtectedPaths(locations)
    const report = await runCleanup([task], guards, {
      remove: async (path) => rmSync(path, { recursive: true, force: true }),
      removeWorktree: (path, repositoryPath) =>
        removeCodexWorktree(path, repositoryPath, async (target) => rmSync(target, { recursive: true, force: true })),
      isCodexRunning: () => false
    })

    // Surface the git failure reason in the assertion message so a Windows-only failure
    // (this is the one test that exercises a real `git worktree remove`) reports what git
    // actually said, not just "failed".
    expect(report.outcomes[0].status.kind, `worktree outcome: ${JSON.stringify(report.outcomes[0].status)}`).toBe('succeeded')
    expect(existsSync(worktree)).toBe(false)
    // The point of going through git: the repository no longer lists it, and the
    // administrative directory inside the repository is gone with it.
    expect(listStdout()).not.toContain(worktreeRel)
    expect(existsSync(join(repository, '.git', 'worktrees', 'repo'))).toBe(false)
  })

  it('refuses a worktree that carries no sign of having been created by Codex', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-cleanup-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const worktree = join(locations.defaultWorktrees, 'bb02')
    const checkout = join(worktree, 'mine')
    const admin = join(root, 'repo', '.git', 'worktrees', 'mine')
    mkdirSync(checkout, { recursive: true })
    mkdirSync(admin, { recursive: true })
    writeFileSync(join(admin, 'commondir'), '../..\n')
    writeFileSync(join(checkout, '.git'), `gitdir: ${admin}\n`)
    writeFileSync(join(checkout, 'work.txt'), 'unsaved')

    const task: CleanupTask = {
      id: worktree, title: 'mine', detail: worktree, url: worktree, expectedBytes: 0,
      threadID: null, companionURLs: [], minimumIdleSeconds: null, requiresCodexStopped: false,
      removal: 'gitWorktree', repositoryPath: join(root, 'repo')
    }
    const report = await runCleanup([task], new ProtectedPaths(locations), {
      remove: async (path) => rmSync(path, { recursive: true, force: true }),
      removeWorktree: (path, repositoryPath) =>
        removeCodexWorktree(path, repositoryPath, async (target) => rmSync(target, { recursive: true, force: true })),
      isCodexRunning: () => false
    })

    // The guard turns it away before the removal runs, and the work is still there.
    expect(report.outcomes[0].status.kind).toBe('failed')
    expect(existsSync(join(checkout, 'work.txt'))).toBe(true)
  })
})
