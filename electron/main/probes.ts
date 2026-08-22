import { execSync } from 'node:child_process'

/**
 * Whether a Codex process is currently running. Used to defer work that needs Codex
 * fully stopped (its `.tmp` scratch space, database compaction). The check excludes this
 * app itself: the Electron process path contains "CleanMyCodex", which matches a naive
 * "codex" grep, so it is filtered out.
 */
export function codexIsRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', timeout: 5000 })
      return out
        .split('\n')
        .some((line) => /codex[^"]*\.exe/i.test(line) && !/CleanMyCodex/i.test(line))
    }
    const out = execSync('pgrep -af codex', { encoding: 'utf8', timeout: 5000 })
    return out
      .split('\n')
      .some((line) => /codex/i.test(line) && !/CleanMyCodex|electron|pgrep/i.test(line))
  } catch {
    // pgrep exits 1 when nothing matches; that means Codex is not running.
    return false
  }
}