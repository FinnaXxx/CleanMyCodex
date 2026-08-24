import { describe, expect, it } from 'vitest'
import { newerReleaseVersion } from '../electron/main/release-update'

describe('release update version comparison', () => {
  it('recognises newer major, minor, and patch releases', () => {
    expect(newerReleaseVersion('1.2.3', 'v2.0.0')).toBe('2.0.0')
    expect(newerReleaseVersion('1.2.3', 'v1.3.0')).toBe('1.3.0')
    expect(newerReleaseVersion('1.2.3', 'v1.2.4')).toBe('1.2.4')
  })

  it('ignores the current version and older releases', () => {
    expect(newerReleaseVersion('1.2.3', 'v1.2.3')).toBeNull()
    expect(newerReleaseVersion('1.2.3', 'v1.2.2')).toBeNull()
    expect(newerReleaseVersion('1.2.3', 'v1.1.9')).toBeNull()
  })

  it('accepts tags without v and ignores malformed versions', () => {
    expect(newerReleaseVersion('1.2.3', '1.2.4')).toBe('1.2.4')
    expect(newerReleaseVersion('1.2.3', 'release-1.2.4')).toBeNull()
    expect(newerReleaseVersion('development', 'v1.2.4')).toBeNull()
  })
})
