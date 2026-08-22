import { describe, expect, it } from 'vitest'
import type { AutomationSettings, CleanupRisk, ScanSnapshot, SessionItem, StorageEntry, WorkspaceFolder } from '../shared/types'
import { buildAutomaticTasks, buildTrustedTasks, makeCleanupPreview } from '../electron/main/planner'

function storage(id: string, risk: CleanupRisk = 'safe'): StorageEntry {
  return { id, title: id, detail: id, url: `/codex/${id}`, bytes: 100, reclaimableBytes: 100, minimumIdleSeconds: null, requiresCodexStopped: false, method: 'trash', risk }
}

function session(id: string, overrides: Partial<SessionItem> = {}): SessionItem {
  return {
    id: `/codex/sessions/${id}.jsonl`, threadID: id, fileURL: `/codex/sessions/${id}.jsonl`, location: 'active',
    modifiedAt: 0, fileBytes: 100, assetBytes: 0, assetURLs: [], embeddedImageBytes: 60, embeddedImageCount: 2,
    distinctImageCount: 1, duplicateImageBytes: 30, workingDirectory: null, title: id, preview: null, tags: [],
    isCompressed: false, isUnstable: false, parseWarnings: 0, ...overrides
  }
}

function folder(path: string, children: WorkspaceFolder[] = []): WorkspaceFolder {
  return { id: path, path, name: path.split('/').at(-1) ?? path, bytes: 100, fileCount: 1, modifiedAt: 0, repositories: [], children }
}

function snapshot(): ScanSnapshot {
  return {
    codexHome: '/codex', scannedAt: 1, totalCodexBytes: 1000, externalBytes: 0,
    categories: [
      { kind: 'temporary', title: 'tmp', detail: '', group: 'recommended', risk: 'safe', entries: [storage('safe')] },
      { kind: 'marketplaceCache', title: 'market', detail: '', group: 'review', risk: 'rebuildable', entries: [storage('market', 'rebuildable')] },
      { kind: 'protectedConfig', title: 'config', detail: '', group: 'protectedData', risk: 'shielded', entries: [storage('shielded', 'shielded')] },
      { kind: 'pluginRemnants', title: 'plugins', detail: '', group: 'recommended', risk: 'safe', entries: [storage('old-plugin')] }
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
    const tasks = buildTrustedTasks({ kind: 'storage', ids: ['safe', 'shielded', 'trash:/etc/passwd'] }, snap, snap.workspace, true)
    expect(tasks.map((task) => task.id)).toEqual(['safe'])
    expect(tasks[0].url).toBe('/codex/safe')
  })

  it('never lets plugin IDs remove current or unknown versions', () => {
    const snap = snapshot()
    const tasks = buildTrustedTasks({ kind: 'plugins', ids: ['/codex/plugins/current', '/codex/plugins/old', '/etc'] }, snap, snap.workspace, true)
    expect(tasks.map((task) => task.url)).toEqual(['/codex/plugins/old'])
  })

  it('falls back explicitly to trash when app server deletion is unavailable', () => {
    const snap = snapshot()
    expect(buildTrustedTasks({ kind: 'sessions-delete', ids: [snap.sessions[0].id], mode: 'appServer' }, snap, snap.workspace, false)[0].method).toBe('trash')
  })

  it('excludes compressed and unstable sessions from rewriting', () => {
    const snap = snapshot()
    const tasks = buildTrustedTasks({ kind: 'sessions-slim', ids: snap.sessions.map((item) => item.id), mode: 'deduplicate' }, snap, snap.workspace, true)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].threadID).toBe('active')
  })

  it('collapses nested workspace choices to their outermost selected directory', () => {
    const snap = snapshot()
    const child = folder('/docs/Codex/day/task')
    const parent = folder('/docs/Codex/day', [child])
    const workspace = { root: '/docs/Codex', isScanned: true, entries: [parent] }
    const tasks = buildTrustedTasks({ kind: 'workspace', ids: [parent.id, child.id] }, snap, workspace, true)
    expect(tasks.map((task) => task.url)).toEqual([parent.path])
  })

  it('rejects invalid cleanup modes received over IPC', () => {
    const snap = snapshot()
    expect(() => buildTrustedTasks({ kind: 'sessions-slim', ids: [], mode: 'bad' } as never, snap, snap.workspace, true)).toThrow('方式无效')
  })

  it('explains direct session deletion and exclusive-access blockers in the preview', () => {
    const snap = snapshot()
    const selection = { kind: 'sessions-delete', ids: [snap.sessions[0].id], mode: 'trash' } as const
    const tasks = buildTrustedTasks(selection, snap, snap.workspace, true)
    const preview = makeCleanupPreview(selection, tasks, { running: true, detectionKnown: true, desktopRunning: false, cliCommands: ['codex'], canRestart: false, blockerSummary: 'codex 正在运行' })
    expect(preview.warnings.join(' ')).toContain('历史列表')
    expect(preview.blockerSummary).toContain('运行')
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
    const tasks = buildAutomaticTasks(snap, settings, true, 100 * 86_400_000)
    expect(tasks.map((task) => task.id)).toContain('safe')
    expect(tasks.map((task) => task.id)).toContain('old-plugin')
    expect(tasks.map((task) => task.id)).not.toContain('market')
    expect(tasks.map((task) => task.threadID)).toContain('active')
    expect(tasks.map((task) => task.threadID)).not.toContain('unstable')
  })
})
