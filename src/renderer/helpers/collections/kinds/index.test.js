import { describe, expect, it } from 'vitest'

import { recogniseSource, SOURCE_KINDS, SOURCE_KINDS_BY_KIND } from './index'
import { hackerTubeSource } from '../hackertube'

const NOW = Date.parse('2026-11-01T12:00:00Z')

describe('source kinds', () => {
  it('each does the three things a source kind does', () => {
    for (const kind of SOURCE_KINDS) {
      expect(typeof kind.kind, kind.kind).toBe('string')
      expect(typeof kind.recognise, kind.kind).toBe('function')
      expect(typeof kind.fetch, kind.kind).toBe('function')
      expect(typeof kind.toShares, kind.kind).toBe('function')
      expect(SOURCE_KINDS_BY_KIND[kind.kind]).toBe(kind)
    }
  })

  it('has HackerTube first', () => {
    expect(SOURCE_KINDS[0].kind).toBe('hackertube')
  })

  it('makes a pasted URL the source of the first kind that recognises it', () => {
    expect(recogniseSource('https://hackertube.org', NOW)).toEqual(hackerTubeSource(NOW))
  })

  it('makes nothing of a URL no kind recognises', () => {
    expect(recogniseSource('https://example.com/videos', NOW)).toBe(null)
  })
})
