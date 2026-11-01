import { describe, expect, it } from 'vitest'

import { recogniseSource } from './kinds/index'
import { STARTER_SOURCE_URLS, starterSources } from './starterSet'

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

  it('are every URL in the list, each recognised by a source kind, none left out', () => {
    for (const url of STARTER_SOURCE_URLS) {
      expect(recogniseSource(url, NOW), url).not.toBe(null)
    }
    expect(starterSources(NOW)).toHaveLength(STARTER_SOURCE_URLS.length)
  })
})
