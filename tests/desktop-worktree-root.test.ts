import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { desktopWorktreeRoot } from '../electron/main/desktop-store'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function home(state: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-desktop-')); roots.push(root)
  const codexHome = join(root, '.codex')
  mkdirSync(codexHome, { recursive: true })
  if (state !== undefined) {
    writeFileSync(join(codexHome, '.codex-global-state.json'), JSON.stringify(state))
  }
  return codexHome
}

describe('worktree root configured in the desktop application', () => {
  it('finds the setting wherever the desktop nests it', () => {
    // The setting is not a top-level key: it lives inside the persisted interface state,
    // so the whole document has to be walked.
    const codexHome = home({
      'electron-persisted-atom-state': {
        panels: { width: 320 },
        worktree: { worktreeRootPath: '/Users/someone/dev/worktrees', autoDeleteLimit: 15 }
      }
    })
    expect(desktopWorktreeRoot(codexHome)).toBe('/Users/someone/dev/worktrees')
  })

  it('reports nothing when the setting is absent, empty, or not a path', () => {
    expect(desktopWorktreeRoot(home(undefined))).toBeNull()
    expect(desktopWorktreeRoot(home({ 'worktree-onboarding-state-v1': { seen: true } }))).toBeNull()
    expect(desktopWorktreeRoot(home({ worktree: null }))).toBeNull()
    // A relative value is not a root this app would ever resolve against anything.
    expect(desktopWorktreeRoot(home({ worktree: { worktreeRoot: 'dev/worktrees' } }))).toBeNull()
  })

  it('survives a state file it cannot parse', () => {
    const codexHome = home({})
    writeFileSync(join(codexHome, '.codex-global-state.json'), '{not json')
    expect(desktopWorktreeRoot(codexHome)).toBeNull()
  })

  it('falls back to the backup the desktop restores from', () => {
    const codexHome = home({ panels: {} })
    writeFileSync(join(codexHome, '.codex-global-state.json.bak'),
      JSON.stringify({ settings: { worktreeDirectory: '/Users/someone/wt' } }))
    expect(desktopWorktreeRoot(codexHome)).toBe('/Users/someone/wt')
  })
})
