import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process'
import { createInterface } from 'node:readline'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Writable, Readable } from 'node:stream'

/**
 * Talks to `codex app-server` over newline-delimited JSON-RPC on stdio. Deleting a
 * thread through the app server is the only way to also drop the derived metadata and
 * spawned child threads, so it is preferred over removing the rollout file by hand.
 */

export interface InstalledPlugin {
  name: string
  version: string | null
  directory: string | null
}

export interface AppServerError {
  code: number
  message: string
}

/** Locate the `codex` CLI, honouring `CODEX_BINARY` and the usual install paths. */
export function locateCodexExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: string[] = []
  if (env['CODEX_BINARY'] && env['CODEX_BINARY'].length) candidates.push(env['CODEX_BINARY'])
  if (process.platform === 'win32') {
    const located = spawnSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true, timeout: 3_000 })
    if (located.status === 0) candidates.push(...located.stdout.split(/\r?\n/).filter(Boolean))
  }
  for (const dir of (env['PATH'] ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir.length) candidates.push(join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex'))
  }
  candidates.push('/opt/homebrew/bin/codex', '/usr/local/bin/codex', join(homedir(), '.codex/bin/codex'), join(homedir(), '.local/bin/codex'))
  return candidates.find((p) => fileIsExecutable(p)) ?? null
}

function fileIsExecutable(path: string): boolean {
  try {
    const stats = statSync(path)
    return stats.isFile() && (process.platform === 'win32' || (stats.mode & 0o111) !== 0)
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
  private nextID = 1
  private closed = false
  private readonly pending = new Map<number, PendingCall>()

  constructor(executable: string, codexHome: string, timeout = 20_000) {
    this.timeout = timeout
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
        call.reject(new Error('codex app-server 已退出'))
      }
      this.pending.clear()
    })
    this.process.on('error', (error) => {
      this.closed = true
      for (const call of this.pending.values()) {
        clearTimeout(call.timer)
        call.reject(new Error(`无法启动 codex app-server：${error.message}`))
      }
      this.pending.clear()
    })
    this.process.stdin.on('error', () => undefined)
  }

  async handshake(): Promise<void> {
    await this.call('initialize', {
      clientInfo: { name: 'cleanmycodex', title: 'CleanMyCodex', version: '0.1.0' },
      capabilities: { experimentalApi: false }
    })
    this.notify('initialized', {})
  }

  async deleteThread(threadID: string): Promise<unknown> {
    return this.call('thread/delete', { threadId: threadID })
  }

  async listPlugins(): Promise<unknown> {
    return this.call('plugin/list', {})
  }

  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('codex app-server 已退出'))
    const id = this.nextID++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`调用 ${method} 超时`))
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
      pending.reject(new Error(`codex 返回错误 ${err.code ?? -1}：${err.message ?? '未知错误'}`))
    } else {
      pending.resolve(object['result'])
    }
  }
}

export class AppServerClient {
  readonly executable: string | null
  private readonly codexHome: string
  private readonly timeout: number

  constructor(codexHome: string, executable: string | null = null, timeout = 20_000) {
    this.codexHome = codexHome
    this.executable = executable ?? locateCodexExecutable()
    this.timeout = timeout
  }

  get isAvailable(): boolean {
    return this.executable !== null
  }

  async openSession(): Promise<AppServerSession> {
    if (!this.executable) throw new Error('没有找到 codex 命令行，无法调用 app server')
    const session = new AppServerSession(this.executable, this.codexHome, this.timeout)
    await session.handshake()
    return session
  }

  /** Best-effort plugin inventory. Returns null when the app server cannot be reached. */
  async installedPlugins(): Promise<InstalledPlugin[] | null> {
    try {
      const session = await this.openSession()
      try {
        const response = await session.listPlugins()
        const plugins = parsePlugins(response)
        // An empty inventory is indistinguishable from an unknown response shape. Never
        // turn every on-disk plugin into an "orphan" on that evidence.
        return plugins.length ? plugins : null
      } finally {
        session.close()
      }
    } catch {
      return null
    }
  }
}

/**
 * `plugin/list` answers with marketplaces that each carry their own plugin rows:
 * `{"marketplaces":[{"name":"personal","plugins":[{"name":…,"localVersion":…,"source":{"path":…}}]}]}`.
 * Older shapes (a bare array, or a top-level `plugins` list) are still accepted.
 */
export function parsePlugins(response: unknown): InstalledPlugin[] {
  const rows: Record<string, unknown>[] = []
  if (Array.isArray(response)) {
    rows.push(...(response as Record<string, unknown>[]))
  } else if (response && typeof response === 'object') {
    const object = response as Record<string, unknown>
    for (const key of ['plugins', 'items', 'installed', 'entries']) {
      const list = object[key]
      if (Array.isArray(list)) rows.push(...(list as Record<string, unknown>[]))
    }
    for (const key of ['marketplaces', 'sources', 'registries']) {
      const marketplaces = object[key]
      if (!Array.isArray(marketplaces)) continue
      for (const marketplace of marketplaces as Record<string, unknown>[]) {
        for (const inner of ['plugins', 'items', 'entries']) {
          const list = marketplace[inner]
          if (Array.isArray(list)) rows.push(...(list as Record<string, unknown>[]))
        }
      }
    }
  }

  return rows
    .map((row): InstalledPlugin | null => {
      const name = firstString(row, ['name', 'pluginName', 'plugin']) ?? idName(row['id'])
      if (!name || !name.length) return null
      const version = firstString(row, ['localVersion', 'version', 'installedVersion', 'currentVersion', 'resolvedVersion'])
      let directory = firstString(row, ['path', 'directory', 'installPath', 'root', 'location'])
      if (!directory && row['source'] && typeof row['source'] === 'object') {
        directory = firstString(row['source'] as Record<string, unknown>, ['path', 'directory', 'root', 'location'])
      }
      if (directory?.startsWith('~/')) directory = join(homedir(), directory.slice(2))
      return { name, version: version ?? null, directory: directory ?? null }
    })
    .filter((p): p is InstalledPlugin => p !== null)
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
