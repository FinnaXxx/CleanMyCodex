import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // electron-vite infers this from a lookup table that stops at Electron 39, and its
      // fallback picks the *oldest* entry rather than the newest, so an unlisted Electron
      // silently compiles down to a decade-old target. Electron 43 is Node 24.18 + Chromium 150.
      target: 'node24',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main/index.ts'),
          worker: resolve(__dirname, 'electron/main/worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      target: 'node24',
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src',
    build: {
      target: 'chrome150',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/index.html') }
      }
    },
    plugins: [react()]
  }
})
