import { homedir, platform } from 'node:os'
import { join, normalize, sep } from 'node:path'

/** `root` itself, or anything below it. The guard exposes the same test, but it imports
 *  this module, so the check is repeated here rather than creating a cycle. */
function containsPath(root: string, candidate: string): boolean {
  const comparable = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
  const r = comparable(normalize(root)).split(sep).filter(Boolean)
  const c = comparable(normalize(candidate)).split(sep).filter(Boolean)
  if (c.length < r.length) return false
  return r.every((part, i) => c[i] === part)
}

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
 *   `%APPDATA%`.
 * - `caches` — platform cache roots. macOS `~/Library/Caches`, Windows `%LOCALAPPDATA%`.
 *
 * `documents` holds the sandbox workspace (`~/Documents/Codex`).
 */
export class CodexLocations {
  readonly home: string
  readonly library: string
  readonly caches: string
  readonly documents: string

  /**
   * Directories holding Codex-managed git worktrees. The desktop application lets the
   * user move this root, and moving it leaves the existing worktrees where they are, so
   * several roots can be live at once. The scan discovers them rather than assuming one;
   * this field carries whatever it found, and always includes the default location.
   */
  readonly worktreeRoots: string[]

  constructor(opts: { home?: string; library?: string; caches?: string; documents?: string; worktreeRoots?: string[] } = {}) {
    this.home = normalize(opts.home ?? CodexLocations.resolveHome())
    this.library = normalize(opts.library ?? CodexLocations.defaultLibrary())
    this.caches = normalize(opts.caches ?? CodexLocations.defaultCaches())
    this.documents = normalize(opts.documents ?? join(homedir(), 'Documents'))
    this.worktreeRoots = [...new Set([
      normalize(join(this.home, 'worktrees')),
      ...(opts.worktreeRoots ?? []).map(normalize)
    ])]
  }

  /** The same locations with an additional set of discovered worktree roots. */
  withWorktreeRoots(roots: string[]): CodexLocations {
    return new CodexLocations({
      home: this.home,
      library: this.library,
      caches: this.caches,
      documents: this.documents,
      worktreeRoots: [...this.worktreeRoots, ...roots]
    })
  }

  private static defaultLibrary(): string {
    switch (platform()) {
      case 'darwin': return join(homedir(), 'Library')
      case 'win32': return process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
      default: throw new Error(`Unsupported platform: ${platform()}`)
    }
  }

  private static defaultCaches(): string {
    switch (platform()) {
      case 'darwin': return join(homedir(), 'Library', 'Caches')
      case 'win32': return process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
      default: throw new Error(`Unsupported platform: ${platform()}`)
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

  /** Where the standalone installer keeps one directory per Codex release it has put on
   *  this machine, with `current` a symlink to the one in use. */
  get standalonePackages(): string { return join(this.home, 'packages', 'standalone') }
  get standaloneReleases(): string { return join(this.standalonePackages, 'releases') }
  get standaloneCurrent(): string { return join(this.standalonePackages, 'current') }

  /** The default worktree root, kept separate from the discovered set for tests. */
  get defaultWorktrees(): string { return join(this.home, 'worktrees') }

  get generatedImages(): string { return join(this.home, 'generated_images') }
  get visualizations(): string { return join(this.home, 'visualizations') }
  /** Rendered viewers Codex materializes from the fragments under `visualizations`, keyed
   *  by thread. Derived output — Codex' own code calls these the viewer caches. */
  get visualizationViewers(): string { return join(this.home, 'visualization-viewers') }
  /** Plan-mode output: one directory per conversation under `plans/<thread-id>`, holding
   *  the PLAN.md revisions that conversation produced. The open-source CLI never writes
   *  here, so each `<thread-id>` directory is validated at runtime before it is claimed. */
  get plans(): string { return join(this.home, 'plans') }
  get computerUse(): string { return join(this.home, 'computer-use') }

  // --- Outside ~/.codex ---

  get appSupport(): string {
    switch (platform()) {
      case 'darwin': return join(this.library, 'Application Support/Codex')
      case 'win32': return join(this.library, 'Codex')
      default: throw new Error(`Unsupported platform: ${platform()}`)
    }
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
      default: throw new Error(`Unsupported platform: ${platform()}`)
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
      default: throw new Error(`Unsupported platform: ${platform()}`)
    }
  }

  /** Where CleanMyCodex keeps its own rescan cache. Never a cleanup target. */
  get scanCache(): string {
    return join(this.caches, 'CleanMyCodex')
  }

  /**
   * Application-support directories that are read for size accounting only. The
   * bundle-identifier variant sits here rather than in `appSupport`: its contents are
   * unknown, so it is counted and shown but is never part of `writableRoots`, which
   * leaves path validation with nothing to allow below it.
   */
  get readOnlyAppSupport(): string[] {
    switch (platform()) {
      case 'darwin': return [join(this.library, 'Application Support/com.openai.codex')]
      case 'win32': return []
      default: throw new Error(`Unsupported platform: ${platform()}`)
    }
  }

  /** Roots recognized by path validation. Anything outside is rejected; individual
   *  roots may be fully locked by `ProtectedPaths`. The log root is deliberately absent:
   *  the application rotates it, so nothing below it is ever a deletion target. */
  get writableRoots(): string[] {
    return [this.home, this.appSupport, this.workspace, ...this.appCacheContainers,
      ...this.worktreeRoots.filter((root) => !containsPath(this.home, root))]
  }
}
