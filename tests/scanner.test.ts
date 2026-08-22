import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexLocations, windowsAppCacheDirectories } from '../electron/main/locations'
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
  it('keeps recent logs, protects live marketplaces, and associates assets with their thread', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-scan-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    const thread = '11111111-1111-1111-1111-111111111111'
    const rollout = join(locations.sessions, '2026', '08', `rollout-${thread}.jsonl`)
    write(rollout)
    writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id: thread, title: '活跃会话' } })}\n`)

    const oldLog = join(locations.appLogs, 'old.log')
    const recentLog = join(locations.appLogs, 'recent.log')
    write(oldLog); write(recentLog); age(oldLog, 12); age(recentLog, 2)
    const stale = join(locations.temporary, 'abandoned')
    write(join(stale, 'payload')); age(join(stale, 'payload'), 5); age(stale, 5)
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

    const progress: Array<{ stage: string; fraction: number }> = []
    const snapshot = await scanSnapshot(locations, [], (item) => progress.push(item))
    expect(progress.at(-1)).toMatchObject({ stage: '完成', fraction: 1 })
    expect(progress.some((item) => item.stage === '会话')).toBe(true)
    const logs = snapshot.categories.find((category) => category.kind === 'appLogs')
    expect(logs?.entries.map((entry) => entry.url)).toEqual([oldLog])
    expect(logs?.entries[0].url).not.toBe(locations.appLogs)

    const temporary = snapshot.categories.find((category) => category.kind === 'temporary')
    expect(temporary?.entries.map((entry) => entry.url)).toContain(stale)
    expect(snapshot.categories.flatMap((category) => category.entries).some((entry) => entry.url === liveMarket && entry.risk !== 'shielded')).toBe(false)
    expect(snapshot.categories.find((category) => category.kind === 'protectedConfig')?.entries.some((entry) => entry.url === liveMarket)).toBe(true)
    expect(snapshot.categories.find((category) => category.kind === 'protectedConfig')?.entries.some((entry) => entry.url === externalMarket)).toBe(true)

    expect(snapshot.sessions.find((session) => session.threadID === thread)?.assetURLs)
      .toContain(join(locations.generatedImages, thread))
    const computerUse = snapshot.categories.find((category) => category.kind === 'computerUse')
    expect(computerUse).toMatchObject({ group: 'review', risk: 'caution' })
    const pluginRuntime = snapshot.categories.find((category) => category.kind === 'pluginRuntime')
    expect(pluginRuntime?.entries.some((entry) => entry.url === locations.pluginRuntime)).toBe(true)
    const sessionDatabase = snapshot.categories.find((category) => category.kind === 'sessionDatabase')
    expect(sessionDatabase?.entries[0].bytes).toBeGreaterThanOrEqual(16_384)
  })

  it('includes application support in the external and total footprint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-scan-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    write(join(locations.home, 'auth.json'), 16_384)
    write(join(locations.appSupport, 'Default', 'Cookies'), 32_768)
    const snapshot = await scanSnapshot(locations, [])
    expect(snapshot.externalBytes).toBeGreaterThan(0)
    expect(snapshot.totalCodexBytes).toBeGreaterThan(snapshot.externalBytes)
  })

  it('does not double-count nested platform data roots', () => {
    expect(outermostStorageRoots(['/app/Codex', '/app/Codex/Logs', '/cache/Codex'])).toEqual(['/app/Codex', '/cache/Codex'])
  })

  it('never treats a whole Windows LocalAppData product directory as a cache root', () => {
    const localRoot = 'C:\\Users\\test\\AppData\\Local'
    const paths = windowsAppCacheDirectories(localRoot)
    expect(paths).not.toContain(`${localRoot}\\Codex`)
    expect(paths).not.toContain(`${localRoot}\\com.openai.codex`)
    expect(paths.every((path) => /(?:Cache|GPUCache|ShaderCache)$/.test(path))).toBe(true)
  })
})
