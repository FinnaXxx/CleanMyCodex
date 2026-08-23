import { describe, expect, it } from 'vitest'
import { parsePlugins } from '../electron/main/app-server'

describe('plugin/list parser', () => {
  it('reads the installed version and install path the way plugin/list means them', () => {
    // plugin/list's own shape: `version` is what the backend advertises, `localVersion`
    // is what is materialized on disk, and `source` is a tagged union.
    const parsed = parsePlugins({
      marketplaces: [{
        name: 'openai-curated-remote',
        plugins: [
          { id: 'linear@openai-curated-remote', name: 'linear', version: '2.0.0', localVersion: null, installed: true, source: { type: 'remote' } },
          { id: 'notion@openai-curated-remote', name: 'notion', version: '3.0.0', localVersion: '1.4.0', installed: true, source: { type: 'local', path: '/abs/notion/1.4.0' } },
          { id: 'repo@openai-curated-remote', name: 'repo', localVersion: '1.0.0', installed: true, source: { type: 'git', url: 'https://example.invalid/x.git', path: 'plugins/repo' } }
        ]
      }]
    })
    const byName = new Map(parsed.map((plugin) => [plugin.name, plugin]))
    // A remote-advertised version is never mistaken for the one on disk.
    expect(byName.get('linear')).toMatchObject({ version: null, directory: null })
    expect(byName.get('notion')).toMatchObject({ version: '1.4.0', directory: '/abs/notion/1.4.0' })
    // A git source's `path` points inside the repository, not at an install directory.
    expect(byName.get('repo')).toMatchObject({ version: '1.0.0', directory: null })
  })

  it('accepts marketplace rows and source paths', () => {
    expect(parsePlugins({ marketplaces: [{ name: 'personal', plugins: [{ name: 'demo', localVersion: '1.2.3', source: { path: '/plugins/demo' } }] }] })).toEqual([
      { marketplace: 'personal', name: 'demo', version: '1.2.3', directory: '/plugins/demo', installed: null }
    ])
  })

  it('preserves explicit installation state and marketplace identity', () => {
    expect(parsePlugins({ marketplaces: [{ name: 'catalog', plugins: [{ name: 'demo', version: '2.0.0', installed: false }] }] })).toEqual([
      { marketplace: 'catalog', name: 'demo', version: '2.0.0', directory: null, installed: false }
    ])
  })
})
