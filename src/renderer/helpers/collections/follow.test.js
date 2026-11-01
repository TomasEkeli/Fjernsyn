import { describe, expect, it, vi } from 'vitest'

import { trySource } from './follow'
import { hackerTubeSource } from './hackertube'
import { lemmyKind, lemmySource } from './kinds/lemmy'

// A real feed of lemmy.cafe's mealtimevideos, trimmed to two posts
import mealtimeTopWeek from './kinds/fixtures/lemmy.cafe--mealtimevideos-topweek.xml?raw'

const NOW = Date.parse('2026-11-01T12:00:00Z')

const MEALTIME = lemmySource({ name: 'mealtimevideos', host: 'lemmy.cafe' }, NOW)

/**
 * The instances as a pasted URL's trial asks them: lemmy.cafe serves its
 * communities' feeds, slrpnk.net serves none (it answers 404, as it did on
 * 2026-11-01), html.example answers every page with a web page, and
 * down.example cannot be reached
 */
function stubInstances() {
  return vi.fn(async (url) => {
    const { host, pathname } = new URL(url)

    switch (host) {
      case 'lemmy.cafe':
        return pathname.startsWith('/feeds/c/')
          ? new Response(mealtimeTopWeek)
          : new Response('not found', { status: 404 })
      case 'slrpnk.net':
        return new Response('404: FetchError', { status: 404 })
      case 'html.example':
        return new Response('<!DOCTYPE html><html><body>Hello</body></html>')
      default:
        throw new TypeError('Failed to fetch')
    }
  })
}

/**
 * @param {string} text
 * @param {{ followed?: string[], fetch?: import('vitest').Mock }} [options]
 */
function attempt(text, { followed = [], fetch = stubInstances() } = {}) {
  return trySource(text, { now: NOW, fetch, isFollowed: id => followed.includes(id) })
}

describe('trying a pasted URL before following it', () => {
  it('tries a Lemmy community\'s feed at its instance, and answers the source and what the feed gave', async () => {
    const fetch = stubInstances()

    const tried = await attempt('https://lemmy.cafe/c/mealtimevideos', { fetch })

    expect(tried.outcome).toBe('followable')
    expect(tried.source).toEqual(MEALTIME)
    expect(tried.fetched.items.map(post => post.postUrl)).toEqual(['https://lemmy.cafe/post/42041782', 'https://lemmy.cafe/post/41934384'])
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://lemmy.cafe/feeds/c/mealtimevideos.xml?sort=New&limit=50',
      'https://lemmy.cafe/feeds/c/mealtimevideos.xml?sort=TopWeek&limit=50',
    ])
  })

  it('hands the trial what confirms PeerTube links, so that a community followed keeps its PeerTube shares at once', async () => {
    const spy = vi.spyOn(lemmyKind, 'fetch')
    const peertube = { refFor: vi.fn(async () => null) }

    try {
      await trySource('https://lemmy.cafe/c/mealtimevideos', { now: NOW, fetch: stubInstances(), isFollowed: () => false, peertube })

      expect(spy).toHaveBeenCalledWith(MEALTIME, expect.objectContaining({ peertube }))
    } finally {
      spy.mockRestore()
    }
  })

  it('follows a community seen through another instance at its home instance', async () => {
    const fetch = stubInstances()

    const tried = await attempt('https://lemmy.world/c/mealtimevideos@lemmy.cafe', { fetch })

    expect(tried.outcome).toBe('followable')
    expect(tried.source).toEqual(MEALTIME)
    expect(fetch.mock.calls.every(([url]) => new URL(url).host === 'lemmy.cafe')).toBe(true)
  })

  it('takes a community\'s handle, with its !', async () => {
    const tried = await attempt('  !mealtimevideos@lemmy.cafe  ')

    expect(tried.outcome).toBe('followable')
    expect(tried.source).toEqual(MEALTIME)
  })

  it('refuses a URL no source kind recognises, without asking anything', async () => {
    const fetch = stubInstances()

    for (const text of ['https://example.com/videos', 'mealtimevideos@lemmy.cafe', 'https://www.youtube.com/c/somechannel', '', '   ']) {
      expect(await attempt(text, { fetch }), text).toEqual({ outcome: 'unrecognised' })
    }

    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a community whose instance serves no feed, as slrpnk.net does', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const tried = await attempt('https://slrpnk.net/c/solarpunk')

    expect(tried.outcome).toBe('no-feed')
    expect(tried.source).toMatchObject({ _id: 'lemmy:solarpunk@slrpnk.net', name: 'solarpunk@slrpnk.net' })
  })

  it('refuses a community whose instance answers with something that is not a feed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect((await attempt('https://html.example/c/videos')).outcome).toBe('no-feed')
  })

  it('says when the instance could not be reached at all, which is not the same as serving no feed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const tried = await attempt('https://down.example/c/videos')

    expect(tried.outcome).toBe('unreachable')
    expect(tried.source).toMatchObject({ _id: 'lemmy:videos@down.example' })
  })

  it('says a source is followed already, without asking it', async () => {
    const fetch = stubInstances()

    const tried = await attempt('https://lemmy.world/c/MealtimeVideos@lemmy.cafe', { followed: [MEALTIME._id], fetch })

    expect(tried.outcome).toBe('followed-already')
    expect(tried.source._id).toBe(MEALTIME._id)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('follows HackerTube without asking it, as its videos come with the app', async () => {
    const fetch = stubInstances()

    const tried = await attempt('https://hackertube.org', { fetch })

    expect(tried).toEqual({ outcome: 'followable', source: hackerTubeSource(NOW), fetched: null })
    expect(fetch).not.toHaveBeenCalled()
  })
})
