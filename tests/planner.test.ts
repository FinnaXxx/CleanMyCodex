import { describe, expect, it } from 'vitest'
import { listableSessions, snapshotSessionBytes, type AutomationSettings, type CleanupRisk, type CleanupSelection, type ScanSnapshot, type SessionItem, type StorageEntry, type WorkspaceFolder } from '../shared/types'
import { buildAutomaticTasks, buildTrustedTasks, makeCleanupPreview } from '../electron/main/planner'
import { message } from '../shared/messages'

function storage(id: string, risk: CleanupRisk = 'safe'): StorageEntry {
  return { id, title: id, note: null, tags: [], url: `/codex/${id}`, bytes: 100, reclaimableBytes: 100, minimumIdleSeconds: null, requiresCodexStopped: false, risk }
}

function session(id: string, overrides: Partial<SessionItem> = {}): SessionItem {
  return {
    id: `/codex/sessions/${id}.jsonl`, threadID: id, fileURL: `/codex/sessions/${id}.jsonl`, segmentURLs: [], location: 'active',
    modifiedAt: 0, fileBytes: 100, assetBytes: 0, assetURLs: [], workingDirectory: null, title: id, preview: null, tags: [],
    isCompressed: false, isUnstable: false, parseWarnings: 0, blocksAutomaticCleanup: false, isPinned: false, isSubagent: false, parentThreadID: null,
    childThreadCount: 0, childBytes: 0, childURLs: [], ...overrides
  }
}

function folder(path: string, children: WorkspaceFolder[] = []): WorkspaceFolder {
  return { id: path, path, name: path.split('/').at(-1) ?? path, bytes: 100, fileCount: 1, modifiedAt: 0, repositories: [], sourceThreads: [], looseFiles: [`${path}/loose.txt`], children }
}

function snapshot(): ScanSnapshot {
  return {
    codexHome: '/codex', scannedAt: 1, totalCodexBytes: 1000, externalBytes: 0,
    categories: [
      { kind: 'temporary', group: 'recommended', risk: 'safe', entries: [storage('safe')] },
      { kind: 'browserCache', group: 'recommended', risk: 'rebuildable', entries: [storage('browser', 'rebuildable')] },
      { kind: 'appCache', group: 'recommended', risk: 'rebuildable', entries: [storage('app-cache', 'rebuildable')] },
      { kind: 'appLogs', group: 'recommended', risk: 'rebuildable', entries: [storage('app-log', 'rebuildable')] },
      { kind: 'marketplaceCache', group: 'review', risk: 'rebuildable', entries: [storage('market', 'rebuildable')] },
      { kind: 'protectedConfig', group: 'protectedData', risk: 'shielded', entries: [storage('shielded', 'shielded')] },
      { kind: 'pluginRemnants', group: 'recommended', risk: 'safe', entries: [storage('old-plugin')] },
      { kind: 'pluginOrphans', group: 'review', risk: 'caution', entries: [storage('orphan-plugin', 'caution')] }
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
    const tasks = buildTrustedTasks({ kind: 'storage', ids: ['safe', 'shielded', 'remove:/etc/passwd'] }, snap, snap.workspace)
    expect(tasks.map((task) => task.id)).toEqual(['safe'])
    expect(tasks[0].url).toBe('/codex/safe')
  })

  it('never lets plugin IDs remove current or unknown versions', () => {
    const snap = snapshot()
    const tasks = buildTrustedTasks({ kind: 'plugins', ids: ['/codex/plugins/current', '/codex/plugins/old', '/etc'] }, snap, snap.workspace)
    expect(tasks.map((task) => task.url)).toEqual(['/codex/plugins/old'])
    expect(tasks[0].requiresCodexStopped).toBe(true)
  })

  it('revalidates overview plugin entries against the latest plugin versions', () => {
    const snap = snapshot()
    const stale = snap.categories.find((category) => category.kind === 'pluginOrphans')!.entries[0]
    stale.url = '/codex/plugins/current'
    expect(buildTrustedTasks({ kind: 'storage', ids: [stale.id] }, snap, snap.workspace)).toEqual([])
    snap.pluginVersions[0].status = 'orphaned'
    expect(buildTrustedTasks({ kind: 'storage', ids: [stale.id] }, snap, snap.workspace)).toHaveLength(1)
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

  it('deletes only the loose files of a date folder that also holds outputs', () => {
    const snap = snapshot()
    const child = folder('/docs/Codex/day/task')
    const parent = folder('/docs/Codex/day', [child])
    const workspace = { root: '/docs/Codex', isScanned: true, entries: [parent] }
    const tasks = buildTrustedTasks({ kind: 'workspace', ids: [parent.id, child.id] }, snap, workspace)
    // Picking the date row must not swallow the output listed beside it, so both
    // choices survive: the loose file for one, the whole output directory for the other.
    expect(tasks.map((task) => task.url)).toEqual(['/docs/Codex/day/loose.txt', child.path])
    expect(tasks.flatMap((task) => task.companionURLs)).toEqual([])
  })

  it('collapses a workspace choice that sits inside another selected output', () => {
    const snap = snapshot()
    const nested = folder('/docs/Codex/day/task/inner')
    const output = folder('/docs/Codex/day/task')
    const workspace = { root: '/docs/Codex', isScanned: true, entries: [folder('/docs/Codex/day', [output, nested])] }
    const tasks = buildTrustedTasks({ kind: 'workspace', ids: [output.id, nested.id] }, snap, workspace)
    expect(tasks.map((task) => task.url)).toEqual([output.path])
  })

  it('explains direct session deletion and exclusive-access blockers in the preview', () => {
    const snap = snapshot()
    const selection: CleanupSelection = { kind: 'sessions-delete', ids: [snap.sessions[0].id] }
    const tasks = buildTrustedTasks(selection, snap, snap.workspace)
    const preview = makeCleanupPreview(selection, tasks, {
      running: true, detectionKnown: true, desktopRunning: false,
      cliCommands: ['codex'], canRestart: false, blockers: [message('blocker.cliRunning', { count: 1 })]
    })
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
    expect(tasks.map((task) => task.id)).not.toContain('orphan-plugin')
    expect(tasks.map((task) => task.id)).not.toContain('market')
    expect(tasks.map((task) => task.id)).not.toContain('browser')
    expect(tasks.map((task) => task.id)).not.toContain('app-cache')
    expect(tasks.map((task) => task.id)).not.toContain('app-log')
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

  it('warns before deleting a pinned conversation by hand, but still deletes it', () => {
    const snap = snapshot()
    snap.sessions = [session('pinned', { blocksAutomaticCleanup: true, isPinned: true }), session('ordinary')]
    const selection: CleanupSelection = { kind: 'sessions-delete', ids: snap.sessions.map((item) => item.id) }
    const tasks = buildTrustedTasks(selection, snap, snap.workspace)
    expect(tasks.map((task) => task.threadID)).toEqual(['pinned', 'ordinary'])
    const preview = makeCleanupPreview(selection, tasks, {
      running: false, detectionKnown: true, desktopRunning: false,
      cliCommands: [], canRestart: false, blockers: []
    }, snap)
    expect(preview.warnings).toContainEqual(message('warning.pinnedSessions', { count: 1 }))
  })
})
