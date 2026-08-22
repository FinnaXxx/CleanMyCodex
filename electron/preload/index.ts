import { contextBridge, ipcRenderer } from 'electron'
import type {
  ScanSnapshot, ScanProgress, AppInfo, CleanupTask, CleanupReport, CleanupProgress,
  WorkspaceSnapshot, AutomationSettings, AutomationState
} from '../../shared/types'

const api = {
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
  scan: (): Promise<ScanSnapshot> => ipcRenderer.invoke('scan:run'),
  onScanProgress: (listener: (progress: ScanProgress) => void): (() => void) => {
    const handler = (_event: unknown, progress: ScanProgress): void => listener(progress)
    ipcRenderer.on('scan:progress', handler)
    return () => ipcRenderer.removeListener('scan:progress', handler)
  },
  cleanup: (tasks: CleanupTask[]): Promise<CleanupReport> => ipcRenderer.invoke('cleanup:run', tasks),
  scanWorkspace: (): Promise<WorkspaceSnapshot> => ipcRenderer.invoke('workspace:scan'),
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke('path:reveal', path),
  openPath: (path: string): Promise<void> => ipcRenderer.invoke('path:open', path),
  getAutomation: (): Promise<AutomationState> => ipcRenderer.invoke('automation:get'),
  saveAutomation: (settings: AutomationSettings): Promise<AutomationState> => ipcRenderer.invoke('automation:save', settings),
  onCleanupProgress: (listener: (progress: CleanupProgress) => void): (() => void) => {
    const handler = (_event: unknown, progress: CleanupProgress): void => listener(progress)
    ipcRenderer.on('cleanup:progress', handler)
    return () => ipcRenderer.removeListener('cleanup:progress', handler)
  }
}

contextBridge.exposeInMainWorld('cleanmycodex', api)

export type CleanMyCodexAPI = typeof api
