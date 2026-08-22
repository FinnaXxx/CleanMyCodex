import { contextBridge, ipcRenderer } from 'electron'
import type { ScanSnapshot, ScanProgress, AppInfo, StorageEntry, CleanupReport, CleanupProgress } from '../../shared/types'

const api = {
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
  scan: (): Promise<ScanSnapshot> => ipcRenderer.invoke('scan:run'),
  onScanProgress: (listener: (progress: ScanProgress) => void): (() => void) => {
    const handler = (_event: unknown, progress: ScanProgress): void => listener(progress)
    ipcRenderer.on('scan:progress', handler)
    return () => ipcRenderer.removeListener('scan:progress', handler)
  },
  cleanup: (entries: StorageEntry[]): Promise<CleanupReport> => ipcRenderer.invoke('cleanup:run', entries),
  onCleanupProgress: (listener: (progress: CleanupProgress) => void): (() => void) => {
    const handler = (_event: unknown, progress: CleanupProgress): void => listener(progress)
    ipcRenderer.on('cleanup:progress', handler)
    return () => ipcRenderer.removeListener('cleanup:progress', handler)
  }
}

contextBridge.exposeInMainWorld('cleanmycodex', api)

export type CleanMyCodexAPI = typeof api