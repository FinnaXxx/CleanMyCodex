import { describe, expect, it } from 'vitest'
import { normalizeAutomaticRunRecord } from '../shared/types'

describe('automatic cleanup records', () => {
  it('accepts the current timestamp representation', () => {
    const record = normalizeAutomaticRunRecord({
      finishedAt: 1_780_000_000_000,
      freedBytes: 42,
      succeeded: 2,
      failed: 0,
      skippedReason: null,
      deferred: 1,
      deferredNote: '文件正在使用'
    })
    expect(record).toEqual({
      finishedAt: 1_780_000_000_000,
      freedBytes: 42,
      succeeded: 2,
      failed: 0,
      skippedReason: null,
      deferred: 1,
      deferredNote: '文件正在使用'
    })
  })

  it('normalizes persisted reference-date seconds and missing optional fields', () => {
    expect(normalizeAutomaticRunRecord({
      finishedAt: 800_000_000,
      freedBytes: 10,
      succeeded: 1,
      failed: 0
    })).toEqual({
      finishedAt: 1_778_307_200_000,
      freedBytes: 10,
      succeeded: 1,
      failed: 0,
      skippedReason: null,
      deferred: 0,
      deferredNote: null
    })
  })

  it('rejects malformed records', () => {
    expect(normalizeAutomaticRunRecord({ finishedAt: 'today' })).toBeNull()
  })
})
