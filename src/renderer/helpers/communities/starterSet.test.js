import { describe, expect, it } from 'vitest'

import { recogniseSource } from './kinds/index'
import { STARTER_SOURCE_URLS, starterSources, starterSourcesToFollow } from './starterSet'

const NOW = Date.parse('2026-11-01T12:00:00Z')

describe('the starter set', () => {
  it('is HackerTube and the five Lemmy communities of the spec, in its order', () => {
    expect(starterSources(NOW).map(source => source._id)).toEqual([
      'hackertube',
      'lemmy:mealtimevideos@lemmy.cafe',
      'lemmy:videos@lemmy.world',
      'lemmy:peertube@lemmy.world',
      'lemmy:documentaries@lemmy.cafe',
      'lemmy:talks@programming.dev',
    ])
  })

  it('is followed as a source followed by its URL would be, HackerTube with no export loaded yet', () => {
    const [hackerTube, mealtime] = starterSources(NOW)

    expect(hackerTube).toEqual({ _id: 'hackertube', kind: 'hackertube', url: 'https://hackertube.org', name: 'HackerTube', followedAt: NOW, dataGenerated: null })
    expect(mealtime).toEqual({
      _id: 'lemmy:mealtimevideos@lemmy.cafe',
      kind: 'lemmy',
      url: 'https://lemmy.cafe/c/mealtimevideos',
      name: 'mealtimevideos@lemmy.cafe',
      followedAt: NOW,
    })
  })

  it('is every URL in the list, each recognised by a source kind, none left out', () => {
    for (const url of STARTER_SOURCE_URLS) {
      expect(recogniseSource(url, NOW), url).not.toBe(null)
    }
    expect(starterSources(NOW)).toHaveLength(STARTER_SOURCE_URLS.length)
  })
})

describe('which of the starter set to follow', () => {
  const starters = starterSources(NOW)
  const ids = sources => sources.map(source => source._id)
  const followedOf = (...followed) => sourceId => followed.includes(sourceId)

  it('is all of it on a fresh installation', () => {
    expect(ids(starterSourcesToFollow(starters, { applied: false, isFollowed: followedOf() }))).toEqual(ids(starters))
  })

  it('is the rest of it where some are followed already, as on an installation from before the set', () => {
    const toFollow = starterSourcesToFollow(starters, { applied: false, isFollowed: followedOf('hackertube', 'lemmy:mealtimevideos@lemmy.cafe') })

    expect(ids(toFollow)).toEqual([
      'lemmy:videos@lemmy.world',
      'lemmy:peertube@lemmy.world',
      'lemmy:documentaries@lemmy.cafe',
      'lemmy:talks@programming.dev',
    ])
  })

  it('is nothing once it has been applied, whatever is followed, so that an unfollowed starter stays unfollowed', () => {
    expect(starterSourcesToFollow(starters, { applied: true, isFollowed: followedOf() })).toEqual([])
    expect(starterSourcesToFollow(starters, { applied: true, isFollowed: followedOf('hackertube') })).toEqual([])
  })

  it('is nothing where every one is followed already', () => {
    expect(starterSourcesToFollow(starters, { applied: false, isFollowed: () => true })).toEqual([])
  })
})
