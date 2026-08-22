/**
 * Shared domain types for CleanMyCodex — used by the main process (scanner, cleanup
 * engine) and the renderer (over IPC). Pure data: no Electron or Node APIs here.
 */

export type StorageGroup = 'recommended' | 'review' | 'protectedData'

/** Shown on the right of a category row: how the app rates cleaning it. */
export const StorageAdviceLabel: Record<StorageGroup, string> = {
  recommended: '建议清理',
  review: '谨慎清理',
  protectedData: '受保护'
}

export type CleanupRisk = 'lossless' | 'safe' | 'rebuildable' | 'caution' | 'shielded'

export const CleanupRiskLabel: Record<CleanupRisk, string> = {
  lossless: '无损',
  safe: '安全',
  rebuildable: '可重建',
  caution: '谨慎清理',
  shielded: '受保护'
}

export const isSelectable = (risk: CleanupRisk): boolean => risk !== 'shielded'

export type CleanupMethod = 'trash' | 'compactDatabase' | 'deleteThread' | 'slimSession'

export const CleanupMethodLabel: Record<CleanupMethod, string> = {
  trash: '移到废纸篓',
  compactDatabase: '压缩数据库',
  deleteThread: '删除会话',
  slimSession: '会话瘦身'
}

export type StorageKind =
  | 'logDatabase'
  | 'temporary'
  | 'marketplaceCache'
  | 'pluginRemnants'
  | 'browserCache'
  | 'appCache'
  | 'appLogs'
  | 'generatedImages'
  | 'computerUse'
  | 'activeSessions'
  | 'archivedSessions'
  | 'protectedConfig'
  | 'protectedUserData'

/** SF Symbol name on macOS; the renderer maps these to an icon set per platform. */
export const StorageKindSymbol: Record<StorageKind, string> = {
  logDatabase: 'cylinder.split.1x2',
  temporary: 'clock.arrow.circlepath',
  marketplaceCache: 'bag',
  pluginRemnants: 'puzzlepiece.extension',
  browserCache: 'safari',
  appCache: 'externaldrive',
  appLogs: 'doc.text',
  generatedImages: 'photo.on.rectangle',
  computerUse: 'display',
  activeSessions: 'bubble.left.and.bubble.right',
  archivedSessions: 'archivebox',
  protectedConfig: 'lock.shield',
  protectedUserData: 'folder.badge.person.crop'
}

/** Content type the category belongs to; drives how the overview groups rows. */
export type StorageSection = 'caches' | 'logs' | 'plugins' | 'assets' | 'protectedData'

export const StorageSectionLabel: Record<StorageSection, string> = {
  caches: '缓存与临时文件',
  logs: '日志与数据库',
  plugins: '插件与组件',
  assets: '会话资产',
  protectedData: '受保护的数据'
}

export const StorageSectionOrder: StorageSection[] = ['caches', 'logs', 'plugins', 'assets', 'protectedData']

export const StorageKindSection: Record<StorageKind, StorageSection> = {
  logDatabase: 'logs',
  temporary: 'caches',
  marketplaceCache: 'caches',
  pluginRemnants: 'plugins',
  browserCache: 'caches',
  appCache: 'caches',
  appLogs: 'logs',
  generatedImages: 'assets',
  computerUse: 'plugins',
  activeSessions: 'assets',
  archivedSessions: 'assets',
  protectedConfig: 'protectedData',
  protectedUserData: 'protectedData'
}

export interface StorageEntry {
  id: string
  title: string
  detail: string
  url: string
  bytes: number
  /** Space actually returned to the volume. Equals `bytes` except for database compaction. */
  reclaimableBytes: number
  /** When set, the target must still have been untouched this long at deletion time. */
  minimumIdleSeconds: number | null
  /** Codex scratch space: only safe to touch once Codex is not running. */
  requiresCodexStopped: boolean
  method: CleanupMethod
  risk: CleanupRisk
}

export interface StorageCategory {
  kind: StorageKind
  title: string
  detail: string
  group: StorageGroup
  risk: CleanupRisk
  entries: StorageEntry[]
}

export const categoryBytes = (c: StorageCategory): number =>
  c.entries.reduce((sum, e) => sum + e.bytes, 0)

export const categoryReclaimable = (c: StorageCategory): number =>
  c.entries.reduce((sum, e) => sum + e.reclaimableBytes, 0)

export const categoryIsEmpty = (c: StorageCategory): boolean => c.entries.length === 0

export const categoryIsSelectable = (c: StorageCategory): boolean =>
  isSelectable(c.risk) && c.entries.length > 0

export const categorySection = (c: StorageCategory): StorageSection => StorageKindSection[c.kind]

export const categoryAdvice = (c: StorageCategory): string => StorageAdviceLabel[c.group]

export type SessionLocation = 'active' | 'archived'

export const SessionLocationLabel: Record<SessionLocation, string> = {
  active: '未归档',
  archived: '已归档'
}

export type SessionTag = 'imageHeavy' | 'browser' | 'computerUse' | 'imageGen'

export const SessionTagLabel: Record<SessionTag, string> = {
  imageHeavy: '图片密集',
  browser: 'Browser',
  computerUse: 'Computer Use',
  imageGen: 'ImageGen'
}

export interface SessionItem {
  id: string
  threadID: string
  fileURL: string
  location: SessionLocation
  modifiedAt: number // epoch ms
  fileBytes: number
  assetBytes: number
  assetURLs: string[]
  embeddedImageBytes: number
  embeddedImageCount: number
  /** Occurrences that were pictures not seen earlier in the same file. */
  distinctImageCount: number
  /** Bytes held by repeat copies of a picture already stored earlier in the file. */
  duplicateImageBytes: number
  workingDirectory: string | null
  title: string | null
  /** First user message, so a thread without a title is still recognisable. */
  preview: string | null
  tags: SessionTag[]
  isCompressed: boolean
  isUnstable: boolean
  parseWarnings: number
}

export const sessionTotalBytes = (s: SessionItem): number => s.fileBytes + s.assetBytes

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

export const sessionHasTitle = (s: SessionItem): boolean =>
  (!!s.title && s.title.length > 0) || (!!s.preview && s.preview.length > 0)

export const sessionSlimmableBytes = (s: SessionItem): number => s.duplicateImageBytes
export const sessionStrippableBytes = (s: SessionItem): number => s.embeddedImageBytes
export const sessionHasDuplicateImages = (s: SessionItem): boolean => s.duplicateImageBytes > 0

export const sessionImageShare = (s: SessionItem): number => {
  if (s.fileBytes <= 0) return 0
  return Math.min(1, s.embeddedImageBytes / s.fileBytes)
}

export type PluginStatus = 'current' | 'outdated' | 'orphaned' | 'unconfirmed'

export const PluginStatusLabel: Record<PluginStatus, string> = {
  current: '当前版本',
  outdated: '旧版本',
  orphaned: '卸载残留',
  unconfirmed: '未确认'
}

export const pluginStatusIsRemovable = (status: PluginStatus): boolean =>
  status === 'outdated' || status === 'orphaned'

export interface PluginVersionItem {
  marketplace: string
  plugin: string
  version: string
  directoryURL: string
  bytes: number
  environmentBytes: number
  modifiedAt: number // epoch ms
  status: PluginStatus
}

export type WorkspaceRepositoryState = 'clean' | 'dirty' | 'unpushed' | 'unknown'

export const WorkspaceRepositoryStateLabel: Record<WorkspaceRepositoryState, string> = {
  clean: '已同步',
  dirty: '有未提交改动',
  unpushed: '有未推送提交',
  unknown: '状态未知'
}

export interface WorkspaceRepository {
  id: string
  path: string
  name: string
  state: WorkspaceRepositoryState
}

export interface WorkspaceFolder {
  id: string
  path: string
  name: string
  bytes: number
  fileCount: number
  modifiedAt: number
  repositories: WorkspaceRepository[]
  children: WorkspaceFolder[]
}

export interface WorkspaceSnapshot {
  root: string
  isScanned: boolean
  entries: WorkspaceFolder[]
}

export const workspaceFolderFileCount = (entry: WorkspaceFolder): number =>
  entry.fileCount + entry.children.reduce((sum, child) => sum + workspaceFolderFileCount(child), 0)

export const workspaceFolderRepositoryCount = (entry: WorkspaceFolder): number =>
  entry.repositories.length + entry.children.reduce((sum, child) => sum + workspaceFolderRepositoryCount(child), 0)

export const workspaceFolderIsUnsafe = (entry: WorkspaceFolder): boolean =>
  entry.repositories.some((repository) => repository.state !== 'clean') || entry.children.some(workspaceFolderIsUnsafe)

export const workspaceBytes = (snapshot: WorkspaceSnapshot): number =>
  snapshot.entries.reduce((sum, entry) => sum + entry.bytes, 0)

export interface ScanProgress {
  stage: string
  currentPath: string
  scannedBytes: number
  fraction: number
}

export const ScanProgressIdle: ScanProgress = {
  stage: '',
  currentPath: '',
  scannedBytes: 0,
  fraction: 0
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
  notes: string[]
}

export const snapshotIsEmpty = (s: ScanSnapshot): boolean =>
  s.categories.length === 0 && s.sessions.length === 0 && s.pluginVersions.length === 0

export const snapshotCategoryList = (s: ScanSnapshot, group: StorageGroup): StorageCategory[] =>
  s.categories
    .filter((c) => c.group === group && !categoryIsEmpty(c))
    .sort((a, b) => categoryReclaimable(b) - categoryReclaimable(a))

export const snapshotSessionBytes = (s: ScanSnapshot): number =>
  s.sessions.reduce((sum, x) => sum + sessionTotalBytes(x), 0)

export const snapshotEmbeddedImageBytes = (s: ScanSnapshot): number =>
  s.sessions.reduce((sum, x) => sum + x.embeddedImageBytes, 0)

export type SessionSlimMode = 'deduplicate' | 'stripAll'

export const SessionSlimModeLabel: Record<SessionSlimMode, string> = {
  deduplicate: '去除重复图片',
  stripAll: '剥离全部内嵌图片'
}

export const SessionSlimModeDetail: Record<SessionSlimMode, string> = {
  deduplicate: '每张图片保留第一份，删除后续重复副本',
  stripAll: '移除会话里的全部图片数据，文字记录保持不变'
}

export interface CleanupTask {
  id: string
  title: string
  detail: string
  url: string
  method: CleanupMethod
  expectedBytes: number
  /** Only for session deletion, where the app server owns the rollout file. */
  threadID: string | null
  /** Extra files removed with the primary target. */
  companionURLs: string[]
  /** Only for slimSession. */
  slimMode: SessionSlimMode | null
  minimumIdleSeconds: number | null
  requiresCodexStopped: boolean
}

/**
 * Renderer-to-main cleanup protocol. The renderer may select objects that came from the
 * latest snapshot, but it never supplies a filesystem path, cleanup method, or safety
 * flag. The main process resolves these stable IDs back to trusted domain objects.
 */
export type CleanupSelection =
  | { kind: 'storage'; ids: string[] }
  | { kind: 'sessions-delete'; ids: string[]; mode: SessionDeletionMode }
  | { kind: 'sessions-slim'; ids: string[]; mode: SessionSlimMode }
  | { kind: 'plugins'; ids: string[] }
  | { kind: 'workspace'; ids: string[] }

export interface CleanupRequest {
  selection: CleanupSelection
  restartCodex: boolean
}

export interface CleanupPreviewItem {
  id: string
  title: string
  detail: string
  method: CleanupMethod
  expectedBytes: number
}

export interface CleanupPreview {
  selection: CleanupSelection
  items: CleanupPreviewItem[]
  expectedBytes: number
  blockedTitles: string[]
  codexRunning: boolean
  canRestartCodex: boolean
  blockerSummary: string | null
  warnings: string[]
}

/** Build cleanup tasks from the storage entries selected in the overview. */
export function tasksFromEntries(entries: StorageEntry[]): CleanupTask[] {
  return entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    detail: entry.detail,
    url: entry.url,
    method: entry.method,
    expectedBytes: entry.reclaimableBytes,
    threadID: null,
    companionURLs: [],
    slimMode: null,
    minimumIdleSeconds: entry.minimumIdleSeconds,
    requiresCodexStopped: entry.requiresCodexStopped
  }))
}

/** Build delete-thread tasks from the sessions selected in the sessions list. */
export function tasksForSessionDeletion(
  sessions: SessionItem[],
  mode: SessionDeletionMode = 'appServer'
): CleanupTask[] {
  return sessions.map((s) => ({
    id: s.id,
    title: sessionDisplayName(s),
    detail: s.fileURL,
    url: s.fileURL,
    method: mode === 'appServer' ? 'deleteThread' : 'trash',
    expectedBytes: sessionTotalBytes(s),
    threadID: s.threadID,
    companionURLs: s.assetURLs,
    slimMode: null,
    minimumIdleSeconds: null,
    requiresCodexStopped: false
  }))
}

export function tasksForSessionSlimming(sessions: SessionItem[], mode: SessionSlimMode): CleanupTask[] {
  return sessions.map((session) => ({
    id: `slim:${mode}:${session.id}`,
    title: sessionDisplayName(session),
    detail: session.fileURL,
    url: session.fileURL,
    method: 'slimSession',
    expectedBytes: mode === 'deduplicate' ? session.duplicateImageBytes : session.embeddedImageBytes,
    threadID: session.threadID,
    companionURLs: [],
    slimMode: mode,
    minimumIdleSeconds: null,
    requiresCodexStopped: false
  }))
}

export function tasksForWorkspace(entries: WorkspaceFolder[]): CleanupTask[] {
  return entries.map((entry) => ({
    id: `workspace:${entry.id}`,
    title: entry.name,
    detail: entry.path,
    url: entry.path,
    method: 'trash',
    expectedBytes: entry.bytes,
    threadID: null,
    companionURLs: [],
    slimMode: null,
    minimumIdleSeconds: null,
    requiresCodexStopped: false
  }))
}

export type CleanupStatus =
  | { kind: 'succeeded' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string }

export const cleanupStatusIsSuccess = (s: CleanupStatus): boolean => s.kind === 'succeeded'

export const cleanupStatusLabel = (s: CleanupStatus): string => {
  switch (s.kind) {
    case 'succeeded':
      return '已完成'
    case 'skipped':
      return '已推迟'
    case 'failed':
      return '失败'
  }
}

export const cleanupStatusMessage = (s: CleanupStatus): string | null => {
  switch (s.kind) {
    case 'succeeded':
      return null
    case 'skipped':
      return s.reason
    case 'failed':
      return s.reason
  }
}

export interface CleanupOutcome {
  id: string
  title: string
  detail: string
  method: CleanupMethod
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

export const reportProblems = (r: CleanupReport): CleanupOutcome[] =>
  r.outcomes.filter((o) => !cleanupStatusIsSuccess(o.status))

export interface CleanupProgress {
  completed: number
  total: number
  currentTitle: string
}

export type SessionDeletionMode = 'appServer' | 'trash'

export const SessionDeletionModeLabel: Record<SessionDeletionMode, string> = {
  appServer: '通过 Codex 删除',
  trash: '移到废纸篓'
}

export const SessionDeletionModeDetail: Record<SessionDeletionMode, string> = {
  appServer: '调用 app server 的 thread/delete，同时清理 rollout、元数据和派生子线程',
  trash: '直接把 rollout 文件和关联资产移到废纸篓，Codex 的索引可能仍保留记录'
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
  runtimeSummary: string | null
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
  skippedReason: string | null
  deferred: number
  deferredNote: string | null
}

export interface AutomationState {
  settings: AutomationSettings
  installed: boolean
  loaded: boolean
  nextRunAt: number | null
  lastRun: AutomaticRunRecord | null
  supported: boolean
}
