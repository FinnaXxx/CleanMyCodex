import { basename, dirname, join, normalize, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import { CodexLocations } from './locations'
import { loadCodexConfiguration, type CodexConfiguration } from './configuration'

function outermost(paths: string[]): string[] {
  const unique = [...new Set(paths.map(normalize))]
  return unique.filter((candidate) => !unique.some(
    (other) => other !== candidate && ProtectedPaths.contains(other, candidate)
  ))
}

/**
 * The allow/deny list that every deletion goes through. Deny-by-default: a path must sit
 * inside one of the Codex data roots and must not match a protected entry. Writable roots
 * themselves are denied except for dedicated rebuildable roots explicitly allowlisted by
 * `CodexLocations`.
 */
export class ProtectedPaths {
  private readonly locations: CodexLocations
  private readonly activePluginDirectories: string[]
  readonly localMarketplaceSources: string[]

  /** Relative names inside ~/.codex that hold credentials, configuration or user work. */
  static readonly protectedHomeEntries = [
    'auth.json',
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

  /** Prefixes of files inside ~/.codex that must never be trashed. */
  static readonly protectedHomePrefixes = ['state_', 'thread_history_', 'goals_', 'queue_', 'memories_', 'history']

  /** Browser profile data that carries the Codex login. */
  static readonly protectedAppSupportEntries = [
    'Default/Cookies',
    'Default/Login Data',
    'Default/Local Storage',
    'Default/Session Storage',
    'Default/IndexedDB',
    'Default/databases',
    'Default/Preferences',
    'Default/Web Data',
    'Local State',
    'WidevineCdm',
    'WasmTtsEngine'
  ]

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

  private get removableRoots(): string[] {
    return this.locations.removableRoots.map(normalize)
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
    const isWritableRoot = this.writableRoots.some((root) => root === target)
      || canonicalRoots.some((root) => root === canonicalTarget)
    const isRemovableRoot = this.removableRoots.some((root) => root === target)
    if (isWritableRoot && !isRemovableRoot) {
      throw new ProtectedPathError(`不能整体删除数据目录：${target}`)
    }
    if (!this.writableRoots.some((root) => ProtectedPaths.contains(root, target))) {
      throw new ProtectedPathError(`不在 Codex 数据目录内：${target}`)
    }
    if (this.isProtected(target)) {
      throw new ProtectedPathError(`受保护的路径：${target}`)
    }
    let resolved: string
    try {
      resolved = canonicalTarget
    } catch {
      resolved = target
    }
    if (resolved !== target) {
      if (!canonicalRoots.some((root) => ProtectedPaths.contains(root, resolved)) || this.isProtected(resolved)) {
        throw new ProtectedPathError(`符号链接指向数据目录外：${resolved}`)
      }
    }
  }
}

export class ProtectedPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtectedPathError'
  }
}
