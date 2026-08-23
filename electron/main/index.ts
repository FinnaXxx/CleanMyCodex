import { app, BrowserWindow, Menu, shell, ipcMain, nativeTheme, Notification, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { release } from 'node:os'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { CodexLocations } from './locations'
import { scanSnapshot } from './scanner'
import { ProtectedPaths } from './guard'
import { runCleanup, type CleanupDeps } from './cleanup'
import { AppServerClient, locateCodexExecutable } from './app-server'
import { buildAutomaticTasks, buildTrustedTasks, makeCleanupPreview } from './planner'
import { codexEnvironment, codexIsRunning, quitCodexDesktop, relaunchCodex } from './platform-services'
import {
  countOrphanRecords,
  deleteOrphanSessionRecords,
  deleteSessionRecords,
  describeDesktopSweep,
  preflightSessionRecords,
  sessionProtocolThreadIDs
} from './session-database'
import { cleanupLogPath, ensureLogDirectory, logCleanup, logDirectory } from './diagnostics'
import { pluginStorageCategories, scanPluginVersions } from './plugins'
import {
  appendAutomationLog,
  applyAutomationSettings,
  getAutomationState,
  loadAutomationSettings,
  loadUILanguage,
  saveAutomaticRun,
  saveUILanguage
} from './automation'
import {
  cleanupStatusReason,
  formatBytes,
  pluginStatusIsRemovable,
  reportFreedBytes,
  type AutomationSettings,
  type CleanupProgress,
  type CleanupReport,
  type CleanupRequest,
  type CleanupSelection,
  type ScanSnapshot,
  type WorkspaceSnapshot
} from '../../shared/types'
import {
  MessageError,
  SCAN_STOPPED,
  decodeMessage,
  describeMessage,
  formatMessage,
  message,
  type Language,
  type Message
} from '../../shared/messages'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const locations = CodexLocations.standard()
let guards = new ProtectedPaths(locations)
const appServer = new AppServerClient(locations.home, app.getVersion())
let mainWindow: BrowserWindow | null = null
let latestSnapshot: ScanSnapshot | null = null
let latestWorkspace: WorkspaceSnapshot = { root: locations.workspace, isScanned: false, entries: [] }
let scanWorker: Worker | null = null
let scanController: AbortController | null = null
let scanRevision = 0
const cancelledWorkers = new WeakSet<Worker>()

ipcMain.handle('app:info', () => {
  const environment = codexEnvironment()
  return {
    version: app.getVersion(),
    platform: process.platform,
    appServerAvailable: appServer.isAvailable,
    codexRunning: environment.running,
    blockers: environment.blockers
  }
})

ipcMain.handle('scan:run', () => runInteractiveScan(async (signal) => {
  const startedAt = Date.now()
  const installedPlugins = await appServer.installedPlugins(signal, reportPluginListFailure)
  logCleanup(`plugin/list: ${installedPlugins === null ? 'unavailable' : `${installedPlugins.length} rows`}`)
  throwIfScanCancelled(signal)
  const snapshot = await runWorker<ScanSnapshot>({ type: 'scan', installedPlugins })
  latestSnapshot = snapshot
  latestWorkspace = snapshot.workspace
  guards = guardsFor(snapshot)
  logScan(snapshot, Date.now() - startedAt)
  return snapshot
}))

ipcMain.handle('scan:cancel', () => {
  scanRevision += 1
  return cancelActiveScan()
})

ipcMain.handle('workspace:scan', () => runInteractiveScan(async () => {
  latestWorkspace = await runWorker<WorkspaceSnapshot>({ type: 'workspace' })
  return latestWorkspace
}))

async function runInteractiveScan<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const revision = ++scanRevision
  await cancelActiveScan()
  if (revision !== scanRevision) return null

  const controller = new AbortController()
  scanController = controller
  try {
    return await operation(controller.signal)
  } catch (error) {
    // Cancellation is a normal IPC outcome. Rejecting here makes Electron log it as
    // an unhandled handler error even though the renderer deliberately requested it.
    if (controller.signal.aborted || revision !== scanRevision || isScanCancellation(error)) return null
    throw error
  } finally {
    if (scanController === controller) scanController = null
  }
}

function throwIfScanCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException(SCAN_STOPPED, 'AbortError')
}

function isScanCancellation(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === 'AbortError' || decodeMessage(error.message)?.key === 'error.scanStopped')
}

function runWorker<T>(request: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'worker.js'))
    let settled = false
    scanWorker = worker
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      if (scanWorker === worker) scanWorker = null
      callback()
    }
    worker.on('message', (event: { type: string; progress?: unknown; result?: T; message?: string }) => {
      if (event.type === 'progress') mainWindow?.webContents.send('scan:progress', event.progress)
      else if (event.type === 'result') { finish(() => resolve(event.result as T)); void worker.terminate() }
      else if (event.type === 'error') {
        finish(() => reject(event.message ? new Error(event.message) : new MessageError(message('error.scanFailed'))))
        void worker.terminate()
      }
    })
    worker.on('error', (error) => finish(() => reject(error)))
    worker.on('exit', (code) => {
      finish(() => reject(new MessageError(cancelledWorkers.has(worker)
        ? message('error.scanStopped')
        : message('error.scanWorkerExited', { code: code ?? -1 }))))
    })
    worker.postMessage(request)
  })
}

async function stopScanWorker(): Promise<void> {
  const worker = scanWorker
  if (!worker) return
  cancelledWorkers.add(worker)
  await worker.terminate()
  if (scanWorker === worker) scanWorker = null
}

async function cancelActiveScan(): Promise<void> {
  scanController?.abort()
  scanController = null
  await stopScanWorker()
}

ipcMain.handle('path:reveal', (_event, path: string) => {
  assertTrustedDisplayPath(path)
  shell.showItemInFolder(path)
})
ipcMain.handle('path:open', async (_event, path: string) => {
  assertTrustedDisplayPath(path)
  const error = await shell.openPath(path)
  if (error) throw new Error(error)
})
/** The folder behind the settings page's log entry, created on demand so it opens. */
ipcMain.handle('app:logDirectory', () => ensureLogDirectory())
ipcMain.handle('automation:get', () => getAutomationState())
ipcMain.handle('automation:save', (_event, settings: AutomationSettings) => applyAutomationSettings(settings))
ipcMain.handle('preferences:language', (_event, language: Language) => {
  saveUILanguage(language)
  // The native menu is the one piece of text the main process has to word itself.
  buildApplicationMenu()
})

// The renderer owns the theme choice, including "follow the system", so it tells the
// window which backdrop to paint behind the interface.
ipcMain.handle('window:theme', (_event, dark: boolean) => {
  mainWindow?.setBackgroundColor(dark ? WindowBackdrop.dark : WindowBackdrop.light)
})

/**
 * Metadata Codex still lists although the rollout file is gone. Reported separately from
 * a scan because it is not disk usage: it is what makes a deleted conversation keep
 * appearing in the desktop sidebar until the row itself is removed.
 */
ipcMain.handle('sessions:leftovers', () => ({
  count: countOrphanRecords(locations.home),
  logPath: cleanupLogPath()
}))

ipcMain.handle('sessions:repairLeftovers', () => {
  if (codexIsRunning()) throw new MessageError(message('error.codexRunningForRepair'))
  const report = deleteOrphanSessionRecords(locations.home, stateBackupDirectory())
  logCleanup(`repair removed ${report.removedRows} rows for ${report.threadIDs.length} threads; ${describeDesktopSweep()}`)
  return { threads: report.threadIDs.length, removedRows: report.removedRows }
})

ipcMain.handle('cleanup:prepare', async (_event, selection: CleanupSelection) => {
  if (selectionTouchesPlugins(selection)) await refreshPluginsBeforeCleanup()
  const tasks = trustedTasks(selection)
  return makeCleanupPreview(selection, tasks, codexEnvironment(), latestSnapshot)
})

ipcMain.handle('cleanup:run', async (_event, request: CleanupRequest) => {
  if (!request || typeof request !== 'object' || typeof request.restartCodex !== 'boolean' || typeof request.forceQuitCodex !== 'boolean') throw new MessageError(message('error.invalidRequest'))
  if (selectionTouchesPlugins(request.selection)) await refreshPluginsBeforeCleanup()
  const tasks = trustedTasks(request.selection)
  logEnvironment(`cleanup:run ${request.selection.kind} tasks=${tasks.length} restart=${request.restartCodex} force=${request.forceQuitCodex}`)
  let reopen: string[] = []
  if (request.restartCodex && tasks.some((task) => task.requiresCodexStopped)) {
    mainWindow?.webContents.send('cleanup:stage', message('cleanup.quitting'))
    reopen = await quitCodexDesktop(20_000, request.forceQuitCodex)
  }
  try {
    const report = await runCleanup(tasks, guards, cleanupDependencies(), (progress: CleanupProgress) => {
      mainWindow?.webContents.send('cleanup:progress', progress)
    })
    logRemovals(request.selection, report)
    return report
  } finally {
    if (reopen.length) {
      mainWindow?.webContents.send('cleanup:stage', message('cleanup.reopening'))
      await relaunchCodex(reopen)
    }
    mainWindow?.webContents.send('cleanup:stage', null)
  }
})

/**
 * What a cleanup actually deleted, path by path. Session deletion writes its own richer
 * entries; this is the record for everything else, because a cache or leftover deletion
 * is permanent and the only way to answer "what did this remove" afterwards.
 */
function logRemovals(selection: CleanupSelection, report: CleanupReport): void {
  const removed = report.outcomes.filter((outcome) => outcome.status.kind === 'succeeded')
  const failed = report.outcomes.filter((outcome) => outcome.status.kind === 'failed')
  logCleanup(`${selection.kind} cleanup: ${removed.length} removed, ${failed.length} failed, ${report.outcomes.length - removed.length - failed.length} skipped`)
  for (const outcome of report.outcomes) {
    // Every outcome, with why. A skip is the most common thing a report is about — the
    // user pressed clean and nothing happened — and a failure is usually the guard
    // refusing a path, which is unreadable without the reason it gave.
    const reason = cleanupStatusReason(outcome.status)
    const why = reason ? `: ${describeMessage(reason)}` : ''
    logCleanup(`  ${outcome.status.kind} ${outcome.detail} (${outcome.freedBytes} bytes)${why}`)
  }
}

/**
 * The header every report needs before its first line means anything: which build, on
 * what, pointed at which Codex home, with which CLI behind the app-server. Written once
 * at startup and again before each cleanup, so a log that has rotated still carries it.
 */
/** Why the plugin inventory came back empty, which decides every plugin's status. */
function reportPluginListFailure(reason: string): void {
  logCleanup(`plugin/list failed: ${reason} — every on-disk plugin stays locked`)
}

function logEnvironment(label: string): void {
  const environment = codexEnvironment()
  const blockers = environment.blockers.map(describeMessage).join(' ') || 'none'
  logCleanup(`${label}: CleanMyCodex ${app.getVersion()} on ${process.platform} ${release()}, electron ${process.versions.electron}`)
  logCleanup(`  codexHome=${locations.home}${process.env['CODEX_HOME'] ? ' (CODEX_HOME)' : ''} codexBinary=${locateCodexExecutable() ?? 'not found'}`)
  logCleanup(`  running=${environment.running} desktop=${environment.desktopRunning} canRestart=${environment.canRestart} blockers=${blockers}`)
}

/**
 * What one scan concluded, in the terms the cleanup decisions are made in. A report of
 * the shape "it offered nothing" or "the total looks wrong" is unanswerable without it,
 * and plugin statuses in particular are where a misread inventory shows up first.
 */
function logScan(snapshot: ScanSnapshot, elapsedMs: number): void {
  const pluginStatuses = snapshot.pluginVersions.reduce<Record<string, number>>((counts, plugin) => {
    counts[plugin.status] = (counts[plugin.status] ?? 0) + 1
    return counts
  }, {})
  const describeCounts = (counts: Record<string, number>): string =>
    Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(' ') || 'none'
  logCleanup(`scan: ${elapsedMs}ms total=${snapshot.totalCodexBytes} external=${snapshot.externalBytes} sessions=${snapshot.sessions.length}`)
  logCleanup(`  plugins ${describeCounts(pluginStatuses)}`)
  for (const category of snapshot.categories) {
    const bytes = category.entries.reduce((sum, entry) => sum + entry.bytes, 0)
    logCleanup(`  ${category.group}/${category.kind} entries=${category.entries.length} bytes=${bytes}`)
  }
  for (const note of snapshot.notes) logCleanup(`  note ${describeMessage(note)}`)
}

async function refreshPluginsBeforeCleanup(): Promise<void> {
  if (!latestSnapshot) throw new MessageError(message('error.scanFirst'))
  const installedPlugins = await appServer.installedPlugins()
  const pluginVersions = scanPluginVersions(locations.plugins, installedPlugins)
  latestSnapshot = {
    ...latestSnapshot,
    categories: [
      ...latestSnapshot.categories.filter((category) => category.kind !== 'pluginRemnants' && category.kind !== 'pluginOrphans'),
      ...pluginStorageCategories(pluginVersions).filter((category) => category.entries.length)
    ],
    pluginVersions
  }
  guards = guardsFor(latestSnapshot)
}

function selectionTouchesPlugins(selection: CleanupSelection): boolean {
  if (!selection || typeof selection !== 'object') return false
  if (selection.kind === 'plugins') return true
  if (selection.kind !== 'storage' || !Array.isArray(selection.ids) || !latestSnapshot) return false
  const pluginIDs = new Set(latestSnapshot.categories
    .filter((category) => category.kind === 'pluginRemnants' || category.kind === 'pluginOrphans')
    .flatMap((category) => category.entries.map((entry) => entry.id)))
  return selection.ids.some((id) => typeof id === 'string' && pluginIDs.has(id))
}

function trustedTasks(selection: CleanupSelection) {
  if (!latestSnapshot) throw new MessageError(message('error.scanFirst'))
  return buildTrustedTasks(selection, latestSnapshot, latestWorkspace)
}

function assertTrustedDisplayPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !trustedDisplayPaths().has(path)) throw new MessageError(message('error.untrustedPath'))
}

function trustedDisplayPaths(): Set<string> {
  // The cleanup log is part of what the interface offers to show, so revealing it is
  // as legitimate as revealing a scanned path.
  const result = new Set<string>([locations.home, locations.workspace, cleanupLogPath(), logDirectory()])
  if (latestSnapshot) {
    for (const category of latestSnapshot.categories) for (const entry of category.entries) result.add(entry.url)
    for (const session of latestSnapshot.sessions) {
      result.add(session.fileURL)
      for (const path of session.assetURLs) result.add(path)
    }
    for (const plugin of latestSnapshot.pluginVersions) result.add(plugin.directoryURL)
  }
  const visit = (entries: WorkspaceSnapshot['entries']): void => {
    for (const entry of entries) { result.add(entry.path); visit(entry.children) }
  }
  visit(latestWorkspace.entries)
  return result
}

function guardsFor(snapshot: ScanSnapshot): ProtectedPaths {
  return new ProtectedPaths(locations, snapshot.pluginVersions
    .filter((plugin) => !pluginStatusIsRemovable(plugin.status))
    .map((plugin) => plugin.directoryURL))
}

/** Where a copy of the desktop state file goes before this app rewrites it. */
function stateBackupDirectory(): string {
  return join(app.getPath('userData'), 'state-backups')
}

function cleanupDependencies(): CleanupDeps {
  return {
    // Permanent, so that the reported "freed" bytes are bytes the volume actually gained.
    remove: (path: string) => rm(path, { recursive: true, force: true }),
    isCodexRunning: codexIsRunning,
    sessionDatabase: {
      preflightDelete: (threadID, relatedURLs) => preflightSessionRecords(locations.home, threadID, relatedURLs),
      deleteThreadWithProtocol: async (threadID, relatedURLs) => {
        const protocolIDs = sessionProtocolThreadIDs(locations.home, threadID, relatedURLs)
        const deleted = await appServer.deleteThreads(protocolIDs)
        logCleanup(`thread/delete ${threadID} ids=${protocolIDs.join(' ')} ${deleted ? 'ok' : 'unavailable'}`)
        return deleted
      },
      // Also runs after a successful thread/delete, to sweep metadata the protocol
      // left behind. Older app servers do not expose thread/delete at all, and then
      // this is the whole cleanup, run after the recoverable file cleanup.
      deleteThreadLocally: (threadID, relatedURLs) => {
        const report = deleteSessionRecords(locations.home, threadID, relatedURLs, stateBackupDirectory())
        logCleanup(`local sweep ${threadID} rows=${report.removedRows}; ${describeDesktopSweep()}`)
        return report
      },
      reportProtocolLeftovers: (threadID, removedRows, reason) => {
        if (reason) logCleanup(`leftover sweep failed ${threadID}: ${reason}`)
        else if (removedRows > 0) logCleanup(`thread/delete left ${removedRows} rows for ${threadID}; removed here`)
      }
    }
  }
}

/** The backdrop behind the interface, so a resize never flashes the opposite appearance. */
const WindowBackdrop = { light: '#eceef4', dark: '#131417' }

const ApplicationTitle = 'Clean My Codex'

function windowBackdrop(): string {
  return nativeTheme.shouldUseDarkColors ? WindowBackdrop.dark : WindowBackdrop.light
}

/**
 * The application menu, written out by hand for one reason: there is no View menu, and
 * so no `toggleDevTools` role. That role is what binds ⌘⌥I and Ctrl+Shift+I, and the
 * console is not part of this product. `blockDeveloperTools` covers the chords Chromium
 * still recognises on its own.
 */
function buildApplicationMenu(): void {
  const language = loadUILanguage()
  const settings: MenuItemConstructorOptions = {
    label: formatMessage(message('menu.settings'), language),
    accelerator: 'CmdOrCtrl+,',
    click: () => mainWindow?.webContents.send('menu:settings')
  }
  const template: MenuItemConstructorOptions[] = process.platform === 'darwin'
    ? [
        {
          // The packaged bundle is CleanMyCodex; in development `app.name` is the
          // package name, so the window title is the one the menu should echo.
          label: ApplicationTitle,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            settings,
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        },
        { role: 'editMenu' },
        { role: 'windowMenu' }
      ]
    : [
        { label: formatMessage(message('menu.file'), language), submenu: [settings, { type: 'separator' }, { role: 'quit' }] },
        { role: 'editMenu' },
        { role: 'windowMenu' }
      ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Physical keys, not characters: on macOS ⌥ rewrites `input.key` into a dead key. */
const DEVELOPER_TOOLS_KEY_CODES = new Set(['KeyI', 'KeyJ', 'KeyC'])

function blockDeveloperTools(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const chord = (input.meta && input.alt) || (input.control && input.shift)
    if (input.code === 'F12' || (chord && DEVELOPER_TOOLS_KEY_CODES.has(input.code))) event.preventDefault()
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    title: ApplicationTitle,
    backgroundColor: windowBackdrop(),
    // The interface draws its own toolbar, so macOS only keeps the window controls and
    // the sidebar runs to the top of the window like a native app.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 19, y: 21 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  blockDeveloperTools(mainWindow)
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  nativeTheme.on('updated', () => mainWindow?.setBackgroundColor(windowBackdrop()))
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { void openExternalWebURL(url); return { action: 'deny' } })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL()
    if (url !== current) event.preventDefault()
  })
  if (process.env['ELECTRON_RENDERER_URL']) void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

async function openExternalWebURL(value: string): Promise<void> {
  let url: URL
  try { url = new URL(value) } catch { return }
  if (url.protocol === 'https:' || url.protocol === 'http:') await shell.openExternal(url.toString())
}

/**
 * Every completed run is recorded, including the ones that cleaned nothing and the ones
 * that failed, so the settings page never shows a stale "last run" while the schedule
 * has in fact been firing.
 */
async function runAutomaticCleanup(): Promise<void> {
  const settings = loadAutomationSettings()
  const language = loadUILanguage()
  const record = (freedBytes: number, succeeded: number, failed: number, deferred: number, note: Message | null) =>
    saveAutomaticRun({ finishedAt: Date.now(), freedBytes, succeeded, failed, deferred, note })

  if (!settings.enabled) {
    appendAutomationLog(message('auto.disabled'))
    record(0, 0, 0, 0, message('auto.disabled'))
    return
  }
  try {
    logEnvironment('automatic run')
    const startedAt = Date.now()
    const installedPlugins = await appServer.installedPlugins(undefined, reportPluginListFailure)
    logCleanup(`plugin/list: ${installedPlugins === null ? 'unavailable' : `${installedPlugins.length} rows`}`)
    const snapshot = await scanSnapshot(locations, installedPlugins)
    guards = guardsFor(snapshot)
    logScan(snapshot, Date.now() - startedAt)
    const tasks = buildAutomaticTasks(snapshot, settings)
    if (!tasks.length) {
      appendAutomationLog(message('auto.nothingToClean'))
      record(0, 0, 0, 0, message('auto.nothingToClean'))
      return
    }
    const report = await runCleanup(tasks, guards, cleanupDependencies())
    const deferred = report.outcomes.filter((item) => item.status.kind === 'skipped')
    const failed = report.outcomes.filter((item) => item.status.kind === 'failed')
    const succeeded = report.outcomes.length - deferred.length - failed.length
    const summary = message('auto.summary', {
      bytes: formatBytes(reportFreedBytes(report)),
      succeeded, skipped: deferred.length, failed: failed.length
    })
    record(reportFreedBytes(report), succeeded, failed.length, deferred.length,
      deferred[0]?.status.kind === 'skipped' ? deferred[0].status.reason : null)
    appendAutomationLog(summary)
    for (const item of deferred) {
      if (item.status.kind !== 'skipped') continue
      appendAutomationLog(message('auto.skippedItem', {
        title: item.title, reason: formatMessage(item.status.reason, language)
      }))
    }
    if (settings.notifyWhenFinished && Notification.isSupported()) {
      new Notification({ title: 'Clean My Codex', body: formatMessage(summary, language) }).show()
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const note = message('auto.failed', { reason: formatMessage(decodeMessage(reason) ?? message('error.verbatim', { text: reason }), language) })
    appendAutomationLog(note)
    record(0, 0, 1, 0, note)
  }
}

app.whenReady().then(async () => {
  if (process.argv.includes('--auto-clean')) { await runAutomaticCleanup(); app.quit(); return }
  logEnvironment('start')
  buildApplicationMenu()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
