import { lstatSync, readdirSync, statSync } from 'node:fs'
import { join, basename, normalize, relative } from 'node:path'
import { appCacheDirectories, CodexLocations } from './locations'
import { directoryAllocatedSize, fileAllocatedSize } from './fs-size'
import { scanSessions } from './sessions'
import { scanGeneratedAssets } from './generated-assets'
import { pluginStorageCategories, scanPluginVersions } from './plugins'
import { scanStandaloneReleases } from './releases'
import { resolveWorktreeRoots, scanWorktrees } from './worktrees'
import { desktopWorktreeRoot } from './desktop-store'
import { CodexThreadIndex } from './thread-index'
import { GIT_INSPECTION_BUDGET, isSystemJunk } from './workspace'
import { ProtectedPaths } from './guard'
import type { InstalledPlugin } from './app-server'
import { pluginStatusIsRemovable, type ScanProgress, type ScanSnapshot, type SessionItem, type StorageCategory, type StorageEntry, type WorktreeItem } from '../../shared/types'
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

/**
 * Temporary files directly inside ~/.codex that outlived whatever wrote them.
 *
 * The desktop application writes its persisted state through a temporary file and, often
 * enough, fails to remove it: a dozen of them accumulate over a few weeks, each holding a
 * whole copy of that state. `skills.bak.<timestamp>` is what an upgrade leaves behind
 * after moving the previous skills directory aside. Neither is ever cleaned by Codex.
 *
 * These are exact shapes rather than a `.bak` or `.tmp` catch-all, so nothing Codex still
 * reads can match one — `.codex-global-state.json` and its `.bak` in particular.
 *
 * `keepNewest` holds back the most recent match of a shape that is written continuously:
 * a file being written right now looks exactly like one abandoned a moment ago, and the
 * idle threshold alone cannot tell them apart. A backup taken during an upgrade is a
 * finished rename, so there is nothing to hold back there.
 */
const HOME_LEFTOVER_PATTERNS: Array<{ pattern: RegExp; note: MessageKey; keepNewest: boolean }> = [
  { pattern: /^\.\.codex-global-state\.json\.tmp-\d+-[0-9a-f-]+$/i, note: 'note.desktopStateLeftover', keepNewest: true },
  { pattern: /^skills\.bak\.\d{14}$/, note: 'note.skillsBackup', keepNewest: false }
]

/**
 * Top-level names inside ~/.codex a category already accounts for. Anything here and not
 * protected is reported as unrecognized: Codex' desktop side adds directories this app
 * cannot learn about from the CLI sources, and an unnamed one would otherwise disappear
 * into the overview's remainder.
 */
const SCANNED_HOME_ENTRIES = [
  'sessions', 'archived_sessions', 'plugins', 'generated_images', 'visualizations',
  'visualization-viewers', 'computer-use', '.tmp', 'tmp', 'worktrees', 'packages'
]

/** Same idea for the desktop application's own data directory. */
const SCANNED_APP_SUPPORT_ENTRIES = ['Default']

const CODEX_CACHE_NOTES: Record<string, MessageKey> = {
  remote_plugin_catalog: 'note.remotePluginCatalogCache',
  codex_apps_tools: 'note.codexAppsToolsCache',
  codex_app_directory: 'note.codexAppDirectoryCache',
  codex_apps_server_info: 'note.codexAppsServerInfoCache',
  'tui-pets': 'note.tuiPetsCache'
}

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

/** Prefixes of Codex' state SQLite databases directly under ~/.codex: runtime state,
 *  goals, the work queue, and memories. Each keeps its version suffix between releases. */
const STATE_DATABASE_PREFIXES = ['state_', 'goals_', 'queue_', 'memories_']

/** Finds Codex' state SQLite databases directly under ~/.codex, each with its WAL/SHM
 *  sidecars folded into the footprint. */
function stateDatabases(home: string): { path: string; bytes: number }[] {
  return STATE_DATABASE_PREFIXES.flatMap((prefix) => databaseFiles(home, prefix))
}

/** `history*` files (e.g. `history.jsonl`) directly under ~/.codex: Codex' append-only
 *  prompt/command history, read at startup for recall. */
function historyFiles(home: string): string[] {
  try {
    return readdirSync(home).filter((name) => name.startsWith('history'))
  } catch {
    return []
  }
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

  // Leftovers lying directly in ~/.codex.
  for (const { pattern, note, keepNewest } of HOME_LEFTOVER_PATTERNS) {
    const matches = childrenOf(locations.home)
      .filter((name) => pattern.test(name))
      .map((name) => ({ name, path: join(locations.home, name) }))
      .sort((a, b) => modifiedAt(b.path) - modifiedAt(a.path))
    for (const match of keepNewest ? matches.slice(1) : matches) {
      staleTemporary.push(...stagedEntry(match.path, match.name, note))
    }
  }

  // The standalone installer sweeps these itself on its next run, so they are only ever
  // seen when an install died partway through.
  for (const name of childrenOf(locations.standaloneReleases)) {
    if (!name.startsWith('.staging.')) continue
    staleTemporary.push(...stagedEntry(join(locations.standaloneReleases, name), name, 'note.installLeftover'))
  }
  for (const name of childrenOf(locations.standalonePackages)) {
    if (!name.startsWith('.current.')) continue
    staleTemporary.push(...stagedEntry(join(locations.standalonePackages, name), name, 'note.installLeftover'))
  }

  categories.push(category('temporary', 'recommended', 'safe', staleTemporary))
  await yieldToEventLoop()

  const codexCacheEntries = locations.codexCaches
    .filter(entryExists)
    .map((path) => entry(relativeTo(locations.codexCache, path),
      CODEX_CACHE_NOTES[basename(path)] ?? 'note.codexOperationalCache', path,
      measure(path, 'stage.caches', 0.15), 'rebuildable', {
      requiresCodexStopped: true
    }))
  // These are safe to rebuild but useful for cold start and offline fallback, so expose
  // them for manual selection without preselecting or scheduling them.
  categories.push(category('codexCache', 'review', 'rebuildable', codexCacheEntries))
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
  const applicationLogs: StorageEntry[] = []
  if (entryExists(locations.appLogs)) {
    applicationLogs.push(entry(basename(locations.appLogs), 'note.applicationLog', locations.appLogs,
      measure(locations.appLogs, 'stage.caches', 0.18), 'shielded'))
  }
  // `~/.codex/log` is the Codex runtime's own rolling log directory. The runtime rotates
  // it, so it is counted alongside the desktop application's logs and never offered for
  // deletion — the same handling as `appLogs` above.
  const codexLogDir = join(locations.home, 'log')
  if (entryExists(codexLogDir)) {
    applicationLogs.push(entry('log', 'note.codexLog', codexLogDir,
      measure(codexLogDir, 'stage.caches', 0.18), 'shielded'))
  }
  // `logs_*.sqlite` are Codex' diagnostic log databases (SQLite, with WAL/SHM). They are
  // logs, so they are counted under 应用日志 rather than split into their own category.
  for (const db of logDatabases(locations.home)) {
    applicationLogs.push(entry(basename(db.path), 'note.logDatabase', db.path, db.bytes, 'shielded'))
  }
  categories.push(category('appLogs', 'protectedData', 'shielded', applicationLogs))
  await yieldToEventLoop()

  const stateDbEntries: StorageEntry[] = stateDatabases(locations.home).map((db) =>
    entry(basename(db.path), 'note.stateDatabase', db.path, db.bytes, 'shielded'))
  // `history*` (e.g. history.jsonl) is Codex' append-only prompt/command history: read at
  // startup for recall, so it is state rather than a rotated log. It is not SQLite, so it
  // has no WAL/SHM sidecar to fold in.
  for (const name of historyFiles(locations.home)) {
    const path = join(locations.home, name)
    stateDbEntries.push(entry(name, 'note.stateDatabase', path, fileAllocatedSize(path), 'shielded'))
  }
  categories.push(category('stateDatabase', 'protectedData', 'shielded', stateDbEntries))
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
  categories.push(category('pluginRuntime', 'protectedData', 'shielded', pluginRuntimeEntries))
  // The Codex executables that actually run these plugins. They are not plugins themselves
  // (no `.codex-plugin/plugin.json` under `.plugin-appserver`), so `scanPluginVersions`
  // never lists them and the Plugins page cannot show them. Enumerated here as their own
  // protected, non-deletable row so the runtime half of the old `pluginRuntime` total is
  // not silently lost when its plugin half jumps to the Plugins page.
  const runtimeBinaryEntries: StorageEntry[] = entryExists(locations.pluginRuntime)
    ? childrenOf(locations.pluginRuntime)
        .filter((name) => !name.startsWith('.'))
        .map((name) => {
          const path = join(locations.pluginRuntime, name)
          return entry(name, 'note.pluginRuntime', path,
            measure(path, 'stage.plugins', 0.36), 'shielded',
            { tags: [{ label: message('tag.runtime'), tone: 'info' }] })
        })
    : []
  categories.push(category('pluginRuntimeBinaries', 'protectedData', 'shielded', runtimeBinaryEntries))
  if (installedPlugins === null && pluginVersions.length) notes.push(message('scanNote.appServerUnavailable'))
  await yieldToEventLoop()

  // Codex releases the standalone installer left on disk. `current` names the live one;
  // without it nothing here is offered, only counted.
  const releasesInUse = guards.releasesInUse()
  const releases = scanStandaloneReleases(locations.standaloneReleases, releasesInUse)
  const supersededReleases = releasesInUse.length ? releases.filter((release) => !release.isCurrent) : []
  categories.push(category('releaseVersions', 'recommended', 'safe', supersededReleases.map((release) =>
    entry(release.name, 'note.releaseVersion', release.path, release.bytes, 'safe', {
      requiresCodexStopped: true,
      tags: [{ label: message('tag.outdated'), tone: 'neutral' }]
    }))))
  categories.push(category('releaseRuntime', 'protectedData', 'shielded',
    releases.filter((release) => !supersededReleases.includes(release)).map((release) =>
      entry(release.name, releasesInUse.length ? 'note.currentRelease' : 'note.unconfirmedRelease',
        release.path, release.bytes, 'shielded', {
          tags: [{
            label: message(releasesInUse.length ? 'tag.current' : 'tag.unconfirmed'),
            tone: releasesInUse.length ? 'info' : 'neutral'
          }]
        }))))
  await yieldToEventLoop()

  // --- Protected: shown for awareness, never selected ---

  const threadIndex = CodexThreadIndex.load(locations.home)
  const sessions = await scanSessions(locations,
    (path, fraction) => progress('stage.sessions', path, 0.43 + fraction * 0.49), signal, threadIndex)
  if (sessions.length && !sessions.some((session) => session.title)) notes.push(message('scanNote.noSessionTitles'))
  throwIfAborted(signal)

  // Worktree roots are found from the conversations themselves rather than from the
  // desktop setting: moving the root in Codex leaves the existing worktrees where they
  // were, so several can be live, and the setting would only ever name the newest. The
  // The setting is read too when it already contains a recognisable worktree, covering
  // roots whose conversations have since been deleted without trusting an empty or
  // unrelated path found through the desktop-state heuristic.
  const worktreeRoots = resolveWorktreeRoots(
    locations.worktreeRoots, threadIndex.locatedThreads, desktopWorktreeRoot(locations.home))
  const worktrees = scanWorktrees(worktreeRoots, threadIndex.locatedThreads, {
    budget: { value: GIT_INSPECTION_BUDGET },
    onProgress: (path, fraction) => progress('stage.worktrees', path, 0.92 + fraction * 0.02)
  })
  tagWorktreeSessions(sessions, worktrees)
  throwIfAborted(signal)
  const generatedAssets = scanGeneratedAssets(locations, sessions, (path, fraction) => progress('stage.assets', path, 0.94 + fraction * 0.03))
  const sessionDatabases = databaseFiles(locations.home, 'thread_history_').map((db) =>
    entry(basename(db.path), 'note.sessionProjection', db.path, db.bytes, 'shielded'))
  categories.push(category('sessionDatabase', 'protectedData', 'shielded', sessionDatabases))
  categories.push(...componentCategories(locations, (path) => measure(path, 'stage.assets', 0.97)))

  const marketplaceSources = new Set(guards.localMarketplaceSources)
  const protectedConfigEntries: StorageEntry[] = []
  const pluginDataEntries: StorageEntry[] = []
  for (const path of guards.protectedURLs) {
    // These containers are represented by dedicated scan results. In particular,
    // plugins/cache is an installation store containing active plugin versions, not a
    // disposable cache; listing the whole tree would duplicate every version below it.
    if (path === locations.codexCache || path === locations.generatedImages || path === join(locations.plugins, 'cache')) continue
    // `~/.codex/log` is shown under 应用日志 (appLogs) above, so do not duplicate it here.
    if (path === join(locations.home, 'log')) continue
    if ((!ProtectedPaths.contains(locations.home, path) && !marketplaceSources.has(path)) || !entryExists(path)) continue
    const relativePath = relativeToHome(path, locations.home)
    const note = marketplaceSources.has(path) ? 'note.localMarketplace'
      : path === join(locations.plugins, 'data') ? 'note.pluginData'
        : path === join(locations.plugins, 'known_marketplaces.json') ? 'note.knownMarketplaces'
          : 'note.configOrCredentials'
    const protectedEntry = entry(
      // Nested protected entries (plugins/data, …) need their path to stay unambiguous.
      marketplaceSources.has(path) || basename(path) !== relativeToHome(path, locations.home)
        ? relativePath
        : basename(path),
      note,
      path,
      pathAllocatedSize(path),
      'shielded'
    )
    const pluginsRoot = join(locations.home, 'plugins')
    if (ProtectedPaths.contains(pluginsRoot, path) || marketplaceSources.has(path)) pluginDataEntries.push(protectedEntry)
    else protectedConfigEntries.push(protectedEntry)
  }
  categories.push(category('pluginData', 'protectedData', 'shielded', pluginDataEntries))
  categories.push(category('protectedConfig', 'protectedData', 'shielded', protectedConfigEntries))

  const protectedUserEntries = ProtectedPaths.protectedAppSupportEntries.flatMap((relative): StorageEntry[] => {
    const path = join(locations.appSupport, relative)
    return entryExists(path) ? [entry(relative, 'note.browserProfile', path, pathAllocatedSize(path), 'shielded')] : []
  })
  categories.push(category('protectedUserData', 'protectedData', 'shielded', protectedUserEntries))

  categories.push(category('unrecognized', 'protectedData', 'shielded',
    unrecognizedEntries(locations, guards, staleTemporary, worktreeRoots)))

  // A configured worktree root may be a mixed user directory. Only recognised worktree
  // entries belong to Codex's footprint; measuring the whole root would silently charge
  // unrelated projects to the overview's "Other" slice.
  const externalRoots = outermostStorageRoots([
    locations.appSupport, ...locations.readOnlyAppSupport, ...locations.appCacheContainers, locations.appLogs
  ].filter(entryExists))
  const externalWorktreeBytes = worktrees
    .filter((worktree) => !ProtectedPaths.contains(locations.home, worktree.path))
    // A worktree inside an already-counted platform root is already in the denominator.
    .filter((worktree) => !externalRoots.some((root) => ProtectedPaths.contains(root, worktree.path)))
    .reduce((sum, worktree) => sum + worktree.bytes, 0)
  const externalBytes = externalRoots.reduce((sum, path) => sum + directoryAllocatedSize(path), 0) + externalWorktreeBytes
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
    generatedAssets,
    pluginVersions,
    worktrees,
    workspace: { root: locations.workspace, isScanned: false, entries: [] },
    notes
  }
}

function modifiedAt(path: string): number {
  try { return statSync(path).mtimeMs } catch { return 0 }
}

/**
 * Marks the conversations that ran inside a worktree. They stay in the session list and
 * keep counting their own rollout bytes; the tag only says where the work happened, so a
 * reader can tell why a checkout of theirs is sitting under CODEX_HOME.
 */
function tagWorktreeSessions(sessions: SessionItem[], worktrees: WorktreeItem[]): void {
  if (!worktrees.length) return
  for (const session of sessions) {
    if (!session.workingDirectory) continue
    const cwd = normalize(session.workingDirectory)
    if (!worktrees.some((worktree) => ProtectedPaths.contains(worktree.path, cwd))) continue
    if (!session.tags.includes('worktree')) session.tags.push('worktree')
  }
}

/**
 * Everything in the two data directories that no category above claimed and no protection
 * rule names. Counted and shown, never selectable: this exists so a directory a future
 * Codex release adds is visible as itself rather than swallowed by the overview's
 * remainder, and so the next gap is found by the app rather than by hand.
 */
function unrecognizedEntries(
  locations: CodexLocations,
  guards: ProtectedPaths,
  staleTemporary: StorageEntry[],
  worktreeRoots: string[]
): StorageEntry[] {
  const claimedTemporary = new Set(staleTemporary.map((item) => normalize(item.url)))
  const entries: StorageEntry[] = []

  const collect = (root: string, claimedNames: string[]): void => {
    const claimed = new Set(claimedNames)
    let names: string[] = []
    try { names = readdirSync(root) } catch { return }
    for (const name of names) {
      const path = join(root, name)
      if (claimed.has(name)) continue
      // What the desktop environment writes behind the user's back is not a gap in this
      // app's knowledge of Codex, and listing it would only be noise.
      if (isSystemJunk(name)) continue
      if (claimedTemporary.has(normalize(path))) continue
      if (HOME_LEFTOVER_PATTERNS.some(({ pattern }) => pattern.test(name))) continue
      if (worktreeRoots.some((worktreeRoot) => ProtectedPaths.contains(worktreeRoot, path))) continue
      if (guards.isProtected(path)) continue
      if (ProtectedPaths.protectedHomePrefixes.some((prefix) => name.startsWith(prefix))) continue
      entries.push(entry(name, null, path, pathAllocatedSize(path), 'shielded'))
    }
  }

  collect(locations.home, [
    ...ProtectedPaths.protectedHomeEntries.map((relativePath) => relativePath.split('/')[0]),
    ...SCANNED_HOME_ENTRIES
  ])
  collect(locations.appSupport, [
    ...ProtectedPaths.protectedAppSupportEntries.map((relativePath) => relativePath.split('/')[0]),
    ...appCacheDirectories('').map((relativePath) => basename(relativePath)),
    ...SCANNED_APP_SUPPORT_ENTRIES
  ])
  return entries
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

function componentCategories(
  locations: CodexLocations,
  measure: (path: string) => number
): StorageCategory[] {
  const computerUse = entryExists(locations.computerUse)
    ? [entry('computer-use', 'note.computerUseComponent', locations.computerUse, measure(locations.computerUse), 'shielded', {
        requiresCodexStopped: true
      })]
    : []
  return [
    category('computerUse', 'protectedData', 'shielded', computerUse)
  ]
}
