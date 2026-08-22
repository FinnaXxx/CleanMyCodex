import { app, BrowserWindow, shell, ipcMain, Notification } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexLocations } from './locations'
import { scanSnapshot } from './scanner'
import { ProtectedPaths } from './guard'
import { runCleanup } from './cleanup'
import { AppServerClient } from './app-server'
import { codexIsRunning } from './probes'
import { scanWorkspace } from './workspace'
import {
  appendAutomationLog,
  applyAutomationSettings,
  getAutomationState,
  loadAutomationSettings,
  saveAutomaticRun
} from './automation'
import {
  tasksForSessionDeletion,
  tasksFromEntries,
  reportFreedBytes,
  type AutomationSettings,
  type ScanProgress,
  type CleanupTask,
  type CleanupProgress
} from '../../shared/types'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

let locations = CodexLocations.standard()
let guards = new ProtectedPaths(locations)
let appServer = new AppServerClient(locations.home)
let mainWindow: BrowserWindow | null = null

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform
}))

ipcMain.handle('scan:run', async () => {
  const progress: ScanProgress = { stage: '扫描中', currentPath: '', scannedBytes: 0, fraction: 0 }
  const installedPlugins = await appServer.installedPlugins()
  const snapshot = await scanSnapshot(locations, installedPlugins, (currentPath) => {
    progress.currentPath = currentPath
    mainWindow?.webContents.send('scan:progress', progress)
  })
  guards = new ProtectedPaths(locations, snapshot.pluginVersions
    .filter((plugin) => plugin.status === 'current' || plugin.status === 'unconfirmed')
    .map((plugin) => plugin.directoryURL))
  return snapshot
})

ipcMain.handle('workspace:scan', async () => scanWorkspace(locations.workspace, (currentPath) => {
  mainWindow?.webContents.send('scan:progress', {
    stage: '工作产出', currentPath, scannedBytes: 0, fraction: 0
  } satisfies ScanProgress)
}))

ipcMain.handle('path:reveal', (_event, path: string) => shell.showItemInFolder(path))
ipcMain.handle('path:open', async (_event, path: string) => {
  const error = await shell.openPath(path)
  if (error) throw new Error(error)
})
ipcMain.handle('automation:get', () => getAutomationState())
ipcMain.handle('automation:save', (_event, settings: AutomationSettings) => applyAutomationSettings(settings))

ipcMain.handle('cleanup:run', async (_event, tasks: CleanupTask[]) => {
  const report = await runCleanup(tasks, guards, {
    trash: (path) => shell.trashItem(path),
    isCodexRunning: codexIsRunning,
    appServer: {
      isAvailable: appServer.isAvailable,
      deleteThread: async (threadID: string) => {
        const session = await appServer.openSession()
        try {
          await session.deleteThread(threadID)
        } finally {
          session.close()
        }
      }
    }
  }, (progress: CleanupProgress) => {
    mainWindow?.webContents.send('cleanup:progress', progress)
  })
  return report
})

function createWindow() {
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
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function runAutomaticCleanup(): Promise<void> {
  const settings = loadAutomationSettings()
  if (!settings.enabled) {
    appendAutomationLog('自动清理未开启，跳过。')
    return
  }
  try {
    const installedPlugins = await appServer.installedPlugins()
    const snapshot = await scanSnapshot(locations, installedPlugins)
    guards = new ProtectedPaths(locations, snapshot.pluginVersions
      .filter((plugin) => plugin.status === 'current' || plugin.status === 'unconfirmed')
      .map((plugin) => plugin.directoryURL))
    const cacheKinds = new Set(['temporary', 'marketplaceCache', 'browserCache', 'appCache', 'appLogs', 'logDatabase'])
    const entries = snapshot.categories.flatMap((category) => {
      if (settings.cleanOldPlugins && category.kind === 'pluginRemnants') return category.entries
      if (settings.cleanCaches && cacheKinds.has(category.kind)) return category.entries
      return []
    })
    const now = Date.now()
    const sessions = snapshot.sessions.filter((session) => {
      if (settings.skipRecentSessions && now - session.modifiedAt < 86_400_000) return false
      const days = session.location === 'archived' ? settings.archivedRetentionDays : settings.activeRetentionDays
      const enabled = session.location === 'archived' ? settings.cleanArchivedSessions : settings.cleanActiveSessions
      return enabled && now - session.modifiedAt >= days * 86_400_000
    })
    const tasks = [...tasksFromEntries(entries), ...tasksForSessionDeletion(sessions)]
    if (!tasks.length) {
      appendAutomationLog('没有需要清理的项目。')
      return
    }
    const report = await runCleanup(tasks, guards, cleanupDependencies())
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
    if (settings.notifyWhenFinished && Notification.isSupported()) new Notification({ title: 'CleanMyCodex', body: summary }).show()
  } catch (err) {
    appendAutomationLog(`自动清理失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

function cleanupDependencies() {
  return {
    trash: (path: string) => shell.trashItem(path),
    isCodexRunning: codexIsRunning,
    appServer: {
      isAvailable: appServer.isAvailable,
      deleteThread: async (threadID: string) => {
        const session = await appServer.openSession()
        try { await session.deleteThread(threadID) } finally { session.close() }
      }
    }
  }
}

app.whenReady().then(async () => {
  if (process.argv.includes('--auto-clean')) {
    await runAutomaticCleanup()
    app.quit()
    return
  }
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
