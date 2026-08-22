import { existsSync } from 'node:fs'
import { execFile, spawnSync } from 'node:child_process'

export type FileUsage = { kind: 'free' } | { kind: 'inUse'; processes: string[] } | { kind: 'unknown' }
export interface CodexEnvironment {
  running: boolean
  detectionKnown: boolean
  desktopRunning: boolean
  cliCommands: string[]
  canRestart: boolean
  blockerSummary: string | null
}

const MAC_BUNDLE_IDS = ['com.openai.codex', 'com.openai.chat']
const MAC_DESKTOP_PATH = /(?:Codex|ChatGPT)\.app[/\\]Contents[/\\]/i
const MAC_DESKTOP_MAIN_PATH = /(?:Codex|ChatGPT)\.app[/\\]Contents[/\\]MacOS[/\\](?:Codex|ChatGPT)(?=$|\s)/i
const MAC_DESKTOP_SESSION_SERVICE_PATH = /(?:Codex|ChatGPT)\.app[/\\]Contents[/\\]Resources[/\\]codex(?:\s|$).*\bapp-server\b/i
const COMPUTER_USE_HELPER_PATH = /Codex Computer Use\.app[/\\]Contents[/\\]MacOS[/\\]SkyComputerUseService/i

export function probeFileUsage(path: string): FileUsage {
  if (!existsSync(path)) return { kind: 'free' }
  if (process.platform === 'win32') return { kind: 'unknown' }
  const executable = ['/usr/sbin/lsof', '/usr/bin/lsof', '/opt/homebrew/bin/lsof'].find(existsSync)
  if (!executable) return { kind: 'unknown' }
  const result = spawnSync(executable, ['-n', '-P', '-F', 'cn', '--', path], { encoding: 'utf8', timeout: 5_000 })
  return fileUsageFromLsof(result.stdout ?? '', result.status, !!result.error || !!result.signal)
}

export function fileUsageFromLsof(stdout: string, status: number | null, executionFailed = false): FileUsage {
  const commands = [...new Set(stdout.split(/\r?\n/).filter((line) => line.startsWith('c')).map((line) => line.slice(1)).filter(Boolean))]
  if (commands.length) return { kind: 'inUse', processes: commands }
  if (executionFailed || (status !== 0 && status !== 1)) return { kind: 'unknown' }
  return { kind: 'free' }
}

export function codexEnvironment(): CodexEnvironment {
  const detected = runningCommands()
  if (detected === null) {
    return {
      running: true,
      detectionKnown: false,
      desktopRunning: false,
      cliCommands: [],
      canRestart: false,
      blockerSummary: '无法确认 Codex 是否正在运行'
    }
  }
  const commands = detected.filter(isCodexProcessCommand)
  const desktop = commands.filter(isCodexDesktopProcessCommand)
  const cli = commands.filter((command) => !isCodexDesktopProcessCommand(command))
  // Electron helpers (especially orphaned crashpad handlers) can outlive the app.
  // Ignore those, but keep waiting for the bundled app-server because it owns the
  // thread-history SQLite handles and can still write while the UI is gone.
  const desktopRunning = process.platform === 'darwin'
    ? commands.some((command) => isCodexDesktopMainProcessCommand(command) || isCodexDesktopSessionServiceCommand(command))
    : desktop.length > 0
  const parts: string[] = []
  if (desktopRunning) parts.push('ChatGPT/Codex 桌面应用或会话服务正在运行')
  if (cli.length) parts.push(`终端里有 ${cli.length} 个 codex 进程在运行`)
  return {
    running: desktopRunning || cli.length > 0,
    detectionKnown: true,
    desktopRunning,
    cliCommands: cli,
    canRestart: process.platform === 'darwin' && desktopRunning && cli.length === 0,
    blockerSummary: parts.length ? parts.join('；') : null
  }
}

export function codexIsRunning(): boolean { return codexEnvironment().running }

export async function quitCodexDesktop(timeoutMs = 20_000, forceAfterTimeout = false): Promise<string[]> {
  const environment = codexEnvironment()
  if (environment.cliCommands.length) throw new Error(`终端里还有 ${environment.cliCommands.length} 个 codex 进程，不会自动结束`)
  if (!environment.desktopRunning) return []
  if (process.platform !== 'darwin') throw new Error('当前平台不能安全地请求 Codex 保存并退出，请手动退出')
  const runningBundles = runningMacBundleIDs()
  if (!runningBundles.length) throw new Error('无法识别正在运行的 Codex 应用，请手动退出后重试')
  const failures: string[] = []
  for (const id of runningBundles) {
    try { await execFilePromise('/usr/bin/osascript', ['-e', `tell application id "${id}" to quit`]) }
    catch (error) { failures.push(`${id}：${error instanceof Error ? error.message : String(error)}`) }
  }
  if (failures.length === runningBundles.length) {
    throw new Error(`无法请求 ChatGPT 退出：${failures.join('；')}`)
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!codexEnvironment().desktopRunning) return runningBundles
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  if (forceAfterTimeout) {
    const pids = runningMacDesktopProcessIDs()
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL') } catch { /* process may have exited */ }
    }
    const forcedDeadline = Date.now() + 5_000
    while (Date.now() < forcedDeadline) {
      if (!codexEnvironment().desktopRunning) return runningBundles
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('已尝试强制结束 Codex，但仍检测到运行中的进程')
  }
  throw new Error('没能退出 Codex，可能有未保存的内容。请手动退出后重试。')
}

function runningMacDesktopProcessIDs(): number[] {
  const result = spawnSync('/bin/ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', timeout: 5_000 })
  if (result.status !== 0) return []
  return (result.stdout ?? '').split(/\r?\n/).flatMap((line): number[] => {
    if (!isCodexDesktopMainProcessCommand(line) && !isCodexDesktopSessionServiceCommand(line)) return []
    const pid = Number(line.trim().match(/^(\d+)/)?.[1])
    return Number.isInteger(pid) && pid > 1 ? [pid] : []
  })
}

function runningMacBundleIDs(): string[] {
  return MAC_BUNDLE_IDS.filter((id) => {
    const result = spawnSync('/usr/bin/osascript', ['-e', `application id "${id}" is running`], { encoding: 'utf8', timeout: 3_000 })
    return result.status === 0 && result.stdout.trim().toLowerCase() === 'true'
  })
}

export async function relaunchCodex(bundleIDs: string[]): Promise<void> {
  if (process.platform !== 'darwin') return
  for (const id of bundleIDs) await execFilePromise('/usr/bin/open', ['-g', '-b', id]).catch(() => undefined)
}

function runningCommands(): string[] | null {
  if (process.platform === 'win32') {
    const result = spawnSync('wmic', ['process', 'get', 'ExecutablePath,CommandLine', '/FORMAT:LIST'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 })
    if (result.status === 0) {
      return (result.stdout ?? '').split(/\r?\n\r?\n/).map((block) => block.replace(/\r?\n/g, ' ')).filter(Boolean)
    }
    const fallback = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ExecutablePath) $($_.CommandLine)" }'
    ], { encoding: 'utf8', windowsHide: true, timeout: 8_000 })
    return fallback.status === 0 ? (fallback.stdout ?? '').split(/\r?\n/).filter(Boolean) : null
  }
  const result = spawnSync('/bin/ps', ['-Ao', 'command='], { encoding: 'utf8', timeout: 5_000 })
  return result.status === 0 ? (result.stdout ?? '').split(/\r?\n/).filter(Boolean) : null
}

export function isCodexProcessCommand(command: string): boolean {
  if (/CleanMyCodex/i.test(command)) return false
  if (COMPUTER_USE_HELPER_PATH.test(command)) return false
  return /(?:^|[/\\\s"'=])codex(?:\.exe)?(?=$|[\s"'])/i.test(command)
    || MAC_DESKTOP_PATH.test(command)
}
export function isCodexDesktopProcessCommand(command: string): boolean {
  if (MAC_DESKTOP_PATH.test(command)) return true
  return process.platform === 'win32' && (/(?:AppData[/\\]Local[/\\]Programs|Program Files)[/\\]Codex.*codex\.exe/i.test(command) || /codex\.exe.*--type=/i.test(command))
}
export function isCodexDesktopMainProcessCommand(command: string): boolean {
  if (MAC_DESKTOP_MAIN_PATH.test(command)) return true
  return process.platform === 'win32'
    && /(?:AppData[/\\]Local[/\\]Programs|Program Files)[/\\]Codex.*codex\.exe/i.test(command)
    && !/--type=/i.test(command)
}
export function isCodexDesktopSessionServiceCommand(command: string): boolean {
  return MAC_DESKTOP_SESSION_SERVICE_PATH.test(command)
}
function execFilePromise(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 10_000 }, (error) => error ? reject(error) : resolve()))
}
