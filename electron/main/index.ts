import { app, BrowserWindow, shell, ipcMain } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexLocations } from './locations'
import { scanSnapshot } from './scanner'
import type { ScanProgress } from '../../shared/types'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

let locations = CodexLocations.standard()
let mainWindow: BrowserWindow | null = null

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform
}))

ipcMain.handle('scan:run', async () => {
  const progress: ScanProgress = { stage: '扫描中', currentPath: '', scannedBytes: 0, fraction: 0 }
  const snapshot = await scanSnapshot(locations, (currentPath) => {
    progress.currentPath = currentPath
    mainWindow?.webContents.send('scan:progress', progress)
  })
  return snapshot
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

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})