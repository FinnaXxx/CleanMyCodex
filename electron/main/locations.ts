import { homedir, platform } from 'node:os'
import { join, normalize, win32 } from 'node:path'

export function windowsAppCacheDirectories(localAppData: string): string[] {
  const relatives = ['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache']
  return ['Codex', 'com.openai.codex'].flatMap((root) => relatives.map((name) => win32.join(localAppData, root, name)))
}

/**
 * Every directory CleanMyCodex is allowed to look at, derived from a single Codex home.
 *
 * On macOS the layout mirrors what the Codex desktop app writes: `~/.codex` for runtime
 * data, `~/Library/Application Support/Codex` for profile data, `~/Library/Caches/…` for
 * rebuildable caches, `~/Library/Logs/com.openai.codex` for logs, and `~/Documents/Codex`
 * for the sandbox workspace. On Windows the same roles map to `%APPDATA%` / `%LOCALAPPDATA%`.
 *
 * `CODEX_HOME` overrides the home directory, mirroring Codex itself.
 */
export class CodexLocations {
  readonly home: string
  readonly library: string
  readonly documents: string

  constructor(opts: { home?: string; library?: string; documents?: string } = {}) {
    this.home = normalize(opts.home ?? CodexLocations.resolveHome())
    const isMac = platform() === 'darwin'
    this.library = normalize(opts.library ?? (isMac ? join(homedir(), 'Library') : process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')))
    this.documents = normalize(opts.documents ?? join(homedir(), 'Documents'))
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
    return new CodexLocations({ home: CodexLocations.resolveHome() })
  }

  // --- Inside ~/.codex ---

  get sessions(): string { return join(this.home, 'sessions') }
  get archivedSessions(): string { return join(this.home, 'archived_sessions') }
  get plugins(): string { return join(this.home, 'plugins') }
  get pluginCache(): string { return join(this.plugins, 'cache') }
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
    const isMac = platform() === 'darwin'
    return join(this.library, isMac ? 'Application Support/Codex' : 'Codex')
  }

  get appCaches(): string[] {
    const isMac = platform() === 'darwin'
    if (isMac) {
      return [
        join(this.library, 'Caches/Codex'),
        join(this.library, 'Caches/com.openai.codex')
      ]
    }
    const local = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
    // Never classify the whole LocalAppData/Codex directory as cache: installers and
    // future builds may put executable or profile data beside these well-known folders.
    return windowsAppCacheDirectories(local)
  }

  get appLogs(): string {
    const isMac = platform() === 'darwin'
    return join(this.library, isMac ? 'Logs/com.openai.codex' : 'Codex/Logs')
  }

  /** Where CleanMyCodex keeps its own rescan cache. Never a cleanup target. */
  get scanCache(): string {
    const isMac = platform() === 'darwin'
    if (isMac) return join(this.library, 'Caches/CleanMyCodex')
    return join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'CleanMyCodex')
  }

  /** Chromium-style caches that the desktop app rebuilds on demand. */
  get browserCacheDirectories(): string[] {
    return [
      'Default/Cache',
      'Default/Code Cache',
      'Default/DawnGraphiteCache',
      'Default/DawnWebGPUCache',
      'Default/GPUCache',
      'Default/Service Worker/CacheStorage',
      'Default/Service Worker/ScriptCache',
      'Cache',
      'GraphiteDawnCache',
      'GPUCache',
      'ShaderCache',
      'GrShaderCache',
      'component_crx_cache',
      'extensions_crx_cache'
    ].map((rel) => join(this.appSupport, rel))
  }

  /** Roots the cleanup engine will ever touch. Anything outside is rejected. */
  get writableRoots(): string[] {
    return [this.home, this.appSupport, this.appLogs, this.workspace, ...this.appCaches]
  }

  /** Dedicated, rebuildable roots that may themselves be removed. Other writable roots
   *  contain user data or mixed-purpose application state and only allow child targets. */
  get removableRoots(): string[] {
    return this.appCaches
  }
}
