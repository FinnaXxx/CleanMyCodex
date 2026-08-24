import { basename, dirname, join, normalize, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import { CodexLocations } from './locations'
import { loadCodexConfiguration, type CodexConfiguration } from './configuration'
import { MessageError, message, type Message } from '../../shared/messages'

function outermost(paths: string[]): string[] {
  const unique = [...new Set(paths.map(normalize))]
  return unique.filter((candidate) => !unique.some(
    (other) => other !== candidate && ProtectedPaths.contains(other, candidate)
  ))
}

/**
 * The allow/deny list that every deletion goes through. Deny-by-default: a path must sit
 * inside one of the Codex data roots and must not match a protected entry. Writable roots
 * themselves are always denied. The only exception below a protected container is an
 * exact, source-known Codex cache leaf. Desktop data outside ~/.codex is stricter still:
 * both the App Support profile and platform cache containers are entirely read-only.
 */
export class ProtectedPaths {
  private readonly locations: CodexLocations
  private readonly activePluginDirectories: string[]
  readonly localMarketplaceSources: string[]

  /**
   * Relative names inside ~/.codex that hold credentials, configuration or user work.
   *
   * Cross-checked against the Codex sources (github.com/openai/codex): every name below
   * either appears there as a path Codex reads live state from, or was observed on disk
   * and is kept for builds this app cannot see into. Over-protection is cheap; the
   * reverse is not, so an entry stays even when the current CLI no longer writes it.
   */
  static readonly protectedHomeEntries = [
    // Credentials. `secrets/` is the age-encrypted store (codex_auth.age, local.age,
    // mcp_oauth.age) and `.credentials.json` is the MCP OAuth fallback file.
    'auth.json',
    'secrets',
    '.credentials.json',
    '.env',
    // Configuration.
    'config.toml',
    'config.json',
    'managed_config.toml',
    'environments.toml',
    'hooks.json',
    'version.json',
    'instructions.md',
    'AGENTS.md',
    'AGENTS.override.md',
    'installation_id',
    // User-authored content.
    'rules',
    'hooks',
    'skills',
    'memories',
    'memories_extensions',
    'agents',
    'themes',
    'avatars',
    'prompts',
    'vendor_imports',
    'ambient-suggestions',
    'browser',
    // Runtime state and caches Codex rebuilds on its own terms.
    'cache',
    'sqlite',
    'db-backups',
    'session_index.jsonl',
    'external_agent_session_imports.json',
    'rollout-migrations',
    'app-server-daemon',
    'app-server-control',
    'ipc',
    'shell_snapshots',
    'attachments',
    'hook_outputs',
    'bin',
    'log',
    // Container only. A scanner-confirmed direct child is an optional ImageGen PNG copy;
    // the root and any deeper forged target stay protected.
    'generated_images',
    // Plugin data Codex persists on a plugin's behalf, and the marketplace registry.
    'plugins/data',
    'plugins/known_marketplaces.json',
    // Network proxy CA material, and the Windows sandbox identity/secret files.
    'proxy',
    '.sandbox',
    '.sandbox-bin',
    '.sandbox-secrets',
    'cap_sid',
    '.codex-global-state.json',
    '.codex-global-state.json.bak'
  ]

  /**
   * Prefixes of files inside ~/.codex that must never be deleted. These cover the
   * versioned SQLite runtimes Codex opens at startup — `state_5.sqlite`, `logs_2.sqlite`,
   * `goals_1.sqlite`, `memories_1.sqlite`, `queue_1.sqlite`, `thread_history_1.sqlite` —
   * whose version suffix moves between releases, plus `history.jsonl`.
   */
  static readonly protectedHomePrefixes = [
    'state_', 'logs_', 'thread_history_', 'goals_', 'queue_', 'memories_', 'history'
  ]

  /**
   * Chromium profile data that carries the Codex login: the cookie and storage backends,
   * and the preference files that hold the key material for them. Chromium has moved
   * several of these between releases — cookies now live under `Network/`, and the
   * desktop app runs with a `Default` profile on some builds and straight in the
   * user-data root on others — so every name is protected in both layouts.
   */
  static readonly protectedProfileEntries = [
    'Cookies',
    'Cookies-journal',
    'Network',
    'Login Data',
    'Login Data For Account',
    'Local Storage',
    'Session Storage',
    'IndexedDB',
    'databases',
    'File System',
    'Service Worker',
    'WebStorage',
    'Storage',
    'Preferences',
    'Secure Preferences',
    'Web Data',
    'Trust Tokens',
    'Trust Tokens-journal',
    'Sync Data',
    'Partitions',
    'blob_storage',
    'SharedStorage',
    'Network Persistent State',
    'TransportSecurity'
  ]

  /** Login-bearing data that only ever sits in the user-data root, beside the profile. */
  static readonly protectedAppSupportRootEntries = [
    'Local State',
    'codex-browser-app',
    'WidevineCdm',
    'WasmTtsEngine'
  ]

  /** Every protected entry below the app support root, in both profile layouts. */
  static get protectedAppSupportEntries(): string[] {
    return [
      ...ProtectedPaths.protectedAppSupportRootEntries,
      ...ProtectedPaths.protectedProfileEntries,
      ...ProtectedPaths.protectedProfileEntries.map((name) => `Default/${name}`)
    ]
  }

  constructor(
    locations: CodexLocations,
    activePluginDirectories: string[] = [],
    configuration: CodexConfiguration = loadCodexConfiguration(locations.home)
  ) {
    this.locations = locations
    this.activePluginDirectories = activePluginDirectories.map((d) => normalize(d))
    this.localMarketplaceSources = outermost([
      ...configuration.localMarketplaceSources.map(normalize),
      normalize(locations.bundledMarketplaceSource)
    ])
  }

  get protectedURLs(): string[] {
    const urls: string[] = []
    for (const name of ProtectedPaths.protectedHomeEntries) urls.push(normalize(`${this.locations.home}/${name}`))
    for (const name of ProtectedPaths.protectedAppSupportEntries) urls.push(normalize(`${this.locations.appSupport}/${name}`))
    urls.push(...this.localMarketplaceSources)
    urls.push(...this.activePluginDirectories)
    return urls
  }

  private get writableRoots(): string[] {
    return this.locations.writableRoots.map(normalize)
  }

  /** External Chromium/application roots are deny-by-default, including future profiles. */
  private isAllowedExternalCacheTarget(target: string): boolean {
    if (ProtectedPaths.contains(this.locations.appSupport, target)) {
      return false
    }
    if (this.locations.appCacheContainers.some((root) => ProtectedPaths.contains(root, target))) {
      return false
    }
    return true
  }

  private canonical(path: string): string {
    const target = normalize(path)
    try { return normalize(realpathSync(target)) } catch {
      const parent = dirname(target)
      if (parent === target) return target
      return join(this.canonical(parent), basename(target))
    }
  }

  /** True when `candidate` is `root` itself or lives below it. */
  static contains(root: string, candidate: string): boolean {
    const comparable = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
    const r = comparable(normalize(root)).split(sep).filter(Boolean)
    const c = comparable(normalize(candidate)).split(sep).filter(Boolean)
    if (c.length < r.length) return false
    return r.every((part, i) => c[i] === part)
  }

  isProtected(url: string): boolean {
    const target = this.canonical(url)
    // `~/.codex/cache` is a protected container. Only exact, source-known cache leaves
    // may be removed; unknown siblings and forged descendants remain deny-by-default.
    const codexCache = this.canonical(this.locations.codexCache)
    const knownCodexCaches = this.locations.codexCaches.map((path) => this.canonical(path))
    if (knownCodexCaches.includes(target)) return false
    if (ProtectedPaths.contains(codexCache, target) || ProtectedPaths.contains(target, codexCache)) return true
    const generatedImages = this.canonical(this.locations.generatedImages)
    if (dirname(target) === generatedImages) return false
    if (ProtectedPaths.contains(generatedImages, target) || ProtectedPaths.contains(target, generatedImages)) return true
    if (this.protectedURLs.map((path) => this.canonical(path)).some((p) => ProtectedPaths.contains(p, target) || ProtectedPaths.contains(target, p))) return true
    // state_*.sqlite, history.jsonl … directly inside ~/.codex.
    const parent = normalize(target + '/..')
    if (normalize(parent) === this.canonical(this.locations.home)) {
      const name = target.split(sep).pop() ?? ''
      if (ProtectedPaths.protectedHomePrefixes.some((prefix) => name.startsWith(prefix))) return true
    }
    return false
  }

  /** Resolves symlinks so a link cannot point the engine somewhere outside the roots. */
  validate(url: string): void {
    const target = normalize(url)
    const canonicalRoots = this.writableRoots.map((root) => this.canonical(root))
    const canonicalTarget = this.canonical(target)
    // No data root is ever a target itself, cache containers included: they hold
    // application state beside the rebuildable directories the scanner names.
    const isWritableRoot = this.writableRoots.some((root) => root === target)
      || canonicalRoots.some((root) => root === canonicalTarget)
    if (isWritableRoot) {
      throw new ProtectedPathError(message('guard.wholeDataRoot', { path: target }))
    }
    if (!this.writableRoots.some((root) => ProtectedPaths.contains(root, target))) {
      throw new ProtectedPathError(message('guard.outsideDataRoots', { path: target }))
    }
    if (!this.isAllowedExternalCacheTarget(target)) {
      throw new ProtectedPathError(message('guard.protectedPath', { path: target }))
    }
    if (this.isProtected(target)) {
      throw new ProtectedPathError(message('guard.protectedPath', { path: target }))
    }
    let resolved: string
    try {
      resolved = canonicalTarget
    } catch {
      resolved = target
    }
    if (resolved !== target) {
      if (!canonicalRoots.some((root) => ProtectedPaths.contains(root, resolved)) || this.isProtected(resolved)) {
        throw new ProtectedPathError(message('guard.symlinkEscape', { path: resolved }))
      }
    }
  }
}

export class ProtectedPathError extends MessageError {
  constructor(info: Message) {
    super(info)
    this.name = 'ProtectedPathError'
  }
}
