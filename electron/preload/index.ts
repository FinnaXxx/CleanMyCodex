import { contextBridge, ipcRenderer } from 'electron'
import type {
  ScanSnapshot, ScanProgress, AppInfo, CleanupReport, CleanupProgress,
  WorkspaceSnapshot, AutomationSettings, AutomationState, CleanupSelection, CleanupPreview, CleanupRequest
} from '../../shared/types'
import type { Language, Message } from '../../shared/messages'

const api = {
  /** The renderer reserves room for the macOS traffic lights and squares its own chrome. */
  platform: process.platform,
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
  scan: (): Promise<ScanSnapshot | null> => ipcRenderer.invoke('scan:run'),
  cancelScan: (): Promise<void> => ipcRenderer.invoke('scan:cancel'),
  onScanProgress: (listener: (progress: ScanProgress) => void): (() => void) => {
    const handler = (_event: unknown, progress: ScanProgress): void => listener(progress)
    ipcRenderer.on('scan:progress', handler)
    return () => ipcRenderer.removeListener('scan:progress', handler)
  },
  prepareCleanup: (selection: CleanupSelection): Promise<CleanupPreview> => ipcRenderer.invoke('cleanup:prepare', selection),
  cleanup: (request: CleanupRequest): Promise<CleanupReport> => ipcRenderer.invoke('cleanup:run', request),
  scanWorkspace: (): Promise<WorkspaceSnapshot | null> => ipcRenderer.invoke('workspace:scan'),
  /** Session rows Codex still lists although their rollout file is gone. */
  sessionLeftovers: (): Promise<{ count: number; logPath: string }> => ipcRenderer.invoke('sessions:leftovers'),
  repairSessionLeftovers: (): Promise<{ threads: number; removedRows: number }> => ipcRenderer.invoke('sessions:repairLeftovers'),
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke('path:reveal', path),
  openPath: (path: string): Promise<void> => ipcRenderer.invoke('path:open', path),
  /** This app's own log folder, created on demand so the settings entry can open it. */
  logDirectory: (): Promise<string> => ipcRenderer.invoke('app:logDirectory'),
  getAutomation: (): Promise<AutomationState> => ipcRenderer.invoke('automation:get'),
  saveAutomation: (settings: AutomationSettings): Promise<AutomationState> => ipcRenderer.invoke('automation:save', settings),
  saveLanguage: (language: Language): Promise<void> => ipcRenderer.invoke('preferences:language', language),
  // Keeps the native window backdrop in step with the theme, so resizing never flashes
  // the opposite appearance behind the interface.
  applyWindowTheme: (dark: boolean): Promise<void> => ipcRenderer.invoke('window:theme', dark),
  onCleanupProgress: (listener: (progress: CleanupProgress) => void): (() => void) => {
    const handler = (_event: unknown, progress: CleanupProgress): void => listener(progress)
    ipcRenderer.on('cleanup:progress', handler)
    return () => ipcRenderer.removeListener('cleanup:progress', handler)
  },
  /** ⌘, / Ctrl+, from the native menu, which cannot open a page by itself. */
  onOpenSettings: (listener: () => void): (() => void) => {
    const handler = (): void => listener()
    ipcRenderer.on('menu:settings', handler)
    return () => ipcRenderer.removeListener('menu:settings', handler)
  },
  onCleanupStage: (listener: (stage: Message | null) => void): (() => void) => {
    const handler = (_event: unknown, stage: Message | null): void => listener(stage)
    ipcRenderer.on('cleanup:stage', handler)
    return () => ipcRenderer.removeListener('cleanup:stage', handler)
  }
}

contextBridge.exposeInMainWorld('cleanmycodex', api)

export type CleanMyCodexAPI = typeof api
