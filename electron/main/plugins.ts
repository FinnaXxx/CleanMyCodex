import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { PluginStatus, PluginVersionItem, StorageCategory, StorageEntry } from '../../shared/types'
import { message } from '../../shared/messages'
import type { InstalledPlugin } from './app-server'
import { directoryAllocatedSize } from './fs-size'

const OFFICIAL_BUILTIN_MARKETPLACES = new Set(['openai-bundled', 'openai-primary-runtime'])

/**
 * Codex' sentinel for a locally installed plugin. `PluginStore::active_plugin_version`
 * resolves the active version from the directory listing alone, and a directory named
 * `local` wins over every semver sibling regardless of what any catalog reports. Treating
 * one as a superseded version would delete the plugin Codex is actually running, so it is
 * never removable no matter what the inventory says.
 */
const ALWAYS_ACTIVE_PLUGIN_VERSION = 'local'

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

function statusFor(path: string, marketplace: string | null, plugin: string, version: string, inventory: InstalledPlugin[] | null): PluginStatus {
  if (marketplace && OFFICIAL_BUILTIN_MARKETPLACES.has(marketplace)) return 'builtin'
  if (normalizedVersion(version) === ALWAYS_ACTIVE_PLUGIN_VERSION) return 'current'
  if (!inventory) return 'unconfirmed'

  // A path match is authoritative, but an explicitly uninstalled catalog row is not.
  if (inventory.some((item) => item.installed !== false && item.directory
    && (containsPath(item.directory, path) || containsPath(path, item.directory)))) {
    return 'current'
  }

  // Plugin names are only unique within a marketplace. Legacy rows without a
  // marketplace may prove an exact version current, but must never justify deletion.
  const known = inventory.filter((item) => item.name === plugin && item.marketplace === marketplace)
  const legacy = inventory.filter((item) => item.name === plugin && item.marketplace === null && item.installed !== false)
  if (legacy.some((item) => normalizedVersion(item.version) === normalizedVersion(version))) return 'current'
  if (!known.length && legacy.length) return 'unconfirmed'
  const active = known.filter((item) => item.installed !== false)
  if (active.some((item) => normalizedVersion(item.version) === normalizedVersion(version))) return 'current'
  if (active.length) {
    if (!active.some((item) => item.version?.length)) return 'unconfirmed'
    return 'outdated'
  }

  // Only call something a leftover when plugin/list supplied authoritative negative
  // evidence for this marketplace. Built-in runtime marketplaces are intentionally
  // absent from plugin/list, so their on-disk bundles must stay locked.
  if (known.some((item) => item.installed === false)) return 'orphaned'
  if (marketplace && inventory.some((item) => item.marketplace === marketplace)) return 'orphaned'
  return 'unconfirmed'
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
    const marketplace = (parts[0] === 'cache' ? parts[1] : parts[0]) || null
    let modifiedAt = 0
    try { modifiedAt = statSync(path).mtimeMs } catch { /* missing */ }
    return {
      marketplace,
      plugin,
      version,
      directoryURL: path,
      bytes: directoryAllocatedSize(path),
      environmentBytes: directoryAllocatedSize(join(path, '.venv')),
      modifiedAt,
      status: statusFor(path, marketplace, plugin, version, installed)
    }
  }).sort((a, b) => a.plugin.localeCompare(b.plugin) || a.version.localeCompare(b.version))
}

function pluginEntries(plugins: PluginVersionItem[], status: 'outdated' | 'orphaned', risk: 'safe' | 'caution'): StorageEntry[] {
  return plugins.filter((plugin) => plugin.status === status).map((plugin): StorageEntry => ({
      id: `remove:${plugin.directoryURL}`,
      title: `${plugin.plugin} · ${plugin.version}`,
      note: null,
      tags: [status === 'orphaned'
        ? { label: message('tag.orphaned'), tone: 'caution' as const }
        : { label: message('tag.outdated'), tone: 'neutral' as const }],
      url: plugin.directoryURL,
      bytes: plugin.bytes,
      reclaimableBytes: plugin.bytes,
      minimumIdleSeconds: null,
      // Plugin helpers may still be executing code from an old version while the desktop
      // app is open. Even an inventory-confirmed remnant is only removed after full exit.
      requiresCodexStopped: true,
      risk
    })).sort((a, b) => b.bytes - a.bytes)
}

export function pluginStorageCategories(plugins: PluginVersionItem[]): StorageCategory[] {
  return [
    {
      kind: 'pluginRemnants',
      group: 'recommended',
      risk: 'safe',
      entries: pluginEntries(plugins, 'outdated', 'safe')
    },
    {
      kind: 'pluginOrphans',
      group: 'review',
      risk: 'caution',
      entries: pluginEntries(plugins, 'orphaned', 'caution')
    }
  ]
}
