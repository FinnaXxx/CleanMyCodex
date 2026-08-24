import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverWorktreeRoots, isCodexManagedWorktree, readWorktreeAdmin, scanWorktrees } from '../electron/main/worktrees'
import type { CodexWorkspaceThread } from '../electron/main/thread-index'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-worktrees-'))
  roots.push(root)
  return root
}

interface Built { worktree: string; checkout: string; repository: string; admin: string }

/**
 * Builds the on-disk shape Codex leaves behind: a checkout under `<root>/<id>/<project>`
 * whose `.git` is a pointer file, and the administrative directory git keeps for it
 * inside the repository. `managed` decides whether Codex' own marker file is written,
 * which is the only thing separating its worktrees from the user's.
 */
function buildWorktree(base: string, options: {
  root: string
  id: string
  project: string
  managed?: boolean
  branch?: string
  /** Writes a bare sha into HEAD, which is how Codex leaves a worktree it checked out. */
  detachedAt?: string
  threadID?: string
  /** Leaves the repository out, as if the user deleted or moved it. */
  withoutRepository?: boolean
}): Built {
  const repository = join(base, 'repos', options.project)
  const admin = join(repository, '.git', 'worktrees', options.project)
  const checkout = join(options.root, options.id, options.project)
  mkdirSync(checkout, { recursive: true })
  mkdirSync(admin, { recursive: true })
  writeFileSync(join(admin, 'HEAD'), options.detachedAt
    ? `${options.detachedAt}\n`
    : `ref: refs/heads/${options.branch ?? 'main'}\n`)
  writeFileSync(join(admin, 'commondir'), '../..\n')
  writeFileSync(join(admin, 'gitdir'), `${join(checkout, '.git')}\n`)
  if (options.managed !== false) {
    writeFileSync(join(admin, 'codex-thread.json'),
      JSON.stringify({ version: 1, ownerThreadId: options.threadID ?? 'thread-1' }))
  }
  writeFileSync(join(checkout, '.git'), `gitdir: ${admin}\n`)
  writeFileSync(join(checkout, 'source.ts'), 'x'.repeat(2048))
  if (options.withoutRepository) rmSync(join(repository, '.git'), { recursive: true, force: true })
  return { worktree: join(options.root, options.id), checkout, repository, admin }
}

function thread(cwd: string, id = 'thread-1', title = 'Fix the parser'): CodexWorkspaceThread {
  return { id, title, archived: false, isSubagent: false, modifiedAt: 1_700_000_000_000, cwd }
}

describe('Codex worktrees', () => {
  it('resolves the checkout back to its repository, branch and owning thread', () => {
    const base = temporaryRoot()
    const root = join(base, '.codex', 'worktrees')
    const built = buildWorktree(base, { root, id: '44af', project: 'CleanMyCodex', branch: 'feature/x', threadID: 'thread-9' })
    const admin = readWorktreeAdmin(built.checkout)
    expect(admin?.adminPath).toBe(built.admin)
    expect(admin?.repositoryPath).toBe(built.repository)
    expect(admin?.branch).toBe('feature/x')
    expect(admin?.ownerThreadID).toBe('thread-9')
    expect(admin?.isCodexManaged).toBe(true)
  })

  it('names the commit a detached worktree sits on, since that is all it has', () => {
    const base = temporaryRoot()
    const root = join(base, '.codex', 'worktrees')
    const sha = 'e4594860f1a2b3c4d5e6f70819a2b3c4d5e6f708'
    const built = buildWorktree(base, { root, id: 'a072', project: 'CleanMyCodex', detachedAt: sha })
    const admin = readWorktreeAdmin(built.checkout)
    expect(admin?.branch).toBeNull()
    expect(admin?.headCommit).toBe('e459486')
    expect(scanWorktrees([root])[0].headCommit).toBe('e459486')
  })

  it('leaves the commit out once a branch is checked out', () => {
    const base = temporaryRoot()
    const root = join(base, '.codex', 'worktrees')
    const built = buildWorktree(base, { root, id: 'b073', project: 'on-branch', branch: 'work' })
    const admin = readWorktreeAdmin(built.checkout)
    expect(admin?.branch).toBe('work')
    expect(admin?.headCommit).toBeNull()
  })

  it('reads an ordinary repository as no worktree at all', () => {
    const base = temporaryRoot()
    const project = join(base, 'plain')
    mkdirSync(join(project, '.git'), { recursive: true })
    expect(readWorktreeAdmin(project)).toBeNull()
  })

  it('separates worktrees Codex created from ones the user made by hand', () => {
    const base = temporaryRoot()
    const root = join(base, '.codex', 'worktrees')
    const codex = buildWorktree(base, { root, id: 'aa01', project: 'codex-made' })
    const mine = buildWorktree(base, { root, id: 'bb02', project: 'hand-made', managed: false })

    expect(isCodexManagedWorktree(codex.worktree)).toBe(true)
    expect(isCodexManagedWorktree(mine.worktree)).toBe(false)

    const found = scanWorktrees([root])
    expect(found.map((item) => item.status).sort()).toEqual(['managed', 'unmanaged'])
    expect(found.find((item) => item.project === 'codex-made')?.status).toBe('managed')
    expect(found.find((item) => item.project === 'hand-made')?.status).toBe('unmanaged')
  })

  it('shows a worktree whose repository is gone, but will not call it deletable', () => {
    const base = temporaryRoot()
    const root = join(base, '.codex', 'worktrees')
    const orphaned = buildWorktree(base, { root, id: 'cc03', project: 'orphan', withoutRepository: true })

    const [item] = scanWorktrees([root])
    expect(item.project).toBe('orphan')
    expect(item.isOrphaned).toBe(true)
    expect(item.repositoryPath).toBeNull()
    expect(item.bytes).toBeGreaterThan(0)
    // Codex' marker lived in the deleted repository, so nothing is left to prove who made
    // this. A missing repository is not on its own a licence to delete.
    expect(item.status).toBe('unmanaged')
    expect(isCodexManagedWorktree(orphaned.worktree)).toBe(false)
  })

  it('measures dependency and build directories apart from the source', () => {
    const base = temporaryRoot()
    const root = join(base, '.codex', 'worktrees')
    const built = buildWorktree(base, { root, id: 'ee05', project: 'sized' })
    mkdirSync(join(built.checkout, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(built.checkout, 'node_modules', 'left-pad', 'index.js'), 'y'.repeat(8192))

    const [item] = scanWorktrees([root])
    expect(item.artifactBytes).toBeGreaterThan(0)
    expect(item.bytes).toBeGreaterThan(item.artifactBytes)
  })

  it('finds a root outside the default location from the conversations alone', () => {
    const base = temporaryRoot()
    const moved = join(base, 'dev', 'wt')
    const built = buildWorktree(base, { root: moved, id: 'ff06', project: 'moved' })
    expect(discoverWorktreeRoots([thread(built.checkout)])).toEqual([moved])
  })

  it('finds both roots after the setting moved, since the old worktrees stay where they were', () => {
    const base = temporaryRoot()
    const older = join(base, '.codex', 'worktrees')
    const newer = join(base, 'dev', 'wt')
    const before = buildWorktree(base, { root: older, id: 'ab11', project: 'before' })
    const after = buildWorktree(base, { root: newer, id: 'ab12', project: 'after' })
    const found = discoverWorktreeRoots([thread(before.checkout, 'a'), thread(after.checkout, 'b')])
    expect(found.sort()).toEqual([older, newer].sort())
  })

  it('never turns a folder of the user\'s own worktrees into a root', () => {
    const base = temporaryRoot()
    const mine = join(base, 'my-worktrees')
    const built = buildWorktree(base, { root: mine, id: 'cd13', project: 'mine', managed: false })
    // Codex has run in here — the conversation proves only that, not that Codex owns it.
    expect(discoverWorktreeRoots([thread(built.checkout)])).toEqual([])
  })

  it('attaches the conversations that ran in a worktree without giving them any bytes', () => {
    const base = temporaryRoot()
    const root = join(base, '.codex', 'worktrees')
    const built = buildWorktree(base, { root, id: 'de14', project: 'threaded', threadID: 'owner' })
    const [item] = scanWorktrees([root], [
      thread(built.checkout, 'owner', 'First conversation'),
      thread(built.checkout, 'second', 'Second conversation')
    ])
    expect(item.sourceThreads.map((entry) => entry.title).sort())
      .toEqual(['First conversation', 'Second conversation'])
    expect(Object.keys(item.sourceThreads[0])).not.toContain('bytes')
  })

  it('falls back to the thread the marker names when no working directory points here', () => {
    const base = temporaryRoot()
    const root = join(base, '.codex', 'worktrees')
    buildWorktree(base, { root, id: 'ef15', project: 'by-marker', threadID: 'owner' })
    const [item] = scanWorktrees([root], [thread(join(base, 'elsewhere'), 'owner', 'Owning conversation')])
    expect(item.sourceThreads.map((entry) => entry.id)).toEqual(['owner'])
  })

  it('ignores directories whose name is not a worktree id', () => {
    const base = temporaryRoot()
    const root = join(base, '.codex', 'worktrees')
    buildWorktree(base, { root, id: 'not-hex', project: 'skipped' })
    expect(scanWorktrees([root])).toEqual([])
  })
})
