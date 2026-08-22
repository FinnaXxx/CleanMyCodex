import { existsSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, join } from 'node:path'
import type { WorkspaceFolder, WorkspaceRepository, WorkspaceRepositoryState, WorkspaceSnapshot } from '../../shared/types'
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

interface WalkResult { bytes: number; files: number; repositories: string[] }

function walk(path: string, recursive: boolean): WalkResult {
  let children
  try { children = readdirSync(path, { withFileTypes: true }) } catch { return { bytes: 0, files: 0, repositories: [] } }
  const result: WalkResult = { bytes: 0, files: 0, repositories: [] }
  for (const child of children) {
    const childPath = join(path, child.name)
    if (!child.isDirectory()) {
      result.bytes += fileAllocatedSize(childPath)
      result.files += 1
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
    state: budget.value-- > 0 ? gitState(repository) : 'unknown'
  })).sort((a, b) => a.name.localeCompare(b.name))
  let modifiedAt = 0
  try { modifiedAt = statSync(path).mtimeMs } catch { /* missing */ }
  return { id: path, path, name: basename(path), bytes: measured.bytes, fileCount: measured.files, modifiedAt, repositories, children: [] }
}

export function scanWorkspace(root: string, onProgress?: (path: string) => void): WorkspaceSnapshot {
  if (!existsSync(root)) return { root, isScanned: true, entries: [] }
  const budget = { value: 32 }
  const entries = childDirectories(root).map((datePath): WorkspaceFolder | null => {
    onProgress?.(datePath)
    const children = childDirectories(datePath).map((path) => folder(path, budget, onProgress)).filter((item): item is WorkspaceFolder => item !== null).sort((a, b) => b.bytes - a.bytes)
    const own = walk(datePath, false)
    const bytes = own.bytes + children.reduce((sum, child) => sum + child.bytes, 0)
    if (!bytes && !children.length) return null
    let modifiedAt = 0
    try { modifiedAt = statSync(datePath).mtimeMs } catch { /* missing */ }
    return { id: datePath, path: datePath, name: basename(datePath), bytes, fileCount: own.files, modifiedAt, repositories: [], children }
  }).filter((item): item is WorkspaceFolder => item !== null).sort((a, b) => b.name.localeCompare(a.name))
  return { root, isScanned: true, entries }
}
