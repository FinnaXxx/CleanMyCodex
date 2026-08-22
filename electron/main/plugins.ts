import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { PluginStatus, PluginVersionItem, StorageCategory, StorageEntry } from '../../shared/types'
import type { InstalledPlugin } from './app-server'
import { directoryAllocatedSize } from './fs-size'

function versionDirectories(root: string, depth = 0): string[] {
  if (depth > 4 || !existsSync(root)) return []
  let children
  try { children = readdirSync(root, { withFileTypes: true }) } catch { return [] }
  return children.flatMap((child) => {
    if (!child.isDirectory() || child.name.startsWith('.')) return []
    const path = join(root, child.name)
    return existsSync(join(path, '.codex-plugin', 'plugin.json')) ? [path] : versionDirectories(path, depth + 1)
  })
}

function normalizedVersion(version: string | null | undefined): string | null {
  const value = version?.trim().toLowerCase().replace(/^v/, '')
  return value?.length ? value : null
}

function containsPath(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..')
}

function statusFor(path: string, plugin: string, version: string, installed: InstalledPlugin[] | null): PluginStatus {
  if (!installed) return 'unconfirmed'
  if (installed.some((item) => item.directory && (containsPath(item.directory, path) || containsPath(path, item.directory)))) {
    return 'current'
  }
  const known = installed.filter((item) => item.name === plugin)
  if (!known.length) return 'orphaned'
  if (known.some((item) => normalizedVersion(item.version) === normalizedVersion(version))) return 'current'
  if (!known.some((item) => item.version?.length)) return 'unconfirmed'
  return 'outdated'
}

export function scanPluginVersions(
  pluginsRoot: string,
  installed: InstalledPlugin[] | null,
  onProgress?: (path: string) => void
): PluginVersionItem[] {
  const rootParts = resolve(pluginsRoot).split(sep)
  return versionDirectories(pluginsRoot).map((path) => {
    onProgress?.(path)
    let manifest: { name?: string; version?: string } = {}
    try { manifest = JSON.parse(readFileSync(join(path, '.codex-plugin', 'plugin.json'), 'utf8')) } catch { /* fallback below */ }
    const parts = resolve(path).split(sep).slice(rootParts.length)
    const plugin = manifest.name || basename(resolve(path, '..'))
    const version = manifest.version || basename(path)
    let modifiedAt = 0
    try { modifiedAt = statSync(path).mtimeMs } catch { /* missing */ }
    return {
      marketplace: parts[0] === 'cache' ? parts[1] || '本地' : parts[0] || '本地',
      plugin,
      version,
      directoryURL: path,
      bytes: directoryAllocatedSize(path),
      environmentBytes: directoryAllocatedSize(join(path, '.venv')),
      modifiedAt,
      status: statusFor(path, plugin, version, installed)
    }
  }).sort((a, b) => a.plugin.localeCompare(b.plugin) || a.version.localeCompare(b.version))
}

export function pluginStorageCategory(plugins: PluginVersionItem[]): StorageCategory {
  return {
    kind: 'pluginRemnants',
    title: '老版本插件与卸载残留',
    detail: '旧版本与卸载残留',
    group: 'recommended',
    risk: 'safe',
    entries: plugins.filter((plugin) => plugin.status === 'outdated' || plugin.status === 'orphaned').map((plugin): StorageEntry => ({
      id: `trash:${plugin.directoryURL}`,
      title: `${plugin.plugin} · ${plugin.version}`,
      detail: '',
      tags: [plugin.status === 'orphaned'
        ? { label: '卸载残留', tone: 'caution' as const }
        : { label: '旧版本', tone: 'neutral' as const }],
      url: plugin.directoryURL,
      bytes: plugin.bytes,
      reclaimableBytes: plugin.bytes,
      minimumIdleSeconds: null,
      requiresCodexStopped: false,
      method: 'trash',
      risk: 'safe'
    })).sort((a, b) => b.bytes - a.bytes)
  }
}
