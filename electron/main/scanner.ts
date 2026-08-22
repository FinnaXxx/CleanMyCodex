import { readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { CodexLocations } from './locations'
import { directoryAllocatedSize, fileAllocatedSize } from './fs-size'
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
 * A first vertical slice: real sizes for the storage categories the cleaner acts on,
 * with sessions and plugins left empty (filled in by later passes). Runs on the main
 * process; `onProgress` gets the path being measured so the UI can show activity.
 */
export async function scanSnapshot(
  locations: CodexLocations,
  onProgress?: (path: string) => void
): Promise<ScanSnapshot> {
  const categories: StorageCategory[] = []

  const measure = (path: string): number => {
    onProgress?.(path)
    return directoryAllocatedSize(path)
  }

  // --- Recommended: reclaimable or lossless ---

  if (entryExists(locations.temporary)) {
    categories.push(
      category(
        'temporary',
        '过期临时目录',
        '旧 staging、失败的 clone 和无人使用的临时目录；只在 Codex 退出后清理',
        'recommended',
        'safe',
        [entry('.tmp', '安装暂存与任务临时目录', locations.temporary, measure(locations.temporary), 'safe', 'trash', { requiresCodexStopped: true })]
      )
    )
  }
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

  const logs = logDatabases(locations.home)
  categories.push(
    category('logDatabase', '日志数据库', 'logs_*.sqlite 的空闲页，压缩回收不影响诊断记录', 'recommended', 'lossless', logs.map((db) => entry(basename(db.path), '日志数据库（仅压缩空闲页）', db.path, db.bytes, 'lossless', 'compactDatabase')))
  )
  await yieldToEventLoop()

  // --- Review: rebuildable but affects offline use ---

  if (entryExists(locations.bundledMarketplaces)) {
    categories.push(
      category('marketplaceCache', '插件市场缓存', '可以重新下载，但离线时会影响插件安装', 'review', 'rebuildable', [
        entry('bundled-marketplaces', '随版本内置的插件市场副本', locations.bundledMarketplaces, measure(locations.bundledMarketplaces), 'rebuildable')
      ])
    )
  }
  await yieldToEventLoop()

  // --- Protected: shown for awareness, never selected ---

  const protectedConfigEntries: StorageEntry[] = []
  for (const name of ['auth.json', 'config.toml']) {
    const path = join(locations.home, name)
    if (entryExists(path)) protectedConfigEntries.push(entry(name, '配置与登录信息，永不清理', path, fileAllocatedSize(path), 'shielded'))
  }
  for (const db of readdirSync(locations.home).filter((n) => n.startsWith('state_') && n.endsWith('.sqlite'))) {
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

  return {
    codexHome: locations.home,
    scannedAt: Date.now(),
    totalCodexBytes,
    externalBytes,
    categories: categories.filter((c) => c.entries.length > 0),
    sessions: [],
    pluginVersions: [],
    workspace: { root: locations.workspace, isScanned: false, entries: [] },
    notes: []
  }
}