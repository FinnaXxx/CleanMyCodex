import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSystemJunk, scanWorkspace } from '../electron/main/workspace'
import { workspaceBytes, workspaceDeletionTargets } from '../shared/types'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('workspace scanner', () => {
  it('never charges a workspace for what a symlink points at', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-workspace-')); roots.push(root)
    const outside = join(root, 'outside.bin')
    writeFileSync(outside, Buffer.alloc(1024 * 1024))
    const session = join(root, '2026-08-22', 'session-a')
    mkdirSync(session, { recursive: true })
    writeFileSync(join(session, 'result.txt'), 'result')
    const plain = scanWorkspace(root).entries[0].children[0].bytes
    // A link to a megabyte outside the tree, and one back into it, add nothing either way.
    symlinkSync(outside, join(session, 'link-out'))
    symlinkSync(join(session, 'result.txt'), join(session, 'link-in'))
    const linked = scanWorkspace(root).entries[0].children[0]
    expect(linked.bytes).toBe(plain)
    expect(linked.fileCount).toBe(3)
  })

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
    const [entry] = snapshot.entries
    expect(entry.fileCount).toBe(1)
    expect(entry.children[0].fileCount).toBe(1)
    // The date folder measures and deletes its loose file alone; the output beside it
    // is a row of its own and carries its own bytes.
    expect(entry.looseFiles).toEqual([join(date, 'summary.txt')])
    expect(entry.bytes).toBeGreaterThan(0)
    expect(entry.children[0].bytes).toBeGreaterThan(0)
    expect(workspaceDeletionTargets(entry)).toEqual([join(date, 'summary.txt')])
    expect(workspaceDeletionTargets(entry.children[0])).toEqual([session])
    expect(workspaceBytes(snapshot)).toBe(entry.bytes + entry.children[0].bytes)
  })

  it('ignores files the desktop environment writes, so they never raise a date row', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-workspace-')); roots.push(root)
    const date = join(root, '2026-08-21')
    const session = join(date, 'codex')
    mkdirSync(session, { recursive: true })
    for (const junk of ['.DS_Store', '._summary.txt', 'Thumbs.db', '.localized']) writeFileSync(join(date, junk), 'junk')
    writeFileSync(join(session, 'result.txt'), 'result')
    const [entry] = scanWorkspace(root).entries
    expect(entry.fileCount).toBe(0)
    expect(entry.looseFiles).toEqual([])
    expect(entry.children.map((child) => child.name)).toEqual(['codex'])
  })

  it('drops a date folder whose only content is desktop junk', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-workspace-')); roots.push(root)
    const date = join(root, '2026-08-20')
    mkdirSync(date, { recursive: true })
    writeFileSync(join(date, '.DS_Store'), 'junk')
    expect(scanWorkspace(root).entries).toEqual([])
  })

  it('keeps a real file whose name only resembles the junk names', () => {
    expect(isSystemJunk('.DS_Store')).toBe(true)
    expect(isSystemJunk('thumbs.db')).toBe(true)
    expect(isSystemJunk('._result.txt')).toBe(true)
    expect(isSystemJunk('DS_Store.md')).toBe(false)
    expect(isSystemJunk('desktop.ini.bak')).toBe(false)
    expect(isSystemJunk('.directory-tree.json')).toBe(false)
  })

  it('progressively adds SQLite thread titles without changing unmatched folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-workspace-')); roots.push(root)
    const linked = join(root, '2026-08-21', 'new-chat')
    const unmatched = join(root, '2026-08-21', 'unknown-output')
    mkdirSync(linked, { recursive: true })
    mkdirSync(unmatched, { recursive: true })
    writeFileSync(join(linked, 'result.txt'), 'result')
    writeFileSync(join(unmatched, 'result.txt'), 'result')

    const snapshot = scanWorkspace(root, undefined, [
      { id: 'main', cwd: linked, title: '分析 Codex 磁盘占用文件', archived: false, isSubagent: false, modifiedAt: 20 },
      { id: 'child', cwd: join(linked, 'work'), title: '子任务', archived: false, isSubagent: true, modifiedAt: 10 },
      { id: 'outside', cwd: join(root, '..', 'elsewhere'), title: '不应关联', archived: false, isSubagent: false, modifiedAt: 30 }
    ])

    const date = snapshot.entries[0]
    const linkedFolder = date.children.find((item) => item.name === 'new-chat')
    const unmatchedFolder = date.children.find((item) => item.name === 'unknown-output')
    expect(linkedFolder?.sourceThreads.map((thread) => thread.id)).toEqual(['main', 'child'])
    // The date folder is listed next to its own children, so it must not borrow their
    // threads: doing so titled it with a child's session and gave it a status pill.
    expect(date.sourceThreads).toEqual([])
    expect(unmatchedFolder?.sourceThreads).toEqual([])
  })

  it('skips a worktree root the user moved inside the workspace, so its bytes are not counted twice', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-workspace-')); roots.push(root)
    const output = join(root, '2026-08-22', 'session-a')
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'result.txt'), 'result')
    const worktreeRoot = join(root, 'worktrees')
    mkdirSync(join(worktreeRoot, '44af', 'project'), { recursive: true })
    writeFileSync(join(worktreeRoot, '44af', 'project', 'source.ts'), 'x'.repeat(4096))

    const including = scanWorkspace(root)
    expect(including.entries.map((entry) => entry.name).sort()).toEqual(['2026-08-22', 'worktrees'])

    // The worktrees page measures that tree, so the workspace must not measure it too.
    const excluding = scanWorkspace(root, undefined, [], [worktreeRoot])
    expect(excluding.entries.map((entry) => entry.name)).toEqual(['2026-08-22'])
    expect(workspaceBytes(excluding)).toBeLessThan(workspaceBytes(including))
  })
})