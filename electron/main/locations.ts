import { homedir, platform } from 'node:os'
import { join, normalize } from 'node:path'

/** Chromium's rebuildable cache directories, by the names it has used across versions. */
const CACHE_DIRECTORY_NAMES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'ShaderCache',
  'GrShaderCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GraphiteDawnCache'
]

/**
 * The cache directories inside one application cache container, and inside its `Default`
 * profile. Never the container itself: an application's cache directory is its own
 * private space, and only these well-known names are known to be rebuildable. Anything
 * else the app keeps beside them — session state included — is not ours to delete.
 */
export function appCacheDirectories(container: string, path = { join }): string[] {
  return [
    ...CACHE_DIRECTORY_NAMES.map((name) => path.join(container, name)),
    ...CACHE_DIRECTORY_NAMES.map((name) => path.join(container, 'Default', name))
  ]
}

/**
 * Every directory CleanMyCodex is allowed to look at, derived from a single Codex home.
 *
 * Three roots are injectable, and every platform-specific path below hangs off one of
 * them, so a test (or a future sandbox) can point the whole app at a temporary tree:
 *
 * - `home` — Codex' runtime data (`~/.codex`, or `CODEX_HOME`).
 * - `library` — profile and application-support data. macOS `~/Library`, Windows
 *   `%APPDATA%`, Linux `$XDG_CONFIG_HOME`.
 * - `caches` — rebuildable caches. macOS `~/Library/Caches`, Windows `%LOCALAPPDATA%`,
 *   Linux `$XDG_CACHE_HOME`.
 *
 * `documents` holds the sandbox workspace (`~/Documents/Codex`).
 */
export class CodexLocations {
  readonly home: string
  readonly library: string
  readonly caches: string
  readonly documents: string

  constructor(opts: { home?: string; library?: string; caches?: string; documents?: string } = {}) {
    this.home = normalize(opts.home ?? CodexLocations.resolveHome())
    this.library = normalize(opts.library ?? CodexLocations.defaultLibrary())
    this.caches = normalize(opts.caches ?? CodexLocations.defaultCaches())
    this.documents = normalize(opts.documents ?? join(homedir(), 'Documents'))
  }

  private static defaultLibrary(): string {
    switch (platform()) {
      case 'darwin': return join(homedir(), 'Library')
      case 'win32': return process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
      default: return process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config')
    }
  }

  private static defaultCaches(): string {
    switch (platform()) {
      case 'darwin': return join(homedir(), 'Library', 'Caches')
      case 'win32': return process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
      default: return process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache')
    }
  }

  /** Codex' sandbox workspace: session work dirs and outputs. User work product — visible
   *  and selectable, never preselected or auto-cleaned. */
  get workspace(): string {
    return join(this.documents, 'Codex')
  }

  static resolveHome(env: NodeJS.ProcessEnv = process.env): string {
    if (env['CODEX_HOME'] && env['CODEX_HOME'].length) return normalize(env['CODEX_HOME'])
    return join(homedir(), '.codex')
  }

  static standard(): CodexLocations {
    return new CodexLocations()
  }

  // --- Inside ~/.codex ---

  get sessions(): string { return join(this.home, 'sessions') }
  get archivedSessions(): string { return join(this.home, 'archived_sessions') }
  get plugins(): string { return join(this.home, 'plugins') }
  get pluginRuntime(): string { return join(this.plugins, '.plugin-appserver') }
  get temporary(): string { return join(this.home, '.tmp') }
  get codexCache(): string { return join(this.home, 'cache') }
  /** Where Codex unpacks the marketplace that ships with the release. Scratch-looking,
   *  but live: config.toml registers it as the `openai-bundled` marketplace source. */
  get bundledMarketplaces(): string { return join(this.temporary, 'bundled-marketplaces') }
  get bundledMarketplaceSource(): string { return join(this.bundledMarketplaces, 'openai-bundled') }
  get generatedImages(): string { return join(this.home, 'generated_images') }
  get visualizations(): string { return join(this.home, 'visualizations') }
  get computerUse(): string { return join(this.home, 'computer-use') }

  // --- Outside ~/.codex ---

  get appSupport(): string {
    return join(this.library, platform() === 'darwin' ? 'Application Support/Codex' : 'Codex')
  }

  /**
   * The per-product cache containers. Read for size accounting and used as roots the
   * engine may reach into — never as deletion targets. Installers, updaters and future
   * builds put profile and executable data beside the cache folders below them.
   */
  get appCacheContainers(): string[] {
    switch (platform()) {
      case 'darwin':
      case 'win32':
        return [join(this.caches, 'Codex'), join(this.caches, 'com.openai.codex')]
      default:
        return [join(this.caches, 'Codex')]
    }
  }

  /** The rebuildable cache directories inside those containers. */
  get appCaches(): string[] {
    return this.appCacheContainers.flatMap((container) => appCacheDirectories(container))
  }

  get appLogs(): string {
    return join(this.library, platform() === 'darwin' ? 'Logs/com.openai.codex' : 'Codex/Logs')
  }

  /** Where CleanMyCodex keeps its own rescan cache. Never a cleanup target. */
  get scanCache(): string {
    return join(this.caches, 'CleanMyCodex')
  }

  /** Chromium-style caches that the desktop app rebuilds on demand. */
  get browserCacheDirectories(): string[] {
    return [
      'Default/Cache',
      'Default/Code Cache',
      'Default/DawnGraphiteCache',
      'Default/DawnWebGPUCache',
      'Default/GPUCache',
      'Cache',
      'GraphiteDawnCache',
      'GPUCache',
      'ShaderCache',
      'GrShaderCache',
      'component_crx_cache',
      'extensions_crx_cache'
    ].map((rel) => join(this.appSupport, rel))
  }

  /** Roots the cleanup engine will ever touch. Anything outside is rejected, and no root
   *  is ever a target itself — only named entries below one. */
  get writableRoots(): string[] {
    return [this.home, this.appSupport, this.appLogs, this.workspace, ...this.appCacheContainers]
  }
}
