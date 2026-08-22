import { describe, expect, it } from 'vitest'
import { listableSessions, snapshotSessionBytes, type AutomationSettings, type CleanupRisk, type ScanSnapshot, type SessionItem, type StorageEntry, type WorkspaceFolder } from '../shared/types'
import { buildAutomaticTasks, buildTrustedTasks, makeCleanupPreview } from '../electron/main/planner'
import { message } from '../shared/messages'

function storage(id: string, risk: CleanupRisk = 'safe'): StorageEntry {
  return { id, title: id, note: null, tags: [], url: `/codex/${id}`, bytes: 100, reclaimableBytes: 100, minimumIdleSeconds: null, requiresCodexStopped: false, risk }
}

function session(id: string, overrides: Partial<SessionItem> = {}): SessionItem {
  return {
    id: `/codex/sessions/${id}.jsonl`, threadID: id, fileURL: `/codex/sessions/${id}.jsonl`, segmentURLs: [], location: 'active',
    modifiedAt: 0, fileBytes: 100, assetBytes: 0, assetURLs: [], workingDirectory: null, title: id, preview: null, tags: [],
    isCompressed: false, isUnstable: false, parseWarnings: 0, blocksAutomaticCleanup: false, isSubagent: false, parentThreadID: null,
    childThreadCount: 0, childBytes: 0, childURLs: [], ...overrides
  }
}

function folder(path: string, children: WorkspaceFolder[] = []): WorkspaceFolder {
  return { id: path, path, name: path.split('/').at(-1) ?? path, bytes: 100, fileCount: 1, modifiedAt: 0, repositories: [], sourceThreads: [], children }
}

function snapshot(): ScanSnapshot {
  return {
    codexHome: '/codex', scannedAt: 1, totalCodexBytes: 1000, externalBytes: 0,
    categories: [
      { kind: 'temporary', group: 'recommended', risk: 'safe', entries: [storage('safe')] },
      { kind: 'marketplaceCache', group: 'review', risk: 'rebuildable', entries: [storage('market', 'rebuildable')] },
      { kind: 'protectedConfig', group: 'protectedData', risk: 'shielded', entries: [storage('shielded', 'shielded')] },
      { kind: 'pluginRemnants', group: 'recommended', risk: 'safe', entries: [storage('old-plugin')] }
    ],
    sessions: [session('active'), session('unstable', { isUnstable: true }), session('compressed', { isCompressed: true })],
    pluginVersions: [
      { marketplace: 'm', plugin: 'p', version: '1', directoryURL: '/codex/plugins/current', bytes: 10, environmentBytes: 0, modifiedAt: 0, status: 'current' },
      { marketplace: 'm', plugin: 'p', version: '0', directoryURL: '/codex/plugins/old', bytes: 10, environmentBytes: 0, modifiedAt: 0, status: 'outdated' }
    ],
    workspace: { root: '/docs/Codex', isScanned: false, entries: [] }, notes: []
  }
}

describe('trusted cleanup planner', () => {
  it('resolves only known selectable IDs and ignores forged or protected entries', () => {
    const snap = snapshot()
    const tasks = buildTrustedTasks({ kind: 'storage', ids: ['safe', 'shielded', 'trash:/etc/passwd'] }, snap, snap.workspace)
    expect(tasks.map((task) => task.id)).toEqual(['safe'])
    expect(tasks[0].url).toBe('/codex/safe')
  })

  it('never lets plugin IDs remove current or unknown versions', () => {
    const snap = snapshot()
    const tasks = buildTrustedTasks({ kind: 'plugins', ids: ['/codex/plugins/current', '/codex/plugins/old', '/etc'] }, snap, snap.workspace)
    expect(tasks.map((task) => task.url)).toEqual(['/codex/plugins/old'])
  })

  it('always plans session deletion as a recoverable Trash operation', () => {
    const snap = snapshot()
    const task = buildTrustedTasks({ kind: 'sessions-delete', ids: [snap.sessions[0].id] }, snap, snap.workspace)[0]
    expect(task.url).toBe(snap.sessions[0].fileURL)
    expect(task.requiresCodexStopped).toBe(true)
  })

  it('deletes a selected parent as one task with child rollout companions and bytes', () => {
    const snap = snapshot()
    const parent = session('parent', {
      childThreadCount: 1,
      childBytes: 75,
      childURLs: ['/codex/sessions/child.jsonl', '/codex/generated_images/child']
    })
    const child = session('child', { isSubagent: true, parentThreadID: 'parent', fileBytes: 50, assetBytes: 25 })
    snap.sessions = [parent, child]
    const tasks = buildTrustedTasks({ kind: 'sessions-delete', ids: [parent.id, child.id] }, snap, snap.workspace)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].expectedBytes).toBe(175)
    expect(tasks[0].companionURLs).toEqual(['/codex/sessions/child.jsonl', '/codex/generated_images/child'])
  })

  it('keeps resumed rollout segments attached to one deletion task', () => {
    const snap = snapshot()
    const resumed = session('resumed', {
      segmentURLs: ['/codex/sessions/resumed-part-1.jsonl', '/codex/sessions/resumed-part-2.jsonl']
    })
    snap.sessions = [resumed]
    const deletion = buildTrustedTasks({ kind: 'sessions-delete', ids: [resumed.id] }, snap, snap.workspace)
    expect(deletion).toHaveLength(1)
    expect(deletion[0].companionURLs).toEqual(resumed.segmentURLs)
  })

  it('lists a grouped parent once while keeping an orphan subagent visible and counted', () => {
    const snap = snapshot()
    const parent = session('parent', { childThreadCount: 1, childBytes: 75 })
    const child = session('child', { isSubagent: true, parentThreadID: 'parent', fileBytes: 50, assetBytes: 25 })
    const orphan = session('orphan', { isSubagent: true, parentThreadID: 'missing', fileBytes: 40 })
    snap.sessions = [parent, child, orphan]
    expect(listableSessions(snap).map((item) => item.threadID)).toEqual(['parent', 'orphan'])
    expect(snapshotSessionBytes(snap)).toBe(100 + 75 + 40)
  })

  it('collapses nested workspace choices to their outermost selected directory', () => {
    const snap = snapshot()
    const child = folder('/docs/Codex/day/task')
    const parent = folder('/docs/Codex/day', [child])
    const workspace = { root: '/docs/Codex', isScanned: true, entries: [parent] }
    const tasks = buildTrustedTasks({ kind: 'workspace', ids: [parent.id, child.id] }, snap, workspace)
    expect(tasks.map((task) => task.url)).toEqual([parent.path])
  })

  it('explains direct session deletion and exclusive-access blockers in the preview', () => {
    const snap = snapshot()
    const selection = { kind: 'sessions-delete', ids: [snap.sessions[0].id] } as const
    const tasks = buildTrustedTasks(selection, snap, snap.workspace)
    const preview = makeCleanupPreview(selection, tasks, {
      running: true, detectionKnown: true, desktopRunning: false,
      cliCommands: ['codex'], canRestart: false, blockers: [message('blocker.cliRunning', { count: 1 })]
    })
    expect(preview.warnings.map((item) => item.key)).toContain('warning.sessionDelete')
    expect(preview.blockers.map((item) => item.key)).toEqual(['blocker.cliRunning'])
    expect(preview.blockedTitles).toEqual(['active'])
  })
})

describe('automatic cleanup planner', () => {
  const settings: AutomationSettings = {
    enabled: true, intervalDays: 30, cleanCaches: true, cleanOldPlugins: true,
    cleanArchivedSessions: true, archivedRetentionDays: 30, cleanActiveSessions: true, activeRetentionDays: 30,
    skipRecentSessions: true, notifyWhenFinished: false, launchAtLogin: false
  }

  it('shares safe cache rules and excludes review categories and unstable sessions', () => {
    const snap = snapshot()
    const tasks = buildAutomaticTasks(snap, settings, 100 * 86_400_000)
    expect(tasks.map((task) => task.id)).toContain('safe')
    expect(tasks.map((task) => task.id)).toContain('old-plugin')
    expect(tasks.map((task) => task.id)).not.toContain('market')
    expect(tasks.map((task) => task.threadID)).toContain('active')
    expect(tasks.map((task) => task.threadID)).not.toContain('unstable')
  })

  it('never schedules a child subagent independently from its visible conversation', () => {
    const snap = snapshot()
    const parent = session('parent', { modifiedAt: 99 * 86_400_000, childThreadCount: 1, childBytes: 50, childURLs: ['/codex/sessions/child.jsonl'] })
    const child = session('child', { isSubagent: true, parentThreadID: 'parent', modifiedAt: 0, fileBytes: 50 })
    snap.sessions = [parent, child]
    const tasks = buildAutomaticTasks(snap, settings, 100 * 86_400_000)
    expect(tasks.some((task) => task.threadID === 'child')).toBe(false)
  })

  it('keeps pinned, queued, and unfinished-goal conversations out of automatic cleanup', () => {
    const snap = snapshot()
    snap.sessions = [session('protected', { blocksAutomaticCleanup: true, modifiedAt: 0 })]
    expect(buildAutomaticTasks(snap, settings, 100 * 86_400_000).some((task) => task.threadID === 'protected')).toBe(false)
  })
})
