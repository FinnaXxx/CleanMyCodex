import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { automaticRunIsDue } from '../electron/main/automation'
import {
  parseWindowsNextRunAt,
  parseWindowsTaskMatch,
  windowsNextRunPowerShell,
  windowsTaskMatchesPowerShell,
  windowsTaskSettingsPowerShell
} from '../electron/main/windows-scheduled-task'

describe('Windows scheduled task integration', () => {
  const realPlatform = process.platform
  beforeAll(() => { Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }) })
  afterAll(() => { Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }) })

  it('accepts every Task Scheduler wake without comparing it to the next occurrence', () => {
    expect(automaticRunIsDue(123_456)).toEqual({ due: true, nextRunAt: 123_456 })
  })

  it('parses only the invariant timestamp emitted by PowerShell', () => {
    expect(parseWindowsNextRunAt('2026-09-24T07:14:00.0000000Z')).toBe(Date.UTC(2026, 8, 24, 7, 14))
    expect(parseWindowsNextRunAt('')).toBeNull()
    expect(parseWindowsNextRunAt('下次运行时间: 2026/9/24 15:14')).toBeNull()
  })

  it('queries NextRunTime structurally and formats it invariantly', () => {
    const script = windowsNextRunPowerShell()
    expect(script).toContain('Get-ScheduledTaskInfo')
    expect(script).toContain('.NextRunTime')
    expect(script).toContain("ToString('o'")
  })

  it('compares executable, arguments, interval and resilience settings inside PowerShell', () => {
    const script = windowsTaskMatchesPowerShell()
    expect(script).toContain('CLEANMYCODEX_TASK_EXECUTABLE')
    expect(script).toContain('CLEANMYCODEX_TASK_ARGUMENTS')
    expect(script).toContain('CLEANMYCODEX_TASK_INTERVAL_DAYS')
    expect(script).toContain('DaysInterval')
    expect(script).toContain('StartWhenAvailable')
    expect(script).toContain('DisallowStartIfOnBatteries')
    expect(script).toContain('StopIfGoingOnBatteries')
    expect(script).toContain('IgnoreNew')
    expect(parseWindowsTaskMatch('match')).toBe(true)
    expect(parseWindowsTaskMatch('mismatch')).toBe(false)
  })

  it('enables catch-up runs and permits a run to start and finish on battery', () => {
    const script = windowsTaskSettingsPowerShell()
    expect(script).toContain('New-ScheduledTaskSettingsSet')
    expect(script).toContain('-StartWhenAvailable')
    expect(script).toContain('-AllowStartIfOnBatteries')
    expect(script).toContain('-DontStopIfGoingOnBatteries')
    expect(script).toContain('-MultipleInstances IgnoreNew')
    expect(script).toContain('Set-ScheduledTask')
  })
})
