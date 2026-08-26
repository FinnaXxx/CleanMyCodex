import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './App.css'
import { PreferencesProvider } from './preferences'

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  try { return typeof error === 'string' ? error : JSON.stringify(error) }
  catch { return String(error) }
}

function reportRendererError(kind: string, detail: string): void {
  // Reporting must not recursively create another global error while the renderer or
  // preload is already failing or being torn down.
  try { window.cleanmycodex.reportRendererError(kind, detail) } catch { /* best effort */ }
}

window.addEventListener('error', (event) => {
  const location = event.filename ? `\n${event.filename}:${event.lineno}:${event.colno}` : ''
  reportRendererError('uncaught error', `${errorDetail(event.error ?? event.message)}${location}`)
})
window.addEventListener('unhandledrejection', (event) => {
  reportRendererError('unhandled rejection', errorDetail(event.reason))
})

createRoot(document.getElementById('root')!, {
  onUncaughtError: (error, info) => {
    reportRendererError('React uncaught error', `${errorDetail(error)}\n${info.componentStack}`)
  },
  onRecoverableError: (error, info) => {
    reportRendererError('React recoverable error', `${errorDetail(error)}\n${info.componentStack}`)
  }
}).render(
  <StrictMode>
    <PreferencesProvider><App /></PreferencesProvider>
  </StrictMode>
)
