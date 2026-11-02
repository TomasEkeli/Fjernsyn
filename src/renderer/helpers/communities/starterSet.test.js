import { describe, expect, it } from 'vitest'

import { recogniseSource } from './kinds/index'
import {
  ORIGINAL_STARTER_SOURCE_IDS,
  STARTER_SOURCE_IDS,
  STARTER_SOURCE_URLS,
  starterSources,
  starterSourcesOffered,
  starterSourcesToFollow,
  withEveryStarterOffered,
} from './starterSet'

const NOW = Date.parse('2026-11-01T12:00:00Z')

describe('the starter set', () => {
  it('is HackerTube and the five Lemmy communities of the spec, then those added since, in order', () => {
    expect(starterSources(NOW).map(source => source._id)).toEqual([
      'hackertube',
      'lemmy:mealtimevideos@lemmy.cafe',
      'lemmy:videos@lemmy.world',
      'lemmy:peertube@lemmy.world',
      'lemmy:documentaries@lemmy.cafe',
      'lemmy:talks@programming.dev',
      'lemmy:videos@sopuli.xyz',
      'lemmy:youtubeclassics@sh.itjust.works',
      'lemmy:videoessays@lemmy.world',
      'lemmy:trailers@lemmy.blahaj.zone',
      'lemmy:industrialvideos@lemmy.zip',
      'lemmy:animatedmusicvideos@sh.itjust.works',
      'lemmy:80smusic@lemmy.world',
      'lemmy:70smusic@lemmy.world',
      'lemmy:electronicmusic@lemmy.ca',
      'lemmy:vgmusic@lemmy.world',
      'lemmy:melodicdeathmetal@lemmy.world',
      'lemmy:music@lemmy.world',
      'lemmy:metal@lemmy.world',
    ])
    expect(STARTER_SOURCE_IDS).toEqual(starterSources(NOW).map(source => source._id))
    expect(ORIGINAL_STARTER_SOURCE_IDS).toEqual(STARTER_SOURCE_IDS.slice(0, 6))
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

describe('the starter sources offered already', () => {
  it('are those the setting lists, and nothing on a fresh installation', () => {
    expect([...starterSourcesOffered([], false)]).toEqual([])
    expect([...starterSourcesOffered(undefined, false)]).toEqual([])
    expect([...starterSourcesOffered(['lemmy:metal@lemmy.world'], false)]).toEqual(['lemmy:metal@lemmy.world'])
  })

  it('are the original six too where the old mark says the set was applied', () => {
    expect([...starterSourcesOffered(undefined, true)]).toEqual(ORIGINAL_STARTER_SOURCE_IDS)
    expect([...starterSourcesOffered(['lemmy:metal@lemmy.world'], true)].sort()).toEqual([...ORIGINAL_STARTER_SOURCE_IDS, 'lemmy:metal@lemmy.world'].sort())
  })

  it('become every starter, sorted, with those listed already kept', () => {
    expect(withEveryStarterOffered(undefined)).toEqual([...STARTER_SOURCE_IDS].sort())
    expect(withEveryStarterOffered(['lemmy:gone@lemmy.example', 'hackertube'])).toEqual([...STARTER_SOURCE_IDS, 'lemmy:gone@lemmy.example'].sort())
  })
})

describe('which of the starter set to follow', () => {
  const starters = starterSources(NOW)
  const ids = sources => sources.map(source => source._id)
  const followedOf = (...followed) => sourceId => followed.includes(sourceId)
  const none = new Set()

  it('is all of it on a fresh installation', () => {
    expect(ids(starterSourcesToFollow(starters, { offered: none, isFollowed: followedOf() }))).toHaveLength(19)
  })

  it('is the rest of it where some are followed already, as on an installation from before the set', () => {
    const toFollow = starterSourcesToFollow(starters, { offered: none, isFollowed: followedOf('hackertube', 'lemmy:mealtimevideos@lemmy.cafe') })

    expect(ids(toFollow)).toEqual(STARTER_SOURCE_IDS.slice(2))
  })

  it('is the ones added since where the old mark says the set was applied, not the original six', () => {
    const toFollow = starterSourcesToFollow(starters, { offered: starterSourcesOffered(undefined, true), isFollowed: followedOf() })

    expect(ids(toFollow)).toEqual(STARTER_SOURCE_IDS.slice(6))
    expect(ids(toFollow)).toHaveLength(13)
  })

  it('is nothing once every one has been offered, whatever is followed, so that an unfollowed starter stays unfollowed', () => {
    const all = new Set(STARTER_SOURCE_IDS)
    expect(starterSourcesToFollow(starters, { offered: all, isFollowed: followedOf() })).toEqual([])
    expect(starterSourcesToFollow(starters, { offered: all, isFollowed: followedOf('hackertube') })).toEqual([])
  })

  it('is nothing where every one is followed already', () => {
    expect(starterSourcesToFollow(starters, { offered: none, isFollowed: () => true })).toEqual([])
  })
})
