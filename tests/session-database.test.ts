import { beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = join(import.meta.dirname, '..')
const output = join(root, 'out', 'test', 'sqlite-runner.cjs')

beforeAll(async () => {
  mkdirSync(join(root, 'out', 'test'), { recursive: true })
  await build({
    entryPoints: [join(import.meta.dirname, 'support', 'sqlite-runner.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'better-sqlite3']
  })
})

describe('session database cleanup in Electron', () => {
  it('deletes roots, descendants, and continuation segments without touching other sessions', () => {
    const require = createRequire(import.meta.url)
    const electron = require('electron') as string
    const result = spawnSync(electron, [output, `--user-data-dir=${join(root, 'out', 'test', 'electron-profile')}`], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000
    })
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('SQLITE_INTEGRATION_OK')
  })
})
