import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AutomaticRunRecord, AutomationSettings, AutomationState } from '../../shared/types'
import { MessageError, formatMessage, message, type Language, type Message } from '../../shared/messages'
import {
  WINDOWS_TASK_ARGUMENTS,
  WINDOWS_TASK_NAME,
  parseWindowsNextRunAt,
  parseWindowsTaskMatch,
  windowsNextRunPowerShell,
  windowsTaskMatchesPowerShell,
  windowsTaskSettingsPowerShell
} from './windows-scheduled-task'

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  enabled: false,
  intervalDays: 30,
  cleanCaches: true,
  cleanOldPlugins: true,
  cleanArchivedSessions: false,
  archivedRetentionDays: 60,
  cleanActiveSessions: false,
  activeRetentionDays: 60,
  skipRecentSessions: true,
  notifyWhenFinished: true,
  launchAtLogin: false
}

const serviceLabel = 'com.finnaxxx.cleanmycodex.autoclean'
const storeDirectory = (): string => app.getPath('userData')
const settingsPath = (): string => join(storeDirectory(), 'automation.json')
const lastRunPath = (): string => join(storeDirectory(), 'last-run.json')
const launchAgentPath = (): string => join(homedir(), 'Library', 'LaunchAgents', `${serviceLabel}.plist`)
const languagePath = (): string => join(storeDirectory(), 'language.json')
const automationLogPath = (): string => join(app.getPath('logs'), 'autoclean.log')

/**
 * The scheduled run has no window, so it cannot ask the renderer which language to use.
 * The renderer mirrors the choice here whenever it changes, and the background run reads
 * it back for its log lines and its completion notification.
 */
export function saveUILanguage(language: Language): void {
  if (language === 'zh-CN' || language === 'en') writeJSON(languagePath(), { language })
}

export function loadUILanguage(): Language {
  return readJSON<{ language?: string }>(languagePath())?.language === 'en' ? 'en' : 'zh-CN'
}

function readJSON<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return null }
}

function writeJSON(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  try { renameSync(temporary, path) }
  catch (error) {
    if (process.platform !== 'win32') throw error
    rmSync(path, { force: true })
    renameSync(temporary, path)
  }
}

export function loadAutomationSettings(): AutomationSettings {
  return { ...DEFAULT_AUTOMATION_SETTINGS, ...(readJSON<Partial<AutomationSettings>>(settingsPath()) ?? {}) }
}

export function saveAutomaticRun(record: AutomaticRunRecord): void {
  writeJSON(lastRunPath(), record)
}

function runLaunchctl(args: string[]): boolean {
  try {
    execFileSync('/bin/launchctl', args, { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch { return false }
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * How often launchd should wake the app, which is not the cleanup interval.
 *
 * `StartInterval` counts from the moment launchd loads the agent, and the counter starts
 * over at every login. A month-long interval on a machine that is ever logged out would
 * simply never come due. So launchd wakes the app once a day and the app decides whether
 * the interval has actually elapsed, which makes the interval mean elapsed time rather
 * than uninterrupted uptime. A wake that is not due costs one short process.
 */
const WAKE_INTERVAL_SECONDS = 86_400

function launchAgentPlist(intervalSeconds: number): string {
  const programArguments = app.isPackaged ? [process.execPath, '--auto-clean'] : [process.execPath, app.getAppPath(), '--auto-clean']
  const argumentXML = programArguments.map((argument) => `<string>${xml(argument)}</string>`).join('')
  const log = automationLogPath()
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${serviceLabel}</string>
  <key>ProgramArguments</key><array>${argumentXML}</array>
  <key>StartInterval</key><integer>${Math.max(3600, Math.floor(intervalSeconds))}</integer>
  <key>RunAtLoad</key><false/><key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`
}

function launchAgentIsLoaded(): boolean {
  return runLaunchctl(['print', `gui/${process.getuid?.() ?? 0}/${serviceLabel}`])
}

/**
 * Installs the agent, or leaves it alone when it is already running exactly this schedule.
 *
 * `bootstrap` restarts launchd's `StartInterval` countdown, and the job does not run at
 * load, so re-installing on every save would push the next run a full interval away each
 * time — a settings page visited often enough would never let a run fire at all. The
 * plist text is the whole schedule, so comparing it against the file on disk is the same
 * question as "would re-installing change anything".
 */
function installLaunchAgent(intervalSeconds: number): void {
  if (process.platform !== 'darwin') throw new MessageError(message('error.launchAgentUnsupported'))
  const path = launchAgentPath()
  const plist = launchAgentPlist(intervalSeconds)
  let unchanged = false
  try { unchanged = readFileSync(path, 'utf8') === plist } catch { /* not installed yet */ }
  if (unchanged && launchAgentIsLoaded()) return

  mkdirSync(dirname(path), { recursive: true })
  mkdirSync(dirname(automationLogPath()), { recursive: true })
  writeFileSync(path, plist, 'utf8')
  runLaunchctl(['bootout', `gui/${process.getuid?.() ?? 0}/${serviceLabel}`])
  if (!runLaunchctl(['bootstrap', `gui/${process.getuid?.() ?? 0}`, path])) {
    throw new MessageError(message('error.launchctlFailed'))
  }
}

function runSchtasks(args: string[]): boolean {
  try {
    execFileSync('schtasks.exe', args, { stdio: 'ignore', timeout: 10_000, windowsHide: true })
    return true
  } catch { return false }
}

function windowsTaskArguments(): string {
  return app.isPackaged ? WINDOWS_TASK_ARGUMENTS : `"${app.getAppPath()}" ${WINDOWS_TASK_ARGUMENTS}`
}

/** Windows knows the real next run time; ask it rather than estimating from a file. */
function windowsNextRunAt(): number | null {
  try {
    const output = execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsNextRunPowerShell()
    ], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    return parseWindowsNextRunAt(output)
  } catch { return null }
}

/** Whether the installed task still launches this build with this saved interval. */
function windowsTaskMatches(intervalDays: number): boolean {
  try {
    const output = execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsTaskMatchesPowerShell()
    ], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      env: {
        ...process.env,
        CLEANMYCODEX_TASK_EXECUTABLE: process.execPath,
        CLEANMYCODEX_TASK_ARGUMENTS: windowsTaskArguments(),
        CLEANMYCODEX_TASK_INTERVAL_DAYS: String(Math.max(1, Math.floor(intervalDays)))
      }
    })
    return parseWindowsTaskMatch(output)
  } catch { return false }
}

function applyWindowsTaskSettings(): boolean {
  try {
    execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsTaskSettingsPowerShell()
    ], { stdio: 'ignore', timeout: 10_000, windowsHide: true })
    return true
  } catch { return false }
}

function installWindowsTask(intervalDays: number): void {
  if (process.platform !== 'win32') throw new MessageError(message('error.schtasksUnsupported'))
  const command = `"${process.execPath}" ${windowsTaskArguments()}`
  const created = runSchtasks(['/Create', '/F', '/SC', 'DAILY', '/MO', String(Math.max(1, Math.floor(intervalDays))), '/TN', WINDOWS_TASK_NAME, '/TR', command])
  if (!created || !applyWindowsTaskSettings()) {
    throw new MessageError(message('error.schtasksFailed'))
  }
}

function uninstallLaunchAgent(): void {
  if (process.platform !== 'darwin') return
  runLaunchctl(['bootout', `gui/${process.getuid?.() ?? 0}/${serviceLabel}`])
  rmSync(launchAgentPath(), { force: true })
}

function uninstallWindowsTask(): void {
  if (process.platform === 'win32') runSchtasks(['/Delete', '/F', '/TN', WINDOWS_TASK_NAME])
}

/**
 * Brings the installed schedule back in line with this build, at startup.
 *
 * Both launchd's plist and Task Scheduler's action name the executable they should launch,
 * and they are normally written only when settings are saved. An app that has moved, or a
 * build whose launch arguments changed, leaves a schedule pointing somewhere that no
 * longer answers. Compare the full macOS plist, or the Windows action, daily interval and
 * missed-run/battery settings, and reinstall only when the definition no longer matches.
 *
 * Returns what it did, so a start that repaired something says so in the log.
 */
export function repairAutomationSchedule(): string | null {
  const settings = loadAutomationSettings()
  if (!settings.enabled) return null
  if (process.platform === 'darwin') {
    const desired = launchAgentPlist(WAKE_INTERVAL_SECONDS)
    let current: string | null = null
    try { current = readFileSync(launchAgentPath(), 'utf8') } catch { /* not installed */ }
    if (current === desired && launchAgentIsLoaded()) return null
    try {
      installLaunchAgent(WAKE_INTERVAL_SECONDS)
      return current === null ? 'reinstalled a missing launch agent' : 'launch agent no longer matched this build; reinstalled'
    } catch (error) {
      return `launch agent could not be repaired: ${error instanceof MessageError ? error.info.key : String(error)}`
    }
  }
  if (process.platform === 'win32') {
    const installed = runSchtasks(['/Query', '/TN', WINDOWS_TASK_NAME])
    if (installed && windowsTaskMatches(settings.intervalDays)) return null
    try {
      installWindowsTask(settings.intervalDays)
      return installed
        ? 'Windows scheduled task no longer matched this build; reinstalled'
        : 'reinstalled a missing Windows scheduled task'
    } catch (error) {
      return `Windows scheduled task could not be repaired: ${error instanceof MessageError ? error.info.key : String(error)}`
    }
  }
  return null
}

/**
 * Whether enough time has passed since the last completed run. launchd only promises a
 * daily wake, so this is what makes `intervalDays` mean what the settings page says. Task
 * Scheduler already wakes Windows at the requested cadence; its NextRunTime advances to
 * the following occurrence before this process starts, so every Windows wake is due.
 */
export function automaticRunIsDue(now = Date.now()): { due: boolean; nextRunAt: number } {
  if (process.platform === 'win32') return { due: true, nextRunAt: now }
  const settings = loadAutomationSettings()
  const lastRun = readJSON<AutomaticRunRecord>(lastRunPath())
  const nextRunAt = nextRunEstimate(settings, lastRun) ?? now
  return { due: now >= nextRunAt, nextRunAt }
}

export function getAutomationState(): AutomationState {
  const settings = loadAutomationSettings()
  const installed = process.platform === 'darwin'
    ? existsSync(launchAgentPath())
    : process.platform === 'win32' && runSchtasks(['/Query', '/TN', WINDOWS_TASK_NAME])
  const loaded = process.platform === 'darwin' ? installed && launchAgentIsLoaded() : installed
  const lastRun = readJSON<AutomaticRunRecord>(lastRunPath())
  return {
    settings,
    installed,
    loaded,
    nextRunAt: installed ? nextRunEstimate(settings, lastRun) : null,
    lastRun,
    supported: process.platform === 'darwin' || process.platform === 'win32'
  }
}

/**
 * launchd only knows a `StartInterval`, so the macOS estimate counts forward from the
 * last completed run — falling back to when the agent was installed — instead of from a
 * file's mtime, which never advanced once a run had fired.
 */
function nextRunEstimate(settings: AutomationSettings, lastRun: AutomaticRunRecord | null): number | null {
  if (process.platform === 'win32') return windowsNextRunAt()
  const interval = Math.max(1, settings.intervalDays) * 86_400_000
  let anchor = lastRun?.finishedAt ?? 0
  if (!anchor) {
    try { anchor = statSync(launchAgentPath()).mtimeMs } catch { return null }
  }
  return anchor + interval
}

export function applyAutomationSettings(settings: AutomationSettings): AutomationState {
  if (!validAutomationSettings(settings)) throw new MessageError(message('error.invalidAutomationSettings'))
  const sanitized: AutomationSettings = {
    ...settings,
    intervalDays: Math.min(180, Math.max(1, Math.round(settings.intervalDays))),
    archivedRetentionDays: Math.min(1825, Math.max(7, Math.round(settings.archivedRetentionDays))),
    activeRetentionDays: Math.min(3650, Math.max(7, Math.round(settings.activeRetentionDays)))
  }
  writeJSON(settingsPath(), sanitized)
  if (sanitized.enabled) {
    if (process.platform === 'darwin') installLaunchAgent(WAKE_INTERVAL_SECONDS)
    else if (process.platform === 'win32') installWindowsTask(sanitized.intervalDays)
    else throw new MessageError(message('error.automationUnsupported'))
  } else {
    uninstallLaunchAgent()
    uninstallWindowsTask()
  }
  app.setLoginItemSettings({ openAtLogin: sanitized.launchAtLogin })
  return getAutomationState()
}

function validAutomationSettings(value: unknown): value is AutomationSettings {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  const booleans = ['enabled', 'cleanCaches', 'cleanOldPlugins', 'cleanArchivedSessions', 'cleanActiveSessions', 'skipRecentSessions', 'notifyWhenFinished', 'launchAtLogin']
  const numbers = ['intervalDays', 'archivedRetentionDays', 'activeRetentionDays']
  return booleans.every((key) => typeof item[key] === 'boolean')
    && numbers.every((key) => typeof item[key] === 'number' && Number.isFinite(item[key]))
}

export function appendAutomationLog(entry: Message): void {
  const path = automationLogPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `[${new Date().toISOString()}] ${formatMessage(entry, loadUILanguage())}\n`, { encoding: 'utf8', flag: 'a' })
}
