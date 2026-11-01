import { describe, expect, it } from 'vitest'

import { starterSources } from './starterSet'

const NOW = Date.parse('2026-11-01T12:00:00Z')

describe('the sources followed on the first open, besides HackerTube', () => {
  it('are mealtimevideos@lemmy.cafe, as a Lemmy source', () => {
    expect(starterSources(NOW)).toEqual([{
      _id: 'lemmy:mealtimevideos@lemmy.cafe',
      kind: 'lemmy',
      url: 'https://lemmy.cafe/c/mealtimevideos',
      name: 'mealtimevideos@lemmy.cafe',
      followedAt: NOW,
    }])
  })
})
