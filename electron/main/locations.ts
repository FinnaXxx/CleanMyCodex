import { homedir, platform } from 'node:os'
import { join, normalize } from 'node:path'

/** Chromium cache directory names observed across desktop app versions. */
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

/** Rebuildable cache leaves currently defined by the Codex sources. */
const CODEX_CACHE_DIRECTORY_NAMES = [
  'remote_plugin_catalog',
  'codex_apps_server_info',
  'codex_apps_tools',
  'codex_app_directory',
  'tui-pets'
]

/**
 * Known cache leaves inside `~/.codex/cache`. The container is deliberately absent:
 * future Codex versions may add live state beside these rebuildable directories.
 */
export function codexCacheDirectories(container: string, path = { join }): string[] {
  return CODEX_CACHE_DIRECTORY_NAMES.map((name) => path.join(container, name))
}

/**
 * The cache directories inside one application cache container, and inside its `Default`
 * profile. Never the container itself: an application's cache directory is its own
 * private space. These names are used only to account for known cache leaves; both the
 * leaves and anything beside them remain protected from deletion.
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
 * - `caches` — platform cache roots. macOS `~/Library/Caches`, Windows `%LOCALAPPDATA%`,
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
  /** Recognized rebuildable leaves; the cache container itself stays protected. */
  get codexCaches(): string[] { return codexCacheDirectories(this.codexCache) }
  /** Where Codex unpacks the marketplace that ships with the release. Scratch-looking,
   *  but live: config.toml registers it as the `openai-bundled` marketplace source. */
  get bundledMarketplaces(): string { return join(this.temporary, 'bundled-marketplaces') }
  get bundledMarketplaceSource(): string { return join(this.bundledMarketplaces, 'openai-bundled') }

  /**
   * Codex' own scratch root for the arg0 helper shims (`apply_patch`, the sandbox
   * binaries). Codex creates one locked directory per running process under it and, on
   * every launch, deletes every sibling whose lock it can take — so an unlocked directory
   * here is by Codex' own definition abandoned. This is `tmp`, a different directory from
   * the `.tmp` staging root above, which holds live locks and marketplace state.
   */
  get arg0Temporary(): string { return join(this.home, 'tmp', 'arg0') }

  /** Marketplaces Codex has installed. Live state, not scratch. */
  get marketplaceInstalls(): string { return join(this.temporary, 'marketplaces') }

  /**
   * Staging parents whose children are always transient copies: Codex stages a
   * marketplace or plugin here, renames the finished tree into place, and drops the
   * staging directory. Anything left below one of these outlived the process that made it.
   */
  get stagingParents(): string[] {
    return [
      join(this.marketplaceInstalls, '.staging'),
      join(this.plugins, '.remote-plugin-install-staging'),
      join(this.plugins, '.marketplace-plugin-source-staging')
    ]
  }

  get generatedImages(): string { return join(this.home, 'generated_images') }
  get visualizations(): string { return join(this.home, 'visualizations') }
  /** Rendered viewers Codex materializes from the fragments under `visualizations`, keyed
   *  by thread. Derived output — Codex' own code calls these the viewer caches. */
  get visualizationViewers(): string { return join(this.home, 'visualization-viewers') }
  get computerUse(): string { return join(this.home, 'computer-use') }

  // --- Outside ~/.codex ---

  get appSupport(): string {
    return join(this.library, platform() === 'darwin' ? 'Application Support/Codex' : 'Codex')
  }

  /**
   * The per-product cache containers. Read for size accounting and used as roots the
   * guard recognizes as protected roots — never as deletion targets. Installers,
   * updaters and future builds may put state beside cache-shaped folders below them.
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

  /** Recognized cache leaves inside those containers, shown as protected usage. */
  get appCaches(): string[] {
    return this.appCacheContainers.flatMap((container) => appCacheDirectories(container))
  }

  /**
   * Where the desktop application writes its own logs, one file per session per process,
   * below a `YYYY/MM/DD` directory. macOS keys the directory by bundle identity; Windows
   * puts it under the local app data root rather than the roaming one.
   */
  get appLogs(): string {
    switch (platform()) {
      case 'darwin': return join(this.library, 'Logs', 'com.openai.codex')
      case 'win32': return join(this.caches, 'Codex', 'Logs')
      default: return join(this.library, 'Codex', 'Logs')
    }
  }

  /** Where CleanMyCodex keeps its own rescan cache. Never a cleanup target. */
  get scanCache(): string {
    return join(this.caches, 'CleanMyCodex')
  }

  /** Roots recognized by path validation. Anything outside is rejected; individual
   *  roots may be fully locked by `ProtectedPaths`. The log root is deliberately absent:
   *  the application rotates it, so nothing below it is ever a deletion target. */
  get writableRoots(): string[] {
    return [this.home, this.appSupport, this.workspace, ...this.appCacheContainers]
  }
}
