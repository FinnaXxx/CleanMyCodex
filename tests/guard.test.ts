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
  it('locks the credential, database and sandbox paths Codex keeps in its home', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-guard-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const guard = new ProtectedPaths(locations)
    const locked = [
      'secrets/codex_auth.age', 'secrets/mcp_oauth.age', '.credentials.json', '.env',
      'logs_2.sqlite', 'state_5.sqlite', 'goals_1.sqlite', 'queue_1.sqlite',
      'memories_1.sqlite', 'thread_history_1.sqlite', 'history.jsonl',
      'db-backups/20260101', 'proxy/ca.pem', '.sandbox-secrets/sandbox_users.json',
      'cap_sid', 'hooks.json', 'managed_config.toml', 'environments.toml',
      'installation_id', 'session_index.jsonl', 'agents/reviewer.md',
      'plugins/data/linear-openai/state.json', 'plugins/known_marketplaces.json'
    ]
    for (const name of locked) {
      const path = join(locations.home, name)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, 'x')
      expect(guard.isProtected(path), name).toBe(true)
      expect(rejection(() => guard.validate(path)), name).toBe('guard.protectedPath')
    }
  })

  it('refuses every application log, which the desktop application rotates itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-guard-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const day = join(locations.appLogs, '2026', '07', '01')
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, 'codex-desktop-s1-100-t0.log'), 'x')
    const guard = new ProtectedPaths(locations)
    for (const path of [locations.appLogs, day, join(day, 'codex-desktop-s1-100-t0.log')]) {
      // macOS keeps the log root outside every data root, while Windows and Linux nest it
      // inside one. It is refused either way; only the reason given differs.
      expect(['guard.outsideDataRoots', 'guard.protectedPath'], path)
        .toContain(rejection(() => guard.validate(path)))
    }
  })

  it('allows the staging directories Codex abandons below its home', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-guard-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const guard = new ProtectedPaths(locations)
    const disposable = [
      join(locations.arg0Temporary, 'codex-arg0ABC'),
      join(locations.temporary, 'plugins-backup-XYZ'),
      ...locations.stagingParents.map((parent) => join(parent, 'staged-1'))
    ]
    for (const path of disposable) {
      mkdirSync(path, { recursive: true })
      expect(guard.isProtected(path), path).toBe(false)
      expect(() => guard.validate(path), path).not.toThrow()
    }
  })

  it('allows only exact source-known leaves inside the Codex cache container', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-guard-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const guard = new ProtectedPaths(locations)
    for (const cache of locations.codexCaches) {
      mkdirSync(cache, { recursive: true })
      expect(guard.isProtected(cache), cache).toBe(false)
      expect(() => guard.validate(cache), cache).not.toThrow()
      expect(rejection(() => guard.validate(join(cache, 'forged-child'))), cache).toBe('guard.protectedPath')
    }
    const unknown = join(locations.codexCache, 'future-runtime-state')
    mkdirSync(unknown, { recursive: true })
    expect(rejection(() => guard.validate(locations.codexCache))).toBe('guard.protectedPath')
    expect(rejection(() => guard.validate(unknown))).toBe('guard.protectedPath')
  })

  it('allows explicitly selected workspace children but never the workspace root', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-guard-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const child = join(locations.workspace, '2026-08-22')
    mkdirSync(child, { recursive: true })
    const guard = new ProtectedPaths(locations)
    expect(() => guard.validate(child)).not.toThrow()
    expect(rejection(() => guard.validate(locations.workspace))).toBe('guard.wholeDataRoot')
  })

  it('locks named cache directories and whole data roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-guard-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    for (const cache of locations.appCaches) mkdirSync(cache, { recursive: true })
    mkdirSync(locations.appSupport, { recursive: true })
    const guard = new ProtectedPaths(locations)

    for (const cache of locations.appCaches) expect(rejection(() => guard.validate(cache))).toBe('guard.protectedPath')
    expect(locations.appCacheContainers.length).toBeGreaterThan(0)
    // The container and every child remain locked; a cache-shaped name is not deletion
    // authority.
    for (const container of locations.appCacheContainers) {
      expect(rejection(() => guard.validate(container))).toBe('guard.wholeDataRoot')
    }
    expect(rejection(() => guard.validate(locations.home))).toBe('guard.wholeDataRoot')
    expect(rejection(() => guard.validate(locations.appSupport))).toBe('guard.wholeDataRoot')
  })

  it('allows one scanned ImageGen thread directory but protects its container and nested targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-guard-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const copy = join(locations.generatedImages, '11111111-1111-1111-1111-111111111111')
    const image = join(copy, 'ig_123.png')
    mkdirSync(copy, { recursive: true })
    writeFileSync(image, 'image')
    const guard = new ProtectedPaths(locations)

    expect(() => guard.validate(copy)).not.toThrow()
    expect(rejection(() => guard.validate(locations.generatedImages))).toBe('guard.protectedPath')
    expect(rejection(() => guard.validate(image))).toBe('guard.protectedPath')
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

  it('locks cache-shaped paths in App Support and platform-cache containers', () => {
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
      expect(rejection(() => guard.validate(path)), path).toBe('guard.protectedPath')
    }
  })

  it('releases only the worktrees Codex created, and never their root or their insides', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-guard-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const guard = new ProtectedPaths(locations)
    const worktreeRoot = locations.defaultWorktrees

    const build = (id: string, project: string, managed: boolean): string => {
      const checkout = join(worktreeRoot, id, project)
      const admin = join(root, 'repos', project, '.git', 'worktrees', project)
      mkdirSync(checkout, { recursive: true })
      mkdirSync(admin, { recursive: true })
      writeFileSync(join(admin, 'commondir'), '../..\n')
      if (managed) writeFileSync(join(admin, 'codex-thread.json'), '{"version":1,"ownerThreadId":"t"}')
      writeFileSync(join(checkout, '.git'), `gitdir: ${admin}\n`)
      return join(worktreeRoot, id)
    }

    const mine = build('aa01', 'codex-made', true)
    const theirs = build('bb02', 'hand-made', false)

    // The one Codex created is the only thing here a cleanup may name.
    expect(guard.isProtected(mine)).toBe(false)
    expect(() => guard.validate(mine)).not.toThrow()
    // A worktree without Codex' marker is someone else's work, wherever it happens to sit.
    expect(guard.isProtected(theirs)).toBe(true)
    expect(rejection(() => guard.validate(theirs))).toBe('guard.protectedPath')
    // Neither the root itself nor anything below a worktree is ever a target.
    expect(rejection(() => guard.validate(worktreeRoot))).toBe('guard.protectedPath')
    expect(rejection(() => guard.validate(join(mine, 'codex-made')))).toBe('guard.protectedPath')
    expect(rejection(() => guard.validate(join(mine, 'codex-made', 'node_modules')))).toBe('guard.protectedPath')
    // A directory that is not a worktree at all stays locked too.
    const stray = join(worktreeRoot, 'cc03')
    mkdirSync(stray, { recursive: true })
    expect(rejection(() => guard.validate(stray))).toBe('guard.protectedPath')
  })

  it('releases superseded Codex releases but never the one current points at', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-guard-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const guard = new ProtectedPaths(locations)
    const live = join(locations.standaloneReleases, '0.2.0-aarch64-apple-darwin')
    const old = join(locations.standaloneReleases, '0.1.0-aarch64-apple-darwin')
    mkdirSync(join(live, 'bin'), { recursive: true })
    mkdirSync(old, { recursive: true })
    symlinkSync(live, locations.standaloneCurrent)

    expect(guard.releasesInUse()).toEqual([live])
    expect(guard.isProtected(old)).toBe(false)
    expect(() => guard.validate(old)).not.toThrow()
    expect(rejection(() => guard.validate(live))).toBe('guard.protectedPath')
    expect(rejection(() => guard.validate(join(old, 'bin')))).toBe('guard.protectedPath')
    expect(rejection(() => guard.validate(locations.standaloneReleases))).toBe('guard.protectedPath')
    expect(rejection(() => guard.validate(locations.standalonePackages))).toBe('guard.protectedPath')
  })

  it('locks every release when nothing says which one is in use', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-guard-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const guard = new ProtectedPaths(locations)
    const release = join(locations.standaloneReleases, '0.1.0-aarch64-apple-darwin')
    mkdirSync(release, { recursive: true })
    expect(guard.releasesInUse()).toEqual([])
    expect(rejection(() => guard.validate(release))).toBe('guard.protectedPath')
  })

  it('locks the small state files a Codex release adds beside the ones already known', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-guard-')); roots.push(root)
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') })
    const guard = new ProtectedPaths(locations)
    for (const name of ['pets', 'plugins/cache', 'mcp-oauth-locks', 'thread-writer-locks',
      'models_cache.json', 'cloud-config-bundle-cache.json', '.personality_migration']) {
      const path = join(locations.home, name)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, 'x')
      expect(guard.isProtected(path), name).toBe(true)
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
