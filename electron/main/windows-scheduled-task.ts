export const WINDOWS_TASK_NAME = 'CleanMyCodex Automatic Cleanup'
export const WINDOWS_TASK_ARGUMENTS = '--auto-clean'

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * PowerShell emits one invariant ISO timestamp. This avoids both localized field names
 * (`Next Run Time`, `下次运行时间`, …) and locale-specific date parsing in JavaScript.
 */
export function windowsNextRunPowerShell(taskName = WINDOWS_TASK_NAME): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$next = (Get-ScheduledTaskInfo -TaskName ${powershellLiteral(taskName)}).NextRunTime`,
    'if ($null -ne $next -and $next -gt [datetime]::MinValue) {',
    "  [Console]::Out.Write($next.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture))",
    '}'
  ].join('\n')
}

/**
 * Compare the installed definition inside PowerShell and return ASCII only. Paths can
 * contain characters that Windows PowerShell 5 writes using the active console code page;
 * passing the expected values through the environment and returning just match/mismatch
 * keeps the Node side independent of that encoding.
 */
export function windowsTaskMatchesPowerShell(taskName = WINDOWS_TASK_NAME): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$task = Get-ScheduledTask -TaskName ${powershellLiteral(taskName)}`,
    '$action = @($task.Actions)[0]',
    '$trigger = @($task.Triggers)[0]',
    '$settings = $task.Settings',
    "$actualExecute = ([string]$action.Execute).Trim().Trim('\"')",
    "$expectedExecute = ([string]$env:CLEANMYCODEX_TASK_EXECUTABLE).Trim().Trim('\"')",
    '$executeMatches = [string]::Equals([IO.Path]::GetFullPath($actualExecute), [IO.Path]::GetFullPath($expectedExecute), [StringComparison]::OrdinalIgnoreCase)',
    '$argumentsMatches = [string]::Equals(([string]$action.Arguments).Trim(), $env:CLEANMYCODEX_TASK_ARGUMENTS, [StringComparison]::Ordinal)',
    '$intervalMatches = [int]$trigger.DaysInterval -eq [int]$env:CLEANMYCODEX_TASK_INTERVAL_DAYS',
    "$instancesMatch = [string]::Equals([string]$settings.MultipleInstances, 'IgnoreNew', [StringComparison]::OrdinalIgnoreCase)",
    '$settingsMatch = [bool]$settings.StartWhenAvailable -and -not [bool]$settings.DisallowStartIfOnBatteries -and -not [bool]$settings.StopIfGoingOnBatteries -and $instancesMatch',
    "if ($executeMatches -and $argumentsMatches -and $intervalMatches -and $settingsMatch) { [Console]::Out.Write('match') } else { [Console]::Out.Write('mismatch') }"
  ].join('\n')
}

/** Settings suited to an infrequent housekeeping task on laptops and sleeping PCs. */
export function windowsTaskSettingsPowerShell(taskName = WINDOWS_TASK_NAME): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew',
    `Set-ScheduledTask -TaskName ${powershellLiteral(taskName)} -Settings $settings | Out-Null`
  ].join('\n')
}

export function parseWindowsNextRunAt(output: string): number | null {
  const value = output.trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/i.test(value)) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseWindowsTaskMatch(output: string): boolean {
  return output.trim().toLowerCase() === 'match'
}
