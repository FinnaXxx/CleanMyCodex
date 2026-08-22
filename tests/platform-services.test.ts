import { describe, expect, it } from 'vitest'
import { fileUsageFromLsof, isCodexDesktopMainProcessCommand, isCodexDesktopProcessCommand, isCodexDesktopSessionServiceCommand, isCodexProcessCommand } from '../electron/main/platform-services'

describe('Codex process detection', () => {
  it('recognises CLI and desktop commands on macOS and Windows', () => {
    expect(isCodexProcessCommand('/opt/homebrew/bin/codex exec task')).toBe(true)
    expect(isCodexProcessCommand('/Applications/Codex.app/Contents/MacOS/Codex --type=renderer')).toBe(true)
    expect(isCodexProcessCommand('/Applications/ChatGPT.app/Contents/Resources/codex app-server')).toBe(true)
    expect(isCodexProcessCommand('ExecutablePath=C:\\Program Files\\Codex\\Codex.exe CommandLine="C:\\Program Files\\Codex\\Codex.exe" --type=renderer')).toBe(true)
    expect(isCodexProcessCommand('codex.exe app-server')).toBe(true)
  })

  it('classifies Codex children hosted by ChatGPT as desktop processes, not terminal CLI', () => {
    expect(isCodexDesktopProcessCommand('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT')).toBe(true)
    expect(isCodexDesktopProcessCommand('/Applications/ChatGPT.app/Contents/Resources/codex app-server')).toBe(true)
    expect(isCodexDesktopProcessCommand('/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)')).toBe(true)
    expect(isCodexProcessCommand('/Users/test/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService')).toBe(false)
    expect(isCodexDesktopProcessCommand('/opt/homebrew/bin/codex exec task')).toBe(false)
  })

  it('uses only the app main executable to decide whether the macOS desktop app is still open', () => {
    expect(isCodexDesktopMainProcessCommand('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT')).toBe(true)
    expect(isCodexDesktopMainProcessCommand('/Applications/Codex.app/Contents/MacOS/Codex --some-flag')).toBe(true)
    expect(isCodexDesktopMainProcessCommand('/Applications/ChatGPT.app/Contents/Resources/codex app-server')).toBe(false)
    expect(isCodexDesktopMainProcessCommand('/Applications/ChatGPT.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler')).toBe(false)
    expect(isCodexDesktopMainProcessCommand('/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)')).toBe(false)
  })

  it('keeps waiting for the bundled session service but ignores unrelated helpers', () => {
    expect(isCodexDesktopSessionServiceCommand('/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server')).toBe(true)
    expect(isCodexDesktopSessionServiceCommand('/Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled')).toBe(true)
    expect(isCodexDesktopSessionServiceCommand('/Applications/ChatGPT.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler')).toBe(false)
    expect(isCodexDesktopSessionServiceCommand('/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer')).toBe(false)
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
