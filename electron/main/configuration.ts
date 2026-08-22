import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

/** The subset of config.toml that affects cleanup safety. */
export interface CodexConfiguration {
  localMarketplaceSources: string[]
}

export function loadCodexConfiguration(codexHome: string): CodexConfiguration {
  try {
    return {
      localMarketplaceSources: marketplaceSources(readFileSync(join(codexHome, 'config.toml'), 'utf8'))
        .map((source) => resolveConfiguredPath(source, codexHome))
    }
  } catch {
    return { localMarketplaceSources: [] }
  }
}

/**
 * Deliberately small TOML reader: only `source = "…"` values inside marketplace tables
 * are relevant. It supports table and inline-table forms used by Codex.
 */
export function marketplaceSources(text: string): string[] {
  const sources: string[] = []
  let insideMarketplace = false
  for (const raw of text.split(/\r?\n/)) {
    let line = stripComment(raw).trim()
    if (!line) continue
    if (line.startsWith('[')) {
      const header = line.replace(/^\[+|\]+$/g, '').trim()
      insideMarketplace = header === 'marketplaces' || header.startsWith('marketplaces.')
      continue
    }
    if (!insideMarketplace && !line.startsWith('marketplaces.')) continue
    const pattern = /(?:^|[\s{,])source\s*=\s*"((?:\\.|[^"\\])*)"/g
    for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
      const value = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      if (value) sources.push(value)
    }
  }
  return [...new Set(sources)]
}

function stripComment(line: string): string {
  let quoted = false
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (escaped) { escaped = false; continue }
    if (char === '\\' && quoted) { escaped = true; continue }
    if (char === '"') { quoted = !quoted; continue }
    if (char === '#' && !quoted) return line.slice(0, i)
  }
  return line
}

function resolveConfiguredPath(value: string, codexHome: string): string {
  const expanded = value === '~' ? homedir() : value.startsWith('~/') || value.startsWith('~\\')
    ? join(homedir(), value.slice(2))
    : value
  return normalize(isAbsolute(expanded) ? expanded : join(codexHome, expanded))
}
