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
 * themselves are always denied. Desktop data outside ~/.codex is stricter still: the
 * App Support profile is never writable, and only exact platform-cache leaves named by
 * `CodexLocations` may be removed.
 */
export class ProtectedPaths {
  private readonly locations: CodexLocations
  private readonly activePluginDirectories: string[]
  readonly localMarketplaceSources: string[]

  /** Relative names inside ~/.codex that hold credentials, configuration or user work. */
  static readonly protectedHomeEntries = [
    'auth.json',
    'sqlite',
    '.codex-global-state.json',
    '.codex-global-state.json.bak',
    'config.toml',
    'config.json',
    'version.json',
    'instructions.md',
    'AGENTS.md',
    'rules',
    'hooks',
    'skills',
    'memories',
    'vendor_imports',
    'shell_snapshots',
    'attachments',
    'ambient-suggestions',
    'browser',
    'prompts',
    'bin',
    'log'
  ]

  /** Prefixes of files inside ~/.codex that must never be deleted. */
  static readonly protectedHomePrefixes = ['state_', 'thread_history_', 'goals_', 'queue_', 'memories_', 'history']

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

  private pathsEqual(left: string, right: string): boolean {
    return ProtectedPaths.contains(left, right) && ProtectedPaths.contains(right, left)
  }

  /** External Chromium/application roots are deny-by-default, including future profiles. */
  private isAllowedExternalCacheTarget(target: string): boolean {
    if (ProtectedPaths.contains(this.locations.appSupport, target)) {
      return false
    }
    if (this.locations.appCacheContainers.some((root) => ProtectedPaths.contains(root, target))) {
      return this.locations.appCaches.some((path) => this.pathsEqual(path, target))
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
