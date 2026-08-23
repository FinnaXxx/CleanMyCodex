import { describe, expect, it } from 'vitest'
import { parsePlugins } from '../electron/main/app-server'

describe('plugin/list parser', () => {
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
