/** GitHub's release tags in this repository are `v<major>.<minor>.<patch>`. */
const VERSION_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/

type VersionParts = readonly [number, number, number]

function parseVersion(value: string): VersionParts | null {
  const match = value.match(VERSION_TAG)
  if (!match) return null
  const parts = match.slice(1).map(Number) as unknown as VersionParts
  return parts.every(Number.isSafeInteger) ? parts : null
}

/**
 * Returns a normalized release version only when the GitHub tag is newer than the
 * packaged app. Malformed tags are ignored rather than turning an update check into a
 * startup error.
 */
export function newerReleaseVersion(currentVersion: string, releaseTag: string): string | null {
  const current = parseVersion(currentVersion)
  const release = parseVersion(releaseTag)
  if (!current || !release) return null

  for (let index = 0; index < release.length; index += 1) {
    if (release[index] > current[index]) return release.join('.')
    if (release[index] < current[index]) return null
  }
  return null
}
