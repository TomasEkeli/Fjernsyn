import { describe, expect, it } from 'vitest'

import { appliedFilters, offeredIn, optionsFor, platformsOf } from './capabilities'
import { defaults } from './query'

describe('platformsOf', () => {
  it('sends each scope to its platforms', () => {
    expect(platformsOf('youtube')).toEqual(['youtube'])
    expect(platformsOf('peertube')).toEqual(['peertube'])
    expect(platformsOf('all')).toEqual(['youtube', 'peertube'])
  })
})

describe('appliedFilters', () => {
  const everything = {
    ...defaults('peertube'),
    instance: 'tilvids.com',
    sort: 'views',
    time: 'week',
    type: 'video',
    length: 'short',
    language: ['no'],
    live: true,
    nsfw: true,
  }

  it('lists what YouTube honours: popularity, time, type, length and live', () => {
    expect(appliedFilters('youtube', everything)).toEqual(['sort', 'time', 'type', 'length', 'live'])
  })

  it('leaves out a sort YouTube does not have', () => {
    expect(appliedFilters('youtube', { ...defaults('all'), sort: 'date' })).toEqual([])
    expect(appliedFilters('youtube', { ...defaults('all'), sort: 'trending' })).toEqual([])
  })

  it('lists every set filter for PeerTube videos', () => {
    expect(appliedFilters('peertube', everything)).toEqual(['instance', 'sort', 'time', 'type', 'length', 'language', 'live', 'nsfw'])
  })

  it('leaves out the types PeerTube has not', () => {
    expect(appliedFilters('peertube', { ...defaults('all'), type: 'playlist' })).toEqual([])
    expect(appliedFilters('youtube', { ...defaults('all'), type: 'playlist' })).toEqual(['type'])
  })

  it('lists only the type and the instance on PeerTube\'s channel search', () => {
    const channels = { ...defaults('peertube'), type: 'channel', sort: 'date', language: ['no'], nsfw: true, instance: 'tilvids.com' }

    expect(appliedFilters('peertube', channels)).toEqual(['instance', 'type'])
  })

  it('is empty for a plain query', () => {
    expect(appliedFilters('youtube', defaults())).toEqual([])
    expect(appliedFilters('peertube', defaults())).toEqual([])
  })
})

describe('optionsFor', () => {
  it('offers YouTube its two sorts', () => {
    expect(optionsFor('sort', 'youtube')).toEqual([null, 'views'])
  })

  it('offers PeerTube and All every sort', () => {
    expect(optionsFor('sort', 'peertube')).toEqual([null, 'date', 'views', 'trending'])
    expect(optionsFor('sort', 'all')).toEqual([null, 'date', 'views', 'trending'])
  })

  it('offers PeerTube videos and channels, and YouTube every type', () => {
    expect(optionsFor('type', 'peertube')).toEqual([null, 'video', 'channel'])
    expect(optionsFor('type', 'youtube')).toEqual([null, 'video', 'channel', 'playlist', 'shorts', 'movie'])
  })
})

describe('offeredIn', () => {
  it('hides language and NSFW in the YouTube scope, and shows them where PeerTube is', () => {
    expect(offeredIn('language', 'youtube')).toBe(false)
    expect(offeredIn('nsfw', 'youtube')).toBe(false)
    expect(offeredIn('language', 'all')).toBe(true)
    expect(offeredIn('nsfw', 'peertube')).toBe(true)
  })

  it('offers what YouTube has everywhere', () => {
    for (const name of ['sort', 'time', 'type', 'length', 'live']) {
      expect(offeredIn(name, 'youtube')).toBe(true)
    }
  })
})
