import { contextBridge, ipcRenderer } from 'electron'
import type { ScanSnapshot, ScanProgress, AppInfo } from '../../shared/types'

const api = {
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
  scan: (): Promise<ScanSnapshot> => ipcRenderer.invoke('scan:run'),
  onScanProgress: (listener: (progress: ScanProgress) => void): (() => void) => {
    const handler = (_event: unknown, progress: ScanProgress): void => listener(progress)
    ipcRenderer.on('scan:progress', handler)
    return () => ipcRenderer.removeListener('scan:progress', handler)
  }
}

contextBridge.exposeInMainWorld('cleanmycodex', api)

export type CleanMyCodexAPI = typeof api