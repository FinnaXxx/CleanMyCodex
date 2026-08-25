import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { GeneratedAssetItem, SessionItem } from '../../shared/types'
import { CodexLocations } from './locations'
import { isSystemJunk } from './workspace'

const UUID_ONLY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface AssetDirectory {
  kind: 'imageGen' | 'visualization' | 'viewer' | 'plan'
  path: string
  threadID: string | null
}

function directDirectories(root: string, kind: AssetDirectory['kind']): AssetDirectory[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => ({ kind, path: join(root, entry.name), threadID: UUID_ONLY_RE.test(entry.name) ? entry.name : null }))
  } catch {
    return []
  }
}

/** Visualization fragments sit below a date hierarchy; a UUID directory owns the
 *  complete result, so nested files and folders stay one deletion unit. */
function visualizationDirectories(root: string): AssetDirectory[] {
  const result: AssetDirectory[] = []
  const stack = [root]
  while (stack.length) {
    const directory = stack.pop()!
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (UUID_ONLY_RE.test(entry.name)) result.push({ kind: 'visualization', path, threadID: entry.name })
      else stack.push(path)
    }
  }
  return result
}

function directoryFacts(root: string): { bytes: number; fileCount: number; formats: string[]; modifiedAt: number } {
  let bytes = 0
  let fileCount = 0
  let modifiedAt = 0
  const formats = new Set<string>()
  try { modifiedAt = statSync(root).mtimeMs } catch { /* missing directory */ }
  const stack = [root]
  while (stack.length) {
    const directory = stack.pop()!
    let entries: string[]
    try { entries = readdirSync(directory) } catch { continue }
    for (const name of entries) {
      if (isSystemJunk(name)) continue
      const path = join(directory, name)
      let stats
      try { stats = lstatSync(path) } catch { continue }
      if (stats.isSymbolicLink()) continue
      modifiedAt = Math.max(modifiedAt, stats.mtimeMs)
      if (stats.isDirectory()) stack.push(path)
      else {
        fileCount += 1
        const extension = extname(name).slice(1).toLowerCase()
        if (extension) formats.add(extension)
        const allocated = stats.blocks * 512
        bytes += allocated > 0 ? allocated : stats.size
      }
    }
  }
  return { bytes, fileCount, formats: [...formats].sort(), modifiedAt }
}

export function scanGeneratedAssets(
  locations: CodexLocations,
  sessions: SessionItem[],
  onProgress?: (path: string, fraction: number) => void
): GeneratedAssetItem[] {
  const imageDirectories = directDirectories(locations.generatedImages, 'imageGen')
  const visualizationSources = visualizationDirectories(locations.visualizations)
  const visualizationViewers = directDirectories(locations.visualizationViewers, 'viewer')
  // Only claim plan directories whose name is a thread UUID: the open-source CLI never
  // writes here, so anything else is an unknown shape and is left for the overview to
  // surface (or to remain unclaimed) rather than shown as a plan asset.
  const planDirectories = directDirectories(locations.plans, 'plan').filter((directory) => directory.threadID !== null)
  const directories = [...imageDirectories, ...visualizationSources, ...visualizationViewers, ...planDirectories]
  const sessionsByThread = new Map(sessions.map((session) => [session.threadID.toLowerCase(), session]))
  const factsByPath = new Map<string, ReturnType<typeof directoryFacts>>()
  directories.forEach((directory, index) => {
    onProgress?.(directory.path, index / Math.max(directories.length, 1))
    if (!existsSync(directory.path)) return
    const facts = directoryFacts(directory.path)
    if (!facts.bytes && !facts.fileCount) return
    factsByPath.set(directory.path, facts)
  })

  const assets = imageDirectories.flatMap((directory): GeneratedAssetItem[] => {
    const facts = factsByPath.get(directory.path)
    if (!facts) return []
    return [assetFromDirectories('imageGen', [directory], factsByPath, sessionsByThread)]
  })

  // Each plan directory is one conversation's revisions; the H1 of its newest PLAN.md
  // gives the row a title that survives the conversation being deleted.
  for (const directory of planDirectories) {
    if (!factsByPath.has(directory.path)) continue
    assets.push(assetFromDirectories('plan', [directory], factsByPath, sessionsByThread, planTitle(directory.path)))
  }

  // A Visualization's source fragments and rendered Viewer are two representations of
  // one result. Group them by thread so the UI cannot leave a half-broken pair behind.
  const visualizationGroups = new Map<string, AssetDirectory[]>()
  for (const directory of [...visualizationSources, ...visualizationViewers]) {
    if (!factsByPath.has(directory.path)) continue
    const key = directory.threadID?.toLowerCase() ?? directory.path
    visualizationGroups.set(key, [...(visualizationGroups.get(key) ?? []), directory])
  }
  for (const group of visualizationGroups.values()) {
    const ordered = [...group].sort((a, b) => Number(a.kind === 'viewer') - Number(b.kind === 'viewer') || a.path.localeCompare(b.path))
    assets.push(assetFromDirectories('visualization', ordered, factsByPath, sessionsByThread))
  }
  onProgress?.('', 1)
  return assets.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
}

function assetFromDirectories(
  kind: GeneratedAssetItem['kind'],
  directories: AssetDirectory[],
  factsByPath: Map<string, ReturnType<typeof directoryFacts>>,
  sessionsByThread: Map<string, SessionItem>,
  title: string | null = null
): GeneratedAssetItem {
  const primary = directories[0]
  const facts = directories.map((directory) => factsByPath.get(directory.path)!).filter(Boolean)
  const formats = new Set(facts.flatMap((item) => item.formats))
  const session = primary.threadID ? sessionsByThread.get(primary.threadID.toLowerCase()) : undefined
  return {
    id: primary.path,
    kind,
    path: primary.path,
    companionPaths: directories.slice(1).map((directory) => directory.path),
    bytes: facts.reduce((sum, item) => sum + item.bytes, 0),
    fileCount: facts.reduce((sum, item) => sum + item.fileCount, 0),
    formats: [...formats].sort(),
    modifiedAt: Math.max(...facts.map((item) => item.modifiedAt)),
    sourceThreadID: primary.threadID,
    sourceSessionID: session?.id ?? null,
    title
  }
}

/**
 * Picks the newest PLAN.md revision under a thread's plans directory and reads its H1.
 * Revisions sit under `<planID>/PLAN.md` where `planID` is a UUIDv7, so the
 * lexicographically greatest planID is the newest revision. The H1 of the first kilobyte
 * names a plan even after its conversation is gone, so an orphaned plan is not just a UUID.
 */
function planTitle(threadDir: string): string | null {
  let entries
  try { entries = readdirSync(threadDir, { withFileTypes: true }) } catch { return null }
  const planIDs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && UUID_ONLY_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a))
  if (!planIDs.length) return null
  let fd: number
  try { fd = openSync(join(threadDir, planIDs[0], 'PLAN.md'), 'r') } catch { return null }
  try {
    const buffer = Buffer.alloc(1024)
    const bytesRead = readSync(fd, buffer, 0, 1024, 0)
    const head = buffer.subarray(0, bytesRead).toString('utf8')
    const match = head.match(/^#[ \t]+(.+?)\r?$/m)
    return match ? match[1].trim() : null
  } finally {
    closeSync(fd)
  }
}
