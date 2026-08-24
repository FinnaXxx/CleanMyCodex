import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MessageError, decodeMessage, encodeMessage, formatErrorText, formatMessage, message } from '../shared/messages'

const root = join(import.meta.dirname, '..')

describe('shared message table', () => {
  it('renders both languages and substitutes parameters', () => {
    const blocked = message('blocker.cliRunning', { count: 3 })
    expect(formatMessage(blocked, 'zh-CN')).toBe('终端里有 3 个 codex 进程在运行')
    expect(formatMessage(blocked, 'en')).toBe('3 codex processes are running in a terminal')
  })

  it('keeps a placeholder that has no parameter rather than printing undefined', () => {
    expect(formatMessage({ key: 'guard.protectedPath' }, 'en')).toBe('Protected path: {path}')
  })

  it('recovers a message from an error that crossed IPC inside Electron wrapping', () => {
    const error = new MessageError(message('error.scanFirst'))
    const wrapped = `Error invoking remote method 'cleanup:prepare': Error: ${error.message}`
    expect(decodeMessage(wrapped)?.key).toBe('error.scanFirst')
    expect(formatErrorText(wrapped, 'en')).toBe('Run a scan first')
  })

  it('shows unknown text verbatim and resolves a known token in either language', () => {
    expect(formatErrorText('ENOSPC: no space left on device', 'en')).toBe('ENOSPC: no space left on device')
    const encoded = encodeMessage({ key: 'error.scanFailed' })
    expect(formatErrorText(encoded, 'zh-CN')).toBe('扫描失败')
    expect(formatErrorText(encoded, 'en')).toBe('Scan failed')
  })

  /**
   * The whole point of the table is that neither language can quietly fall behind, so
   * guard against an entry that was added with one side left empty or copied over.
   */
  it('defines a distinct, non-empty translation for every key', () => {
    const source = readFileSync(join(root, 'shared', 'messages.ts'), 'utf8')
    const table = source.slice(source.indexOf('const TRANSLATIONS'), source.indexOf('export function formatMessage'))
    const rows = [...table.matchAll(/^\s*'([\w.]+)':\s*\[(.+)\],?$/gm)]
    expect(rows.length).toBeGreaterThan(60)
    for (const [, key, pair] of rows) {
      const both = [...pair.matchAll(/'((?:\\.|[^'\\])*)'/g)].map((m) => m[1])
      expect(both, key).toHaveLength(2)
      for (const text of both) expect(text.trim(), key).not.toBe('')
    }
  })

  it('never leaves display text in the main process', () => {
    const files = [
      'electron/main/scanner.ts', 'electron/main/cleanup.ts', 'electron/main/planner.ts',
      'electron/main/plugins.ts', 'electron/main/platform-services.ts', 'electron/main/automation.ts',
      'electron/main/index.ts', 'electron/main/worker.ts', 'electron/main/app-server.ts',
      'electron/main/session-database.ts', 'electron/main/guard.ts', 'electron/main/release-update.ts',
      'shared/types.ts'
    ]
    for (const file of files) {
      const body = readFileSync(join(root, file), 'utf8')
      const code = body.split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n')
      expect(code, `${file} still builds user-facing text instead of emitting a Message`)
        .not.toMatch(/[\u4e00-\u9fa5]/)
    }
  })
})
