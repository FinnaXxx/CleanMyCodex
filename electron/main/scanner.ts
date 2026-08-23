import { lstatSync, readdirSync, statSync } from 'node:fs'
import { join, basename, relative } from 'node:path'
import { CodexLocations } from './locations'
import { directoryAllocatedSize, fileAllocatedSize } from './fs-size'
import { scanSessions } from './sessions'
import { pluginStorageCategories, scanPluginVersions } from './plugins'
import { ProtectedPaths } from './guard'
import type { InstalledPlugin } from './app-server'
import { pluginStatusIsRemovable, type ScanProgress, type ScanSnapshot, type SessionItem, type StorageCategory, type StorageEntry } from '../../shared/types'
import { SCAN_STOPPED, message, type Message, type MessageKey } from '../../shared/messages'

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * Directory-name prefixes Codex uses for its own temp directories directly under `.tmp`:
 * the curated-plugin clone and the backup it moves the previous checkout into. Codex'
 * startup sweep only ever removes the clones, so the backups accumulate on their own.
 */
const TEMPORARY_STAGING_PREFIXES = ['plugins-clone-', 'plugins-backup-']

/** How long a staging directory must sit untouched before it counts as abandoned. */
const STAGING_IDLE_SECONDS = 86_400

function entryExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function pathAllocatedSize(path: string): number {
  try { return lstatSync(path).isDirectory() ? directoryAllocatedSize(path) : fileAllocatedSize(path) } catch { return 0 }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException(SCAN_STOPPED, 'AbortError')
}

function measureTree(path: string, signal?: AbortSignal): { bytes: number; latestActivity: number } {
  throwIfAborted(signal)
  let stats
  try { stats = lstatSync(path) } catch { return { bytes: 0, latestActivity: 0 } }
  if (stats.isSymbolicLink()) return { bytes: 0, latestActivity: stats.mtimeMs }
  if (!stats.isDirectory()) return { bytes: fileAllocatedSize(path), latestActivity: stats.mtimeMs }
  let bytes = 0
  let latestActivity = stats.mtimeMs
  let children: string[] = []
  try { children = readdirSync(path) } catch { return { bytes, latestActivity } }
  for (const name of children) {
    const measured = measureTree(join(path, name), signal)
    bytes += measured.bytes
    latestActivity = Math.max(latestActivity, measured.latestActivity)
  }
  return { bytes, latestActivity }
}

function entry(
  title: string,
  note: MessageKey | null,
  url: string,
  bytes: number,
  risk: StorageEntry['risk'],
  extra: Partial<Pick<StorageEntry, 'minimumIdleSeconds' | 'requiresCodexStopped' | 'tags'>> = {}
): StorageEntry {
  return {
    id: `remove:${url}`,
    title,
    note: note ? message(note) : null,
    tags: extra.tags ?? [],
    url,
    bytes,
    reclaimableBytes: bytes,
    minimumIdleSeconds: extra.minimumIdleSeconds ?? null,
    requiresCodexStopped: extra.requiresCodexStopped ?? false,
    risk
  }
}

function category(
  kind: StorageCategory['kind'],
  group: StorageCategory['group'],
  risk: StorageCategory['risk'],
  entries: StorageEntry[]
): StorageCategory {
  return { kind, group, risk, entries: entries.filter((e) => e.bytes > 0).sort((a, b) => b.bytes - a.bytes || a.title.localeCompare(b.title)) }
}

/** Finds `logs_*.sqlite` directly under ~/.codex (Codex' rolling log database). */
function logDatabases(home: string): { path: string; bytes: number }[] {
  try {
    return readdirSync(home)
      .filter((name) => name.startsWith('logs_') && name.endsWith('.sqlite'))
      .map((name) => {
        const path = join(home, name)
        // WAL and SHM are part of the database's actual current footprint.
        const bytes =
          fileAllocatedSize(path) +
          fileAllocatedSize(`${path}-wal`) +
          fileAllocatedSize(`${path}-shm`)
        return { path, bytes }
      })
  } catch {
    return []
  }
}

function databaseFiles(home: string, prefix: string): { path: string; bytes: number }[] {
  try {
    return readdirSync(home)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.sqlite'))
      .map((name) => {
        const path = join(home, name)
        return { path, bytes: fileAllocatedSize(path) + fileAllocatedSize(`${path}-wal`) + fileAllocatedSize(`${path}-shm`) }
      })
  } catch { return [] }
}

/**
 * Builds the core Codex snapshot. The interactive worker fills in workspace output
 * immediately afterward so the Documents permission prompt belongs to the main scan.
 * Automatic background cleanup deliberately leaves that user-data scan untouched.
 */
export async function scanSnapshot(
  locations: CodexLocations,
  installedPlugins: InstalledPlugin[] | null,
  onProgress?: (progress: ScanProgress) => void,
  signal?: AbortSignal
): Promise<ScanSnapshot> {
  const categories: StorageCategory[] = []
  const notes: Message[] = []
  const guards = new ProtectedPaths(locations)
  const progress = (stage: MessageKey, currentPath: string, fraction: number): void => {
    onProgress?.({ stage: message(stage), currentPath, fraction })
  }

  const measure = (path: string, stage: MessageKey = 'stage.caches', fraction = 0): number => {
    throwIfAborted(signal)
    progress(stage, path, fraction)
    return pathAllocatedSize(path)
  }

  // --- Recommended: disposable or rebuildable ---

  const staleTemporary: StorageEntry[] = []
  /** Measures one abandoned scratch directory, or nothing if it is live or protected. */
  const stagedEntry = (path: string, title: string, note: MessageKey): StorageEntry[] => {
    throwIfAborted(signal)
    if (guards.isProtected(path)) return []
    progress('stage.caches', path, 0.08)
    const measured = measureTree(path, signal)
    if (!measured.bytes) return []
    const idleSeconds = STAGING_IDLE_SECONDS
    if (Date.now() - measured.latestActivity < idleSeconds * 1000) return []
    return [entry(title, note, path, measured.bytes, 'safe', {
      minimumIdleSeconds: idleSeconds, requiresCodexStopped: true
    })]
  }
  const childrenOf = (root: string): string[] => {
    try { return readdirSync(root) } catch { return [] }
  }

  for (const name of childrenOf(locations.temporary)) {
    throwIfAborted(signal)
    const path = join(locations.temporary, name)
    if (path === locations.bundledMarketplaces) {
      for (const bundledName of childrenOf(path)) {
        if (!bundledName.includes('.staging-')) continue
        staleTemporary.push(...stagedEntry(join(path, bundledName), bundledName, 'note.marketplaceStaging'))
      }
      continue
    }
    // Unknown children of .tmp may become live state in a later Codex release — it holds
    // the curated plugin checkout, the installed marketplaces and Codex' rollout locks.
    // Only the temp-directory prefixes Codex itself creates there are eligible.
    if (!TEMPORARY_STAGING_PREFIXES.some((prefix) => name.startsWith(prefix)) && !name.includes('.staging-')) continue
    staleTemporary.push(...stagedEntry(path, name, 'note.installLeftover'))
  }

  // Codex renames a finished tree out of these staging parents and drops the rest, so
  // every surviving child belongs to a process that died mid-install.
  for (const parent of locations.stagingParents) {
    for (const name of childrenOf(parent)) {
      staleTemporary.push(...stagedEntry(join(parent, name), name, 'note.marketplaceStaging'))
    }
  }

  // ~/.codex/tmp/arg0 holds one directory per running Codex process, each holding a lock
  // file. Codex sweeps every unlocked sibling on launch; the ones left are from processes
  // that never got to. Removing them only costs the next launch a symlink rebuild.
  for (const name of childrenOf(locations.arg0Temporary)) {
    staleTemporary.push(...stagedEntry(join(locations.arg0Temporary, name), name, 'note.helperScratch'))
  }

  categories.push(category('temporary', 'recommended', 'safe', staleTemporary))
  await yieldToEventLoop()

  const codexCacheEntries = [locations.codexCache]
    .filter(entryExists)
    .map((path) => entry(cacheTitle(path, locations), 'note.codexOperationalCache', path, measure(path, 'stage.caches', 0.15), 'shielded', {
      requiresCodexStopped: true
    }))
  categories.push(category('codexCache', 'protectedData', 'shielded', codexCacheEntries))
  await yieldToEventLoop()

  const appCacheEntries = locations.appCaches
    .filter(entryExists)
    .map((path) => entry(cacheTitle(path, locations), 'note.platformCache', path, measure(path, 'stage.caches', 0.16), 'shielded', {
      requiresCodexStopped: true
    }))
  categories.push(category('appCache', 'protectedData', 'shielded', appCacheEntries))
  await yieldToEventLoop()

  // The desktop application rotates its own logs, so they are counted towards the totals
  // and never offered: cleaning them would reclaim only what it is about to reclaim
  // itself, and would take the recent sessions its diagnostics read with it.
  const applicationLogs = entryExists(locations.appLogs)
    ? [entry(basename(locations.appLogs), 'note.applicationLog', locations.appLogs,
        measure(locations.appLogs, 'stage.caches', 0.18), 'shielded')]
    : []
  categories.push(category('appLogs', 'protectedData', 'shielded', applicationLogs))
  await yieldToEventLoop()

  const logs = logDatabases(locations.home)
  categories.push(category('logDatabase', 'protectedData', 'shielded',
    logs.map((db) => entry(basename(db.path), 'note.logDatabase', db.path, db.bytes, 'shielded'))))
  await yieldToEventLoop()

  const pluginVersions = scanPluginVersions(locations.plugins, installedPlugins, (path) => progress('stage.plugins', path, 0.32))
  categories.push(...pluginStorageCategories(pluginVersions).filter((category) => category.entries.length))
  const pluginRuntimeEntries: StorageEntry[] = pluginVersions
    .filter((plugin) => !pluginStatusIsRemovable(plugin.status))
    .map((plugin) => entry(`${plugin.plugin} · ${plugin.version}`,
      plugin.status === 'builtin' ? 'note.builtinPlugin'
        : plugin.status === 'current' ? 'note.currentPlugin' : 'note.unconfirmedPlugin',
      plugin.directoryURL, plugin.bytes, 'shielded', {
        tags: [{
          label: message(plugin.status === 'builtin' ? 'tag.builtin'
            : plugin.status === 'current' ? 'tag.current' : 'tag.unconfirmed'),
          tone: plugin.status === 'builtin' ? 'info' : 'neutral'
        }]
      }))
  if (entryExists(locations.pluginRuntime)) {
    pluginRuntimeEntries.push(entry('.plugin-appserver', 'note.pluginRuntime', locations.pluginRuntime,
      measure(locations.pluginRuntime, 'stage.plugins', 0.36), 'shielded', { tags: [{ label: message('tag.runtime'), tone: 'info' }] }))
  }
  categories.push(category('pluginRuntime', 'protectedData', 'shielded', pluginRuntimeEntries))
  if (installedPlugins === null && pluginVersions.length) notes.push(message('scanNote.appServerUnavailable'))
  await yieldToEventLoop()

  // --- Protected: shown for awareness, never selected ---

  const sessions = await scanSessions(locations, (path, fraction) => progress('stage.sessions', path, 0.43 + fraction * 0.49), signal)
  if (sessions.length && !sessions.some((session) => session.title)) notes.push(message('scanNote.noSessionTitles'))
  throwIfAborted(signal)
  const sessionDatabases = databaseFiles(locations.home, 'thread_history_').map((db) =>
    entry(basename(db.path), 'note.sessionProjection', db.path, db.bytes, 'shielded'))
  categories.push(category('sessionDatabase', 'protectedData', 'shielded', sessionDatabases))
  categories.push(...assetCategories(locations, (path) => measure(path, 'stage.assets', 0.93)))

  const marketplaceSources = new Set(guards.localMarketplaceSources)
  const protectedConfigEntries: StorageEntry[] = []
  for (const path of guards.protectedURLs) {
    if (path === locations.codexCache) continue // represented by its dedicated category
    if ((!ProtectedPaths.contains(locations.home, path) && !marketplaceSources.has(path)) || !entryExists(path)) continue
    protectedConfigEntries.push(entry(
      // Nested protected entries (plugins/data, …) need their path to stay unambiguous.
      marketplaceSources.has(path) || basename(path) !== relativeToHome(path, locations.home)
        ? relativeToHome(path, locations.home)
        : basename(path),
      marketplaceSources.has(path) ? 'note.localMarketplace' : 'note.configOrCredentials',
      path,
      pathAllocatedSize(path),
      'shielded'
    ))
  }
  let homeEntries: string[] = []
  try { homeEntries = readdirSync(locations.home) } catch { /* missing home */ }
  for (const db of homeEntries.filter((name) => !name.startsWith('thread_history_') && ProtectedPaths.protectedHomePrefixes.some((prefix) => name.startsWith(prefix)))) {
    const path = join(locations.home, db)
    protectedConfigEntries.push(entry(db, 'note.stateDatabase', path, fileAllocatedSize(path), 'shielded'))
  }
  categories.push(category('protectedConfig', 'protectedData', 'shielded', protectedConfigEntries))

  const protectedUserEntries = ProtectedPaths.protectedAppSupportEntries.flatMap((relative): StorageEntry[] => {
    const path = join(locations.appSupport, relative)
    return entryExists(path) ? [entry(relative, 'note.browserProfile', path, pathAllocatedSize(path), 'shielded')] : []
  })
  categories.push(category('protectedUserData', 'protectedData', 'shielded', protectedUserEntries))

  const externalBytes = outermostStorageRoots([locations.appSupport, ...locations.appCacheContainers, locations.appLogs].filter(entryExists))
    .reduce((sum, path) => sum + directoryAllocatedSize(path), 0)
  const totalCodexBytes = directoryAllocatedSize(locations.home) + externalBytes
  progress('stage.done', '', 1)

  return {
    codexHome: locations.home,
    codexHomeExists: entryExists(locations.home),
    scannedAt: Date.now(),
    totalCodexBytes,
    externalBytes,
    categories: categories.filter((c) => c.entries.length > 0),
    sessions,
    pluginVersions,
    workspace: { root: locations.workspace, isScanned: false, entries: [] },
    notes
  }
}

export function outermostStorageRoots(paths: string[]): string[] {
  return [...new Set(paths)].filter((candidate) => !paths.some(
    (other) => other !== candidate && ProtectedPaths.contains(other, candidate)
  ))
}

/** `Codex/Default/Cache`, so cache directories sharing a name stay distinguishable. */
function cacheTitle(path: string, locations: CodexLocations): string {
  return relativeTo(locations.caches, path)
}

function relativeToHome(path: string, home: string): string {
  return relativeTo(home, path)
}

/** A path named by where it sits under `root`, falling back to its own name. */
function relativeTo(root: string, path: string): string {
  const value = relative(root, path)
  return value && !value.startsWith('..') ? value : basename(path)
}

function assetCategories(
  locations: CodexLocations,
  measure: (path: string) => number
): StorageCategory[] {
  const computerUse = entryExists(locations.computerUse)
    ? [entry('computer-use', 'note.computerUseComponent', locations.computerUse, measure(locations.computerUse), 'shielded', {
        requiresCodexStopped: true
      })]
    : []
  return [category('computerUse', 'protectedData', 'shielded', computerUse)]
}
