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
    // A child killed by a signal reports neither an exit code nor a message, so put
    // everything it managed to write into the assertion itself — otherwise a crash reads
    // only as "expected 'SIGABRT' to be null" and the reason dies with the process.
    const transcript = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    expect(result.signal, transcript).toBeNull()
    expect(result.status, transcript).toBe(0)
    expect(result.stdout, transcript).toContain('THREAD_INDEX_OK')
  })
})
