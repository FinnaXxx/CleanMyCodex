import { lstatSync, readdirSync, statSync } from 'node:fs'
import { join, basename, relative } from 'node:path'
import { CodexLocations } from './locations'
import { directoryAllocatedSize, fileAllocatedSize } from './fs-size'
import { scanSessions } from './sessions'
import { inspectDatabase } from './sqlite-maintenance'
import { pluginStorageCategory, scanPluginVersions } from './plugins'
import { ProtectedPaths } from './guard'
import type { InstalledPlugin } from './app-server'
import { formatBytes } from '../../shared/types'
import type { ScanProgress, ScanSnapshot, SessionItem, StorageCategory, StorageEntry } from '../../shared/types'

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

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
  if (signal?.aborted) throw new DOMException('扫描已停止', 'AbortError')
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
  detail: string,
  url: string,
  bytes: number,
  risk: StorageEntry['risk'],
  method: StorageEntry['method'] = 'trash',
  extra: Partial<Pick<StorageEntry, 'minimumIdleSeconds' | 'requiresCodexStopped' | 'tags'>> = {}
): StorageEntry {
  return {
    id: `${method}:${url}`,
    title,
    detail,
    tags: extra.tags ?? [],
    url,
    bytes,
    reclaimableBytes: bytes,
    minimumIdleSeconds: extra.minimumIdleSeconds ?? null,
    requiresCodexStopped: extra.requiresCodexStopped ?? false,
    method,
    risk
  }
}

function category(
  kind: StorageCategory['kind'],
  title: string,
  detail: string,
  group: StorageCategory['group'],
  risk: StorageCategory['risk'],
  entries: StorageEntry[]
): StorageCategory {
  return { kind, title, detail, group, risk, entries: entries.filter((e) => e.bytes > 0).sort((a, b) => b.bytes - a.bytes || a.title.localeCompare(b.title)) }
}

/** Finds `logs_*.sqlite` directly under ~/.codex (Codex' rolling log database). */
function logDatabases(home: string): { path: string; bytes: number }[] {
  try {
    return readdirSync(home)
      .filter((name) => name.startsWith('logs_') && name.endsWith('.sqlite'))
      .map((name) => {
        const path = join(home, name)
        // Count the WAL and SHM siblings too: they hold pages VACUUM can reclaim.
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

/**
 * Builds the complete Codex snapshot. Workspace output remains opt-in because reading
 * Documents may trigger an OS permission prompt; it is scanned by `scanWorkspace` when
 * that page opens. `onProgress` lets the renderer show the path currently measured.
 */
export async function scanSnapshot(
  locations: CodexLocations,
  installedPlugins: InstalledPlugin[] | null,
  onProgress?: (progress: ScanProgress) => void,
  signal?: AbortSignal
): Promise<ScanSnapshot> {
  const categories: StorageCategory[] = []
  const notes: string[] = []
  const guards = new ProtectedPaths(locations)
  const progress = (stage: string, currentPath: string, fraction: number): void => {
    onProgress?.({ stage, currentPath, scannedBytes: 0, fraction })
  }

  const measure = (path: string, stage = '缓存与临时文件', fraction = 0): number => {
    throwIfAborted(signal)
    progress(stage, path, fraction)
    return pathAllocatedSize(path)
  }

  // --- Recommended: reclaimable or lossless ---

  const staleTemporary: StorageEntry[] = []
  const marketplaceCaches: StorageEntry[] = []
  let temporaryNames: string[] = []
  try { temporaryNames = readdirSync(locations.temporary) } catch { /* missing */ }
  for (const name of temporaryNames) {
    throwIfAborted(signal)
    const path = join(locations.temporary, name)
    if (guards.isProtected(path)) continue
    progress('缓存与临时文件', path, 0.08)
    const measured = measureTree(path, signal)
    if (!measured.bytes) continue
    if (name.toLowerCase().includes('marketplace')) {
      marketplaceCaches.push(entry(name, '插件市场的本地副本，可重新下载', path, measured.bytes, 'rebuildable'))
      continue
    }
    const staging = name.includes('.staging-') || name.startsWith('plugins-clone-')
    const idleSeconds = staging ? 3_600 : 3 * 86_400
    if (Date.now() - measured.latestActivity < idleSeconds * 1000) continue
    staleTemporary.push(entry(name, staging ? '安装或更新时留下的目录' : '超过 3 天没有改动', path, measured.bytes, 'safe', 'trash', {
      minimumIdleSeconds: idleSeconds, requiresCodexStopped: true
    }))
  }
  categories.push(category('temporary', '过期临时目录', '安装和更新过程留下的临时目录，Codex 退出后清理', 'recommended', 'safe', staleTemporary))
  categories.push(category('marketplaceCache', '插件市场缓存', '可重新下载，离线时会影响插件安装', 'review', 'rebuildable', marketplaceCaches))
  await yieldToEventLoop()

  const browserEntries = locations.browserCacheDirectories
    .filter(entryExists)
    .map((path) => entry(basename(path), '缓存目录，可重新生成', path, measure(path, '缓存与临时文件', 0.12), 'rebuildable'))
  categories.push(
    category('browserCache', '浏览器与渲染缓存', '桌面应用按需重建的浏览器缓存', 'recommended', 'rebuildable', browserEntries)
  )
  await yieldToEventLoop()

  const appCacheEntries = locations.appCaches
    .filter(entryExists)
    .map((path) => entry(basename(path), '缓存目录，可重新生成', path, measure(path, '缓存与临时文件', 0.16), 'rebuildable'))
  categories.push(
    category('appCache', '应用缓存', '桌面应用的本地缓存目录', 'recommended', 'rebuildable', appCacheEntries)
  )
  await yieldToEventLoop()

  const logCutoff = Date.now() - 10 * 86_400_000
  let logNames: string[] = []
  try { logNames = readdirSync(locations.appLogs) } catch { /* missing */ }
  const oldLogs = logNames.flatMap((name): StorageEntry[] => {
    const path = join(locations.appLogs, name)
    try {
      if (statSync(path).mtimeMs >= logCutoff) return []
      return [entry(name, '早于 10 天的应用日志', path, measure(path, '缓存与临时文件', 0.18), 'rebuildable')]
    } catch { return [] }
  })
  categories.push(category('appLogs', '旧应用日志', '保留最近 10 天，其余可以清理', 'recommended', 'rebuildable', oldLogs))
  await yieldToEventLoop()

  const logs = logDatabases(locations.home).flatMap((db) => {
    throwIfAborted(signal)
    try {
      const inspection = inspectDatabase(db.path)
      if (inspection.reclaimableBytes <= 1024 * 1024) return []
      return [{ ...db, inspection }]
    } catch (err) {
      notes.push(`${basename(db.path)} 暂时无法读取：${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  })
  categories.push(
    category('logDatabase', '日志数据库', '压缩数据库回收空闲空间，日志内容保留', 'recommended', 'lossless', logs.map((db) => ({
      ...entry(basename(db.path), `已使用 ${formatBytes(db.inspection.usedBytes)}`, db.path, db.bytes, 'lossless', 'compactDatabase'),
      reclaimableBytes: db.inspection.reclaimableBytes
    })))
  )
  await yieldToEventLoop()

  const pluginVersions = scanPluginVersions(locations.plugins, installedPlugins, (path) => progress('插件', path, 0.32))
  const pluginCategory = pluginStorageCategory(pluginVersions)
  if (pluginCategory.entries.length) categories.push(pluginCategory)
  if (installedPlugins === null && pluginVersions.length) {
    notes.push('未连接 codex app server，无法确认插件的当前版本，已全部锁定。')
  }
  await yieldToEventLoop()

  // --- Review: rebuildable but affects offline use ---

  // bundled-marketplaces is a live source referenced by config.toml, not disposable cache.

  // --- Protected: shown for awareness, never selected ---

  const sessions = await scanSessions(locations, (path, fraction) => progress('会话', path, 0.43 + fraction * 0.49), signal)
  if (sessions.length && !sessions.some((session) => session.title)) {
    notes.push('没有读到 Codex 的会话标题，列表改用会话首句或项目名显示。')
  }
  throwIfAborted(signal)
  categories.push(...assetCategories(locations, sessions, (path) => measure(path, '资产目录', 0.93)))

  const marketplaceSources = new Set(guards.localMarketplaceSources)
  const protectedConfigEntries: StorageEntry[] = []
  for (const path of guards.protectedURLs) {
    if ((!ProtectedPaths.contains(locations.home, path) && !marketplaceSources.has(path)) || !entryExists(path)) continue
    protectedConfigEntries.push(entry(
      marketplaceSources.has(path) ? relativeToHome(path, locations.home) : basename(path),
      marketplaceSources.has(path) ? 'config.toml 注册的本地插件市场' : '配置、凭据或用户规则',
      path,
      pathAllocatedSize(path),
      'shielded'
    ))
  }
  let homeEntries: string[] = []
  try { homeEntries = readdirSync(locations.home) } catch { /* missing home */ }
  for (const db of homeEntries.filter((name) => ProtectedPaths.protectedHomePrefixes.some((prefix) => name.startsWith(prefix)))) {
    const path = join(locations.home, db)
    protectedConfigEntries.push(entry(db, 'Codex 状态数据库', path, fileAllocatedSize(path), 'shielded'))
  }
  categories.push(
    category('protectedConfig', '受保护的配置', '凭据、配置和状态数据库', 'protectedData', 'shielded', protectedConfigEntries)
  )

  const protectedUserEntries = ProtectedPaths.protectedAppSupportEntries.flatMap((relative): StorageEntry[] => {
    const path = join(locations.appSupport, relative)
    return entryExists(path) ? [entry(relative, '浏览器配置与登录状态', path, pathAllocatedSize(path), 'shielded')] : []
  })
  categories.push(category('protectedUserData', '用户数据', '浏览器登录状态与本地配置', 'protectedData', 'shielded', protectedUserEntries))

  const externalBytes = outermostStorageRoots([locations.appSupport, ...locations.appCaches, locations.appLogs].filter(entryExists))
    .reduce((sum, path) => sum + directoryAllocatedSize(path), 0)
  const totalCodexBytes = directoryAllocatedSize(locations.home) + externalBytes
  progress('完成', '', 1)

  return {
    codexHome: locations.home,
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

function relativeToHome(path: string, home: string): string {
  const value = relative(home, path)
  return value && !value.startsWith('..') ? value : basename(path)
}

function assetCategories(
  locations: CodexLocations,
  sessions: SessionItem[],
  measure: (path: string) => number
): StorageCategory[] {
  const byThread = new Map<string, SessionItem>()
  for (const session of sessions) if (!byThread.has(session.threadID)) byThread.set(session.threadID, session)
  let names: string[] = []
  try { names = readdirSync(locations.generatedImages) } catch { /* missing */ }
  const images = names.flatMap((name): StorageEntry[] => {
    const path = join(locations.generatedImages, name)
    const bytes = measure(path)
    if (!bytes) return []
    const session = byThread.get(name)
    const title = session?.title || session?.preview || name
    const tag: StorageEntry['tags'] = session
      ? [{ label: session.location === 'archived' ? '已归档' : '未归档', tone: session.location === 'archived' ? 'neutral' : 'info' }]
      : [{ label: '会话已删除', tone: 'caution' }]
    return [entry(title, '', path, bytes, session ? 'caution' : 'safe', 'trash', { tags: tag })]
  }).sort((a, b) => b.bytes - a.bytes)

  const computerUse = entryExists(locations.computerUse)
    ? [entry('computer-use', 'Computer Use 辅助组件，删除后需要重新下载', locations.computerUse, measure(locations.computerUse), 'caution')]
    : []
  return [
    category('generatedImages', '会话生成的图片', 'Codex 在会话里生成的图片，删除后会话中不再显示', 'review', 'caution', images),
    category('computerUse', 'Computer Use 组件', 'Computer Use 运行所需的本地组件', 'review', 'caution', computerUse)
  ]
}
