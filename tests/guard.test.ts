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

  it('allows named cache directories but never a whole data root, cache containers included', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-guard-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    for (const cache of locations.appCaches) mkdirSync(cache, { recursive: true })
    mkdirSync(locations.appSupport, { recursive: true })
    const guard = new ProtectedPaths(locations)

    for (const cache of locations.appCaches) expect(() => guard.validate(cache)).not.toThrow()
    expect(locations.appCacheContainers.length).toBeGreaterThan(0)
    // An application's cache container holds whatever it likes beside the rebuildable
    // directories: deleting it outright is what takes a login with it.
    for (const container of locations.appCacheContainers) {
      expect(rejection(() => guard.validate(container))).toBe('guard.wholeDataRoot')
    }
    expect(rejection(() => guard.validate(locations.home))).toBe('guard.wholeDataRoot')
    expect(rejection(() => guard.validate(locations.appSupport))).toBe('guard.wholeDataRoot')
  })

  it('rejects every unnamed path inside desktop data roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-guard-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const guard = new ProtectedPaths(locations)
    const unknownProfile = join(locations.appSupport, 'Future Profile', 'Future Storage')
    const unknownCacheState = join(locations.appCacheContainers[0], 'session-state')
    mkdirSync(unknownProfile, { recursive: true })
    mkdirSync(unknownCacheState, { recursive: true })

    expect(rejection(() => guard.validate(unknownProfile))).toBe('guard.protectedPath')
    expect(rejection(() => guard.validate(unknownCacheState))).toBe('guard.protectedPath')
  })

  it('protects login-bearing profile data in both Chromium profile layouts', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-guard-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const guard = new ProtectedPaths(locations)
    // Cookies moved under Network/ in current Chromium, and the desktop app runs with a
    // Default profile on some builds and straight in the user-data root on others.
    for (const relative of ['Network', 'Network/Cookies', 'Local Storage', 'Service Worker', 'Local State',
      'codex-browser-app', 'Default/Network/Cookies', 'Default/Local Storage', 'Default/Service Worker',
      'Default/Partitions', 'Default/Partitions/codex-browser-app']) {
      const path = join(locations.appSupport, relative)
      mkdirSync(path, { recursive: true })
      expect(rejection(() => guard.validate(path)), relative).toBe('guard.protectedPath')
    }
    // The desktop's own conversation store and persisted state never go either.
    for (const relative of ['sqlite', '.codex-global-state.json']) {
      const path = join(locations.home, relative)
      mkdirSync(path, { recursive: true })
      expect(rejection(() => guard.validate(path)), relative).toBe('guard.protectedPath')
    }
  })

  it('locks cache-shaped App Support paths while allowing exact platform-cache leaves', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-guard-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const guard = new ProtectedPaths(locations)
    for (const relative of ['Cache', 'Default/Cache', 'GraphiteDawnCache']) {
      const path = join(locations.appSupport, relative)
      mkdirSync(path, { recursive: true })
      expect(rejection(() => guard.validate(path)), path).toBe('guard.protectedPath')
    }
    for (const path of locations.appCaches) {
      mkdirSync(path, { recursive: true })
      expect(() => guard.validate(path), path).not.toThrow()
    }
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
