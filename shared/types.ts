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
  | 'marketplaceCache'
  | 'pluginRemnants'
  | 'pluginRuntime'
  | 'browserCache'
  | 'appCache'
  | 'appLogs'
  | 'computerUse'
  | 'protectedConfig'
  | 'protectedUserData'

/** Content type the category belongs to; drives how the overview groups rows. */
export type StorageSection = 'caches' | 'logs' | 'plugins' | 'assets' | 'protectedData'

export const StorageSectionOrder: StorageSection[] = ['caches', 'logs', 'plugins', 'assets', 'protectedData']

export const StorageKindSection: Record<StorageKind, StorageSection> = {
  logDatabase: 'logs',
  sessionDatabase: 'assets',
  temporary: 'caches',
  marketplaceCache: 'caches',
  pluginRemnants: 'plugins',
  pluginRuntime: 'plugins',
  browserCache: 'caches',
  appCache: 'caches',
  appLogs: 'logs',
  computerUse: 'plugins',
  protectedConfig: 'protectedData',
  protectedUserData: 'protectedData'
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

export type SessionTag = 'browser' | 'computerUse'

/** Codex' own feature names; identical in both languages. */
export const SessionTagLabel: Record<SessionTag, string> = {
  browser: 'Browser',
  computerUse: 'Computer Use'
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

export type PluginStatus = 'current' | 'outdated' | 'orphaned' | 'unconfirmed'

export const pluginStatusIsRemovable = (status: PluginStatus): boolean =>
  status === 'outdated' || status === 'orphaned'

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
  bytes: number
  fileCount: number
  modifiedAt: number
  repositories: WorkspaceRepository[]
  /** Threads whose SQLite cwd points at exactly this output directory or below it —
   *  never inherited from a child, so a date folder is not labelled with a child's thread. */
  sourceThreads: WorkspaceThreadReference[]
  children: WorkspaceFolder[]
}

export interface WorkspaceSnapshot {
  root: string
  isScanned: boolean
  entries: WorkspaceFolder[]
}

export const workspaceFolderFileCount = (entry: WorkspaceFolder): number =>
  entry.fileCount + entry.children.reduce((sum, child) => sum + workspaceFolderFileCount(child), 0)

export const workspaceFolderIsUnsafe = (entry: WorkspaceFolder): boolean =>
  entry.repositories.some((repository) => !repositoryStateIsSafe(repository.state)) ||
  entry.children.some(workspaceFolderIsUnsafe)

export const workspaceBytes = (snapshot: WorkspaceSnapshot): number =>
  snapshot.entries.reduce((sum, entry) => sum + entry.bytes, 0)

export interface ScanProgress {
  stage: Message | null
  currentPath: string
  fraction: number
}

export interface ScanSnapshot {
  codexHome: string
  scannedAt: number // epoch ms
  totalCodexBytes: number
  externalBytes: number
  categories: StorageCategory[]
  sessions: SessionItem[]
  workspace: WorkspaceSnapshot
  pluginVersions: PluginVersionItem[]
  notes: Message[]
}

/** Sessions shown as top-level rows: subagents whose parent is present are rolled into the parent, so exclude them to avoid double-counting rows and bytes. */
export const listableSessions = (s: ScanSnapshot): SessionItem[] => {
  const presentThreadIDs = new Set(s.sessions.map((x) => x.threadID))
  return s.sessions.filter((x) => !(x.isSubagent && x.parentThreadID && presentThreadIDs.has(x.parentThreadID)))
}

export const snapshotSessionBytes = (s: ScanSnapshot): number =>
  listableSessions(s).reduce((sum, x) => sum + sessionTotalBytes(x), 0) +
  s.categories.filter((category) => category.kind === 'sessionDatabase').reduce((sum, category) => sum + categoryBytes(category), 0)

export const snapshotPluginBytes = (s: ScanSnapshot): number =>
  s.categories.filter((category) => category.kind === 'pluginRemnants' || category.kind === 'pluginRuntime')
    .reduce((sum, category) => sum + categoryBytes(category), 0)

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
}

/**
 * Renderer-to-main cleanup protocol. The renderer may select objects that came from the
 * latest snapshot, but it never supplies a filesystem path or safety flag. The main
 * process resolves these stable IDs back to trusted domain objects.
 */
export type CleanupSelection =
  | { kind: 'storage'; ids: string[] }
  | { kind: 'sessions-delete'; ids: string[] }
  | { kind: 'plugins'; ids: string[] }
  | { kind: 'workspace'; ids: string[] }

export interface CleanupRequest {
  selection: CleanupSelection
  restartCodex: boolean
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
  canRestartCodex: boolean
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

export function tasksForWorkspace(entries: WorkspaceFolder[]): CleanupTask[] {
  return entries.map((entry) => ({
    id: `workspace:${entry.id}`,
    title: entry.name,
    detail: entry.path,
    url: entry.path,
    expectedBytes: entry.bytes,
    threadID: null,
    companionURLs: [],
    minimumIdleSeconds: null,
    requiresCodexStopped: false
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
