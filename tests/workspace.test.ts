import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanWorkspace } from '../electron/main/workspace'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('workspace scanner', () => {
  it('groups session output below date folders and counts loose files', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-workspace-')); roots.push(root)
    const date = join(root, '2026-08-22')
    const session = join(date, 'session-a')
    mkdirSync(session, { recursive: true })
    writeFileSync(join(date, 'summary.txt'), 'summary')
    writeFileSync(join(session, 'result.txt'), 'result')
    const snapshot = scanWorkspace(root)
    expect(snapshot.isScanned).toBe(true)
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0].fileCount).toBe(1)
    expect(snapshot.entries[0].children[0].fileCount).toBe(1)
    expect(snapshot.entries[0].bytes).toBeGreaterThan(0)
  })
})
