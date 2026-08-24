import { describe, expect, it } from 'vitest'
import {
  SUGGESTED_ARCHIVED_SESSION_AGE_DAYS,
  sessionMatchesSuggestedArchivePreset,
  type SessionItem
} from '../shared/types'

const DAY = 86_400_000

function session(id: string, overrides: Partial<SessionItem> = {}): SessionItem {
  return {
    id,
    threadID: id,
    fileURL: `/codex/sessions/${id}.jsonl`,
    segmentURLs: [],
    location: 'archived',
    modifiedAt: 0,
    fileBytes: 100,
    assetBytes: 0,
    assetURLs: [],
    workingDirectory: null,
    title: id,
    preview: null,
    tags: [],
    isCompressed: false,
    isUnstable: false,
    parseWarnings: 0,
    blocksAutomaticCleanup: false,
    isPinned: false,
    isSubagent: false,
    parentThreadID: null,
    childThreadCount: 0,
    childBytes: 0,
    childURLs: [],
    ...overrides
  }
}

describe('suggested archived-session preset', () => {
  it('selects only stable, unpinned, unblocked archives at least 60 days old', () => {
    const now = 100 * DAY
    const cutoff = now - SUGGESTED_ARCHIVED_SESSION_AGE_DAYS * DAY
    const sessions = [
      session('eligible', { modifiedAt: cutoff }),
      session('recent', { modifiedAt: cutoff + 1 }),
      session('active', { location: 'active', modifiedAt: 0 }),
      session('pinned', { modifiedAt: 0, isPinned: true }),
      session('goal-or-queue', { modifiedAt: 0, blocksAutomaticCleanup: true }),
      session('being-written', { modifiedAt: 0, isUnstable: true })
    ]

    expect(sessions.filter((item) => sessionMatchesSuggestedArchivePreset(item, now)).map((item) => item.id))
      .toEqual(['eligible'])
  })
})
