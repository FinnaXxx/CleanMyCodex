import { beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = join(import.meta.dirname, '..')
const output = join(root, 'out', 'test', 'thread-index-runner.cjs')

beforeAll(async () => {
  mkdirSync(join(root, 'out', 'test'), { recursive: true })
  await build({
    entryPoints: [join(import.meta.dirname, 'support', 'thread-index-runner.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'better-sqlite3']
  })
})

describe('Codex state database thread index in Electron', () => {
  it('prefers the state database title over rollout metadata', () => {
    const require = createRequire(import.meta.url)
    const electron = require('electron') as string
    const result = spawnSync(electron, [output, `--user-data-dir=${join(root, 'out', 'test', 'thread-profile')}`], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000
    })
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('THREAD_INDEX_OK')
  })
})
