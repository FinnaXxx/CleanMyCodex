import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isCodexDesktopActiveProcessCommand, isCodexDesktopMainProcessCommand, isCodexDesktopProcessCommand, isCodexDesktopSessionServiceCommand, isCodexProcessCommand } from '../electron/main/platform-services'

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

  it('waits for profile-using helpers and ignores only crash reporters', () => {
    const renderer = '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer'
    const network = '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex Helper.app/Contents/MacOS/Codex Helper --type=utility --utility-sub-type=network.mojom.NetworkService'
    const storage = '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex Helper.app/Contents/MacOS/Codex Helper --type=utility --utility-sub-type=storage.mojom.StorageService'
    const browserCrashpad = '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/browser_crashpad_handler --monitor-self'
    const chromeCrashpad = '/Applications/Codex.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --monitor-self'

    expect(isCodexDesktopActiveProcessCommand('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT')).toBe(true)
    expect(isCodexDesktopActiveProcessCommand('/Applications/ChatGPT.app/Contents/Resources/codex app-server')).toBe(true)
    expect(isCodexDesktopActiveProcessCommand(renderer)).toBe(true)
    expect(isCodexDesktopActiveProcessCommand(network)).toBe(true)
    expect(isCodexDesktopActiveProcessCommand(storage)).toBe(true)
    expect(isCodexDesktopActiveProcessCommand(browserCrashpad)).toBe(false)
    expect(isCodexDesktopActiveProcessCommand(chromeCrashpad)).toBe(false)
  })

  it('does not mistake CleanMyCodex for Codex', () => {
    expect(isCodexProcessCommand('C:\\Program Files\\CleanMyCodex\\CleanMyCodex.exe')).toBe(false)
    expect(isCodexProcessCommand('/Applications/Safari.app/Contents/MacOS/Safari')).toBe(false)
  })
})

describe('Windows desktop detection', () => {
  // The win32 branches of the classifiers gate on process.platform; stub it so the same
  // assertions hold on every CI OS, not only the Windows runner.
  const realPlatform = process.platform
  beforeAll(() => { Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }) })
  afterAll(() => { Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }) })

  // Real Codex desktop install on Windows: an MSIX under Program Files\WindowsApps\OpenAI.Codex_<ver>\.
  const main = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.818.8289.0_arm64__2p2nqsd0c76g0\\app\\ChatGPT.exe'
  const helper = `${main} --type=renderer --lang=zh-CN`
  const crashpad = `${main} --type=crashpad-handler --database=C:\\Users\\erinfan\\AppData\\Roaming\\Codex\\web\\Codex\\Crashpad`
  const session = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.818.8289.0_arm64__2p2nqsd0c76g0\\app\\resources\\codex.exe -c features.code_mode_host=true app-server --analytics-default-enabled'
  const cli = 'C:\\Users\\erinfan\\AppData\\Roaming\\npm\\codex.exe exec task'

  it('sees the ChatGPT.exe main and Electron helpers as Codex desktop processes', () => {
    expect(isCodexProcessCommand(main)).toBe(true)
    expect(isCodexDesktopProcessCommand(main)).toBe(true)
    expect(isCodexDesktopMainProcessCommand(main)).toBe(true)
    expect(isCodexDesktopActiveProcessCommand(main)).toBe(true)

    expect(isCodexProcessCommand(helper)).toBe(true)
    expect(isCodexDesktopProcessCommand(helper)).toBe(true)
    expect(isCodexDesktopMainProcessCommand(helper)).toBe(false) // has --type=
    expect(isCodexDesktopActiveProcessCommand(helper)).toBe(true)
  })

  it('counts the crashpad helper as desktop but not as active', () => {
    expect(isCodexDesktopProcessCommand(crashpad)).toBe(true)
    expect(isCodexDesktopActiveProcessCommand(crashpad)).toBe(false)
    expect(isCodexDesktopMainProcessCommand(crashpad)).toBe(false)
  })

  it('classifies the app-server session service as desktop, never as the quit-able main', () => {
    expect(isCodexProcessCommand(session)).toBe(true)
    expect(isCodexDesktopProcessCommand(session)).toBe(true)
    expect(isCodexDesktopMainProcessCommand(session)).toBe(false) // app-server present
    expect(isCodexDesktopActiveProcessCommand(session)).toBe(true)
  })

  it('keeps a terminal codex CLI invocation out of the desktop bucket', () => {
    expect(isCodexProcessCommand(cli)).toBe(true)
    expect(isCodexDesktopProcessCommand(cli)).toBe(false)
    expect(isCodexDesktopMainProcessCommand(cli)).toBe(false)
  })

  it('does not mistake CleanMyCodex for the Codex desktop app', () => {
    const cmc = 'C:\\Users\\erinfan\\AppData\\Local\\Programs\\CleanMyCodex\\CleanMyCodex.exe'
    expect(isCodexProcessCommand(cmc)).toBe(false)
    expect(isCodexDesktopProcessCommand(cmc)).toBe(false)
  })
})
