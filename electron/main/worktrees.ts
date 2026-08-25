import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import type { WorkspaceThreadReference, WorktreeItem, WorktreeStatus } from '../../shared/types'
import type { CodexWorkspaceThread } from './thread-index'
import { GIT_INSPECTION_BUDGET, gitState } from './workspace'
import { fileAllocatedSize } from './fs-size'
import { MessageError, message } from '../../shared/messages'

/**
 * Codex-managed git worktrees.
 *
 * The desktop application checks a repository out under `<root>/<id>/<project>`, where
 * `<root>` defaults to `~/.codex/worktrees` and `<id>` is a short hex string. The
 * checkout's `.git` is a file pointing at an administrative directory that lives inside
 * the user's own repository, at `<repo>/.git/worktrees/<name>`.
 *
 * A worktree is only ever offered for deletion when that administrative directory holds
 * `codex-thread.json`. Git never writes that file, so its presence is what separates a
 * worktree Codex created from one the user made by hand — which may sit in the same
 * place, holds their own work, and must stay untouched. If a future Codex release stops
 * writing the marker, worktrees fall back to `unmanaged`: counted and shown, never
 * deletable. The failure direction is the safe one.
 */

/** Directory name under `<root>`: a short hex id, as the desktop application writes it. */
const WORKTREE_ID_RE = /^[0-9a-f]{4,}$/i

/** Written by Codex into the git administrative directory; carries `ownerThreadId`. */
const CODEX_MARKER_FILE = 'codex-thread.json'

/** Dependencies and build output. Measured separately: it is nearly all of a worktree's
 *  size, and it is the part a reader recognises as reproducible. */
const ARTIFACT_DIRECTORY_NAMES = new Set([
  'node_modules', 'target', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.turbo'
])

export interface WorktreeAdmin {
  /** `<repo>/.git/worktrees/<name>` */
  adminPath: string
  /** Working tree root of the repository this worktree belongs to. */
  repositoryPath: string | null
  /** Thread that owns this worktree, from the marker file. */
  ownerThreadID: string | null
  isCodexManaged: boolean
}

function readFile(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

/** Resolve platform aliases such as macOS `/var` → `/private/var` before identity checks. */
function canonicalExistingPath(path: string): string {
  try { return normalize(realpathSync(path)) } catch { return normalize(path) }
}

/**
 * Resolves a checkout's `.git` pointer file to the administrative directory git keeps for
 * it. Returns null for a normal repository (whose `.git` is a directory), for a pointer
 * that does not resolve, and for one that resolves somewhere other than a `worktrees/`
 * directory — none of those is a linked worktree.
 */
export function readGitPointer(projectPath: string): string | null {
  const pointer = join(projectPath, '.git')
  let stats
  try { stats = lstatSync(pointer) } catch { return null }
  // A directory here is an ordinary repository, which is nothing to do with this page.
  if (!stats.isFile()) return null
  const match = readFile(pointer)?.match(/^gitdir:\s*(.+?)\s*$/m)
  if (!match) return null
  return normalize(isAbsolute(match[1]) ? match[1] : resolve(projectPath, match[1]))
}

export function readWorktreeAdmin(projectPath: string): WorktreeAdmin | null {
  const adminPath = readGitPointer(projectPath)
  if (!adminPath) return null
  if (!isDirectory(adminPath) || basename(dirname(adminPath)) !== 'worktrees') return null

  const marker = readFile(join(adminPath, CODEX_MARKER_FILE))
  let ownerThreadID: string | null = null
  if (marker) {
    try {
      const parsed = JSON.parse(marker) as Record<string, unknown>
      // The desktop writes `ownerThreadId`; the snake_case spelling is accepted too so a
      // reshaped marker still identifies its thread.
      const value = parsed['ownerThreadId'] ?? parsed['owner_thread_id']
      if (typeof value === 'string' && value.length) ownerThreadID = value
    } catch { /* an unparseable marker still proves Codex owns this worktree */ }
  }

  return {
    adminPath,
    repositoryPath: repositoryRoot(adminPath),
    ownerThreadID,
    isCodexManaged: marker !== null
  }
}

/**
 * The repository a worktree belongs to, from the `commondir` file git writes beside the
 * administrative directory. That names the repository's `.git`; the working tree is its
 * parent, unless the repository is bare, in which case there is nothing to return.
 */
function repositoryRoot(adminPath: string): string | null {
  const commonDir = readFile(join(adminPath, 'commondir'))?.trim()
  if (!commonDir) return null
  const gitDir = normalize(isAbsolute(commonDir) ? commonDir : resolve(adminPath, commonDir))
  if (!isDirectory(gitDir)) return null
  if (basename(gitDir) !== '.git') return null
  const root = dirname(gitDir)
  return isDirectory(root) ? root : null
}

/** The checkout inside `<root>/<id>`: its single child directory, or the id directory
 *  itself if a future layout puts the checkout straight in there. */
function checkoutDirectory(worktreeDirectory: string): string | null {
  if (existsSync(join(worktreeDirectory, '.git'))) return worktreeDirectory
  let children: string[] = []
  try {
    children = readdirSync(worktreeDirectory, { withFileTypes: true })
      .filter((child) => child.isDirectory())
      .map((child) => join(worktreeDirectory, child.name))
  } catch { return null }
  return children.find((child) => existsSync(join(child, '.git'))) ?? children[0] ?? null
}

/**
 * Whether this directory is a worktree Codex created. Re-checked on disk at deletion
 * time rather than trusted from a scan result, because it is the whole of what separates
 * a disposable checkout from the user's own work.
 */
export function isCodexManagedWorktree(worktreeDirectory: string): boolean {
  if (!WORKTREE_ID_RE.test(basename(worktreeDirectory))) return false
  const checkout = checkoutDirectory(worktreeDirectory)
  if (!checkout) return false
  return readWorktreeAdmin(checkout)?.isCodexManaged === true
}

interface Measured { bytes: number; artifactBytes: number; modifiedAt: number }

/** One pass over the checkout, splitting off the dependency and build directories.
 *  Symlinks are not followed, matching how every other tree in this app is measured. */
function measure(path: string, insideArtifact = false): Measured {
  const result: Measured = { bytes: 0, artifactBytes: 0, modifiedAt: 0 }
  try { result.modifiedAt = Math.round(statSync(path).mtimeMs) } catch { /* missing */ }
  let children
  try { children = readdirSync(path, { withFileTypes: true }) } catch { return result }
  for (const child of children) {
    const childPath = join(path, child.name)
    if (child.isSymbolicLink()) continue
    if (child.isDirectory()) {
      const nested = measure(childPath, insideArtifact || ARTIFACT_DIRECTORY_NAMES.has(child.name))
      result.bytes += nested.bytes
      result.artifactBytes += nested.artifactBytes
      result.modifiedAt = Math.max(result.modifiedAt, nested.modifiedAt)
      continue
    }
    const bytes = fileAllocatedSize(childPath)
    result.bytes += bytes
    if (insideArtifact) result.artifactBytes += bytes
    try { result.modifiedAt = Math.max(result.modifiedAt, Math.round(statSync(childPath).mtimeMs)) } catch { /* missing */ }
  }
  return result
}

/**
 * Worktree roots in use on this machine, worked out from the working directories of the
 * conversations already scanned. Moving the root in Codex' settings leaves the existing
 * worktrees where they were, so more than one root can be live, and reading the setting
 * would only ever name the newest.
 *
 * A directory is only accepted as a root on the strength of a worktree Codex itself
 * created: a user who keeps their own worktrees in one folder and runs Codex inside them
 * must never see that folder turn into a place this app offers to clean.
 */
export function discoverWorktreeRoots(threads: CodexWorkspaceThread[]): string[] {
  const roots = new Set<string>()
  for (const thread of threads) {
    const checkout = managedCheckoutAtOrAbove(thread.cwd)
    if (!checkout) continue
    const worktreeDirectory = dirname(checkout)
    const root = dirname(worktreeDirectory)
    if (roots.has(root)) continue
    roots.add(root)
  }
  return [...roots]
}

/** A conversation may run in any project subdirectory, not just at the checkout root. */
function managedCheckoutAtOrAbove(path: string): string | null {
  let candidate = normalize(path)
  while (true) {
    const worktreeDirectory = dirname(candidate)
    if (WORKTREE_ID_RE.test(basename(worktreeDirectory)) &&
      readWorktreeAdmin(candidate)?.isCodexManaged === true) return candidate
    const parent = dirname(candidate)
    if (parent === candidate) return null
    candidate = parent
  }
}

/**
 * Every evidenced worktree root this machine has in play: the default one, roots the
 * scanned conversations reveal, and a configured root that already contains a linked
 * worktree. An empty configured directory adds nothing until Codex creates one there.
 */
export function resolveWorktreeRoots(
  known: string[],
  threads: CodexWorkspaceThread[],
  configured: string | null
): string[] {
  return [...new Set([
    ...known.map(normalize),
    ...discoverWorktreeRoots(threads),
    ...(configured && isWorktreeRoot(configured) ? [normalize(configured)] : [])
  ])]
}

export interface WorktreeScanOptions {
  onProgress?: (path: string, fraction: number) => void
  /** Shared across roots so a machine with many worktrees still finishes promptly. */
  budget?: { value: number }
}

/** Every worktree below the given roots, `managed` ones first and largest first. */
export function scanWorktrees(
  roots: string[],
  threads: CodexWorkspaceThread[] = [],
  options: WorktreeScanOptions = {}
): WorktreeItem[] {
  const budget = options.budget ?? { value: GIT_INSPECTION_BUDGET }
  const directories = roots.flatMap((root) => worktreeDirectories(root))
  const found: Described[] = []
  directories.forEach((directory, index) => {
    options.onProgress?.(directory, directories.length ? index / directories.length : 1)
    const described = describe(directory, budget)
    if (described) found.push(described)
  })
  attachSourceThreads(found, threads)
  const items = found.map((entry) => entry.item)
  return items.sort((a, b) =>
    Number(a.status === 'unmanaged') - Number(b.status === 'unmanaged') || b.bytes - a.bytes ||
    a.project.localeCompare(b.project))
}

function worktreeDirectories(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((child) => child.isDirectory() && WORKTREE_ID_RE.test(child.name))
      .map((child) => join(root, child.name))
  } catch { return [] }
}

/**
 * Whether a configured path has evidence of being a git worktree root. An empty setting
 * is deliberately ignored: until at least one hex-named child resolves to git's
 * `worktrees/` administration directory, a guessed desktop-state key is not trusted as
 * a storage root.
 */
export function isWorktreeRoot(path: string): boolean {
  return worktreeDirectories(path).some((directory) => {
    const checkout = checkoutDirectory(directory)
    return checkout !== null && readWorktreeAdmin(checkout) !== null
  })
}

/** Recognised worktree container paths below the given roots, without measuring them. */
export function worktreePaths(roots: string[]): string[] {
  return roots.flatMap((root) => worktreeDirectories(root)).filter((directory) => {
    const checkout = checkoutDirectory(directory)
    return checkout !== null && readGitPointer(checkout) !== null
  })
}

interface Described {
  item: WorktreeItem
  /** From the marker file; the fallback when no conversation names this directory. */
  ownerThreadID: string | null
}

function describe(worktreeDirectory: string, budget: { value: number }): Described | null {
  const checkout = checkoutDirectory(worktreeDirectory)
  if (!checkout) return null
  const admin = readWorktreeAdmin(checkout)
  // A `.git` pointer that no longer resolves means the repository this was cut from has
  // been deleted or moved. The checkout is worth showing — it is often the largest thing
  // here and the most obviously finished — but Codex' marker went with the repository, so
  // there is no longer any proof of who created it, and it stays undeletable.
  if (!admin && !readGitPointer(checkout)) return null

  const status: WorktreeStatus = admin?.isCodexManaged ? 'managed' : 'unmanaged'
  const measured = measure(checkout)
  const isOrphaned = !admin || admin.repositoryPath === null

  return {
    ownerThreadID: admin?.ownerThreadID ?? null,
    item: {
      id: worktreeDirectory,
      path: worktreeDirectory,
      projectPath: checkout,
      project: basename(checkout),
      repositoryPath: admin?.repositoryPath ?? null,
      status,
      // A worktree whose repository is gone has no upstream to compare against, so asking
      // git about it would only ever answer `unknown` at the cost of a subprocess.
      state: isOrphaned ? 'unknown' : budget.value > 0 ? (budget.value--, gitState(checkout)) : 'unchecked',
      isOrphaned,
      bytes: measured.bytes,
      artifactBytes: measured.artifactBytes,
      modifiedAt: measured.modifiedAt,
      sourceThreads: []
    }
  }
}

/**
 * Conversations that ran inside each worktree, matched on working directory the same way
 * the workspace scan does, and falling back to the thread the marker file names when no
 * working directory points here. These are references: the rollout files they stand for
 * live under `~/.codex/sessions` and are counted there, never here.
 */
function attachSourceThreads(found: Described[], threads: CodexWorkspaceThread[]): void {
  if (!found.length || !threads.length) return
  const byID = new Map(threads.map((thread) => [thread.id, thread]))
  for (const { item, ownerThreadID } of found) {
    const base = normalize(item.path)
    for (const thread of threads) {
      const rel = relative(base, normalize(thread.cwd))
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue
      item.sourceThreads.push(reference(thread))
    }
    if (!item.sourceThreads.length && ownerThreadID) {
      const owner = byID.get(ownerThreadID)
      if (owner) item.sourceThreads.push(reference(owner))
    }
    item.sourceThreads = uniqueThreads(item.sourceThreads)
  }
}

function reference(thread: CodexWorkspaceThread): WorkspaceThreadReference {
  return {
    id: thread.id,
    title: thread.title,
    archived: thread.archived,
    isSubagent: thread.isSubagent,
    modifiedAt: thread.modifiedAt
  }
}

function uniqueThreads(threads: WorkspaceThreadReference[]): WorkspaceThreadReference[] {
  const unique = new Map(threads.map((thread) => [thread.id, thread]))
  return [...unique.values()].sort((a, b) =>
    Number(a.isSubagent) - Number(b.isSubagent) || b.modifiedAt - a.modifiedAt || a.title.localeCompare(b.title))
}

/**
 * Removes one Codex-created worktree, letting git do the work.
 *
 * `git worktree remove` is what keeps the user's repository consistent: it takes down
 * `<repo>/.git/worktrees/<name>` along with the checkout, so the repository stops listing
 * a worktree that is no longer on disk. That administrative directory sits outside every
 * root this app may write to, which is exactly why deleting the checkout by hand is not
 * an option here.
 *
 * A git failure is reported rather than bypassed with direct filesystem deletion. Only
 * git can prove that both the checkout and the administrative record in the user's
 * repository were removed consistently. The container directory Codex wrapped around
 * the checkout goes last, after that consistency check succeeds.
 */
export async function removeCodexWorktree(
  worktreeDirectory: string,
  repositoryPath: string | null,
  remove: (path: string) => Promise<void>
): Promise<void> {
  // Re-read the marker rather than trusting the scan that produced this task: this is the
  // one check standing between a disposable checkout and the user's own worktree.
  if (!isCodexManagedWorktree(worktreeDirectory)) {
    throw new MessageError(message('cleanup.worktreeNotManaged'))
  }
  const checkout = checkoutDirectory(worktreeDirectory)
  if (!checkout) throw new MessageError(message('cleanup.worktreeNotManaged'))
  const admin = readWorktreeAdmin(checkout)
  if (!admin?.repositoryPath || !repositoryPath) {
    throw new MessageError(message('cleanup.worktreeRemoveFailed', { reason: 'repository unavailable' }))
  }
  if (canonicalExistingPath(admin.repositoryPath) !== canonicalExistingPath(repositoryPath)) {
    throw new MessageError(message('cleanup.worktreeRemoveFailed', { reason: 'repository changed since the last scan' }))
  }

  const result = git(admin.repositoryPath, ['worktree', 'remove', '--force', checkout])
  if (!result.ok) {
    throw new MessageError(message('cleanup.worktreeRemoveFailed', { reason: result.reason }))
  }
  if (existsSync(checkout) || existsSync(admin.adminPath)) {
    throw new MessageError(message('cleanup.worktreeRemoveFailed', { reason: 'git left worktree metadata behind' }))
  }
  if (existsSync(worktreeDirectory)) await remove(worktreeDirectory)
}

function git(repositoryPath: string, args: string[]): { ok: boolean; reason: string } {
  const result = spawnSync('git', ['-C', repositoryPath, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
    timeout: 30_000
  })
  if (result.error) return { ok: false, reason: result.error.message }
  if (result.status !== 0) return { ok: false, reason: (result.stderr || '').trim() || `git exited ${result.status}` }
  return { ok: true, reason: '' }
}
