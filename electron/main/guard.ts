import { resolve, normalize, sep } from 'node:path'
import { CodexLocations } from './locations'

/**
 * The allow/deny list that every deletion goes through. Deny-by-default: a path must sit
 * inside one of the Codex data roots, must not be a root itself, and must not match a
 * protected entry. Mirrors the Swift app's ProtectedPaths.
 */
export class ProtectedPaths {
  private readonly locations: CodexLocations
  private readonly activePluginDirectories: string[]

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
    'prompts',
    'bin',
    'log'
  ]

  /** Prefixes of files inside ~/.codex that must never be trashed. */
  static readonly protectedHomePrefixes = ['state_', 'history']

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
    'WidevineCdm'
  ]

  constructor(locations: CodexLocations, activePluginDirectories: string[] = []) {
    this.locations = locations
    this.activePluginDirectories = activePluginDirectories.map((d) => normalize(d))
  }

  private get protectedURLs(): string[] {
    const urls: string[] = []
    for (const name of ProtectedPaths.protectedHomeEntries) urls.push(normalize(`${this.locations.home}/${name}`))
    for (const name of ProtectedPaths.protectedAppSupportEntries) urls.push(normalize(`${this.locations.appSupport}/${name}`))
    urls.push(normalize(`${this.locations.documents}/Codex`))
    urls.push(...this.activePluginDirectories)
    return urls
  }

  private get writableRoots(): string[] {
    return this.locations.writableRoots.map(normalize)
  }

  /** True when `candidate` is `root` itself or lives below it. */
  static contains(root: string, candidate: string): boolean {
    const r = normalize(root).split(sep).filter(Boolean)
    const c = normalize(candidate).split(sep).filter(Boolean)
    if (c.length < r.length) return false
    return r.every((part, i) => c[i] === part)
  }

  isProtected(url: string): boolean {
    const target = normalize(url)
    if (this.protectedURLs.some((p) => ProtectedPaths.contains(p, target))) return true
    // state_*.sqlite, history.jsonl … directly inside ~/.codex.
    const parent = normalize(target + '/..')
    if (normalize(parent) === normalize(this.locations.home)) {
      const name = target.split(sep).pop() ?? ''
      if (ProtectedPaths.protectedHomePrefixes.some((prefix) => name.startsWith(prefix))) return true
    }
    return false
  }

  /** Resolves symlinks so a link cannot point the engine somewhere outside the roots. */
  validate(url: string): void {
    const target = normalize(url)
    if (this.writableRoots.some((root) => root === target)) {
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
      resolved = resolve(target)
    } catch {
      resolved = target
    }
    if (resolved !== target) {
      if (!this.writableRoots.some((root) => ProtectedPaths.contains(root, resolved)) || this.isProtected(resolved)) {
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