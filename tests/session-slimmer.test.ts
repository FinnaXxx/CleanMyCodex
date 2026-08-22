import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_IMAGE_PLACEHOLDER, slimSession } from '../electron/main/session-slimmer'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(): { root: string; path: string; image: string } {
  const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-session-')); roots.push(root)
  const path = join(root, 'rollout-test.jsonl')
  const image = `data:image/png;base64,${Buffer.alloc(32_000, 7).toString('base64')}`
  writeFileSync(path, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'test' } }),
    JSON.stringify({ payload: { image } }),
    JSON.stringify({ payload: { image } })
  ].join('\n') + '\n')
  return { root, path, image }
}

const trashToBackup = async (path: string): Promise<void> => renameSync(path, `${path}.trashed`)

describe('session slimmer', () => {
  it('keeps the first image and replaces only duplicate occurrences', async () => {
    const { path, image } = fixture()
    const report = await slimSession(path, 'deduplicate', trashToBackup)
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(report.replacedCount).toBe(1)
    expect(report.keptCount).toBe(1)
    expect(lines[1].payload.image).toBe(image)
    expect(lines[2].payload.image).toBe(SESSION_IMAGE_PLACEHOLDER)
    expect(readFileSync(`${path}.trashed`, 'utf8')).toContain(image)
  })

  it('strips every image while preserving JSONL structure', async () => {
    const { path } = fixture()
    const report = await slimSession(path, 'stripAll', trashToBackup)
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(report.replacedCount).toBe(2)
    expect(lines).toHaveLength(3)
    expect(lines[1].payload.image).toBe(SESSION_IMAGE_PLACEHOLDER)
    expect(lines[2].payload.image).toBe(SESSION_IMAGE_PLACEHOLDER)
  })

  it('rejects compressed rollouts', async () => {
    const { root } = fixture()
    await expect(slimSession(join(root, 'rollout.jsonl.zst'), 'stripAll', trashToBackup)).rejects.toThrow('压缩会话')
  })
})
