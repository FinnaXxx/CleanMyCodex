import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AppServerClient,
  locateCodexExecutable,
  parsePlugins,
  windowsDesktopCodexCandidates
} from '../electron/main/app-server'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cleanmycodex-app-server-'))
  temporaryDirectories.push(directory)
  return directory
}

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
}

describe('codex executable locator', () => {
  it('discovers hash-versioned desktop binaries before the MSIX fallback', () => {
    const root = temporaryDirectory()
    const localAppData = join(root, 'LocalAppData')
    const programFiles = join(root, 'Program Files')
    const older = join(localAppData, 'OpenAI', 'Codex', 'bin', 'older-hash', 'codex.exe')
    const newer = join(localAppData, 'OpenAI', 'Codex', 'bin', 'newer-hash', 'codex.exe')
    const packaged = join(programFiles, 'WindowsApps', 'OpenAI.Codex_1.2.3.0_x64__8wekyb3d8bbwe', 'app', 'resources', 'codex.exe')
    touch(older)
    touch(newer)
    touch(packaged)
    utimesSync(older, new Date(1_000), new Date(1_000))
    utimesSync(newer, new Date(2_000), new Date(2_000))

    const candidates = windowsDesktopCodexCandidates({ LOCALAPPDATA: localAppData, ProgramFiles: programFiles }, root)
    expect(candidates.slice(0, 2)).toEqual([newer, older])
    expect(candidates).toContain(packaged)
    expect(candidates.indexOf(packaged)).toBeGreaterThan(candidates.indexOf(older))
    expect(locateCodexExecutable({ LOCALAPPDATA: localAppData, ProgramFiles: programFiles }, 'win32', root)).toBe(newer)
  })

  it('keeps CODEX_BINARY above desktop install discovery', () => {
    const root = temporaryDirectory()
    const override = join(root, 'manual', 'codex.exe')
    const bundled = join(root, 'LocalAppData', 'OpenAI', 'Codex', 'bin', 'hash', 'codex.exe')
    touch(override)
    touch(bundled)

    expect(locateCodexExecutable({
      CODEX_BINARY: override,
      LOCALAPPDATA: join(root, 'LocalAppData')
    }, 'win32', root)).toBe(override)
  })

  it('uses the packaged MSIX binary when no LocalAppData copy exists', () => {
    const root = temporaryDirectory()
    const programFiles = join(root, 'Program Files')
    const packaged = join(programFiles, 'WindowsApps', 'OpenAI.Codex_1.2.3.0_x64__8wekyb3d8bbwe', 'app', 'resources', 'codex.exe')
    touch(packaged)

    expect(locateCodexExecutable({
      LOCALAPPDATA: join(root, 'empty-local-app-data'),
      ProgramFiles: programFiles
    }, 'win32', root)).toBe(packaged)
  })

  it('retries a missing executable before every session open', async () => {
    let locateCalls = 0
    const client = new AppServerClient(rootlessHome(), 'test', null, 100, () => {
      locateCalls += 1
      return null
    })
    expect(locateCalls).toBe(1)

    await expect(client.openSession()).rejects.toBeInstanceOf(Error)
    await expect(client.openSession()).rejects.toBeInstanceOf(Error)
    expect(locateCalls).toBe(3)
  })

  it('reports why thread deletion fell back instead of losing the exception', async () => {
    const client = new AppServerClient(rootlessHome(), 'test', null, 100, () => null)
    const failures: string[] = []

    await expect(client.deleteThreads(['thread-id'], (reason) => failures.push(reason))).resolves.toBe(false)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('error.codexBinaryMissing')
  })
})

function rootlessHome(): string {
  return join(tmpdir(), 'cleanmycodex-missing-home')
}

describe('plugin/list parser', () => {
  it('reads the installed version and install path the way plugin/list means them', () => {
    // plugin/list's own shape: `version` is what the backend advertises, `localVersion`
    // is what is materialized on disk, and `source` is a tagged union.
    const parsed = parsePlugins({
      marketplaces: [{
        name: 'openai-curated-remote',
        plugins: [
          { id: 'linear@openai-curated-remote', name: 'linear', version: '2.0.0', localVersion: null, installed: true, source: { type: 'remote' } },
          { id: 'notion@openai-curated-remote', name: 'notion', version: '3.0.0', localVersion: '1.4.0', installed: true, source: { type: 'local', path: '/abs/notion/1.4.0' } },
          { id: 'repo@openai-curated-remote', name: 'repo', localVersion: '1.0.0', installed: true, source: { type: 'git', url: 'https://example.invalid/x.git', path: 'plugins/repo' } }
        ]
      }]
    })
    const byName = new Map(parsed.map((plugin) => [plugin.name, plugin]))
    // A remote-advertised version is never mistaken for the one on disk.
    expect(byName.get('linear')).toMatchObject({ version: null, directory: null })
    expect(byName.get('notion')).toMatchObject({ version: '1.4.0', directory: '/abs/notion/1.4.0' })
    // A git source's `path` points inside the repository, not at an install directory.
    expect(byName.get('repo')).toMatchObject({ version: '1.0.0', directory: null })
  })

  it('accepts marketplace rows and source paths', () => {
    expect(parsePlugins({ marketplaces: [{ name: 'personal', plugins: [{ name: 'demo', localVersion: '1.2.3', source: { path: '/plugins/demo' } }] }] })).toEqual([
      { marketplace: 'personal', name: 'demo', version: '1.2.3', directory: '/plugins/demo', installed: null }
    ])
  })

  it('preserves explicit installation state and marketplace identity', () => {
    expect(parsePlugins({ marketplaces: [{ name: 'catalog', plugins: [{ name: 'demo', version: '2.0.0', installed: false }] }] })).toEqual([
      { marketplace: 'catalog', name: 'demo', version: '2.0.0', directory: null, installed: false }
    ])
  })
})
