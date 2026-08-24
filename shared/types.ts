/**
 * Shared domain types for CleanMyCodex — used by the main process (scanner, cleanup
 * engine) and the renderer (over IPC). Pure data: no Electron or Node APIs here.
 *
 * Nothing in this file carries display text. Anything the user reads is a `Message`
 * from `./messages`, which the renderer resolves in the language they picked.
 */

import type { Message } from './messages'

export type StorageGroup = 'recommended' | 'review' | 'protectedData'

export type CleanupRisk = 'safe' | 'rebuildable' | 'caution' | 'shielded'

export const isSelectable = (risk: CleanupRisk): boolean => risk !== 'shielded'

export type StorageKind =
  | 'logDatabase'
  | 'sessionDatabase'
  | 'temporary'
  | 'pluginRemnants'
  | 'pluginOrphans'
  | 'pluginRuntime'
  | 'pluginData'
  | 'releaseVersions'
  | 'releaseRuntime'
  | 'codexCache'
  | 'appCache'
  | 'appLogs'
  | 'computerUse'
  | 'protectedConfig'
  | 'protectedUserData'
  | 'unrecognized'

/** Content type the category belongs to; drives how the overview groups rows. */
export type StorageSection = 'caches' | 'logs' | 'plugins' | 'protectedData'

export const StorageSectionOrder: StorageSection[] = ['caches', 'logs', 'plugins', 'protectedData']

export const StorageKindSection: Record<StorageKind, StorageSection> = {
  logDatabase: 'logs',
  sessionDatabase: 'logs',
  temporary: 'caches',
  pluginRemnants: 'plugins',
  pluginOrphans: 'plugins',
  pluginRuntime: 'plugins',
  pluginData: 'plugins',
  releaseVersions: 'plugins',
  releaseRuntime: 'plugins',
  codexCache: 'caches',
  appCache: 'protectedData',
  appLogs: 'logs',
  computerUse: 'plugins',
  protectedConfig: 'protectedData',
  protectedUserData: 'protectedData',
  unrecognized: 'protectedData'
}

/** Small status chip on a storage entry; states a fact the title cannot carry. */
export interface StorageEntryTag {
  label: Message
  tone: 'neutral' | 'info' | 'caution'
}

export interface StorageEntry {
  id: string
  /** A file or directory name, so it is shown as-is in both languages. */
  title: string
  /** Why this entry exists, in the reader's language. */
  note: Message | null
  tags: StorageEntryTag[]
  url: string
  bytes: number
  /** Space expected to be returned to the volume by the selected cleanup. */
  reclaimableBytes: number
  /** When set, the target must still have been untouched this long at deletion time. */
  minimumIdleSeconds: number | null
  /** Codex scratch space: only safe to touch once Codex is not running. */
  requiresCodexStopped: boolean
  risk: CleanupRisk
}

/** Title and detail are looked up from `kind`, so the two languages cannot drift. */
export interface StorageCategory {
  kind: StorageKind
  group: StorageGroup
  risk: CleanupRisk
  entries: StorageEntry[]
}

export const categoryBytes = (c: StorageCategory): number =>
  c.entries.reduce((sum, e) => sum + e.bytes, 0)

export const categoryReclaimable = (c: StorageCategory): number =>
  c.entries.reduce((sum, e) => sum + e.reclaimableBytes, 0)

export const categoryIsEmpty = (c: StorageCategory): boolean => c.entries.length === 0

export const categorySection = (c: StorageCategory): StorageSection => StorageKindSection[c.kind]

export type SessionLocation = 'active' | 'archived'

export type SessionTag = 'browser' | 'computerUse' | 'imageGen' | 'worktree'

/** Codex' own feature names; identical in both languages. */
export const SessionTagLabel: Record<SessionTag, string> = {
  browser: 'Browser',
  computerUse: 'Computer Use',
  imageGen: 'ImageGen',
  worktree: 'Worktree'
}

export interface SessionItem {
  id: string
  threadID: string
  fileURL: string
  /** Additional rollout segments that belong to the same thread. */
  segmentURLs: string[]
  location: SessionLocation
  modifiedAt: number // epoch ms
  fileBytes: number
  /** Generated-image and Visualization directories owned by this thread. */
  assetBytes: number
  assetURLs: string[]
  workingDirectory: string | null
  title: string | null
  /** First user message, so a thread without a title is still recognisable. */
  preview: string | null
  tags: SessionTag[]
  isCompressed: boolean
  isUnstable: boolean
  parseWarnings: number
  /** Pinned, queued, or unfinished-goal conversations are never removed automatically. */
  blocksAutomaticCleanup: boolean
  /** Pinned in the desktop. Shown in the list; manual deletion still goes ahead. */
  isPinned: boolean
  /** Subagent rollouts are spawned by a parent thread; hidden from the session list and rolled into the parent. */
  isSubagent: boolean
  /** The parent thread a subagent was spawned from; null for user conversations. */
  parentThreadID: string | null
  /** Number of subagent rollouts grouped under this parent (0 for subagents and parentless threads). */
  childThreadCount: number
  /** Allocated bytes of grouped subagent rollouts + their assets, so the parent's total reflects the whole conversation. */
  childBytes: number
  /** Subagent rollout files + their asset dirs, deleted alongside the parent rollout. */
  childURLs: string[]
}

export const sessionTotalBytes = (s: SessionItem): number => s.fileBytes + s.assetBytes + s.childBytes

/**
 * The conservative preset offered only when the user asks the overview to help choose
 * conversations. It is never used to start a cleanup by itself.
 */
export const SUGGESTED_ARCHIVED_SESSION_AGE_DAYS = 60

export const sessionMatchesSuggestedArchivePreset = (s: SessionItem, now = Date.now()): boolean =>
  s.location === 'archived' &&
  now - s.modifiedAt >= SUGGESTED_ARCHIVED_SESSION_AGE_DAYS * 86_400_000 &&
  !s.isPinned &&
  !s.blocksAutomaticCleanup &&
  !s.isUnstable

export const sessionProjectName = (s: SessionItem): string | null => {
  if (!s.workingDirectory || s.workingDirectory.length === 0) return null
  const parts = s.workingDirectory.split(/[/\\]/).filter(Boolean)
  const name = parts[parts.length - 1] ?? ''
  return name.length ? name : null
}

export const sessionDisplayName = (s: SessionItem): string => {
  if (s.title && s.title.length) return s.title
  if (s.preview && s.preview.length) return s.preview
  const project = sessionProjectName(s)
  if (project) return project
  return s.threadID.slice(0, 12)
}

export type GeneratedAssetKind = 'imageGen' | 'visualization'

/** A thread-scoped asset directory. The directory is the smallest safe deletion unit:
 *  Visualization viewers contain several cooperating files and must stay together. */
export interface GeneratedAssetItem {
  id: string
  kind: GeneratedAssetKind
  /** Primary directory opened from the UI and removed first. */
  path: string
  /** Cooperating directories removed with the primary one, such as a rendered Viewer. */
  companionPaths: string[]
  bytes: number
  fileCount: number
  /** Lowercase extensions found below the asset directory, without leading dots. */
  formats: string[]
  modifiedAt: number
  /** Parsed from the directory name even when the source conversation is gone. */
  sourceThreadID: string | null
  /** The matching rollout row, or null for an orphaned asset directory. */
  sourceSessionID: string | null
}

export const generatedAssetBytes = (assets: GeneratedAssetItem[]): number =>
  assets.reduce((sum, asset) => sum + asset.bytes, 0)

/** The title shared by the generated-assets table and every cleanup surface. */
export const generatedAssetDisplayName = (asset: GeneratedAssetItem, session?: SessionItem): string =>
  session ? sessionDisplayName(session) :
    asset.sourceThreadID ?? asset.path.split(/[/\\]/).filter(Boolean).at(-1) ?? asset.path

export type PluginStatus = 'builtin' | 'current' | 'outdated' | 'orphaned' | 'unconfirmed'

export const pluginStatusIsRemovable = (status: PluginStatus): boolean =>
  status === 'outdated' || status === 'orphaned'

export const pluginVersionCanUninstall = (plugin: PluginVersionItem): boolean =>
  plugin.status === 'current' && plugin.marketplace !== null

export interface PluginVersionItem {
  /** Marketplace directory name, or null when the plugin sits outside one. */
  marketplace: string | null
  plugin: string
  version: string
  directoryURL: string
  bytes: number
  environmentBytes: number
  modifiedAt: number // epoch ms
  status: PluginStatus
}

/** `unchecked` means the scan's git-inspection budget ran out, not that git failed. */
export type WorkspaceRepositoryState = 'clean' | 'dirty' | 'unpushed' | 'unknown' | 'unchecked'

export const repositoryStateIsSafe = (state: WorkspaceRepositoryState): boolean => state === 'clean'

export interface WorkspaceRepository {
  id: string
  path: string
  name: string
  state: WorkspaceRepositoryState
}

export interface WorkspaceThreadReference {
  id: string
  title: string
  archived: boolean
  isSubagent: boolean
  modifiedAt: number
}

export interface WorkspaceFolder {
  id: string
  path: string
  name: string
  /** What this row's own deletion removes, and nothing else: everything below a session
   *  output, or only the loose files of a date folder that is listed beside its outputs.
   *  Children carry their own bytes, so a total has to add them up. */
  bytes: number
  fileCount: number
  modifiedAt: number
  repositories: WorkspaceRepository[]
  /** Threads whose SQLite cwd points at exactly this output directory or below it —
   *  never inherited from a child, so a date folder is not labelled with a child's thread. */
  sourceThreads: WorkspaceThreadReference[]
  /** Files sitting directly in this folder rather than inside one of its outputs. Only
   *  consulted for a folder that has children, whose row stands for these files alone. */
  looseFiles: string[]
  children: WorkspaceFolder[]
}

export interface WorkspaceSnapshot {
  root: string
  isScanned: boolean
  entries: WorkspaceFolder[]
}

/**
 * The paths a row's checkbox actually removes. A date folder that also holds outputs
 * gives up only the files lying loose in it, so ticking it never takes the outputs
 * listed beside it; everything else is removed whole, directory and all.
 */
export const workspaceDeletionTargets = (entry: WorkspaceFolder): string[] =>
  entry.children.length ? entry.looseFiles : [entry.path]

/** Only this row's own repositories: a date row deletes loose files, never a repository
 *  in an output below it. */
export const workspaceFolderIsUnsafe = (entry: WorkspaceFolder): boolean =>
  entry.repositories.some((repository) => !repositoryStateIsSafe(repository.state))

/** The title shared by the workspace table and every cleanup surface. */
export const workspaceDisplayName = (entry: WorkspaceFolder): string => {
  if (!entry.sourceThreads.length) return entry.name
  const main = entry.sourceThreads.filter((thread) => !thread.isSubagent)
  return (main.length ? main : entry.sourceThreads)[0].title
}

const workspaceFolderTotalBytes = (entry: WorkspaceFolder): number =>
  entry.bytes + entry.children.reduce((sum, child) => sum + workspaceFolderTotalBytes(child), 0)

export const workspaceBytes = (snapshot: WorkspaceSnapshot): number =>
  snapshot.entries.reduce((sum, entry) => sum + workspaceFolderTotalBytes(entry), 0)

/**
 * `managed` means Codex created and owns this worktree: its git admin directory carries
 * the marker file Codex writes there. `unmanaged` is a linked worktree sitting in the
 * same place without that marker — someone else's, so it is counted and shown but never
 * offered for deletion.
 */
export type WorktreeStatus = 'managed' | 'unmanaged'

export interface WorktreeItem {
  /** `<root>/<id>`: the directory a deletion removes, and the stable selection id. */
  id: string
  path: string
  /** The checkout itself, one level below `path`. */
  projectPath: string
  /** Directory name of the checkout, which is the repository's own name. */
  project: string
  /** Repository this worktree is linked to, or null when the link no longer resolves. */
  repositoryPath: string | null
  status: WorktreeStatus
  state: WorkspaceRepositoryState
  /** True when the `.git` pointer no longer resolves to a repository. */
  isOrphaned: boolean
  bytes: number
  /** Part of `bytes` that is dependency and build output rather than source. */
  artifactBytes: number
  modifiedAt: number
  /** Conversations that ran in here. References only: they carry no bytes of their own. */
  sourceThreads: WorkspaceThreadReference[]
}

export const worktreeIsRemovable = (worktree: WorktreeItem): boolean =>
  worktree.status === 'managed'

export const worktreeIsUnsafe = (worktree: WorktreeItem): boolean =>
  !repositoryStateIsSafe(worktree.state)

/** The title shared by the worktree table and every cleanup surface. */
export const worktreeDisplayName = (worktree: WorktreeItem): string => {
  const main = worktree.sourceThreads.filter((thread) => !thread.isSubagent)
  const thread = (main.length ? main : worktree.sourceThreads)[0]
  return thread ? thread.title : worktree.project
}

export const worktreeBytes = (worktrees: WorktreeItem[]): number =>
  worktrees.reduce((sum, worktree) => sum + worktree.bytes, 0)

export interface ScanProgress {
  stage: Message | null
  currentPath: string
  fraction: number
}

export interface ScanSnapshot {
  codexHome: string
  /** False when Codex has never run on this machine, or keeps its home somewhere else. */
  codexHomeExists: boolean
  scannedAt: number // epoch ms
  totalCodexBytes: number
  externalBytes: number
  categories: StorageCategory[]
  sessions: SessionItem[]
  generatedAssets: GeneratedAssetItem[]
  workspace: WorkspaceSnapshot
  worktrees: WorktreeItem[]
  pluginVersions: PluginVersionItem[]
  notes: Message[]
}

/** Nothing of Codex' was found anywhere the scan looks: no files, no sessions, no output. */
export const snapshotFoundNothing = (s: ScanSnapshot): boolean =>
  s.totalCodexBytes === 0 && s.categories.length === 0 && s.sessions.length === 0 &&
  s.pluginVersions.length === 0 && s.generatedAssets.length === 0 && s.workspace.entries.length === 0 &&
  (s.worktrees ?? []).length === 0

/** Sessions shown as top-level rows: subagents whose parent is present are rolled into the parent, so exclude them to avoid double-counting rows and bytes. */
export const listableSessions = (s: ScanSnapshot): SessionItem[] => {
  const presentThreadIDs = new Set(s.sessions.map((x) => x.threadID))
  return s.sessions.filter((x) => !(x.isSubagent && x.parentThreadID && presentThreadIDs.has(x.parentThreadID)))
}

export const snapshotSessionBytes = (s: ScanSnapshot): number => {
  const sessionIDs = new Set(s.sessions.map((session) => session.id))
  const linkedAssetBytes = generatedAssetBytes((s.generatedAssets ?? [])
    .filter((asset) => asset.sourceSessionID !== null && sessionIDs.has(asset.sourceSessionID)))
  return Math.max(0, listableSessions(s).reduce((sum, x) => sum + sessionTotalBytes(x), 0) - linkedAssetBytes) +
    s.categories.filter((category) => category.kind === 'sessionDatabase').reduce((sum, category) => sum + categoryBytes(category), 0)
}

export const snapshotGeneratedAssetBytes = (s: ScanSnapshot): number =>
  generatedAssetBytes(s.generatedAssets ?? [])

export const snapshotWorktreeBytes = (s: ScanSnapshot): number =>
  worktreeBytes(s.worktrees ?? [])

export const snapshotPluginBytes = (s: ScanSnapshot): number =>
  s.pluginVersions.reduce((sum, plugin) => sum + plugin.bytes, 0)

export interface CleanupTask {
  id: string
  /** A file, folder, or session name — shown as-is. */
  title: string
  /** The absolute path, shown under the title. */
  detail: string
  url: string
  expectedBytes: number
  /** Thread identity retained for direct session-database cleanup. */
  threadID: string | null
  /** Extra files removed with the primary target. */
  companionURLs: string[]
  minimumIdleSeconds: number | null
  requiresCodexStopped: boolean
  /**
   * How the target is removed. A git worktree cannot be deleted as a directory: its
   * administrative data lives inside the user's own repository, outside every root this
   * app may write to, so git has to take it down and clean up after itself.
   */
  removal?: 'filesystem' | 'gitWorktree' | 'codexPlugin'
  /** The repository `git worktree remove` is run from. Only set for `gitWorktree`. */
  repositoryPath?: string | null
  /** Trusted identity passed to `codex plugin remove`; never supplied by the renderer. */
  pluginName?: string
  pluginMarketplace?: string
}

/**
 * Renderer-to-main cleanup protocol. The renderer may select objects that came from the
 * latest snapshot, but it never supplies a filesystem path or safety flag. The main
 * process resolves these stable IDs back to trusted domain objects.
 */
export type CleanupSelection =
  | { kind: 'storage'; ids: string[] }
  | { kind: 'sessions-delete'; ids: string[] }
  | { kind: 'generated-assets'; ids: string[] }
  | { kind: 'plugins'; ids: string[] }
  | { kind: 'workspace'; ids: string[] }
  | { kind: 'worktrees'; ids: string[]; deleteRelatedSessions: boolean }

export interface CleanupRequest {
  selection: CleanupSelection
  quitCodex: boolean
  forceQuitCodex: boolean
}

export interface CleanupPreviewItem {
  id: string
  title: string
  detail: string
  expectedBytes: number
}

export interface CleanupPreview {
  selection: CleanupSelection
  items: CleanupPreviewItem[]
  expectedBytes: number
  blockedTitles: string[]
  codexRunning: boolean
  canQuitCodex: boolean
  /** Why Codex counts as running; empty when it is not. */
  blockers: Message[]
  warnings: Message[]
}

/** Build cleanup tasks from the storage entries selected in the overview. */
export function tasksFromEntries(entries: StorageEntry[]): CleanupTask[] {
  return entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    detail: entry.url,
    url: entry.url,
    expectedBytes: entry.reclaimableBytes,
    threadID: null,
    companionURLs: [],
    minimumIdleSeconds: entry.minimumIdleSeconds,
    requiresCodexStopped: entry.requiresCodexStopped
  }))
}

/** Build delete-thread tasks from the sessions selected in the sessions list. */
export function tasksForSessionDeletion(sessions: SessionItem[]): CleanupTask[] {
  const selectedParents = new Set(sessions.filter((s) => !s.isSubagent).map((s) => s.threadID))
  return sessions.filter((s) => !(s.isSubagent && s.parentThreadID && selectedParents.has(s.parentThreadID))).map((s) => ({
    id: s.id,
    title: sessionDisplayName(s),
    detail: s.fileURL,
    url: s.fileURL,
    expectedBytes: sessionTotalBytes(s),
    threadID: s.threadID,
    companionURLs: [...s.segmentURLs, ...s.assetURLs, ...s.childURLs],
    minimumIdleSeconds: null,
    requiresCodexStopped: true
  }))
}

export function tasksForGeneratedAssets(assets: GeneratedAssetItem[], sessions: SessionItem[]): CleanupTask[] {
  const sessionsByID = new Map(sessions.map((session) => [session.id, session]))
  return assets.map((asset) => ({
    id: asset.id,
    title: generatedAssetDisplayName(asset, asset.sourceSessionID ? sessionsByID.get(asset.sourceSessionID) : undefined),
    detail: asset.path,
    url: asset.path,
    expectedBytes: asset.bytes,
    threadID: null,
    companionURLs: asset.companionPaths,
    minimumIdleSeconds: null,
    requiresCodexStopped: true
  }))
}

export function tasksForWorkspace(entries: WorkspaceFolder[]): CleanupTask[] {
  return entries
    .map((entry) => ({ entry, targets: workspaceDeletionTargets(entry) }))
    .filter((item) => item.targets.length > 0)
    .map(({ entry, targets }) => ({
      id: `workspace:${entry.id}`,
      title: workspaceDisplayName(entry),
      detail: entry.path,
      url: targets[0],
      expectedBytes: entry.bytes,
      threadID: null,
      companionURLs: targets.slice(1),
      minimumIdleSeconds: null,
      requiresCodexStopped: false
    }))
}

/**
 * Worktree deletions never carry companions: the git administrative directory belongs to
 * the user's repository and is taken down by `git worktree remove`, not by this app.
 */
export function tasksForWorktrees(worktrees: WorktreeItem[]): CleanupTask[] {
  return worktrees.filter(worktreeIsRemovable).map((worktree) => ({
    id: `worktree:${worktree.id}`,
    title: worktreeDisplayName(worktree) === worktree.project
      ? worktree.project
      : `${worktree.project} · ${worktreeDisplayName(worktree)}`,
    detail: worktree.path,
    url: worktree.path,
    expectedBytes: worktree.bytes,
    threadID: null,
    companionURLs: [],
    minimumIdleSeconds: null,
    requiresCodexStopped: true,
    removal: 'gitWorktree' as const,
    repositoryPath: worktree.repositoryPath
  }))
}

export type CleanupStatus =
  | { kind: 'succeeded' }
  | { kind: 'skipped'; reason: Message }
  | { kind: 'failed'; reason: Message }

export const cleanupStatusReason = (s: CleanupStatus): Message | null =>
  s.kind === 'succeeded' ? null : s.reason

export interface CleanupOutcome {
  id: string
  title: string
  detail: string
  status: CleanupStatus
  freedBytes: number
}

export interface CleanupReport {
  startedAt: number
  finishedAt: number
  outcomes: CleanupOutcome[]
}

export const reportFreedBytes = (r: CleanupReport): number =>
  r.outcomes.reduce((sum, o) => sum + o.freedBytes, 0)

export interface CleanupProgress {
  completed: number
  total: number
  currentTitle: string
}

/** Binary units, matching how macOS reports Codex' own directories. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  const digits = index === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[index]}`
}

export interface AppInfo {
  version: string
  platform: string
  appServerAvailable: boolean
  codexBinaryAvailable: boolean
  codexRunning: boolean
  /** Why Codex counts as running; empty when it is not. */
  blockers: Message[]
}

export interface AutomationSettings {
  enabled: boolean
  intervalDays: number
  cleanCaches: boolean
  cleanOldPlugins: boolean
  cleanArchivedSessions: boolean
  archivedRetentionDays: number
  cleanActiveSessions: boolean
  activeRetentionDays: number
  skipRecentSessions: boolean
  notifyWhenFinished: boolean
  launchAtLogin: boolean
}

export interface AutomaticRunRecord {
  finishedAt: number
  freedBytes: number
  succeeded: number
  failed: number
  deferred: number
  /** Why the run did nothing, or why the first item was skipped. */
  note: Message | null
}

export interface AutomationState {
  settings: AutomationSettings
  installed: boolean
  loaded: boolean
  nextRunAt: number | null
  lastRun: AutomaticRunRecord | null
  supported: boolean
}
