import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCodexConfiguration, marketplaceSources } from '../electron/main/configuration'
import { ProtectedPaths } from '../electron/main/guard'
import { CodexLocations } from '../electron/main/locations'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('Codex marketplace configuration', () => {
  it('reads table and inline local sources without accepting similarly named keys', () => {
    const sources = marketplaceSources(`
[marketplaces.local]
source_type = "local"
source = ".tmp/live-market" # active source
source_type = "ignored"

marketplaces.inline = { source_type = "local", source = "../shared/plugins" }
marketplaces.bad = { my_source = "bad", sources = "also-bad" }
`)
    expect(sources).toEqual(['.tmp/live-market', '../shared/plugins'])
  })

  it('resolves relative paths and protects their parents from cleanup', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-config-')); roots.push(root)
    const home = join(root, '.codex')
    const source = join(home, '.tmp', 'live-market')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(home, 'config.toml'), '[marketplaces.local]\nsource = ".tmp/live-market"\n')
    const config = loadCodexConfiguration(home)
    expect(config.localMarketplaceSources).toEqual([source])
    const locations = new CodexLocations({ home, library: join(root, 'Library'), documents: join(root, 'Documents') })
    const guard = new ProtectedPaths(locations)
    expect(guard.isProtected(source)).toBe(true)
    expect(guard.isProtected(join(home, '.tmp'))).toBe(true)
    expect(() => guard.validate(source)).toThrow('受保护的路径')
  })
})
