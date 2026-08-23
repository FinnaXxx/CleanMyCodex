import { app, BrowserWindow, shell, ipcMain, nativeTheme, Notification } from 'electron'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { CodexLocations } from './locations'
import { scanSnapshot } from './scanner'
import { ProtectedPaths } from './guard'
import { runCleanup, type CleanupDeps } from './cleanup'
import { AppServerClient } from './app-server'
import { buildAutomaticTasks, buildTrustedTasks, makeCleanupPreview } from './planner'
import { codexEnvironment, codexIsRunning, quitCodexDesktop, relaunchCodex } from './platform-services'
import { deleteSessionRecords, preflightSessionRecords, sessionProtocolThreadIDs } from './session-database'
import { scanPluginVersions } from './plugins'
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
  formatBytes,
  reportFreedBytes,
  type AutomationSettings,
  type CleanupProgress,
  type CleanupRequest,
  type CleanupSelection,
  type ScanSnapshot,
  type WorkspaceSnapshot
} from '../../shared/types'
import {
  MessageError,
  SCAN_STOPPED,
  decodeMessage,
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
  const installedPlugins = await appServer.installedPlugins(signal)
  throwIfScanCancelled(signal)
  const snapshot = await runWorker<ScanSnapshot>({ type: 'scan', installedPlugins })
  latestSnapshot = snapshot
  latestWorkspace = snapshot.workspace
  guards = guardsFor(snapshot)
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
ipcMain.handle('automation:get', () => getAutomationState())
ipcMain.handle('automation:save', (_event, settings: AutomationSettings) => applyAutomationSettings(settings))
ipcMain.handle('preferences:language', (_event, language: Language) => saveUILanguage(language))

// The renderer owns the theme choice, including "follow the system", so it tells the
// window which backdrop to paint behind the interface.
ipcMain.handle('window:theme', (_event, dark: boolean) => {
  mainWindow?.setBackgroundColor(dark ? WindowBackdrop.dark : WindowBackdrop.light)
})

ipcMain.handle('cleanup:prepare', (_event, selection: CleanupSelection) => {
  const tasks = trustedTasks(selection)
  return makeCleanupPreview(selection, tasks, codexEnvironment())
})

ipcMain.handle('cleanup:run', async (_event, request: CleanupRequest) => {
  if (!request || typeof request !== 'object' || typeof request.restartCodex !== 'boolean' || typeof request.forceQuitCodex !== 'boolean') throw new MessageError(message('error.invalidRequest'))
  if (request.selection.kind === 'plugins') await refreshPluginsBeforeCleanup()
  const tasks = trustedTasks(request.selection)
  let reopen: string[] = []
  if (request.restartCodex && tasks.some((task) => task.requiresCodexStopped)) {
    mainWindow?.webContents.send('cleanup:stage', message('cleanup.quitting'))
    reopen = await quitCodexDesktop(20_000, request.forceQuitCodex)
  }
  try {
    return await runCleanup(tasks, guards, cleanupDependencies(), (progress: CleanupProgress) => {
      mainWindow?.webContents.send('cleanup:progress', progress)
    })
  } finally {
    if (reopen.length) {
      mainWindow?.webContents.send('cleanup:stage', message('cleanup.reopening'))
      await relaunchCodex(reopen)
    }
    mainWindow?.webContents.send('cleanup:stage', null)
  }
})

async function refreshPluginsBeforeCleanup(): Promise<void> {
  if (!latestSnapshot) throw new MessageError(message('error.scanFirst'))
  const installedPlugins = await appServer.installedPlugins()
  latestSnapshot = {
    ...latestSnapshot,
    pluginVersions: scanPluginVersions(locations.plugins, installedPlugins)
  }
  guards = guardsFor(latestSnapshot)
}

function trustedTasks(selection: CleanupSelection) {
  if (!latestSnapshot) throw new MessageError(message('error.scanFirst'))
  return buildTrustedTasks(selection, latestSnapshot, latestWorkspace)
}

function assertTrustedDisplayPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !trustedDisplayPaths().has(path)) throw new MessageError(message('error.untrustedPath'))
}

function trustedDisplayPaths(): Set<string> {
  const result = new Set<string>([locations.home, locations.workspace])
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
    .filter((plugin) => plugin.status === 'current' || plugin.status === 'unconfirmed')
    .map((plugin) => plugin.directoryURL))
}

function cleanupDependencies(): CleanupDeps {
  return {
    // Permanent, so that the reported "freed" bytes are bytes the volume actually gained.
    remove: (path: string) => rm(path, { recursive: true, force: true }),
    isCodexRunning: codexIsRunning,
    sessionDatabase: {
      preflightDelete: (threadID, relatedURLs) => preflightSessionRecords(locations.home, threadID, relatedURLs),
      deleteThreadWithProtocol: async (threadID, relatedURLs) => {
        const protocolIDs = sessionProtocolThreadIDs(threadID, relatedURLs)
        return appServer.deleteThreads(protocolIDs)
      },
      // Older app servers do not expose thread/delete. Run this only after the
      // recoverable file cleanup when the preferred protocol was unavailable.
      deleteThreadLocally: (threadID, relatedURLs) => deleteSessionRecords(locations.home, threadID, relatedURLs)
    }
  }
}

/** The backdrop behind the interface, so a resize never flashes the opposite appearance. */
const WindowBackdrop = { light: '#eceef4', dark: '#131417' }

function windowBackdrop(): string {
  return nativeTheme.shouldUseDarkColors ? WindowBackdrop.dark : WindowBackdrop.light
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    title: 'Clean My Codex',
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
    const installedPlugins = await appServer.installedPlugins()
    const snapshot = await scanSnapshot(locations, installedPlugins)
    guards = guardsFor(snapshot)
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
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
