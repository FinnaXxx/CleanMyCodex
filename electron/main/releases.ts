import { readdirSync, realpathSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { directoryAllocatedSize } from './fs-size'

/**
 * Codex releases the standalone installer keeps on disk.
 *
 * `install.sh` unpacks every version it installs into
 * `~/.codex/packages/standalone/releases/<version>-<target>` and repoints a `current`
 * symlink at the new one. It sweeps its own staging directories on each run but never
 * removes a superseded release, and the app-server daemon's updater re-runs the installer
 * on a schedule, so the old ones accumulate a full copy of Codex apiece.
 *
 * `current` — plus whatever the `codex` command on PATH resolves to — is the evidence for
 * which release is live. Without it nothing here is offered, the same way a plugin whose
 * status the app server will not confirm stays locked.
 */

/** `0.1.0-aarch64-apple-darwin`: a version, then the target triple it was built for. */
const RELEASE_DIRECTORY_RE = /^\d+[0-9A-Za-z.+-]*-[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_.-]+$/

export interface ReleaseVersion {
  path: string
  /** Directory name, which is the version and target triple. */
  name: string
  bytes: number
  modifiedAt: number
  /** True for a release something still points at, so it is counted but never offered. */
  isCurrent: boolean
}

export function scanStandaloneReleases(releasesRoot: string, inUse: string[]): ReleaseVersion[] {
  const canonical = (path: string): string => {
    try { return normalize(realpathSync(path)) } catch { return normalize(path) }
  }
  const live = new Set(inUse.map(canonical))
  let children: string[]
  try {
    children = readdirSync(releasesRoot, { withFileTypes: true })
      .filter((child) => child.isDirectory() && RELEASE_DIRECTORY_RE.test(child.name))
      .map((child) => child.name)
  } catch { return [] }

  return children.map((name) => {
    const path = join(releasesRoot, name)
    let modifiedAt = 0
    try { modifiedAt = statSync(path).mtimeMs } catch { /* missing */ }
    return { path, name, bytes: directoryAllocatedSize(path), modifiedAt, isCurrent: live.has(canonical(path)) }
  }).sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name))
}
