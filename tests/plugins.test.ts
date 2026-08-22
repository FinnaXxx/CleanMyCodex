import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanPluginVersions, pluginStorageCategory } from '../electron/main/plugins'

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
  it('protects the installed version and exposes only stale/orphaned directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-plugins-')); roots.push(root)
    const current = plugin(root, 'personal', 'browser', '2.0.0')
    plugin(root, 'personal', 'browser', '1.0.0')
    plugin(root, 'personal', 'unused', '3.0.0')
    const items = scanPluginVersions(root, [{ name: 'browser', version: 'v2.0.0', directory: current }])
    expect(items.map((item) => [item.plugin, item.version, item.status])).toEqual([
      ['browser', '1.0.0', 'outdated'], ['browser', '2.0.0', 'current'], ['unused', '3.0.0', 'orphaned']
    ])
    expect(pluginStorageCategory(items).entries).toHaveLength(2)
  })

  it('locks every version when plugin/list is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-plugins-')); roots.push(root)
    plugin(root, 'personal', 'browser', '1.0.0')
    expect(scanPluginVersions(root, null)[0].status).toBe('unconfirmed')
    expect(pluginStorageCategory(scanPluginVersions(root, null)).entries).toEqual([])
  })
})
