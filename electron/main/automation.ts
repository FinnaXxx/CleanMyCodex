import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AutomaticRunRecord, AutomationSettings, AutomationState } from '../../shared/types'

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  enabled: false,
  intervalDays: 30,
  cleanCaches: true,
  cleanOldPlugins: true,
  cleanArchivedSessions: false,
  archivedRetentionDays: 180,
  cleanActiveSessions: false,
  activeRetentionDays: 365,
  skipRecentSessions: true,
  notifyWhenFinished: true,
  launchAtLogin: false
}

const serviceLabel = 'com.finnaxxx.clean-my-codex.autoclean'
const windowsTaskName = 'CleanMyCodex Automatic Cleanup'
const storeDirectory = (): string => app.getPath('userData')
const settingsPath = (): string => join(storeDirectory(), 'automation.json')
const lastRunPath = (): string => join(storeDirectory(), 'last-run.json')
const launchAgentPath = (): string => join(homedir(), 'Library', 'LaunchAgents', `${serviceLabel}.plist`)
export const automationLogPath = (): string => join(app.getPath('logs'), 'autoclean.log')

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

function installLaunchAgent(intervalSeconds: number): void {
  if (process.platform !== 'darwin') throw new Error('当前系统不支持 macOS LaunchAgent')
  const path = launchAgentPath()
  const log = automationLogPath()
  mkdirSync(dirname(path), { recursive: true })
  mkdirSync(dirname(log), { recursive: true })
  const programArguments = app.isPackaged ? [process.execPath, '--auto-clean'] : [process.execPath, app.getAppPath(), '--auto-clean']
  const argumentXML = programArguments.map((argument) => `<string>${xml(argument)}</string>`).join('')
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${serviceLabel}</string>
  <key>ProgramArguments</key><array>${argumentXML}</array>
  <key>StartInterval</key><integer>${Math.max(3600, Math.floor(intervalSeconds))}</integer>
  <key>RunAtLoad</key><false/><key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`
  writeFileSync(path, plist, 'utf8')
  runLaunchctl(['bootout', `gui/${process.getuid?.() ?? 0}/${serviceLabel}`])
  if (!runLaunchctl(['bootstrap', `gui/${process.getuid?.() ?? 0}`, path])) {
    throw new Error('launchctl 无法加载自动清理任务')
  }
}

function runSchtasks(args: string[]): boolean {
  try {
    execFileSync('schtasks.exe', args, { stdio: 'ignore', timeout: 10_000, windowsHide: true })
    return true
  } catch { return false }
}

function installWindowsTask(intervalDays: number): void {
  if (process.platform !== 'win32') throw new Error('当前系统不支持 Windows 任务计划程序')
  const command = app.isPackaged
    ? `"${process.execPath}" --auto-clean`
    : `"${process.execPath}" "${app.getAppPath()}" --auto-clean`
  if (!runSchtasks(['/Create', '/F', '/SC', 'DAILY', '/MO', String(Math.max(1, Math.floor(intervalDays))), '/TN', windowsTaskName, '/TR', command])) {
    throw new Error('Windows 任务计划程序无法创建自动清理任务')
  }
}

function uninstallLaunchAgent(): void {
  if (process.platform !== 'darwin') return
  runLaunchctl(['bootout', `gui/${process.getuid?.() ?? 0}/${serviceLabel}`])
  rmSync(launchAgentPath(), { force: true })
}

function uninstallWindowsTask(): void {
  if (process.platform === 'win32') runSchtasks(['/Delete', '/F', '/TN', windowsTaskName])
}

export function getAutomationState(): AutomationState {
  const settings = loadAutomationSettings()
  const installed = process.platform === 'darwin'
    ? existsSync(launchAgentPath())
    : process.platform === 'win32' && runSchtasks(['/Query', '/TN', windowsTaskName])
  const loaded = process.platform === 'darwin'
    ? installed && runLaunchctl(['print', `gui/${process.getuid?.() ?? 0}/${serviceLabel}`])
    : installed
  let nextRunAt: number | null = null
  if (installed) {
    try {
      const reference = process.platform === 'darwin' ? launchAgentPath() : settingsPath()
      nextRunAt = statSync(reference).mtimeMs + Math.max(1, settings.intervalDays) * 86_400_000
    } catch { /* missing */ }
  }
  return {
    settings,
    installed,
    loaded,
    nextRunAt,
    lastRun: readJSON<AutomaticRunRecord>(lastRunPath()),
    supported: process.platform === 'darwin' || process.platform === 'win32'
  }
}

export function applyAutomationSettings(settings: AutomationSettings): AutomationState {
  if (!validAutomationSettings(settings)) throw new Error('自动清理设置无效')
  const sanitized: AutomationSettings = {
    ...settings,
    intervalDays: Math.min(180, Math.max(1, Math.round(settings.intervalDays))),
    archivedRetentionDays: Math.min(1825, Math.max(7, Math.round(settings.archivedRetentionDays))),
    activeRetentionDays: Math.min(3650, Math.max(7, Math.round(settings.activeRetentionDays)))
  }
  writeJSON(settingsPath(), sanitized)
  if (sanitized.enabled) {
    if (process.platform === 'darwin') installLaunchAgent(sanitized.intervalDays * 86_400)
    else if (process.platform === 'win32') installWindowsTask(sanitized.intervalDays)
    else throw new Error('当前系统不支持定期后台清理')
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

export function appendAutomationLog(message: string): void {
  const path = automationLogPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `[${new Date().toISOString()}] ${message}\n`, { encoding: 'utf8', flag: 'a' })
}
