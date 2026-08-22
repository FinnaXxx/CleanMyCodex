import { parentPort } from 'node:worker_threads'
import { CodexLocations } from './locations'
import { scanSnapshot } from './scanner'
import { scanWorkspace } from './workspace'
import { CodexThreadIndex } from './thread-index'
import type { InstalledPlugin } from './app-server'

type Request = { type: 'scan'; installedPlugins: InstalledPlugin[] | null } | { type: 'workspace' }

parentPort?.on('message', async (request: Request) => {
  const locations = CodexLocations.standard()
  try {
    if (request.type === 'scan') {
      const result = await scanSnapshot(locations, request.installedPlugins, (progress) => {
        if (progress.stage !== '完成') parentPort?.postMessage({
          type: 'progress', progress: { ...progress, fraction: Math.min(progress.fraction * 0.9, 0.9) }
        })
      })
      const workspaceThreads = CodexThreadIndex.load(locations.home).workspaceThreads(locations.workspace)
      result.workspace = scanWorkspace(locations.workspace, (currentPath) => parentPort?.postMessage({
        type: 'progress', progress: { stage: '工作产出', currentPath, scannedBytes: 0, fraction: 0.95 }
      }), workspaceThreads)
      parentPort?.postMessage({
        type: 'progress', progress: { stage: '完成', currentPath: '', scannedBytes: 0, fraction: 1 }
      })
      parentPort?.postMessage({ type: 'result', result })
    } else {
      const workspaceThreads = CodexThreadIndex.load(locations.home).workspaceThreads(locations.workspace)
      const result = scanWorkspace(locations.workspace, (currentPath) => parentPort?.postMessage({
        type: 'progress', progress: { stage: '工作产出', currentPath, scannedBytes: 0, fraction: 0 }
      }), workspaceThreads)
      parentPort?.postMessage({ type: 'result', result })
    }
  } catch (error) {
    parentPort?.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
})
