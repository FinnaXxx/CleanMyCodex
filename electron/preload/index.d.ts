import type { CleanMyCodexAPI } from './index'

declare global {
  interface Window {
    cleanmycodex: CleanMyCodexAPI
  }
}