import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexLocations } from '../electron/main/locations'
import { ProtectedPaths, ProtectedPathError } from '../electron/main/guard'
import type { MessageKey } from '../shared/messages'

/** Guard rejections carry a message key, so assertions do not depend on wording. */
function rejection(run: () => void): MessageKey | null {
  try { run() } catch (error) { return error instanceof ProtectedPathError ? error.info.key : null }
  return null
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('cleanup path guard', () => {
  it('allows explicitly selected workspace children but never the workspace root', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-guard-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const child = join(locations.workspace, '2026-08-22')
    mkdirSync(child, { recursive: true })
    const guard = new ProtectedPaths(locations)
    expect(() => guard.validate(child)).not.toThrow()
    expect(rejection(() => guard.validate(locations.workspace))).toBe('guard.wholeDataRoot')
  })

  it('allows dedicated app cache roots but keeps other data roots protected', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-guard-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    for (const cache of locations.appCaches) mkdirSync(cache, { recursive: true })
    mkdirSync(locations.appSupport, { recursive: true })
    const guard = new ProtectedPaths(locations)

    for (const cache of locations.appCaches) expect(() => guard.validate(cache)).not.toThrow()
    expect(rejection(() => guard.validate(locations.home))).toBe('guard.wholeDataRoot')
    expect(rejection(() => guard.validate(locations.appSupport))).toBe('guard.wholeDataRoot')
  })

  it('rejects parents of protected files and symlinks outside writable roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-guard-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    mkdirSync(locations.home, { recursive: true })
    writeFileSync(join(locations.home, 'auth.json'), '{}')
    const parent = join(locations.home, 'container')
    const outside = join(root, 'outside')
    mkdirSync(parent); mkdirSync(outside)
    symlinkSync(outside, join(parent, 'escape'))
    const guard = new ProtectedPaths(locations)
    expect(rejection(() => guard.validate(locations.home))).toBe('guard.wholeDataRoot')
    const profile = join(locations.appSupport, 'Default')
    mkdirSync(join(profile, 'Cookies'), { recursive: true })
    expect(rejection(() => guard.validate(profile))).toBe('guard.protectedPath')
    expect(rejection(() => guard.validate(join(parent, 'escape')))).toBe('guard.symlinkEscape')
  })
})
