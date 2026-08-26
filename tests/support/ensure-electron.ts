import { createRequire } from 'node:module'

/**
 * Download the Electron binary once, before any test file runs.
 *
 * Electron 33 shipped `"postinstall": "node install.js"`, so the binary was always on disk
 * by the time tests started. Electron 43 has no install script at all: `require('electron')`
 * notices the missing binary and downloads it right there, on first use. vitest runs test
 * files in parallel, so several files hit that at once — each starting its own download into
 * the same `dist/` directory while another file is already spawning what is written so far.
 * macOS aborts at launch on the truncated Mach-O ("segment '__TEXT' load command content
 * extends beyond end of file"); Windows just fails to spawn.
 *
 * Resolving it here serializes that into one download that finishes before the first test.
 */
export async function setup(): Promise<void> {
  createRequire(import.meta.url)('electron')
}
