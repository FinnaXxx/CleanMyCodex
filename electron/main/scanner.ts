import { lstatSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { CodexLocations } from './locations'
import { directoryAllocatedSize, fileAllocatedSize } from './fs-size'
import { scanSessions } from './sessions'
import { inspectDatabase } from './sqlite-maintenance'
import { pluginStorageCategory, scanPluginVersions } from './plugins'
import type { InstalledPlugin } from './app-server'
import type { ScanSnapshot, StorageCategory, StorageEntry } from '../../shared/types'

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function entryExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function measureTree(path: string): { bytes: number; latestActivity: number } {
  let stats
  try { stats = lstatSync(path) } catch { return { bytes: 0, latestActivity: 0 } }
  if (stats.isSymbolicLink()) return { bytes: 0, latestActivity: stats.mtimeMs }
  if (!stats.isDirectory()) return { bytes: fileAllocatedSize(path), latestActivity: stats.mtimeMs }
  let bytes = 0
  let latestActivity = stats.mtimeMs
  let children: string[] = []
  try { children = readdirSync(path) } catch { return { bytes, latestActivity } }
  for (const name of children) {
    const measured = measureTree(join(path, name))
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
  extra: Partial<Pick<StorageEntry, 'minimumIdleSeconds' | 'requiresCodexStopped'>> = {}
): StorageEntry {
  return {
    id: `${method}:${url}`,
    title,
    detail,
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
  return { kind, title, detail, group, risk, entries: entries.filter((e) => e.bytes > 0) }
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
  onProgress?: (path: string) => void
): Promise<ScanSnapshot> {
  const categories: StorageCategory[] = []
  const notes: string[] = []

  const measure = (path: string): number => {
    onProgress?.(path)
    return directoryAllocatedSize(path)
  }

  // --- Recommended: reclaimable or lossless ---

  const staleTemporary: StorageEntry[] = []
  const marketplaceCaches: StorageEntry[] = []
  let temporaryNames: string[] = []
  try { temporaryNames = readdirSync(locations.temporary) } catch { /* missing */ }
  for (const name of temporaryNames) {
    const path = join(locations.temporary, name)
    if (path === locations.bundledMarketplaces) continue
    onProgress?.(path)
    const measured = measureTree(path)
    if (!measured.bytes) continue
    if (name.toLowerCase().includes('marketplace')) {
      marketplaceCaches.push(entry(name, '插件市场副本，离线时需要重新下载', path, measured.bytes, 'rebuildable'))
      continue
    }
    const staging = name.includes('.staging-') || name.startsWith('plugins-clone-')
    const idleSeconds = staging ? 3_600 : 3 * 86_400
    if (Date.now() - measured.latestActivity < idleSeconds * 1000) continue
    staleTemporary.push(entry(name, staging ? '安装暂存或克隆残留' : '3 天内没有改动的临时目录', path, measured.bytes, 'safe', 'trash', {
      minimumIdleSeconds: idleSeconds, requiresCodexStopped: true
    }))
  }
  categories.push(category('temporary', '过期临时目录', '旧 staging、失败的 clone 和无人使用的临时目录；只在 Codex 退出后清理', 'recommended', 'safe', staleTemporary))
  categories.push(category('marketplaceCache', '插件市场缓存', '可以重新下载，但离线时会影响插件安装', 'review', 'rebuildable', marketplaceCaches))
  await yieldToEventLoop()

  if (entryExists(locations.generatedImages)) {
    categories.push(
      category('generatedImages', '生成图片', '按线程保存的图片；会话已删除的图片可以安全清理', 'recommended', 'safe', [
        entry('generated_images', '按线程保存的生成图片', locations.generatedImages, measure(locations.generatedImages), 'safe')
      ])
    )
  }
  await yieldToEventLoop()

  if (entryExists(locations.computerUse)) {
    categories.push(
      category('computerUse', 'Computer Use 组件', 'Computer Use 期间的截图与中间产物', 'recommended', 'safe', [
        entry('computer-use', 'Computer Use 组件', locations.computerUse, measure(locations.computerUse), 'safe')
      ])
    )
  }
  await yieldToEventLoop()

  const browserEntries = locations.browserCacheDirectories
    .filter(entryExists)
    .map((path) => entry(basename(path), '浏览器/渲染缓存，可重建', path, measure(path), 'rebuildable'))
  categories.push(
    category('browserCache', '浏览器与渲染缓存', 'Chromium 风格缓存，桌面应用按需重建', 'recommended', 'rebuildable', browserEntries)
  )
  await yieldToEventLoop()

  const appCacheEntries = locations.appCaches
    .filter(entryExists)
    .map((path) => entry(basename(path), '应用缓存，可重建', path, measure(path), 'rebuildable'))
  categories.push(
    category('appCache', '应用缓存', '桌面应用的本地缓存目录', 'recommended', 'rebuildable', appCacheEntries)
  )
  await yieldToEventLoop()

  if (entryExists(locations.appLogs)) {
    categories.push(
      category('appLogs', '应用日志', '桌面应用自身写入的日志文件', 'recommended', 'safe', [
        entry(basename(locations.appLogs), '旧应用日志', locations.appLogs, measure(locations.appLogs), 'safe')
      ])
    )
  }
  await yieldToEventLoop()

  const logs = logDatabases(locations.home).flatMap((db) => {
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
    category('logDatabase', '日志数据库空闲页', 'checkpoint 和 VACUUM 只回收空闲页，不删除诊断记录', 'recommended', 'lossless', logs.map((db) => ({
      ...entry(basename(db.path), `已使用 ${db.inspection.usedBytes} B，空闲 ${db.inspection.freeListCount} 页`, db.path, db.bytes, 'lossless', 'compactDatabase'),
      reclaimableBytes: db.inspection.reclaimableBytes
    })))
  )
  await yieldToEventLoop()

  const pluginVersions = scanPluginVersions(locations.plugins, installedPlugins, onProgress)
  const pluginCategory = pluginStorageCategory(pluginVersions)
  if (pluginCategory.entries.length) categories.push(pluginCategory)
  if (installedPlugins === null && pluginVersions.length) {
    notes.push('没有连接到 codex app server，插件的当前版本未确认，已全部标记为受保护。')
  }
  await yieldToEventLoop()

  // --- Review: rebuildable but affects offline use ---

  // bundled-marketplaces is a live source referenced by config.toml, not disposable cache.

  // --- Protected: shown for awareness, never selected ---

  const protectedConfigEntries: StorageEntry[] = []
  for (const name of ['auth.json', 'config.toml']) {
    const path = join(locations.home, name)
    if (entryExists(path)) protectedConfigEntries.push(entry(name, '配置与登录信息，永不清理', path, fileAllocatedSize(path), 'shielded'))
  }
  let homeEntries: string[] = []
  try { homeEntries = readdirSync(locations.home) } catch { /* missing home */ }
  for (const db of homeEntries.filter((n) => n.startsWith('state_') && n.endsWith('.sqlite'))) {
    const path = join(locations.home, db)
    protectedConfigEntries.push(entry(db, 'Codex 状态数据库，永不清理', path, fileAllocatedSize(path), 'shielded'))
  }
  categories.push(
    category('protectedConfig', '受保护的配置', '凭据、配置和状态数据库，永不清理', 'protectedData', 'shielded', protectedConfigEntries)
  )

  const externalBytes = [...locations.appCaches, locations.appLogs]
    .filter(entryExists)
    .reduce((sum, path) => sum + directoryAllocatedSize(path), 0)
  const totalCodexBytes = directoryAllocatedSize(locations.home) + externalBytes

  const sessions = await scanSessions(locations, onProgress)

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
