import { describe, expect, it } from 'vitest'
import { listableSessions, snapshotSessionBytes, type AutomationSettings, type CleanupRisk, type CleanupSelection, type ScanSnapshot, type SessionItem, type StorageEntry, type WorkspaceFolder, type WorktreeItem } from '../shared/types'
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

function worktree(id: string, overrides: Partial<WorktreeItem> = {}): WorktreeItem {
  return {
    id, path: id, projectPath: `${id}/app`, project: 'app', repositoryPath: '/repos/app',
    status: 'managed', state: 'clean', isOrphaned: false,
    bytes: 500, artifactBytes: 400, modifiedAt: 0, sourceThreads: [], ...overrides
  }
}

function snapshot(): ScanSnapshot {
  return {
    codexHome: '/codex', codexHomeExists: true, scannedAt: 1, totalCodexBytes: 1000, externalBytes: 0,
    categories: [
      { kind: 'temporary', group: 'recommended', risk: 'safe', entries: [storage('safe')] },
      { kind: 'appCache', group: 'recommended', risk: 'rebuildable', entries: [storage('app-cache', 'rebuildable')] },
      { kind: 'appLogs', group: 'recommended', risk: 'rebuildable', entries: [storage('app-log', 'rebuildable')] },
      { kind: 'protectedConfig', group: 'protectedData', risk: 'shielded', entries: [storage('shielded', 'shielded')] },
      { kind: 'pluginRemnants', group: 'recommended', risk: 'safe', entries: [storage('old-plugin')] },
      { kind: 'pluginOrphans', group: 'review', risk: 'caution', entries: [storage('orphan-plugin', 'caution')] }
    ],
    sessions: [session('active'), session('unstable', { isUnstable: true }), session('compressed', { isCompressed: true })],
    generatedAssets: [{
      id: '/codex/generated_images/active', kind: 'imageGen', path: '/codex/generated_images/active',
      companionPaths: [], bytes: 25, fileCount: 1, formats: ['png'], modifiedAt: 0,
      sourceThreadID: 'active', sourceSessionID: '/codex/sessions/active.jsonl'
    }],
    pluginVersions: [
      { marketplace: 'm', plugin: 'p', version: '1', directoryURL: '/codex/plugins/current', bytes: 10, environmentBytes: 0, modifiedAt: 0, status: 'current' },
      { marketplace: 'm', plugin: 'p', version: '0', directoryURL: '/codex/plugins/old', bytes: 10, environmentBytes: 0, modifiedAt: 0, status: 'outdated' }
    ],
    worktrees: [
      worktree('/codex/worktrees/aa01'),
      worktree('/codex/worktrees/bb02', { status: 'unmanaged' }),
      worktree('/codex/worktrees/cc03', { state: 'dirty' })
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

  it('uses Codex to uninstall a current plugin and the filesystem only for old versions', () => {
    const snap = snapshot()
    const tasks = buildTrustedTasks({ kind: 'plugins', ids: ['/codex/plugins/current', '/codex/plugins/old', '/etc'] }, snap, snap.workspace)
    expect(tasks.map((task) => [task.url, task.removal ?? 'filesystem'])).toEqual([
      ['/codex/plugins/current', 'codexPlugin']
    ])
    expect(tasks[0]).toMatchObject({
      pluginName: 'p', pluginMarketplace: 'm', requiresCodexStopped: true,
      expectedBytes: 20, companionURLs: ['/codex/plugins/old']
    })
    expect(makeCleanupPreview({ kind: 'plugins', ids: ['/codex/plugins/current'] }, [tasks[0]], {
      running: false, detectionKnown: true, desktopRunning: false, cliCommands: [], canQuit: false, blockers: []
    }, snap).warnings).toEqual([message('warning.pluginManagement')])
  })

  it('deduplicates multiple current versions into one whole-plugin uninstall', () => {
    const snap = snapshot()
    snap.pluginVersions.push({
      ...snap.pluginVersions[0], version: 'local', directoryURL: '/codex/plugins/local', bytes: 15
    })
    const tasks = buildTrustedTasks({
      kind: 'plugins', ids: ['/codex/plugins/current', '/codex/plugins/local']
    }, snap, snap.workspace)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      removal: 'codexPlugin', expectedBytes: 35,
      companionURLs: ['/codex/plugins/current', '/codex/plugins/old']
    })
  })

  it('never offers built-in or marketplace-unknown current plugins for uninstall', () => {
    const snap = snapshot()
    snap.pluginVersions.push(
      { ...snap.pluginVersions[0], directoryURL: '/codex/plugins/builtin', status: 'builtin' },
      { ...snap.pluginVersions[0], directoryURL: '/codex/plugins/unknown', marketplace: null }
    )
    expect(buildTrustedTasks({ kind: 'plugins', ids: ['/codex/plugins/builtin', '/codex/plugins/unknown'] }, snap, snap.workspace)).toEqual([])
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
      cliCommands: ['codex'], canQuit: false, blockers: [message('blocker.cliRunning', { count: 1 })]
    })
    expect(preview.blockers.map((item) => item.key)).toEqual(['blocker.cliRunning'])
    expect(preview.blockedTitles).toEqual(['active'])
  })

  it('warns that deleting a generated asset leaves a stale saved path', () => {
    const snap = snapshot()
    const image = snap.generatedAssets[0]
    const selection: CleanupSelection = { kind: 'generated-assets', ids: [image.id, '/etc/passwd'] }
    const tasks = buildTrustedTasks(selection, snap, snap.workspace)
    expect(tasks).toMatchObject([{ id: image.id, url: image.path, companionURLs: [], expectedBytes: image.bytes, requiresCodexStopped: true }])
    expect(tasks[0].title).toBe('active')
    const preview = makeCleanupPreview(selection, tasks, {
      running: false, detectionKnown: true, desktopRunning: false,
      cliCommands: [], canQuit: false, blockers: []
    }, snap)
    expect(preview.warnings).toContainEqual(message('warning.generatedAssetLocalCopy'))
  })

  it('deletes a Visualization source and Viewer as one generated asset', () => {
    const snap = snapshot()
    const visualization = {
      id: '/codex/visualizations/2026/08/24/active', kind: 'visualization' as const,
      path: '/codex/visualizations/2026/08/24/active', companionPaths: ['/codex/visualization-viewers/active'],
      bytes: 75, fileCount: 3, formats: ['html', 'png'], modifiedAt: 0,
      sourceThreadID: 'active', sourceSessionID: '/codex/sessions/active.jsonl'
    }
    snap.generatedAssets = [visualization]
    const tasks = buildTrustedTasks({ kind: 'generated-assets', ids: [visualization.id] }, snap, snap.workspace)
    expect(tasks).toMatchObject([{
      id: visualization.id,
      url: visualization.path,
      companionURLs: visualization.companionPaths,
      expectedBytes: visualization.bytes
    }])
  })

  it('uses the source conversation title for generated assets and workspace outputs', () => {
    const snap = snapshot()
    snap.sessions[0].title = '表格里的生成资产题目'
    const assetTask = buildTrustedTasks({ kind: 'generated-assets', ids: [snap.generatedAssets[0].id] }, snap, snap.workspace)[0]

    const output = folder('/docs/Codex/day/output')
    output.sourceThreads = [{ id: 'active', title: '表格里的工作产出题目', archived: false, isSubagent: false, modifiedAt: 1 }]
    const workspace = { root: '/docs/Codex', isScanned: true, entries: [folder('/docs/Codex/day', [output])] }
    const workspaceTask = buildTrustedTasks({ kind: 'workspace', ids: [output.id] }, snap, workspace)[0]

    expect(assetTask.title).toBe('表格里的生成资产题目')
    expect(workspaceTask.title).toBe('表格里的工作产出题目')
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
    expect(tasks.map((task) => task.id)).not.toContain('app-cache')
    expect(tasks.map((task) => task.id)).not.toContain('app-log')
    expect(tasks.map((task) => task.id)).not.toContain('imagegen-copy')
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
      cliCommands: [], canQuit: false, blockers: []
    }, snap)
    expect(preview.warnings).toContainEqual(message('warning.pinnedSessions', { count: 1 }))
  })

  it('never lets a worktree selection reach one Codex did not create', () => {
    const snap = snapshot()
    const tasks = buildTrustedTasks(
      { kind: 'worktrees', ids: ['/codex/worktrees/aa01', '/codex/worktrees/bb02', '/etc'], deleteRelatedSessions: false }, snap, snap.workspace)
    expect(tasks.map((task) => task.url)).toEqual(['/codex/worktrees/aa01'])
    // git has to take a worktree down, so the task says so and names the repository.
    expect(tasks[0].removal).toBe('gitWorktree')
    expect(tasks[0].repositoryPath).toBe('/repos/app')
    expect(tasks[0].companionURLs).toEqual([])
    expect(tasks[0].requiresCodexStopped).toBe(true)
  })

  it('optionally appends trusted related conversation deletions after the worktree', () => {
    const snap = snapshot()
    const parent = session('parent', {
      childThreadCount: 1,
      childBytes: 75,
      childURLs: ['/codex/sessions/child.jsonl', '/codex/generated_images/child']
    })
    const child = session('child', { isSubagent: true, parentThreadID: 'parent', fileBytes: 50, assetBytes: 25 })
    snap.sessions = [parent, child, session('unrelated')]
    snap.worktrees[0].sourceThreads = [
      { id: 'parent', title: 'Parent', archived: false, isSubagent: false, modifiedAt: 2 },
      { id: 'child', title: 'Child', archived: false, isSubagent: true, modifiedAt: 1 }
    ]

    const tasks = buildTrustedTasks({
      kind: 'worktrees', ids: [snap.worktrees[0].id], deleteRelatedSessions: true
    }, snap, snap.workspace)

    expect(tasks).toHaveLength(2)
    expect(tasks[0].removal).toBe('gitWorktree')
    expect(tasks[1]).toMatchObject({ threadID: 'parent', url: parent.fileURL })
    expect(tasks[1].companionURLs).toEqual(parent.childURLs)
    expect(tasks.some((task) => task.threadID === 'unrelated')).toBe(false)

    const preview = makeCleanupPreview({
      kind: 'worktrees', ids: [snap.worktrees[0].id], deleteRelatedSessions: true
    }, tasks, {
      running: false, detectionKnown: true, desktopRunning: false,
      cliCommands: [], canQuit: false, blockers: []
    }, snap)
    expect(preview.items).toEqual([{
      id: `worktree:${snap.worktrees[0].id}`,
      title: 'app · Parent',
      detail: snap.worktrees[0].path,
      expectedBytes: snap.worktrees[0].bytes + 175
    }])
    expect(preview.expectedBytes).toBe(snap.worktrees[0].bytes + 175)
  })

  it('matches a related conversation by rollout cwd when the desktop index ID differs', () => {
    const snap = snapshot()
    const related = session('rollout-id', { workingDirectory: '/codex/worktrees/aa01/app' })
    snap.sessions = [related]
    snap.worktrees[0].sourceThreads = [
      { id: 'desktop-catalog-id', title: 'Related', archived: false, isSubagent: false, modifiedAt: 1 }
    ]
    const selection: CleanupSelection = {
      kind: 'worktrees', ids: [snap.worktrees[0].id], deleteRelatedSessions: true
    }
    const tasks = buildTrustedTasks(selection, snap, snap.workspace)
    expect(tasks.map((task) => task.threadID)).toEqual([null, 'rollout-id'])

    const preview = makeCleanupPreview(selection, tasks, {
      running: false, detectionKnown: true, desktopRunning: false,
      cliCommands: [], canQuit: false, blockers: []
    }, snap)
    expect(preview.items).toHaveLength(1)
    expect(preview.items[0].expectedBytes).toBe(snap.worktrees[0].bytes + related.fileBytes)
  })

  it('keeps worktrees out of the scheduled run entirely', () => {
    const settings: AutomationSettings = {
      enabled: true, intervalDays: 1, cleanCaches: true, cleanOldPlugins: true,
      cleanArchivedSessions: true, archivedRetentionDays: 0, cleanActiveSessions: true,
      activeRetentionDays: 0, skipRecentSessions: false, notifyWhenFinished: false, launchAtLogin: false
    }
    const tasks = buildAutomaticTasks(snapshot(), settings, 86_400_000 * 10)
    expect(tasks.some((task) => task.url.includes('worktrees'))).toBe(false)
  })

  it('reminds the user to save uncommitted work only when a chosen worktree has some', () => {
    const snap = snapshot()
    const environment = {
      running: false, detectionKnown: true, desktopRunning: false,
      cliCommands: [], canQuit: false, blockers: []
    }
    const clean: CleanupSelection = { kind: 'worktrees', ids: ['/codex/worktrees/aa01'], deleteRelatedSessions: false }
    const dirty: CleanupSelection = { kind: 'worktrees', ids: ['/codex/worktrees/cc03'], deleteRelatedSessions: false }
    const keys = (selection: CleanupSelection) =>
      makeCleanupPreview(selection, buildTrustedTasks(selection, snap, snap.workspace), environment, snap)
        .warnings.map((warning) => warning.key)
    expect(keys(clean)).toEqual(['warning.permanent'])
    expect(keys(dirty)).toEqual(['warning.permanentWorktreeGit'])
  })
})
