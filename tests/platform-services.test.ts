import { describe, expect, it } from 'vitest'
import { fileUsageFromLsof, isCodexProcessCommand } from '../electron/main/platform-services'

describe('Codex process detection', () => {
  it('recognises CLI and desktop commands on macOS and Windows', () => {
    expect(isCodexProcessCommand('/opt/homebrew/bin/codex exec task')).toBe(true)
    expect(isCodexProcessCommand('/Applications/Codex.app/Contents/MacOS/Codex --type=renderer')).toBe(true)
    expect(isCodexProcessCommand('ExecutablePath=C:\\Program Files\\Codex\\Codex.exe CommandLine="C:\\Program Files\\Codex\\Codex.exe" --type=renderer')).toBe(true)
    expect(isCodexProcessCommand('codex.exe app-server')).toBe(true)
  })

  it('does not mistake CleanMyCodex for Codex', () => {
    expect(isCodexProcessCommand('C:\\Program Files\\CleanMyCodex\\CleanMyCodex.exe')).toBe(false)
    expect(isCodexProcessCommand('/Applications/Safari.app/Contents/MacOS/Safari')).toBe(false)
  })
})

describe('lsof file usage interpretation', () => {
  it('treats the normal no-match exit as a definitive free result', () => {
    expect(fileUsageFromLsof('', 1)).toEqual({ kind: 'free' })
    expect(fileUsageFromLsof('', 0)).toEqual({ kind: 'free' })
  })

  it('keeps holders even on a nonstandard exit and reserves unknown for probe failures', () => {
    expect(fileUsageFromLsof('p12\ncCodex\np13\nccodex\n', 2)).toEqual({ kind: 'inUse', processes: ['Codex', 'codex'] })
    expect(fileUsageFromLsof('', 2)).toEqual({ kind: 'unknown' })
    expect(fileUsageFromLsof('', 1, true)).toEqual({ kind: 'unknown' })
  })
})
