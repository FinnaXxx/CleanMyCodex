/**
 * Shared domain types for CleanMyCodex — used by the main process (scanner, cleanup
 * engine) and the renderer (over IPC). Pure data: no Electron or Node APIs here.
 */

export type StorageGroup = 'recommended' | 'review' | 'protectedData'

export const StorageGroupLabel: Record<StorageGroup, { title: string; subtitle: string }> = {
  recommended: { title: '建议清理', subtitle: '可重建或无损回收，默认选中' },
  review: { title: '谨慎清理', subtitle: '删除后无法恢复，请逐项确认' },
  protectedData: { title: '受保护的数据', subtitle: '配置、登录信息和用户成果，永不清理' }
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

export interface WorkspaceFolder {
  id: string
  path: string
  name: string
  bytes: number
  fileCount: number
  modifiedAt: number
}

export interface WorkspaceSnapshot {
  root: string
  isScanned: boolean
  entries: WorkspaceFolder[]
}

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
  deduplicate: '只去重（保留每张图的第一份）',
  stripAll: '剥离全部内嵌图片'
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
}