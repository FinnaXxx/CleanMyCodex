import { dirname } from 'node:path'
import { parentPort } from 'node:worker_threads'
import { CodexLocations } from './locations'
import { scanSnapshot } from './scanner'
import { scanWorkspace } from './workspace'
import { resolveWorktreeRoots } from './worktrees'
import { desktopWorktreeRoot } from './desktop-store'
import { CodexThreadIndex } from './thread-index'
import type { InstalledPlugin } from './app-server'
import { message } from '../../shared/messages'

type Request = { type: 'scan'; installedPlugins: InstalledPlugin[] | null } | { type: 'workspace' }

parentPort?.on('message', async (request: Request) => {
  const locations = CodexLocations.standard()
  try {
    if (request.type === 'scan') {
      // The core scan's own "done" is not the end: workspace output is still to come,
      // so its progress is compressed into the first 90% and its final tick dropped.
      const result = await scanSnapshot(locations, request.installedPlugins, (progress) => {
        if (progress.stage?.key !== 'stage.done') parentPort?.postMessage({
          type: 'progress', progress: { ...progress, fraction: Math.min(progress.fraction * 0.9, 0.9) }
        })
      })
      const workspaceThreads = CodexThreadIndex.load(locations.home).workspaceThreads(locations.workspace)
      // Worktrees are measured by the scan above. A worktree root the user moved into the
      // workspace is skipped here so the same bytes are not reported by both pages.
      const worktreeRoots = result.worktrees.map((worktree) => dirname(worktree.path))
      result.workspace = scanWorkspace(locations.workspace, (currentPath) => parentPort?.postMessage({
        type: 'progress', progress: { stage: message('stage.workspace'), currentPath, fraction: 0.95 }
      }), workspaceThreads, worktreeRoots)
      parentPort?.postMessage({
        type: 'progress', progress: { stage: message('stage.done'), currentPath: '', fraction: 1 }
      })
      parentPort?.postMessage({ type: 'result', result })
    } else {
      const threadIndex = CodexThreadIndex.load(locations.home)
      const workspaceThreads = threadIndex.workspaceThreads(locations.workspace)
      const worktreeRoots = resolveWorktreeRoots(
        locations.worktreeRoots, threadIndex.locatedThreads, desktopWorktreeRoot(locations.home))
      const result = scanWorkspace(locations.workspace, (currentPath) => parentPort?.postMessage({
        type: 'progress', progress: { stage: message('stage.workspace'), currentPath, fraction: 0 }
      }), workspaceThreads, worktreeRoots)
      parentPort?.postMessage({ type: 'result', result })
    }
  } catch (error) {
    parentPort?.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
})
