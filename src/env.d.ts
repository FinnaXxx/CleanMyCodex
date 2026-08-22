/// <reference types="vite/client" />
import type { CleanMyCodexAPI } from '../electron/preload/index'

declare global {
  interface Window {
    cleanmycodex: CleanMyCodexAPI
  }
}