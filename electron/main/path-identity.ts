import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, sep, win32 } from 'node:path'

/** Resolve filesystem aliases through the nearest existing ancestor. */
function canonicalExistingPath(path: string): string {
  const normalized = normalize(path)
  try { return normalize(realpathSync(normalized)) } catch { /* try an existing ancestor */ }
  // On another host, a Windows path is not native or probeable. Its own path flavor is
  // handled below, and treating it as a relative POSIX name would corrupt it.
  if (!isAbsolute(normalized)) return normalized

  const suffix: string[] = []
  let candidate = normalized
  while (true) {
    const parent = dirname(candidate)
    if (parent === candidate) return normalized
    suffix.unshift(basename(candidate))
    candidate = parent
    try { return normalize(join(realpathSync(candidate), ...suffix)) } catch { /* keep walking */ }
  }
}

/**
 * Convert both ordinary and extended-length Windows paths to the same spelling. This is
 * intentionally recognised on every host so Windows path behavior can be regression
 * tested on macOS and Linux.
 */
function comparableWindowsPath(path: string): string | null {
  let ordinary = path.replaceAll('/', '\\')
  const lower = ordinary.toLowerCase()
  if (lower.startsWith('\\\\?\\unc\\')) ordinary = `\\\\${ordinary.slice(8)}`
  else if (lower.startsWith('\\\\?\\')) ordinary = ordinary.slice(4)

  if (!/^[a-z]:\\/i.test(ordinary) && !ordinary.startsWith('\\\\')) return null
  return win32.normalize(ordinary)
}

/** A stable, case-insensitive identity for Windows paths and a canonical identity elsewhere. */
export function pathIdentityKey(path: string): string {
  const canonical = canonicalExistingPath(path)
  const windows = comparableWindowsPath(canonical) ?? comparableWindowsPath(path)
  return windows === null ? `native:${canonical}` : `windows:${windows.toLowerCase()}`
}

/** Keep the first spelling of every physical path. */
export function uniquePaths(paths: string[]): string[] {
  const unique = new Map<string, string>()
  for (const path of paths) {
    const key = pathIdentityKey(path)
    if (!unique.has(key)) unique.set(key, path)
  }
  return [...unique.values()]
}

/**
 * Path components below `root`, or null when `candidate` is outside it. Windows paths
 * are compared through `node:path.win32` after removing `\\?\`; native paths retain
 * realpath-based alias handling.
 */
export function relativePathSegments(root: string, candidate: string): string[] | null {
  const canonicalRoot = canonicalExistingPath(root)
  const canonicalCandidate = canonicalExistingPath(candidate)
  const windowsRoot = comparableWindowsPath(canonicalRoot) ?? comparableWindowsPath(root)
  const windowsCandidate = comparableWindowsPath(canonicalCandidate) ?? comparableWindowsPath(candidate)

  if ((windowsRoot === null) !== (windowsCandidate === null)) return null
  const rel = windowsRoot !== null && windowsCandidate !== null
    ? win32.relative(windowsRoot, windowsCandidate)
    : relative(canonicalRoot, canonicalCandidate)
  const separator = windowsRoot === null ? sep : win32.sep
  const absolute = windowsRoot === null ? isAbsolute(rel) : win32.isAbsolute(rel)
  if (rel === '..' || rel.startsWith(`..${separator}`) || absolute) return null
  return rel.split(separator).filter(Boolean)
}
