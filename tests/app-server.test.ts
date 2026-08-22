import { describe, expect, it } from 'vitest'
import { parsePlugins } from '../electron/main/app-server'

describe('plugin/list parser', () => {
  it('accepts marketplace rows and source paths', () => {
    expect(parsePlugins({ marketplaces: [{ name: 'personal', plugins: [{ name: 'demo', localVersion: '1.2.3', source: { path: '/plugins/demo' } }] }] })).toEqual([
      { name: 'demo', version: '1.2.3', directory: '/plugins/demo' }
    ])
  })
})
