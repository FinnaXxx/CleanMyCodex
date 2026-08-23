import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanPluginVersions, pluginStorageCategories } from '../electron/main/plugins'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function plugin(root: string, market: string, name: string, version: string): string {
  const path = join(root, 'cache', market, name, version)
  mkdirSync(join(path, '.codex-plugin'), { recursive: true })
  writeFileSync(join(path, '.codex-plugin', 'plugin.json'), JSON.stringify({ name, version }))
  writeFileSync(join(path, 'payload.bin'), Buffer.alloc(8192))
  return path
}

describe('plugin scanner', () => {
  it('never treats a `local` version as superseded, whatever the catalog reports', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-plugins-')); roots.push(root)
    // Codex resolves the active version from the directory listing, and `local` wins over
    // every semver sibling — so a catalog naming 2.0.0 does not make `local` a remnant.
    plugin(root, 'personal', 'browser', 'local')
    const current = plugin(root, 'personal', 'browser', '2.0.0')
    const items = scanPluginVersions(root, [
      { marketplace: 'personal', name: 'browser', version: '2.0.0', directory: current, installed: true }
    ])
    expect(items.map((item) => [item.version, item.status])).toEqual([
      ['2.0.0', 'current'], ['local', 'current']
    ])
    const categories = pluginStorageCategories(items)
    expect(categories.flatMap((category) => category.entries)).toHaveLength(0)
  })

  it('protects the installed version and exposes only stale/orphaned directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-plugins-')); roots.push(root)
    const current = plugin(root, 'personal', 'browser', '2.0.0')
    plugin(root, 'personal', 'browser', '1.0.0')
    plugin(root, 'personal', 'unused', '3.0.0')
    const items = scanPluginVersions(root, [{ marketplace: 'personal', name: 'browser', version: 'v2.0.0', directory: current, installed: true }])
    expect(items.map((item) => [item.plugin, item.version, item.status])).toEqual([
      ['browser', '1.0.0', 'outdated'], ['browser', '2.0.0', 'current'], ['unused', '3.0.0', 'orphaned']
    ])
    const categories = pluginStorageCategories(items)
    expect(categories.find((category) => category.kind === 'pluginRemnants')).toMatchObject({ group: 'recommended', risk: 'safe' })
    expect(categories.find((category) => category.kind === 'pluginRemnants')?.entries).toHaveLength(1)
    expect(categories.find((category) => category.kind === 'pluginRemnants')?.entries[0].requiresCodexStopped).toBe(true)
    expect(categories.find((category) => category.kind === 'pluginOrphans')).toMatchObject({ group: 'review', risk: 'caution' })
    expect(categories.find((category) => category.kind === 'pluginOrphans')?.entries).toHaveLength(1)
    expect(categories.find((category) => category.kind === 'pluginOrphans')?.entries[0].risk).toBe('caution')
    expect(categories.find((category) => category.kind === 'pluginOrphans')?.entries[0].requiresCodexStopped).toBe(true)
  })

  it('locks every version when plugin/list is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-plugins-')); roots.push(root)
    plugin(root, 'personal', 'browser', '1.0.0')
    expect(scanPluginVersions(root, null)[0].status).toBe('unconfirmed')
    expect(pluginStorageCategories(scanPluginVersions(root, null)).flatMap((category) => category.entries)).toEqual([])
  })

  it('marks official runtime plugins as built-in and locks them', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-plugins-')); roots.push(root)
    plugin(root, 'openai-primary-runtime', 'pdf', '26.819.11345')
    const inventory = [{ marketplace: 'personal', name: 'browser', version: '2.0.0', directory: null, installed: true }]
    expect(scanPluginVersions(root, inventory)[0].status).toBe('builtin')
    expect(pluginStorageCategories(scanPluginVersions(root, inventory)).flatMap((category) => category.entries)).toEqual([])
  })

  it('marks bundled OpenAI plugins as built-in and locks them', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-plugins-')); roots.push(root)
    plugin(root, 'openai-bundled', 'codex-app-tools', '0.1.0')
    const inventory = [{ marketplace: 'personal', name: 'browser', version: '2.0.0', directory: null, installed: true }]
    const items = scanPluginVersions(root, inventory)
    expect(items[0].status).toBe('builtin')
    expect(pluginStorageCategories(items).flatMap((category) => category.entries)).toEqual([])
  })

  it('marks a plugin leftover only with negative evidence from its marketplace', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-plugins-')); roots.push(root)
    plugin(root, 'personal', 'unused', '3.0.0')
    const inventory = [{ marketplace: 'personal', name: 'browser', version: '2.0.0', directory: null, installed: true }]
    expect(scanPluginVersions(root, inventory)[0].status).toBe('orphaned')
  })

  it('honors an explicit uninstalled catalog row', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-plugins-')); roots.push(root)
    plugin(root, 'personal', 'unused', '3.0.0')
    const inventory = [{ marketplace: 'personal', name: 'unused', version: '3.0.0', directory: null, installed: false }]
    expect(scanPluginVersions(root, inventory)[0].status).toBe('orphaned')
  })

  it('never deletes based on an ambiguous legacy row without a marketplace', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-plugins-')); roots.push(root)
    plugin(root, 'personal', 'browser', '2.0.0')
    const inventory = [{ marketplace: null, name: 'browser', version: '1.0.0', directory: null, installed: null }]
    expect(scanPluginVersions(root, inventory)[0].status).toBe('unconfirmed')
  })
})
