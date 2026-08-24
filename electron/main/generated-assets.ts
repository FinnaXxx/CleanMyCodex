import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { GeneratedAssetItem, SessionItem } from '../../shared/types'
import { CodexLocations } from './locations'

const UUID_ONLY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface AssetDirectory {
  kind: 'imageGen' | 'visualization' | 'viewer'
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
  const directories = [...imageDirectories, ...visualizationSources, ...visualizationViewers]
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
  sessionsByThread: Map<string, SessionItem>
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
    sourceSessionID: session?.id ?? null
  }
}
