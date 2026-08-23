import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import type { ScanProgress } from '../shared/types'
import { CodexLocations, appCacheDirectories } from '../electron/main/locations'
import { outermostStorageRoots, scanSnapshot } from '../electron/main/scanner'

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

describe('storage scanner semantics', () => {
  it('reclaims every staging root Codex abandons, and nothing live beside them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-scan-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const stale = (path: string): string => {
      write(join(path, 'payload')); age(join(path, 'payload'), 3); age(path, 3)
      return path
    }
    // Codex' own scratch roots, taken from the sources: the arg0 shim directories it
    // sweeps on launch, the curated-plugin backup its sweep misses, and the staging
    // parents it renames finished trees out of.
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
    write(join(locations.computerUse, 'helper.bin'))
    write(join(locations.pluginRuntime, 'codex'))
    write(join(locations.home, 'thread_history_1.sqlite'))
    write(join(locations.home, 'thread_history_1.sqlite-wal'))
    write(join(locations.appSupport, 'Default', 'Cookies'))
    write(join(locations.appSupport, 'Default', 'Cache', 'cache.bin'))
    write(join(locations.appSupport, 'Cache', 'cache.bin'))
    write(join(locations.appSupport, 'GraphiteDawnCache', 'cache.bin'))
    write(join(locations.appSupport, 'WasmTtsEngine', 'engine.bin'))
    write(join(locations.codexCache, 'cache.bin'))
    write(join(locations.appCaches[0], 'cache.bin'))
    write(join(locations.home, 'attachments', 'attachment.bin'))
    write(join(locations.home, 'goals_1.sqlite'))

    const progress: ScanProgress[] = []
    const snapshot = await scanSnapshot(locations, [], (item) => progress.push(item))
    expect(progress.at(-1)).toMatchObject({ stage: { key: 'stage.done' }, fraction: 1 })
    expect(progress.some((item) => item.stage?.key === 'stage.sessions')).toBe(true)
    // The desktop application rotates its own logs: they are counted as one protected
    // entry for the log root, and no log is ever offered for deletion however old it is.
    const logs = snapshot.categories.find((category) => category.kind === 'appLogs')
    expect(logs).toMatchObject({ group: 'protectedData', risk: 'shielded' })
    expect(logs?.entries.map((entry) => entry.url)).toEqual([locations.appLogs])
    expect(logs?.entries[0].bytes).toBeGreaterThan(0)
    expect(snapshot.categories.flatMap((category) => category.entries).some((entry) => entry.url === oldLog)).toBe(false)

    const temporary = snapshot.categories.find((category) => category.kind === 'temporary')
    expect(temporary?.entries.map((entry) => entry.url)).not.toContain(stale)
    expect(temporary?.entries.map((entry) => entry.url)).toContain(directStaging)
    expect(temporary?.entries.map((entry) => entry.url)).toContain(bundledStaging)
    expect(temporary?.entries.map((entry) => entry.url)).not.toContain(bundledLive)
    expect(snapshot.categories.flatMap((category) => category.entries).some((entry) => entry.url === liveMarket && entry.risk !== 'shielded')).toBe(false)
    expect(snapshot.categories.find((category) => category.kind === 'protectedConfig')?.entries.some((entry) => entry.url === liveMarket)).toBe(true)
    expect(snapshot.categories.find((category) => category.kind === 'protectedConfig')?.entries.some((entry) => entry.url === externalMarket)).toBe(true)

    expect(snapshot.sessions.find((session) => session.threadID === thread)?.assetURLs)
      .toContain(join(locations.generatedImages, thread))
    const computerUse = snapshot.categories.find((category) => category.kind === 'computerUse')
    expect(computerUse).toMatchObject({ group: 'protectedData', risk: 'shielded' })
    expect(computerUse?.entries[0].requiresCodexStopped).toBe(true)
    const displayedURLs = snapshot.categories.flatMap((category) => category.entries.map((entry) => entry.url))
    expect(displayedURLs).not.toContain(join(locations.appSupport, 'Cache'))
    expect(displayedURLs).not.toContain(join(locations.appSupport, 'GraphiteDawnCache'))
    const codexCache = snapshot.categories.find((category) => category.kind === 'codexCache')
    expect(codexCache).toMatchObject({ group: 'protectedData', risk: 'shielded' })
    expect(codexCache?.entries.some((entry) => entry.url === locations.codexCache)).toBe(true)
    const appCache = snapshot.categories.find((category) => category.kind === 'appCache')
    expect(appCache).toMatchObject({ group: 'protectedData', risk: 'shielded' })
    expect(appCache?.entries.some((entry) => entry.url === locations.codexCache)).toBe(false)
    expect(snapshot.categories.find((category) => category.kind === 'protectedConfig')?.entries.some((entry) => entry.url === join(locations.home, 'attachments'))).toBe(true)
    expect(snapshot.categories.find((category) => category.kind === 'protectedConfig')?.entries.some((entry) => entry.url === join(locations.home, 'goals_1.sqlite'))).toBe(true)
    expect(snapshot.categories.find((category) => category.kind === 'protectedUserData')?.entries.some((entry) => entry.url === join(locations.appSupport, 'WasmTtsEngine'))).toBe(true)
    const pluginRuntime = snapshot.categories.find((category) => category.kind === 'pluginRuntime')
    expect(pluginRuntime?.entries.some((entry) => entry.url === locations.pluginRuntime)).toBe(true)
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
})
