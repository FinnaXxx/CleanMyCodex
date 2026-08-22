import { contextBridge, ipcRenderer } from 'electron'

const api = {
  appInfo: () => ipcRenderer.invoke('app:info')
}

contextBridge.exposeInMainWorld('cleanmycodex', api)

export type CleanMyCodexAPI = typeof api