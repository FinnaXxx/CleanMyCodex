import { app, BrowserWindow, shell, ipcMain, Notification } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { CodexLocations } from './locations'
import { scanSnapshot } from './scanner'
import { ProtectedPaths } from './guard'
import { runCleanup, type CleanupDeps } from './cleanup'
import { AppServerClient, type AppServerSession } from './app-server'
import { buildAutomaticTasks, buildTrustedTasks, makeCleanupPreview } from './planner'
import { codexEnvironment, codexIsRunning, probeFileUsage, quitCodexDesktop, relaunchCodex } from './platform-services'
import {
  appendAutomationLog,
  applyAutomationSettings,
  getAutomationState,
  loadAutomationSettings,
  saveAutomaticRun
} from './automation'
import {
  reportFreedBytes,
  type AutomationSettings,
  type CleanupProgress,
  type CleanupRequest,
  type CleanupSelection,
  type ScanSnapshot,
  type WorkspaceSnapshot
} from '../../shared/types'

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
    runtimeSummary: environment.blockerSummary
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
  if (signal.aborted) throw new DOMException('扫描已停止', 'AbortError')
}

function isScanCancellation(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === '扫描已停止')
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
    worker.on('message', (message: { type: string; progress?: unknown; result?: T; message?: string }) => {
      if (message.type === 'progress') mainWindow?.webContents.send('scan:progress', message.progress)
      else if (message.type === 'result') { finish(() => resolve(message.result as T)); void worker.terminate() }
      else if (message.type === 'error') { finish(() => reject(new Error(message.message ?? '扫描失败'))); void worker.terminate() }
    })
    worker.on('error', (error) => finish(() => reject(error)))
    worker.on('exit', (code) => {
      finish(() => reject(new Error(cancelledWorkers.has(worker) ? '扫描已停止' : `扫描进程已退出（${code}）`)))
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

ipcMain.handle('cleanup:prepare', (_event, selection: CleanupSelection) => {
  const tasks = trustedTasks(selection)
  return makeCleanupPreview(selection, tasks, codexEnvironment())
})

ipcMain.handle('cleanup:run', async (_event, request: CleanupRequest) => {
  if (!request || typeof request !== 'object' || typeof request.restartCodex !== 'boolean') throw new Error('清理请求无效')
  const tasks = trustedTasks(request.selection)
  let reopen: string[] = []
  if (request.restartCodex && tasks.some((task) => task.requiresCodexStopped || task.method === 'compactDatabase')) {
    mainWindow?.webContents.send('cleanup:stage', '正在退出 Codex…')
    reopen = await quitCodexDesktop()
  }
  const session = await openBatchSession(tasks.some((task) => task.method === 'deleteThread'))
  try {
    return await runCleanup(tasks, guards, cleanupDependencies(session), (progress: CleanupProgress) => {
      mainWindow?.webContents.send('cleanup:progress', progress)
    })
  } finally {
    session?.close()
    if (reopen.length) {
      mainWindow?.webContents.send('cleanup:stage', '正在重新打开 Codex…')
      await relaunchCodex(reopen)
    }
    mainWindow?.webContents.send('cleanup:stage', '')
  }
})

function trustedTasks(selection: CleanupSelection) {
  if (!latestSnapshot) throw new Error('请先完成扫描')
  return buildTrustedTasks(selection, latestSnapshot, latestWorkspace, appServer.isAvailable)
}

function assertTrustedDisplayPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !trustedDisplayPaths().has(path)) throw new Error('不能打开未扫描的路径')
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

async function openBatchSession(required: boolean): Promise<AppServerSession | null> {
  if (!required || !appServer.isAvailable) return null
  try { return await appServer.openSession() } catch { return null }
}

function cleanupDependencies(session: AppServerSession | null): CleanupDeps {
  return {
    trash: (path: string) => shell.trashItem(path),
    isCodexRunning: codexIsRunning,
    fileUsage: probeFileUsage,
    appServer: {
      isAvailable: session !== null,
      deleteThread: async (threadID: string) => {
        if (!session) throw new Error('没有连接到 codex app server')
        await session.deleteThread(threadID)
      }
    }
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 760,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'CleanMyCodex',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
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

async function runAutomaticCleanup(): Promise<void> {
  const settings = loadAutomationSettings()
  if (!settings.enabled) { appendAutomationLog('自动清理未开启，跳过。'); return }
  try {
    const installedPlugins = await appServer.installedPlugins()
    const snapshot = await scanSnapshot(locations, installedPlugins)
    guards = guardsFor(snapshot)
    const tasks = buildAutomaticTasks(snapshot, settings, appServer.isAvailable)
    if (!tasks.length) { appendAutomationLog('没有需要清理的项目。'); return }
    const batchSession = await openBatchSession(tasks.some((task) => task.method === 'deleteThread'))
    let report
    try { report = await runCleanup(tasks, guards, cleanupDependencies(batchSession)) }
    finally { batchSession?.close() }
    const deferred = report.outcomes.filter((item) => item.status.kind === 'skipped')
    const failed = report.outcomes.filter((item) => item.status.kind === 'failed')
    saveAutomaticRun({
      finishedAt: Date.now(), freedBytes: reportFreedBytes(report),
      succeeded: report.outcomes.length - deferred.length - failed.length,
      failed: failed.length, skippedReason: null, deferred: deferred.length,
      deferredNote: deferred[0]?.status.kind === 'skipped' ? deferred[0].status.reason : null
    })
    const summary = `已释放 ${reportFreedBytes(report)} 字节，成功 ${report.outcomes.length - deferred.length - failed.length} 项`
    appendAutomationLog(summary)
    for (const item of deferred) appendAutomationLog(`推迟：${item.title} — ${item.status.kind === 'skipped' ? item.status.reason : ''}`)
    if (settings.notifyWhenFinished && Notification.isSupported()) new Notification({ title: 'CleanMyCodex', body: summary }).show()
  } catch (err) {
    appendAutomationLog(`自动清理失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

app.whenReady().then(async () => {
  if (process.argv.includes('--auto-clean')) { await runAutomaticCleanup(); app.quit(); return }
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
