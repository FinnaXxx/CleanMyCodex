import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { snapshotFoundNothing, type ScanProgress } from '../shared/types'
import { CodexLocations, appCacheDirectories, codexCacheDirectories } from '../electron/main/locations'
import { outermostStorageRoots, scanSnapshot } from '../electron/main/scanner'
import { directoryAllocatedSize } from '../electron/main/fs-size'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function write(path: string, bytes = 8192): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes, 7))
}

function age(path: string, days: number): void {
  const date = new Date(Date.now() - days * 86_400_000)
  utimesSync(path, date, date)
}

function linkedWorktree(base: string, root: string, id = '44af', project = 'project'): string {
  const checkout = join(root, id, project)
  const admin = join(base, 'repos', project, '.git', 'worktrees', project)
  write(join(checkout, 'source.ts'))
  mkdirSync(admin, { recursive: true })
  writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(admin, 'commondir'), '../..\n')
  writeFileSync(join(admin, 'codex-thread.json'), '{"version":1,"ownerThreadId":"t"}')
  writeFileSync(join(checkout, '.git'), `gitdir: ${admin}\n`)
  return join(root, id)
}

describe('storage scanner semantics', () => {
  it('reclaims every staging root Codex abandons, and nothing live beside them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-scan-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const stale = (path: string): string => {
      write(join(path, 'payload')); age(join(path, 'payload'), 3); age(path, 3)
      return path
    }
    // Codex' own scratch roots: the arg0 shim directories it sweeps on launch, the
    // curated-plugin backup its sweep misses, and the staging parents it renames
    // finished trees out of.
    const arg0 = stale(join(locations.arg0Temporary, 'codex-arg0ABC'))
    const backup = stale(join(locations.temporary, 'plugins-backup-XYZ'))
    const staged = locations.stagingParents.map((parent) => stale(join(parent, 'staged-1')))
    // Live state that shares those roots and must survive.
    const curated = join(locations.temporary, 'plugins')
    const installed = join(locations.marketplaceInstalls, 'openai-curated')
    write(join(curated, 'marketplace.json'))
    write(join(installed, 'marketplace.json'))
    write(join(locations.temporary, 'plugins.sha'))
    const fresh = join(locations.temporary, 'plugins-backup-FRESH')
    write(join(fresh, 'payload'))

    const snapshot = await scanSnapshot(locations, [])
    const urls = snapshot.categories.find((category) => category.kind === 'temporary')?.entries.map((entry) => entry.url) ?? []
    for (const path of [arg0, backup, ...staged]) expect(urls, path).toContain(path)
    for (const path of [curated, installed, fresh, join(locations.temporary, 'plugins.sha')]) {
      expect(urls, path).not.toContain(path)
    }
  })

  it('keeps recent logs, protects live marketplaces, and associates assets with their thread', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-scan-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const thread = '11111111-1111-1111-1111-111111111111'
    const rollout = join(locations.sessions, '2026', '08', `rollout-${thread}.jsonl`)
    write(rollout)
    writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id: thread, title: '活跃会话' } })}\n`)

    const oldLog = join(locations.appLogs, '2026', '07', '01', 'codex-desktop-s1-100-t0.log')
    write(oldLog); age(oldLog, 40)
    const stale = join(locations.temporary, 'abandoned')
    write(join(stale, 'payload')); age(join(stale, 'payload'), 5); age(stale, 5)
    const directStaging = join(locations.temporary, 'plugins-clone-old')
    write(join(directStaging, 'payload')); age(join(directStaging, 'payload'), 2); age(directStaging, 2)
    const bundledLive = locations.bundledMarketplaceSource
    const bundledStaging = join(locations.bundledMarketplaces, 'openai-bundled.staging-old')
    write(join(bundledLive, 'plugin.json'))
    write(join(bundledStaging, 'plugin.json')); age(join(bundledStaging, 'plugin.json'), 2); age(bundledStaging, 2)
    const liveMarket = join(locations.temporary, 'custom-source')
    const externalMarket = join(root, 'shared-market')
    write(join(liveMarket, 'plugin.json'))
    write(join(externalMarket, 'plugin.json'))
    writeFileSync(join(locations.home, 'config.toml'), '[marketplaces.local]\nsource = ".tmp/custom-source"\n[marketplaces.shared]\nsource = "../shared-market"\n')

    write(join(locations.generatedImages, thread, 'active.png'))
    const orphanImages = join(locations.generatedImages, '99999999-9999-9999-9999-999999999999')
    write(join(orphanImages, 'only-copy.png'))
    const visualization = join(locations.visualizations, '2026', '08', '24', thread)
    write(join(visualization, 'comparison.html'))
    write(join(visualization, 'comparison.png'))
    const viewer = join(locations.visualizationViewers, thread)
    write(join(viewer, 'index.html'))
    write(join(locations.computerUse, 'helper.bin'))
    write(join(locations.pluginRuntime, 'codex'))
    mkdirSync(join(locations.home, 'plugins/cache/openai-bundled/example/1/.codex-plugin'), { recursive: true })
    writeFileSync(join(locations.home, 'plugins/cache/openai-bundled/example/1/.codex-plugin/plugin.json'), '{"name":"example","version":"1"}')
    write(join(locations.home, 'plugins/cache/openai-bundled/example/1', 'payload.bin'))
    const logDatabase = join(locations.home, 'logs_2.sqlite')
    write(logDatabase)
    write(`${logDatabase}-wal`)
    write(`${logDatabase}-shm`)
    write(join(locations.home, 'thread_history_1.sqlite'))
    write(join(locations.home, 'thread_history_1.sqlite-wal'))
    write(join(locations.appSupport, 'Default', 'Cookies'))
    write(join(locations.appSupport, 'Default', 'Cache', 'cache.bin'))
    write(join(locations.appSupport, 'Cache', 'cache.bin'))
    write(join(locations.appSupport, 'GraphiteDawnCache', 'cache.bin'))
    write(join(locations.appSupport, 'WasmTtsEngine', 'engine.bin'))
    for (const cache of locations.codexCaches) write(join(cache, 'cache.bin'))
    const unknownCodexCache = join(locations.codexCache, 'future-runtime-state')
    write(join(unknownCodexCache, 'state.bin'))
    write(join(locations.appCaches[0], 'cache.bin'))
    write(join(locations.home, 'attachments', 'attachment.bin'))
    write(join(locations.home, 'goals_1.sqlite'))
    write(join(locations.home, 'history.jsonl'))
    write(join(locations.home, 'log', 'codex-tui.log'))

    const progress: ScanProgress[] = []
    const snapshot = await scanSnapshot(locations, [], (item) => progress.push(item))
    expect(progress.at(-1)).toMatchObject({ stage: { key: 'stage.done' }, fraction: 1 })
    expect(progress.some((item) => item.stage?.key === 'stage.sessions')).toBe(true)
    // The desktop application rotates its own logs: they are counted as one protected
    // entry for the log root, and no log is ever offered for deletion however old it is.
    const logs = snapshot.categories.find((category) => category.kind === 'appLogs')
    expect(logs).toMatchObject({ group: 'protectedData', risk: 'shielded' })
    expect(new Set(logs?.entries.map((entry) => entry.url))).toEqual(new Set([locations.appLogs, join(locations.home, 'log'), logDatabase]))
    expect(logs?.entries[0].bytes).toBeGreaterThan(0)
    // `~/.codex/log` is the Codex runtime's rolling log directory: counted under 应用日志
    // with its own note, never offered for deletion.
    expect(logs?.entries.some((entry) => entry.url === join(locations.home, 'log') && entry.note?.key === 'note.codexLog' && entry.risk === 'shielded')).toBe(true)
    // `logs_*.sqlite` diagnostic DBs are folded into 应用日志 (WAL/SHM rolled into the
    // entry's bytes) rather than split into their own category.
    expect(logs?.entries.some((entry) => entry.url === logDatabase && entry.note?.key === 'note.logDatabase' && entry.bytes === 24_576 && entry.risk === 'shielded')).toBe(true)
    // `logDatabase` is no longer its own StorageKind: it is folded into 应用日志 above, so
    // there is nothing to assert here — the type itself forbids that category kind.
    expect(snapshot.categories.flatMap((category) => category.entries).some((entry) => entry.url === oldLog)).toBe(false)
    const protectedConfigURLs = snapshot.categories.find((category) => category.kind === 'protectedConfig')?.entries.map((entry) => entry.url) ?? []
    expect(protectedConfigURLs).not.toContain(logDatabase)
    expect(protectedConfigURLs).not.toContain(`${logDatabase}-wal`)
    expect(protectedConfigURLs).not.toContain(`${logDatabase}-shm`)
    expect(protectedConfigURLs).not.toContain(join(locations.home, 'log'))
    // State databases (state/goals/queue/memories) get their own category in 日志与数据库,
    // with WAL/SHM folded in; they no longer sit in protected-config as separate sidecars.
    const stateDbs = snapshot.categories.find((category) => category.kind === 'stateDatabase')
    expect(stateDbs).toMatchObject({ group: 'protectedData', risk: 'shielded' })
    expect(stateDbs?.entries.some((entry) => entry.url === join(locations.home, 'goals_1.sqlite') && entry.note?.key === 'note.stateDatabase')).toBe(true)
    // `history.jsonl` is prompt/command history: state, not a rotated log, so it joins the
    // state databases rather than sitting in protected-config.
    expect(stateDbs?.entries.some((entry) => entry.url === join(locations.home, 'history.jsonl') && entry.note?.key === 'note.stateDatabase')).toBe(true)
    expect(protectedConfigURLs).not.toContain(join(locations.home, 'goals_1.sqlite'))
    expect(protectedConfigURLs).not.toContain(join(locations.home, 'goals_1.sqlite-wal'))
    expect(protectedConfigURLs).not.toContain(join(locations.home, 'history.jsonl'))

    const temporary = snapshot.categories.find((category) => category.kind === 'temporary')
    expect(temporary?.entries.map((entry) => entry.url)).not.toContain(stale)
    expect(temporary?.entries.map((entry) => entry.url)).toContain(directStaging)
    expect(temporary?.entries.map((entry) => entry.url)).toContain(bundledStaging)
    expect(temporary?.entries.map((entry) => entry.url)).not.toContain(bundledLive)
    expect(snapshot.categories.flatMap((category) => category.entries).some((entry) => entry.url === liveMarket && entry.risk !== 'shielded')).toBe(false)
    expect(snapshot.categories.find((category) => category.kind === 'pluginData')?.entries.some((entry) => entry.url === liveMarket)).toBe(true)
    expect(snapshot.categories.find((category) => category.kind === 'pluginData')?.entries.some((entry) => entry.url === externalMarket)).toBe(true)

    expect(snapshot.sessions.find((session) => session.threadID === thread)?.assetURLs)
      .toEqual(expect.arrayContaining([join(locations.generatedImages, thread), visualization, viewer]))
    expect(snapshot.sessions.find((session) => session.threadID === thread)?.tags).toContain('imageGen')
    expect(snapshot.generatedAssets).toHaveLength(3)
    expect(snapshot.generatedAssets).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'imageGen', path: join(locations.generatedImages, thread), companionPaths: [], sourceThreadID: thread, sourceSessionID: rollout, fileCount: 1, formats: ['png'] }),
      expect.objectContaining({ kind: 'imageGen', path: orphanImages, sourceSessionID: null, fileCount: 1 }),
      expect.objectContaining({ kind: 'visualization', path: visualization, companionPaths: [viewer], sourceSessionID: rollout, fileCount: 3, formats: ['html', 'png'] })
    ]))
    const computerUse = snapshot.categories.find((category) => category.kind === 'computerUse')
    expect(computerUse).toMatchObject({ group: 'protectedData', risk: 'shielded' })
    expect(computerUse?.entries[0].requiresCodexStopped).toBe(true)
    const displayedURLs = snapshot.categories.flatMap((category) => category.entries.map((entry) => entry.url))
    expect(displayedURLs).not.toContain(join(locations.appSupport, 'Cache'))
    expect(displayedURLs).not.toContain(join(locations.appSupport, 'GraphiteDawnCache'))
    const codexCache = snapshot.categories.find((category) => category.kind === 'codexCache')
    expect(codexCache).toMatchObject({ group: 'review', risk: 'rebuildable' })
    expect(new Set(codexCache?.entries.map((entry) => entry.url))).toEqual(new Set(locations.codexCaches))
    expect(Object.fromEntries(codexCache?.entries.map((entry) => [entry.title, entry.note?.key]) ?? [])).toEqual({
      remote_plugin_catalog: 'note.remotePluginCatalogCache',
      codex_apps_tools: 'note.codexAppsToolsCache',
      codex_app_directory: 'note.codexAppDirectoryCache',
      codex_apps_server_info: 'note.codexAppsServerInfoCache',
      'tui-pets': 'note.tuiPetsCache'
    })
    expect(codexCache?.entries.every((entry) => entry.requiresCodexStopped)).toBe(true)
    expect(codexCache?.entries.some((entry) => entry.url === locations.codexCache)).toBe(false)
    expect(codexCache?.entries.some((entry) => entry.url === unknownCodexCache)).toBe(false)
    const appCache = snapshot.categories.find((category) => category.kind === 'appCache')
    expect(appCache).toMatchObject({ group: 'protectedData', risk: 'shielded' })
    expect(appCache?.entries.some((entry) => entry.url === locations.codexCache)).toBe(false)
    expect(snapshot.categories.find((category) => category.kind === 'protectedConfig')?.entries.some((entry) => entry.url === join(locations.home, 'attachments'))).toBe(true)
    expect(snapshot.categories.find((category) => category.kind === 'protectedConfig')?.entries.some((entry) => entry.url === locations.generatedImages)).toBe(false)
    expect(snapshot.categories.find((category) => category.kind === 'protectedConfig')?.entries.some((entry) => entry.url === join(locations.home, 'goals_1.sqlite'))).toBe(false)
    expect(snapshot.categories.find((category) => category.kind === 'protectedUserData')?.entries.some((entry) => entry.url === join(locations.appSupport, 'WasmTtsEngine'))).toBe(true)
    const pluginRuntime = snapshot.categories.find((category) => category.kind === 'pluginRuntime')
    expect(pluginRuntime?.entries.some((entry) => entry.url === locations.pluginRuntime)).toBe(false)
    expect(pluginRuntime?.entries.some((entry) => entry.url === join(locations.home, 'plugins/cache/openai-bundled/example/1'))).toBe(true)
    const runtimeBinaries = snapshot.categories.find((category) => category.kind === 'pluginRuntimeBinaries')
    expect(runtimeBinaries?.entries.some((entry) => entry.url === join(locations.pluginRuntime, 'codex'))).toBe(true)
    expect(runtimeBinaries?.entries.every((entry) => entry.risk === 'shielded')).toBe(true)
    const pluginData = snapshot.categories.find((category) => category.kind === 'pluginData')
    expect(pluginData?.entries.some((entry) => entry.url === join(locations.home, 'plugins/cache'))).toBe(false)
    expect(snapshot.categories.find((category) => category.kind === 'protectedConfig')?.entries.some((entry) => entry.url === join(locations.home, 'plugins/cache'))).toBe(false)
    const sessionDatabase = snapshot.categories.find((category) => category.kind === 'sessionDatabase')
    expect(sessionDatabase?.entries[0].bytes).toBeGreaterThanOrEqual(16_384)
  })

  it('includes application support in the external and total footprint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-scan-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    write(join(locations.home, 'auth.json'), 16_384)
    write(join(locations.appSupport, 'Default', 'Cookies'), 32_768)
    const snapshot = await scanSnapshot(locations, [])
    expect(snapshot.externalBytes).toBeGreaterThan(0)
    expect(snapshot.totalCodexBytes).toBeGreaterThan(snapshot.externalBytes)
  })

  it('does not count an unrelated directory guessed from desktop worktree settings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-scan-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const ordinary = join(root, 'ordinary-projects')
    write(join(ordinary, 'project', 'large.bin'), 2 * 1024 * 1024)
    mkdirSync(locations.home, { recursive: true })
    writeFileSync(join(locations.home, '.codex-global-state.json'),
      JSON.stringify({ settings: { worktreeRootPath: ordinary } }))

    const snapshot = await scanSnapshot(locations, [])
    expect(snapshot.worktrees).toEqual([])
    expect(snapshot.externalBytes).toBe(0)
    expect(snapshot.totalCodexBytes).toBe(directoryAllocatedSize(locations.home))
  })

  it('counts only recognised worktrees inside a mixed external root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-scan-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const mixed = join(root, 'dev')
    const worktree = linkedWorktree(root, mixed)
    write(join(mixed, 'ordinary-project', 'large.bin'), 2 * 1024 * 1024)
    mkdirSync(locations.home, { recursive: true })
    writeFileSync(join(locations.home, '.codex-global-state.json'),
      JSON.stringify({ settings: { worktreeRootPath: mixed } }))

    const snapshot = await scanSnapshot(locations, [])
    expect(snapshot.worktrees.map((item) => item.path)).toEqual([worktree])
    expect(snapshot.externalBytes).toBe(snapshot.worktrees[0].bytes)
    expect(snapshot.totalCodexBytes).toBe(directoryAllocatedSize(locations.home) + snapshot.worktrees[0].bytes)
  })

  it('reports an unused machine as empty rather than as a scan that found nothing to clean', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-scan-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })

    const missing = await scanSnapshot(locations, [])
    expect(missing.codexHomeExists).toBe(false)
    expect(snapshotFoundNothing(missing)).toBe(true)

    mkdirSync(locations.home, { recursive: true })
    const empty = await scanSnapshot(locations, [])
    expect(empty.codexHomeExists).toBe(true)
    expect(snapshotFoundNothing(empty)).toBe(true)

    write(join(locations.temporary, 'plugins', 'marketplace.json'))
    const used = await scanSnapshot(locations, [])
    expect(snapshotFoundNothing(used)).toBe(false)
  })

  it('does not double-count nested platform data roots', () => {
    expect(outermostStorageRoots(['/app/Codex', '/app/Codex/Logs', '/cache/Codex'])).toEqual(['/app/Codex', '/cache/Codex'])
  })

  it('derives every cache path from the injected caches directory, on any platform', () => {
    // A scan (or a test) must never be able to reach the real user-level cache directory
    // through an injected location.
    const locations = new CodexLocations({ home: '/tmp/x/.codex', library: '/tmp/x/Library', caches: '/tmp/x/Caches', documents: '/tmp/x/Documents' })
    expect(locations.appCaches.length).toBeGreaterThan(0)
    for (const path of [...locations.appCacheContainers, ...locations.appCaches, locations.scanCache]) {
      expect(path.startsWith(locations.caches), path).toBe(true)
    }
  })

  it('never treats a whole product cache container as a deletable cache, on any platform', () => {
    const localRoot = 'C:\\Users\\test\\AppData\\Local'
    const paths = appCacheDirectories(`${localRoot}\\Codex`, win32)
    expect(paths).not.toContain(`${localRoot}\\Codex`)
    expect(paths.every((path) => /(?:Cache)$/.test(path))).toBe(true)

    const locations = new CodexLocations({ home: '/tmp/x/.codex', library: '/tmp/x/Library', caches: '/tmp/x/Caches', documents: '/tmp/x/Documents' })
    for (const container of locations.appCacheContainers) {
      expect(locations.appCaches).not.toContain(container)
      expect(locations.writableRoots).toContain(container)
    }
  })

  it('derives only source-known leaves from the Codex cache container', () => {
    const container = 'C:\\Users\\test\\.codex\\cache'
    expect(codexCacheDirectories(container, win32)).toEqual([
      `${container}\\remote_plugin_catalog`,
      `${container}\\codex_apps_server_info`,
      `${container}\\codex_apps_tools`,
      `${container}\\codex_app_directory`,
      `${container}\\tui-pets`
    ])
    expect(codexCacheDirectories(container, win32)).not.toContain(container)
  })

  it('offers superseded Codex releases and locks the one current points at', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-scan-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const live = join(locations.standaloneReleases, '0.2.0-aarch64-apple-darwin')
    const old = join(locations.standaloneReleases, '0.1.0-aarch64-apple-darwin')
    write(join(live, 'bin', 'codex'))
    write(join(old, 'bin', 'codex'))
    symlinkSync(live, locations.standaloneCurrent)

    const snapshot = await scanSnapshot(locations, [])
    const superseded = snapshot.categories.find((category) => category.kind === 'releaseVersions')
    const current = snapshot.categories.find((category) => category.kind === 'releaseRuntime')
    expect(superseded?.entries.map((entry) => entry.url)).toEqual([old])
    expect(superseded?.group).toBe('recommended')
    expect(current?.entries.map((entry) => entry.url)).toEqual([live])
    expect(current?.risk).toBe('shielded')
  })

  it('reports no releases at all on an installation that has no packages directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-scan-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    write(join(locations.home, 'config.toml'))

    const snapshot = await scanSnapshot(locations, [])
    expect(snapshot.categories.some((category) => category.kind === 'releaseVersions')).toBe(false)
    expect(snapshot.categories.some((category) => category.kind === 'releaseRuntime')).toBe(false)
  })

  it('offers the desktop state files left behind, keeping the newest and the live ones', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-scan-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const leftover = (name: string, days: number): string => {
      const path = join(locations.home, name)
      write(path); age(path, days)
      return path
    }
    const oldest = leftover('..codex-global-state.json.tmp-1784512834570-9a9a323b-5b53-4838-a6bf-d1f253d9149e', 30)
    const middle = leftover('..codex-global-state.json.tmp-1785117131549-afc2646d-148d-47e8-9aea-aa1fb4040bea', 20)
    const newest = leftover('..codex-global-state.json.tmp-1786003736128-cb973325-3953-4d1f-b4d8-a3d98d39174c', 10)
    const backup = leftover('skills.bak.20260524214331', 30)
    // The files Codex actually reads share the prefix and must never be touched.
    write(join(locations.home, '.codex-global-state.json'))
    write(join(locations.home, '.codex-global-state.json.bak'))

    const snapshot = await scanSnapshot(locations, [])
    const temporary = snapshot.categories.find((category) => category.kind === 'temporary')
    const offered = temporary?.entries.map((entry) => entry.url) ?? []
    expect(offered).toContain(oldest)
    expect(offered).toContain(middle)
    expect(offered).toContain(backup)
    // One of each shape is held back in case something is in the middle of writing it.
    expect(offered).not.toContain(newest)
    expect(offered).not.toContain(join(locations.home, '.codex-global-state.json'))
    expect(offered).not.toContain(join(locations.home, '.codex-global-state.json.bak'))
  })

  it('names the entries it does not recognise instead of letting them vanish into the total', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-scan-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    write(join(locations.home, 'config.toml'))
    write(join(locations.home, 'something-a-future-release-added', 'data.bin'))
    write(join(locations.appSupport, 'component_crx_cache', 'blob'))

    const snapshot = await scanSnapshot(locations, [])
    const unrecognized = snapshot.categories.find((category) => category.kind === 'unrecognized')
    expect(unrecognized?.entries.map((entry) => entry.title).sort())
      .toEqual(['component_crx_cache', 'something-a-future-release-added'])
    // Shown so the numbers add up, never as something to remove.
    expect(unrecognized?.risk).toBe('shielded')
    expect(unrecognized?.group).toBe('protectedData')
  })

  it('measures Codex worktrees without letting them into a cleanup category', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-scan-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const checkout = join(locations.defaultWorktrees, '44af', 'project')
    const admin = join(root, 'repos', 'project', '.git', 'worktrees', 'project')
    write(join(checkout, 'source.ts'))
    mkdirSync(admin, { recursive: true })
    writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(admin, 'commondir'), '../..\n')
    writeFileSync(join(admin, 'codex-thread.json'), '{"version":1,"ownerThreadId":"t"}')
    writeFileSync(join(checkout, '.git'), `gitdir: ${admin}\n`)

    // A conversation that ran in there, so the tag and the byte split can be checked.
    const id = '33333333-3333-3333-3333-333333333333'
    const rollout = join(locations.sessions, '2026', '08', `rollout-${id}.jsonl`)
    mkdirSync(join(rollout, '..'), { recursive: true })
    writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: checkout, title: 'In a worktree' } })}\n`)

    const snapshot = await scanSnapshot(locations, [])
    expect(snapshot.worktrees.map((worktree) => worktree.project)).toEqual(['project'])
    expect(snapshot.worktrees[0].status).toBe('managed')
    // Worktrees are their own list, so no storage category can pull one into a
    // scheduled run or an overview checkbox.
    const everyEntryURL = snapshot.categories.flatMap((category) => category.entries.map((entry) => entry.url))
    expect(everyEntryURL.some((url) => url.includes('worktrees'))).toBe(false)

    // The conversation stays in the session list, keeps its own rollout bytes, and only
    // gains a tag saying where it ran. The checkout's bytes belong to the worktree alone.
    const session = snapshot.sessions.find((item) => item.threadID === id)
    expect(session?.tags).toContain('worktree')
    expect(session?.fileBytes).toBeGreaterThan(0)
    expect(session?.fileBytes).toBeLessThan(snapshot.worktrees[0].bytes)
  })

  it('groups plan revisions under a thread and names them by the newest H1', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-scan-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const thread = '22222222-2222-7222-8222-222222222222'
    const rollout = join(locations.sessions, '2026', '08', `rollout-${thread}.jsonl`)
    write(rollout)
    writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id: thread, title: 'Plan session' } })}\n`)

    // Two revisions of one plan: the lexicographically greater planID is the newest.
    // A .DS_Store sits beside them and must not be counted as a file.
    const planDir = (planID: string): string => join(locations.plans, thread, planID)
    mkdirSync(planDir('01990000-0000-7000-8000-00000000000a'), { recursive: true })
    writeFileSync(join(planDir('01990000-0000-7000-8000-00000000000a'), 'PLAN.md'), '# 旧标题\n\n## Summary\nold\n')
    mkdirSync(planDir('01990000-0000-7000-8000-00000000000b'), { recursive: true })
    writeFileSync(join(planDir('01990000-0000-7000-8000-00000000000b'), 'PLAN.md'), '# Session 素材二维码分享\n\n## Summary\nnew\n')
    writeFileSync(join(locations.plans, thread, '.DS_Store'), Buffer.alloc(8))

    const snapshot = await scanSnapshot(locations, [])
    const plans = snapshot.generatedAssets.filter((asset) => asset.kind === 'plan')
    expect(plans).toHaveLength(1)
    const plan = plans[0]
    expect(plan.path).toBe(join(locations.plans, thread))
    expect(plan.sourceThreadID).toBe(thread)
    expect(plan.sourceSessionID).toBe(rollout)
    expect(plan.fileCount).toBe(2)
    expect(plan.formats).toEqual(['md'])
    expect(plan.title).toBe('Session 素材二维码分享')

    const session = snapshot.sessions.find((item) => item.threadID === thread)
    expect(session?.tags).toContain('plan')
    expect(session?.assetURLs).toContain(join(locations.plans, thread))
    expect(session?.assetBytes).toBeGreaterThan(0)
    // `plans` is a claimed home entry, so it never shows up as unrecognized.
    const unrecognized = snapshot.categories.find((category) => category.kind === 'unrecognized')?.entries.map((entry) => entry.url) ?? []
    expect(unrecognized).not.toContain(locations.plans)
  })

  it('names an orphaned plan by its H1 even when the source conversation is gone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-scan-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const orphan = '33333333-3333-7333-8333-333333333333'
    mkdirSync(join(locations.plans, orphan, '01990000-0000-7000-8000-00000000000a'), { recursive: true })
    writeFileSync(join(locations.plans, orphan, '01990000-0000-7000-8000-00000000000a', 'PLAN.md'), '# Orphan plan title\n\n## Summary\nx\n')

    const snapshot = await scanSnapshot(locations, [])
    const plan = snapshot.generatedAssets.find((asset) => asset.kind === 'plan')
    expect(plan?.sourceThreadID).toBe(orphan)
    expect(plan?.sourceSessionID).toBeNull()
    expect(plan?.title).toBe('Orphan plan title')
  })

  it('leaves a non-UUID plans subdirectory unclaimed rather than showing it as a plan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-scan-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    // A non-UUID subdirectory: not a thread shape the scanner can validate, so it is not
    // claimed as a plan asset. Because `plans` is a claimed home entry, the subdir is not
    // surfaced as unrecognized either — it simply stays out of the asset list.
    mkdirSync(join(locations.plans, 'not-a-thread-id', '01990000-0000-7000-8000-00000000000a'), { recursive: true })
    writeFileSync(join(locations.plans, 'not-a-thread-id', '01990000-0000-7000-8000-00000000000a', 'PLAN.md'), '# Not a plan\n')
    // A UUID-named plan alongside, to confirm the scanner still works.
    const thread = '44444444-4444-7444-8444-444444444444'
    const rollout = join(locations.sessions, '2026', '08', `rollout-${thread}.jsonl`)
    write(rollout)
    writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id: thread, title: 'Real' } })}\n`)
    mkdirSync(join(locations.plans, thread, '01990000-0000-7000-8000-00000000000a'), { recursive: true })
    writeFileSync(join(locations.plans, thread, '01990000-0000-7000-8000-00000000000a', 'PLAN.md'), '# Real plan\n')

    const snapshot = await scanSnapshot(locations, [])
    const planPaths = snapshot.generatedAssets.filter((asset) => asset.kind === 'plan').map((asset) => asset.path)
    expect(planPaths).toEqual([join(locations.plans, thread)])
    const unrecognized = snapshot.categories.find((category) => category.kind === 'unrecognized')?.entries.map((entry) => entry.url) ?? []
    expect(unrecognized).not.toContain(join(locations.plans, 'not-a-thread-id'))
  })
})
