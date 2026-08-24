import { spawnSync, execFile } from 'node:child_process'
import { MessageError, message, type Message } from '../../shared/messages'

export interface CodexEnvironment {
  running: boolean
  detectionKnown: boolean
  desktopRunning: boolean
  cliCommands: string[]
  canQuit: boolean
  /** Why Codex counts as running; empty when it is not. */
  blockers: Message[]
}

const MAC_BUNDLE_IDS = ['com.openai.codex', 'com.openai.chat']
const MAC_DESKTOP_PATH = /(?:Codex|ChatGPT)\.app[/\\]Contents[/\\]/i
const MAC_DESKTOP_MAIN_PATH = /(?:Codex|ChatGPT)\.app[/\\]Contents[/\\]MacOS[/\\](?:Codex|ChatGPT)(?=$|\s)/i
const MAC_DESKTOP_SESSION_SERVICE_PATH = /(?:Codex|ChatGPT)\.app[/\\]Contents[/\\]Resources[/\\]codex(?:\s|$).*\bapp-server\b/i
const MAC_DESKTOP_CRASHPAD_PATH = /(?:Codex|ChatGPT)\.app[/\\]Contents[/\\].*[/\\](?:browser|chrome)_crashpad_handler(?=$|\s)/i
const COMPUTER_USE_HELPER_PATH = /Codex Computer Use\.app[/\\]Contents[/\\]MacOS[/\\]SkyComputerUseService/i

export function codexEnvironment(): CodexEnvironment {
  const detected = runningCommands()
  if (detected === null) {
    return {
      running: true,
      detectionKnown: false,
      desktopRunning: false,
      cliCommands: [],
      canQuit: false,
      blockers: [message('blocker.detectionFailed')]
    }
  }
  const commands = detected.filter(isCodexProcessCommand)
  const desktop = commands.filter(isCodexDesktopProcessCommand)
  const cli = commands.filter((command) => !isCodexDesktopProcessCommand(command))
  // Chromium's network/storage/renderer helpers can keep profile handles open after the
  // main window disappears. Wait for all desktop children except crashpad, whose only
  // job is reporting crashes and which commonly survives a normal app quit.
  const desktopRunning = process.platform === 'darwin'
    ? commands.some(isCodexDesktopActiveProcessCommand)
    : desktop.length > 0
  const blockers: Message[] = []
  if (desktopRunning) blockers.push(message('blocker.desktopRunning'))
  if (cli.length) blockers.push(message('blocker.cliRunning', { count: cli.length }))
  return {
    running: desktopRunning || cli.length > 0,
    detectionKnown: true,
    desktopRunning,
    cliCommands: cli,
    canQuit: process.platform === 'darwin' && desktopRunning && cli.length === 0,
    blockers
  }
}

export function codexIsRunning(): boolean { return codexEnvironment().running }

export async function quitCodexDesktop(timeoutMs = 20_000, forceAfterTimeout = false): Promise<void> {
  const environment = codexEnvironment()
  if (environment.cliCommands.length) throw new MessageError(message('error.cliStillRunning', { count: environment.cliCommands.length }))
  if (!environment.desktopRunning) return
  if (process.platform !== 'darwin') throw new MessageError(message('error.quitUnsupported'))
  const runningBundles = runningMacBundleIDs()
  if (!runningBundles.length) throw new MessageError(message('error.noRunningCodexApp'))
  const failures: string[] = []
  for (const id of runningBundles) {
    try { await execFilePromise('/usr/bin/osascript', ['-e', `tell application id "${id}" to quit`]) }
    catch (error) { failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (failures.length === runningBundles.length) {
    throw new MessageError(message('error.quitRequestFailed', { reason: failures.join('; ') }))
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!codexEnvironment().desktopRunning) return
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  if (forceAfterTimeout) {
    const pids = runningMacDesktopProcessIDs()
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL') } catch { /* process may have exited */ }
    }
    const forcedDeadline = Date.now() + 5_000
    while (Date.now() < forcedDeadline) {
      if (!codexEnvironment().desktopRunning) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new MessageError(message('error.forceQuitFailed'))
  }
  throw new MessageError(message('error.quitTimedOut'))
}

function runningMacDesktopProcessIDs(): number[] {
  const result = spawnSync('/bin/ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', timeout: 5_000 })
  if (result.status !== 0) return []
  return (result.stdout ?? '').split(/\r?\n/).flatMap((line): number[] => {
    if (!isCodexDesktopActiveProcessCommand(line)) return []
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
export function isCodexDesktopActiveProcessCommand(command: string): boolean {
  return isCodexDesktopProcessCommand(command) && !MAC_DESKTOP_CRASHPAD_PATH.test(command)
}
function execFilePromise(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 10_000 }, (error) => error ? reject(error) : resolve()))
}
