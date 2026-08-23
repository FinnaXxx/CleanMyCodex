import { existsSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, isAbsolute, join, normalize, relative, sep } from 'node:path'
import type { WorkspaceFolder, WorkspaceRepository, WorkspaceRepositoryState, WorkspaceSnapshot, WorkspaceThreadReference } from '../../shared/types'
import type { CodexWorkspaceThread } from './thread-index'
import { fileAllocatedSize } from './fs-size'

function gitState(path: string): WorkspaceRepositoryState {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  const run = (args: string[]) => spawnSync('git', args, { cwd: path, env, encoding: 'utf8', timeout: 5_000 })
  const status = run(['status', '--porcelain', '--untracked-files=normal'])
  if (status.status !== 0 || status.error) return 'unknown'
  if (status.stdout.trim()) return 'dirty'
  const upstream = run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (upstream.status !== 0 || !upstream.stdout.trim()) return 'unpushed'
  const ahead = run(['rev-list', '--count', '@{upstream}..HEAD'])
  if (ahead.status !== 0) return 'unknown'
  return Number(ahead.stdout.trim()) > 0 ? 'unpushed' : 'clean'
}

/** Each repository costs up to three git subprocesses, so a scan inspects at most this
 *  many and marks the rest `unchecked` rather than stalling on a huge workspace. */
const GIT_INSPECTION_BUDGET = 32

/**
 * Names the desktop environment writes behind the user's back — never work product, and
 * never a reason to list a folder. One `.DS_Store` beside two session outputs used to
 * promote its date folder into a row of its own, so the scan ignores these everywhere.
 *
 * Matching is by whole name, lowercased, so no pattern can swallow a file a session
 * actually produced. `._name` is the single prefix rule and it is AppleDouble's own
 * reserved form, written next to real files on non-Apple filesystems.
 */
const SYSTEM_JUNK_NAMES = new Set([
  '.ds_store', '.localized', '.apdisk', '.directory',
  'thumbs.db', 'thumbs.db:encryptable', 'ehthumbs.db', 'ehthumbs_vista.db', 'desktop.ini',
  '.spotlight-v100', '.documentrevisions-v100', '.fseventsd', '.temporaryitems', '.trashes', '$recycle.bin'
])

export function isSystemJunk(name: string): boolean {
  return SYSTEM_JUNK_NAMES.has(name.toLowerCase()) || name.startsWith('._')
}

/** `looseFiles` holds only the files directly inside the walked directory, never the
 *  nested ones a recursive walk adds to `bytes` and `files`. */
interface WalkResult { bytes: number; files: number; repositories: string[]; looseFiles: string[] }

function walk(path: string, recursive: boolean): WalkResult {
  let children
  try { children = readdirSync(path, { withFileTypes: true }) } catch { return { bytes: 0, files: 0, repositories: [], looseFiles: [] } }
  const result: WalkResult = { bytes: 0, files: 0, repositories: [], looseFiles: [] }
  for (const child of children) {
    if (isSystemJunk(child.name)) continue
    const childPath = join(path, child.name)
    // A link contributes no bytes of its own and is never followed, matching how every
    // other directory in the app is measured. Counting the target instead would charge a
    // workspace for the same bytes twice over a tree like `node_modules`, whose links
    // mostly point back inside it, and would charge it for outside trees it does not own.
    if (child.isSymbolicLink()) {
      result.files += 1
      result.looseFiles.push(childPath)
      continue
    }
    if (!child.isDirectory()) {
      result.bytes += fileAllocatedSize(childPath)
      result.files += 1
      result.looseFiles.push(childPath)
      continue
    }
    if (child.name === '.git') result.repositories.push(path)
    if (!recursive) continue
    const nested = walk(childPath, true)
    result.bytes += nested.bytes
    result.files += nested.files
    result.repositories.push(...nested.repositories)
  }
  return result
}

function childDirectories(path: string): string[] {
  try { return readdirSync(path, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => join(path, item.name)) } catch { return [] }
}

function folder(path: string, budget: { value: number }, onProgress?: (path: string) => void): WorkspaceFolder | null {
  onProgress?.(path)
  const measured = walk(path, true)
  if (!measured.bytes && !measured.files) return null
  const repositories: WorkspaceRepository[] = measured.repositories.map((repository) => ({
    id: repository,
    path: repository,
    name: basename(repository),
    state: budget.value > 0 ? (budget.value--, gitState(repository)) : 'unchecked'
  })).sort((a, b) => a.name.localeCompare(b.name))
  let modifiedAt = 0
  try { modifiedAt = statSync(path).mtimeMs } catch { /* missing */ }
  return { id: path, path, name: basename(path), bytes: measured.bytes, fileCount: measured.files, modifiedAt, repositories, sourceThreads: [], looseFiles: measured.looseFiles, children: [] }
}

export function scanWorkspace(root: string, onProgress?: (path: string) => void, threads: CodexWorkspaceThread[] = []): WorkspaceSnapshot {
  if (!existsSync(root)) return { root, isScanned: true, entries: [] }
  const budget = { value: GIT_INSPECTION_BUDGET }
  const entries = childDirectories(root).map((datePath): WorkspaceFolder | null => {
    onProgress?.(datePath)
    const children = childDirectories(datePath).map((path) => folder(path, budget, onProgress)).filter((item): item is WorkspaceFolder => item !== null).sort((a, b) => b.bytes - a.bytes)
    // A date folder measures only what it holds itself. It is listed beside its outputs
    // rather than above them, so counting theirs would show the same bytes twice and
    // would make ticking the date row look like it takes the outputs with it.
    const own = walk(datePath, false)
    if (!own.files && !children.length) return null
    let modifiedAt = 0
    try { modifiedAt = statSync(datePath).mtimeMs } catch { /* missing */ }
    return { id: datePath, path: datePath, name: basename(datePath), bytes: own.bytes, fileCount: own.files, modifiedAt, repositories: [], sourceThreads: [], looseFiles: own.looseFiles, children }
  }).filter((item): item is WorkspaceFolder => item !== null).sort((a, b) => b.name.localeCompare(a.name))
  attachSourceThreads(root, entries, threads)
  return { root, isScanned: true, entries }
}

function attachSourceThreads(root: string, entries: WorkspaceFolder[], threads: CodexWorkspaceThread[]): void {
  const base = normalize(root)
  const byPath = new Map<string, WorkspaceFolder>()
  for (const entry of entries) {
    byPath.set(normalize(entry.path), entry)
    for (const child of entry.children) byPath.set(normalize(child.path), child)
  }

  for (const thread of threads) {
    const rel = relative(base, normalize(thread.cwd))
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue
    const parts = rel.split(sep).filter(Boolean)
    const targetPath = parts.length >= 2 ? join(base, parts[0], parts[1]) : join(base, parts[0])
    const target = byPath.get(normalize(targetPath))
    if (target) target.sourceThreads.push(reference(thread))
  }

  // Deliberately not aggregated upward: a date folder is listed alongside its own
  // children, so inheriting their threads would title it with a child's session.
  for (const entry of entries) {
    entry.sourceThreads = uniqueThreads(entry.sourceThreads)
    for (const child of entry.children) child.sourceThreads = uniqueThreads(child.sourceThreads)
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
  return [...unique.values()].sort((a, b) => Number(a.isSubagent) - Number(b.isSubagent) || b.modifiedAt - a.modifiedAt || a.title.localeCompare(b.title))
}
