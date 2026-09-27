import { describe, expect, it } from 'vitest'

import {
  FETCH_FAILED,
  FETCH_OK,
  FETCH_RATE_LIMITED,
  FETCH_UNAVAILABLE,
} from '../../../subscriptionFetchStatusValues'
import { FEED_STATUS } from './feed'
import { createPlatformLayer } from '../index'
import { createFakeFetch } from './testing/fakeFetch'

import blenderConfig from './fixtures/video.blender.org--config.json'
import blenderNewest from './fixtures/video.blender.org--channel-videos-newest.json'
import blenderNotFound from './fixtures/video.blender.org--not-found.json'
import endedLive from './fixtures/synthesised--video-live-ended.json'
import liveNow from './fixtures/peertube.livespotting.com--video-live.json'
import rateLimited from './fixtures/synthesised--rate-limited.json'
import scheduledLive from './fixtures/tube.xy-space.de--video-live-scheduled.json'
import waitingLive from './fixtures/video.marcorennmaus.de--video-live-waiting-no-download.json'

const BLENDER = 'blender_studio@video.blender.org'
const BLENDER_API = `https://video.blender.org/api/v1/video-channels/${BLENDER}`

/** A stored subscription stub, as a profile holds it */
const BLENDER_STUB = Object.freeze({
  id: BLENDER,
  name: 'Blender Studio',
  thumbnail: 'https://video.blender.org/lazy-static/avatars/x.png',
  platform: 'peertube',
  host: 'video.blender.org',
})

/**
 * The URL a feed's videos are asked at, with every parameter the layer sends
 *
 * @param {string} api
 * @param {{ isLive: boolean, nsfw?: string }} params
 */
function feedUrl(api, { isLive, nsfw = 'false' }) {
  return `${api}/videos?start=0&count=30&sort=-publishedAt&isLive=${isLive}&nsfw=${nsfw}`
}

/**
 * @param {object} [options]
 * @param {object} [options.config]
 */
function setUp({ config } = {}) {
  const fake = createFakeFetch([blenderConfig])
  const layer = createPlatformLayer({ fetch: fake.fetch, config: { peertubeEnabled: true, ...config } })
  return { fake, layer }
}

/**
 * A channel's list of lives, made of recorded video bodies: no instance was
 * recorded with a live, a scheduled live and an ended one on one channel, and a
 * list item carries the same fields as the details the layer reads.
 *
 * @param {object[]} videos
 */
function listOf(videos) {
  return { status: 200, body: { total: videos.length, data: videos.map(video => structuredClone(video)) } }
}

describe('fetchChannelFeed (PeerTube): the fetch status contract', () => {
  it('speaks the same status values as the subscription refresh', () => {
    expect(FEED_STATUS).toEqual({
      ok: FETCH_OK,
      rateLimited: FETCH_RATE_LIMITED,
      unavailable: FETCH_UNAVAILABLE,
      failed: FETCH_FAILED,
    })
    expect([FETCH_OK, FETCH_RATE_LIMITED, FETCH_UNAVAILABLE, FETCH_FAILED])
      .toEqual(['ok', 'rateLimited', 'unavailable', 'failed'])
  })
})

describe('fetchChannelFeed (PeerTube): videos', () => {
  it('answers with the channel\'s latest uploads, from its origin, as cache entries', async () => {
    const { fake, layer } = setUp()
    fake.respond(feedUrl(BLENDER_API, { isLive: false }), blenderNewest)

    const result = await layer.fetchChannelFeed(BLENDER_STUB, 'videos')

    expect(result.status).toBe(FETCH_OK)
    expect(result.entries).toHaveLength(blenderNewest.body.data.length)
    expect(result.entries[0]).toEqual({
      type: 'video',
      platform: 'peertube',
      host: 'video.blender.org',
      videoId: '2c9347ab-7090-4f5a-a541-ca27340e9c9b',
      title: blenderNewest.body.data[0].name,
      author: 'Blender Studio',
      authorId: BLENDER,
      thumbnail: expect.stringMatching(/^https:\/\/video\.blender\.org\//),
      lengthSeconds: 281,
      published: Date.parse('2026-09-15T10:43:46.032Z'),
      viewCount: 94,
      liveNow: false,
      isUpcoming: false,
      nsfw: false,
    })
    // No name or avatar comes back: the refresh would write them into the
    // stub through YouTube's thumbnail rewrite
    expect(result).not.toHaveProperty('name')
    expect(result).not.toHaveProperty('thumbnailUrl')
    expect(fake.urls()).toEqual([feedUrl(BLENDER_API, { isLive: false })])
  })

  it('takes the stored stub or its bare handle alike', async () => {
    const { fake, layer } = setUp()
    fake.respond(feedUrl(BLENDER_API, { isLive: false }), blenderNewest)

    const result = await layer.fetchChannelFeed(BLENDER, 'videos')

    expect(result.status).toBe(FETCH_OK)
    expect(result.entries).toHaveLength(5)
  })

  it('publish times are ms numbers, so the stream interleaves them with YouTube\'s', async () => {
    const { fake, layer } = setUp()
    fake.respond(feedUrl(BLENDER_API, { isLive: false }), blenderNewest)

    const { entries } = await layer.fetchChannelFeed(BLENDER_STUB, 'videos')

    for (const entry of entries) {
      expect(typeof entry.published).toBe('number')
    }
  })

  it('leaves a live out of the uploads even from an instance that ignores `isLive=false`', async () => {
    const { fake, layer } = setUp()
    const withLive = structuredClone(blenderNewest)
    withLive.body.data.splice(1, 0, structuredClone(liveNow.body))
    fake.respond(feedUrl(BLENDER_API, { isLive: false }), withLive)

    const { status, entries } = await layer.fetchChannelFeed(BLENDER_STUB, 'videos')

    expect(status).toBe(FETCH_OK)
    expect(entries.map(entry => entry.videoId)).not.toContain(liveNow.body.uuid)
    expect(entries).toHaveLength(5)
  })

  it('drops NSFW videos while the setting hides them, and asks with nsfw=false', async () => {
    const { fake, layer } = setUp()
    const withNsfw = structuredClone(blenderNewest)
    withNsfw.body.data[0].nsfw = true
    fake.respond(feedUrl(BLENDER_API, { isLive: false }), withNsfw)

    const { entries } = await layer.fetchChannelFeed(BLENDER_STUB, 'videos')

    expect(entries.map(entry => entry.videoId)).not.toContain(withNsfw.body.data[0].uuid)
    expect(entries).toHaveLength(4)
  })

  it('keeps NSFW videos and asks with nsfw=both while the setting shows them', async () => {
    const { fake, layer } = setUp({ config: { peertubeShowNsfw: true } })
    const withNsfw = structuredClone(blenderNewest)
    withNsfw.body.data[0].nsfw = true
    fake.respond(feedUrl(BLENDER_API, { isLive: false, nsfw: 'both' }), withNsfw)

    const { entries } = await layer.fetchChannelFeed(BLENDER_STUB, 'videos')

    expect(entries).toHaveLength(5)
    expect(entries[0].nsfw).toBe(true)
  })

  it('is an empty answer for a channel with no uploads, which is worth caching', async () => {
    const { fake, layer } = setUp()
    fake.respond(feedUrl(BLENDER_API, { isLive: false }), { status: 200, body: { total: 0, data: [] } })

    expect(await layer.fetchChannelFeed(BLENDER_STUB, 'videos')).toEqual({ status: FETCH_OK, entries: [] })
  })
})

describe('fetchChannelFeed (PeerTube): live', () => {
  const LIVE_CHANNEL = 'stuttgartmarketing@peertube.livespotting.com'
  const LIVE_API = `https://peertube.livespotting.com/api/v1/video-channels/${LIVE_CHANNEL}`

  it('flags a live that is on now, and a scheduled one as upcoming with its time', async () => {
    const { fake, layer } = setUp()
    fake.respond(feedUrl(LIVE_API, { isLive: true }), listOf([liveNow.body, scheduledLive.body]))

    const { status, entries } = await layer.fetchChannelFeed(LIVE_CHANNEL, 'live')

    expect(status).toBe(FETCH_OK)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ videoId: liveNow.body.uuid, liveNow: true, isUpcoming: false })
    // The card reads a missing duration as live
    expect(entries[0]).not.toHaveProperty('lengthSeconds')
    expect(entries[1]).toMatchObject({
      videoId: scheduledLive.body.uuid,
      liveNow: false,
      isUpcoming: true,
      premiereDate: new Date('2026-10-04T07:30:00.000Z'),
    })
    expect(fake.urls()).toEqual([feedUrl(LIVE_API, { isLive: true })])
  })

  it('keeps a waiting live with no schedule as upcoming, without a time', async () => {
    const { fake, layer } = setUp()
    fake.respond(feedUrl(LIVE_API, { isLive: true }), listOf([waitingLive.body]))

    const { entries } = await layer.fetchChannelFeed(LIVE_CHANNEL, 'live')

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ videoId: waitingLive.body.uuid, liveNow: false, isUpcoming: true })
    expect(entries[0]).not.toHaveProperty('premiereDate')
  })

  it('drops an ended live, which has nothing left to watch (a saved replay is an upload)', async () => {
    const { fake, layer } = setUp()
    fake.respond(feedUrl(LIVE_API, { isLive: true }), listOf([endedLive.body, scheduledLive.body]))

    const { entries } = await layer.fetchChannelFeed(LIVE_CHANNEL, 'live')

    expect(entries.map(entry => entry.videoId)).toEqual([scheduledLive.body.uuid])
  })

  it('leaves an upload out of the lives even from an instance that ignores `isLive=true`', async () => {
    const { fake, layer } = setUp()
    fake.respond(feedUrl(LIVE_API, { isLive: true }), listOf([blenderNewest.body.data[0], liveNow.body]))

    const { entries } = await layer.fetchChannelFeed(LIVE_CHANNEL, 'live')

    expect(entries.map(entry => entry.videoId)).toEqual([liveNow.body.uuid])
  })
})

describe('fetchChannelFeed (PeerTube): shorts and posts', () => {
  it.each(['shorts', 'posts'])('%s is an empty answer, without a request', async (feed) => {
    const { fake, layer } = setUp()

    expect(await layer.fetchChannelFeed(BLENDER_STUB, feed)).toEqual({ status: FETCH_OK, entries: [] })
    expect(fake.requests).toHaveLength(0)
  })
})

describe('fetchChannelFeed (PeerTube): what is not an answer', () => {
  it('a 404 on the channel from its origin, which is PeerTube, is a disappearance with no entries', async () => {
    const { fake, layer } = setUp()
    fake.respond(feedUrl(BLENDER_API, { isLive: false }), blenderNotFound)

    const result = await layer.fetchChannelFeed(BLENDER_STUB, 'videos')

    expect(result).toMatchObject({ status: FETCH_UNAVAILABLE, entries: [] })
    expect(result.error).toMatchObject({ kind: 'notFound', status: 404, host: 'video.blender.org' })
    // The origin was asked whether it is still a PeerTube instance at all
    expect(fake.urls()).toContain('https://video.blender.org/api/v1/config')
  })

  it('a 404 from a host that no longer answers as PeerTube is a failure, not a disappearance', async () => {
    const { fake, layer } = setUp()
    fake.respond(feedUrl(BLENDER_API, { isLive: false }), blenderNotFound)
    fake.respond('https://video.blender.org/api/v1/config', { status: 404, body: '<html>parked</html>' })

    expect(await layer.fetchChannelFeed(BLENDER_STUB, 'videos')).toMatchObject({ status: FETCH_FAILED, entries: null })
  })

  it('a 404 from a host whose config cannot be read right now is a failure', async () => {
    const { fake, layer } = setUp()
    fake.respond(feedUrl(BLENDER_API, { isLive: false }), blenderNotFound)
    fake.respond('https://video.blender.org/api/v1/config', { status: 503, body: 'down' })

    expect(await layer.fetchChannelFeed(BLENDER_STUB, 'videos')).toMatchObject({ status: FETCH_FAILED, entries: null })
  })

  it('asks the origin afresh whether it is PeerTube, not trusting the yes it gave earlier in the session', async () => {
    const { fake, layer } = setUp()
    fake.respond(feedUrl(BLENDER_API, { isLive: false }), blenderNotFound)
    const configAsked = () => fake.urls().filter(url => url === 'https://video.blender.org/api/v1/config').length

    // The session learns that the host is PeerTube
    expect(await layer.fetchChannelFeed(BLENDER_STUB, 'videos')).toMatchObject({ status: FETCH_UNAVAILABLE })
    expect(configAsked()).toBe(1)

    // ... and it has since stopped being one
    fake.respond('https://video.blender.org/api/v1/config', { status: 404, body: '<html>parked</html>' })

    expect(await layer.fetchChannelFeed(BLENDER_STUB, 'videos')).toMatchObject({ status: FETCH_FAILED, entries: null })
    expect(configAsked()).toBe(2)
  })

  it('a fresh yes each time makes each 404 a disappearance', async () => {
    const { fake, layer } = setUp()
    fake.respond(feedUrl(BLENDER_API, { isLive: false }), blenderNotFound)

    expect(await layer.fetchChannelFeed(BLENDER_STUB, 'videos')).toMatchObject({ status: FETCH_UNAVAILABLE, entries: [] })
    expect(await layer.fetchChannelFeed(BLENDER_STUB, 'videos')).toMatchObject({ status: FETCH_UNAVAILABLE, entries: [] })
    expect(fake.urls().filter(url => url.endsWith('/api/v1/config'))).toHaveLength(2)
  })

  it.each([
    ['an HTML page', { status: 404, headers: { 'content-type': 'text/html' }, body: '<html><h1>404 Not Found</h1></html>' }],
    ['an empty body', { status: 404, body: '' }],
    ['JSON that is not PeerTube\'s not-found', { status: 404, body: { message: 'no route' } }],
    ['a problem that is not a 404', { status: 404, body: { ...blenderNotFound.body, status: 500 } }],
  ])('a 404 with %s is a failure, and the origin is not asked about it', async (_what, answer) => {
    const { fake, layer } = setUp()
    fake.respond(feedUrl(BLENDER_API, { isLive: false }), answer)

    const result = await layer.fetchChannelFeed(BLENDER_STUB, 'videos')

    expect(result).toMatchObject({ status: FETCH_FAILED, entries: null })
    expect(result.error).toMatchObject({ kind: 'notFound', status: 404 })
    expect(fake.urls()).not.toContain('https://video.blender.org/api/v1/config')
  })

  it('a 429 is a rate limit, with no entries, and the host is not asked again until Retry-After', async () => {
    const { fake, layer } = setUp()
    fake.respond(feedUrl(BLENDER_API, { isLive: false }), rateLimited)

    const first = await layer.fetchChannelFeed(BLENDER_STUB, 'videos')

    expect(first).toMatchObject({ status: FETCH_RATE_LIMITED, entries: null })
    expect(first.error).toMatchObject({ kind: 'rateLimited', retryAfterMs: 7000 })

    fake.clearRequests()
    const second = await layer.fetchChannelFeed(BLENDER_STUB, 'live')

    expect(second).toMatchObject({ status: FETCH_RATE_LIMITED, entries: null })
    expect(fake.requests).toHaveLength(0)
  })

  it('an unreachable instance is a failure, with no entries', async () => {
    const { fake, layer } = setUp()
    fake.respond(feedUrl(BLENDER_API, { isLive: false }), new TypeError('Failed to fetch'))

    const result = await layer.fetchChannelFeed(BLENDER_STUB, 'videos')

    expect(result).toMatchObject({ status: FETCH_FAILED, entries: null })
    expect(result.error).toMatchObject({ kind: 'unavailable' })
  })

  it.each([
    ['a server error', { status: 502, body: 'Bad gateway' }],
    ['a refusal', { status: 403, body: { detail: 'Forbidden' } }],
    ['a 200 that is not JSON', { status: 200, body: '<html>maintenance</html>' }],
    ['a 200 without a list', { status: 200, body: { detail: 'odd' } }],
  ])('%s is a failure, with no entries', async (_what, answer) => {
    const { fake, layer } = setUp()
    fake.respond(feedUrl(BLENDER_API, { isLive: false }), answer)

    expect(await layer.fetchChannelFeed(BLENDER_STUB, 'videos')).toMatchObject({ status: FETCH_FAILED, entries: null })
  })

  it.each([
    ['a YouTube stub', { id: 'UCxxxxxxxxxxxxxxxxxxxxxx', name: 'YouTube' }],
    ['a YouTube channel id', 'UCxxxxxxxxxxxxxxxxxxxxxx'],
    ['a handle on YouTube\'s host', 'someone@www.youtube.com'],
  ])('%s is a failure, without a request', async (_what, ref) => {
    const { fake, layer } = setUp()

    expect(await layer.fetchChannelFeed(ref, 'videos')).toMatchObject({ status: FETCH_FAILED, entries: null })
    expect(fake.requests).toHaveLength(0)
  })

  it('an unknown feed is a failure, without a request', async () => {
    const { fake, layer } = setUp()

    expect(await layer.fetchChannelFeed(BLENDER_STUB, 'podcasts')).toMatchObject({ status: FETCH_FAILED, entries: null })
    expect(fake.requests).toHaveLength(0)
  })
})
