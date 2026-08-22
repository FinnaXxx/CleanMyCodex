/// <reference types="vite/client" />

interface AppInfo {
  version: string
  platform: string
}

interface CleanMyCodexAPI {
  appInfo: () => Promise<AppInfo>
}

interface Window {
  cleanmycodex: CleanMyCodexAPI
}