import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readdirSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { Writable, Readable } from 'node:stream'
import { MessageError, SCAN_STOPPED, describeMessage, message } from '../../shared/messages'

/** Talks to `codex app-server` over newline-delimited JSON-RPC on stdio. CleanMyCodex
 * currently uses it only to discover installed plugins; session scanning and cleanup
 * use the rollout files and local indexes/databases directly. */

export interface InstalledPlugin {
  marketplace: string | null
  name: string
  version: string | null
  directory: string | null
  /** null is used for older plugin/list response shapes that did not expose it. */
  installed: boolean | null
}

/** Locate the `codex` CLI, honouring `CODEX_BINARY` and the usual install paths. */
export function locateCodexExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string | null {
  const candidates: string[] = []
  if (env['CODEX_BINARY'] && env['CODEX_BINARY'].length) candidates.push(env['CODEX_BINARY'])
  // Prefer the desktop-bundled CLI because its app-server protocol matches the
  // installed desktop UI. A separately installed Homebrew/npm CLI can lag behind.
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
      join(home, 'Applications/ChatGPT.app/Contents/Resources/codex'),
      join(home, 'Applications/Codex.app/Contents/Resources/codex')
    )
  }
  if (platform === 'win32') {
    candidates.push(...windowsDesktopCodexCandidates(env, home))
    const located = spawnSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true, timeout: 3_000 })
    if (located.status === 0) candidates.push(...located.stdout.split(/\r?\n/).filter(Boolean))
  }
  for (const dir of (env['PATH'] ?? '').split(platform === 'win32' ? ';' : ':')) {
    if (dir.length) candidates.push(join(dir, platform === 'win32' ? 'codex.exe' : 'codex'))
  }
  candidates.push('/opt/homebrew/bin/codex', '/usr/local/bin/codex', join(home, '.codex/bin/codex'), join(home, '.local/bin/codex'))
  return candidates.find((path) => fileIsExecutable(path, platform)) ?? null
}

/** Desktop-managed Windows installs use version/hash directories that are not on the
 * normal user PATH. Return newest copies first when an upgrade left several behind. */
export function windowsDesktopCodexCandidates(env: NodeJS.ProcessEnv, home: string = homedir()): string[] {
  const localAppData = environmentValue(env, 'LOCALAPPDATA') ?? join(home, 'AppData', 'Local')
  const candidates = childExecutablesByNewest(
    join(localAppData, 'OpenAI', 'Codex', 'bin'),
    () => true,
    ['codex.exe']
  )
  candidates.push(
    join(localAppData, 'Programs', 'ChatGPT', 'resources', 'codex.exe'),
    join(localAppData, 'Programs', 'Codex', 'resources', 'codex.exe')
  )

  const systemDrive = environmentValue(env, 'SystemDrive') ?? 'C:'
  const programFilesRoots = [
    environmentValue(env, 'ProgramW6432'),
    environmentValue(env, 'ProgramFiles'),
    join(systemDrive, 'Program Files')
  ].filter((root, index, roots): root is string => Boolean(root) && roots.indexOf(root) === index)
  for (const root of programFilesRoots) {
    candidates.push(...childExecutablesByNewest(
      join(root, 'WindowsApps'),
      (name) => name.toLowerCase().startsWith('openai.codex_'),
      ['app', 'resources', 'codex.exe']
    ))
  }
  return candidates
}

function childExecutablesByNewest(root: string, acceptsDirectory: (name: string) => boolean, suffix: string[]): string[] {
  try {
    return readdirSync(root)
      .filter(acceptsDirectory)
      .map((name) => join(root, name, ...suffix))
      .filter((path) => fileIsExecutable(path, 'win32'))
      .sort((left, right) => modifiedAt(right) - modifiedAt(left))
  } catch {
    // WindowsApps is commonly unreadable to unpackaged processes. It is only a
    // fallback, so an inaccessible package directory must not block PATH lookup.
    return []
  }
}

function modifiedAt(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name]
  if (direct) return direct
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}

function fileIsExecutable(path: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const stats = statSync(path)
    return stats.isFile() && (platform === 'win32' || (stats.mode & 0o111) !== 0)
  } catch {
    return false
  }
}

interface PendingCall {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class AppServerSession {
  private readonly process: ChildProcessByStdio<Writable, Readable, null>
  private readonly timeout: number
  private readonly clientVersion: string
  private nextID = 1
  private closed = false
  private readonly pending = new Map<number, PendingCall>()

  constructor(executable: string, codexHome: string, clientVersion: string, timeout = 20_000) {
    this.timeout = timeout
    this.clientVersion = clientVersion
    const env = { ...process.env, CODEX_HOME: codexHome }
    this.process = spawn(executable, ['app-server'], {
      env,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })

    const lines = createInterface({ input: this.process.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => this.handleLine(line))

    this.process.on('exit', () => {
      this.closed = true
      for (const call of this.pending.values()) {
        clearTimeout(call.timer)
        call.reject(new MessageError(message('error.appServerExited')))
      }
      this.pending.clear()
    })
    this.process.on('error', (error) => {
      this.closed = true
      for (const call of this.pending.values()) {
        clearTimeout(call.timer)
        call.reject(new MessageError(message('error.appServerSpawnFailed', { reason: error.message })))
      }
      this.pending.clear()
    })
    this.process.stdin.on('error', () => undefined)
  }

  async handshake(): Promise<void> {
    await this.call('initialize', {
      clientInfo: { name: 'cleanmycodex', title: 'Clean My Codex', version: this.clientVersion },
      capabilities: { experimentalApi: false }
    })
    this.notify('initialized', {})
  }

  async listPlugins(): Promise<unknown> {
    return this.call('plugin/list', {})
  }

  async deleteThread(threadID: string): Promise<unknown> {
    return this.call('thread/delete', { threadId: threadID })
  }

  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new MessageError(message('error.appServerExited')))
    const id = this.nextID++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new MessageError(message('error.appServerTimeout', { method })))
      }, this.timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.process.stdin.end()
    } catch {
      /* ignore */
    }
    this.process.kill()
  }

  private send(message: Record<string, unknown>): void {
    this.process.stdin.write(JSON.stringify(message) + '\n')
  }

  private handleLine(line: string): void {
    let object: Record<string, unknown>
    try {
      object = JSON.parse(line)
    } catch {
      return
    }
    const id = typeof object['id'] === 'number' ? (object['id'] as number) : null
    if (id === null) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (object['error']) {
      const err = object['error'] as { code?: number; message?: string }
      pending.reject(new MessageError(message('error.appServerError', { code: err.code ?? -1, reason: err.message ?? '' })))
    } else {
      pending.resolve(object['result'])
    }
  }
}

export class AppServerClient {
  private cachedExecutable: string | null
  private readonly codexHome: string
  private readonly clientVersion: string
  private readonly timeout: number
  private readonly locateExecutable: () => string | null

  constructor(
    codexHome: string,
    clientVersion: string,
    executable: string | null = null,
    timeout = 20_000,
    locateExecutable: () => string | null = locateCodexExecutable
  ) {
    this.codexHome = codexHome
    this.clientVersion = clientVersion
    this.locateExecutable = locateExecutable
    this.cachedExecutable = executable ?? this.locateExecutable()
    this.timeout = timeout
  }

  get executable(): string | null {
    return this.cachedExecutable
  }

  get isAvailable(): boolean {
    return this.resolveExecutable() !== null
  }

  async openSession(signal?: AbortSignal): Promise<AppServerSession> {
    const executable = this.resolveExecutable()
    if (!executable) throw new MessageError(message('error.codexBinaryMissing'))
    const session = new AppServerSession(executable, this.codexHome, this.clientVersion, this.timeout)
    const abort = () => session.close()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      if (signal?.aborted) throw new DOMException(SCAN_STOPPED, 'AbortError')
      await session.handshake()
      if (signal?.aborted) throw new DOMException(SCAN_STOPPED, 'AbortError')
      return session
    } catch (error) {
      session.close()
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  private resolveExecutable(): string | null {
    // Do not cache a failed startup lookup forever. Codex can be installed, upgraded,
    // or added to PATH while CleanMyCodex remains open.
    if (!this.cachedExecutable) this.cachedExecutable = this.locateExecutable()
    return this.cachedExecutable
  }

  /**
   * Best-effort plugin inventory. Returns null when the app server cannot be reached.
   *
   * `onFailure` reports why it came back null. Without it the difference between "Codex
   * says no plugins", "the CLI could not be started" and "the response shape moved" is
   * invisible, and all three lock every plugin on disk in exactly the same way.
   */
  async installedPlugins(
    signal?: AbortSignal,
    onFailure?: (reason: string) => void
  ): Promise<InstalledPlugin[] | null> {
    let session: AppServerSession | null = null
    const abort = () => session?.close()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      session = await this.openSession(signal)
      if (signal?.aborted) throw new DOMException(SCAN_STOPPED, 'AbortError')
      const response = await session.listPlugins()
      const plugins = parsePlugins(response)
      // An empty inventory is indistinguishable from an unknown response shape. Never
      // turn every on-disk plugin into an "orphan" on that evidence.
      if (!plugins.length) onFailure?.('no plugin rows parsed from the response')
      return plugins.length ? plugins : null
    } catch (error) {
      // A MessageError hides an encoded token in its text; report its key instead.
      if (!signal?.aborted) {
        onFailure?.(error instanceof MessageError ? describeMessage(error.info)
          : error instanceof Error ? error.message : String(error))
      }
      return null
    } finally {
      signal?.removeEventListener('abort', abort)
      session?.close()
    }
  }

  /** Prefer Codex's own deletion protocol. Each subagent is an independent thread,
   * so callers provide the complete root/subagent set in child-first order. */
  async deleteThreads(threadIDs: string[], onFailure?: (reason: string) => void): Promise<boolean> {
    let session: AppServerSession | null = null
    try {
      session = await this.openSession()
      for (const threadID of threadIDs) await session.deleteThread(threadID)
      return true
    } catch (error) {
      onFailure?.(error instanceof MessageError ? describeMessage(error.info)
        : error instanceof Error ? error.message : String(error))
      return false
    } finally {
      session?.close()
    }
  }
}

/**
 * `plugin/list` answers with marketplaces that each carry their own plugin rows:
 * `{"marketplaces":[{"name":"personal","plugins":[{"name":…,"localVersion":…,"source":{"path":…}}]}]}`.
 * Older shapes (a bare array, or a top-level `plugins` list) are still accepted.
 */
export function parsePlugins(response: unknown): InstalledPlugin[] {
  const rows: Array<{ marketplace: string | null; plugin: Record<string, unknown> }> = []
  if (Array.isArray(response)) {
    rows.push(...(response as Record<string, unknown>[]).map((plugin) => ({ marketplace: null, plugin })))
  } else if (response && typeof response === 'object') {
    const object = response as Record<string, unknown>
    for (const key of ['plugins', 'items', 'installed', 'entries']) {
      const list = object[key]
      if (Array.isArray(list)) {
        rows.push(...(list as Record<string, unknown>[]).map((plugin) => ({ marketplace: null, plugin })))
      }
    }
    for (const key of ['marketplaces', 'sources', 'registries']) {
      const marketplaces = object[key]
      if (!Array.isArray(marketplaces)) continue
      for (const marketplace of marketplaces as Record<string, unknown>[]) {
        const marketplaceName = firstString(marketplace, ['name', 'id', 'marketplace']) ?? null
        for (const inner of ['plugins', 'items', 'entries']) {
          const list = marketplace[inner]
          if (Array.isArray(list)) {
            rows.push(...(list as Record<string, unknown>[]).map((plugin) => ({ marketplace: marketplaceName, plugin })))
          }
        }
      }
    }
  }

  return rows
    .map(({ marketplace, plugin: row }): InstalledPlugin | null => {
      const name = firstString(row, ['name', 'pluginName', 'plugin']) ?? idName(row['id'])
      if (!name || !name.length) return null
      // `localVersion` is the version materialized on disk; `version` is the one the
      // marketplace backend advertises, which is the latest available rather than the
      // installed one. A row that carries `localVersion` is answering the question
      // directly, so a null there means "not known", never "look at the remote version" —
      // reading the remote one would call the only copy on disk a superseded remnant.
      const version = 'localVersion' in row
        ? firstString(row, ['localVersion'])
        : firstString(row, ['version', 'installedVersion', 'currentVersion', 'resolvedVersion'])
      let directory = firstString(row, ['path', 'directory', 'installPath', 'root', 'location'])
      if (!directory) directory = sourceDirectory(row['source'])
      if (directory?.startsWith('~/')) directory = join(homedir(), directory.slice(2))
      // Only an absolute path names an install directory. A git source's `path` is a
      // subdirectory inside the repository, and resolving it against this app's working
      // directory would compare a plugin against somewhere it has never been.
      if (directory && !isAbsolute(directory)) directory = undefined
      const installed = typeof row['installed'] === 'boolean' ? row['installed'] as boolean : null
      return { marketplace, name, version: version ?? null, directory: directory ?? null, installed }
    })
    .filter((p): p is InstalledPlugin => p !== null)
}

/**
 * The install directory a plugin's `source` names, if any. `source` is a tagged union —
 * `{"type":"local","path":…}` is the only variant whose `path` is an install location.
 * `git` carries the subdirectory inside the repository under the same key.
 */
function sourceDirectory(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') return undefined
  const row = source as Record<string, unknown>
  const kind = typeof row['type'] === 'string' ? (row['type'] as string).toLowerCase() : null
  if (kind && kind !== 'local') return undefined
  return firstString(row, ['path', 'directory', 'root', 'location'])
}

function firstString(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.length) return value
  }
  return undefined
}

function idName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.split('@')[0]
}
