import { describe, expect, it, vi } from 'vitest'

import { PlatformError } from './errors'
import { createPeerTubeClient, createPlatformLayer } from './index'
import { createFakeFetch } from './peertube/testing/fakeFetch'

import blenderConfig from './peertube/fixtures/video.blender.org--config.json'
import blenderNotFound from './peertube/fixtures/video.blender.org--not-found.json'
import makertubeConfig from './peertube/fixtures/makertube.net--config.json'
import makertubeVideo from './peertube/fixtures/makertube.net--video.json'
import rateLimited from './peertube/fixtures/synthesised--rate-limited.json'
import tilvidsConfig from './peertube/fixtures/tilvids.com--config.json'

const BLENDER_UUID = 'b29290cc-5c6d-4b9e-8d64-2f6f3b3a1e11'
const MAKERTUBE_UUID = makertubeVideo.body.uuid
const MAKERTUBE_SHORT = makertubeVideo.body.shortUUID

/**
 * @param {object} [options]
 * @param {Array<object>} [options.fixtures]
 * @param {object} [options.youtube]
 * @param {object} [options.config]
 */
function setUp({ fixtures = [blenderConfig, makertubeConfig, tilvidsConfig], youtube, config } = {}) {
  const fake = createFakeFetch(fixtures)
  const layer = createPlatformLayer({ fetch: fake.fetch, youtube, config: { peertubeEnabled: true, ...config } })
  return { fake, layer }
}

/**
 * @param {string} host
 * @param {string} uuid
 * @param {number | null} [timestamp]
 */
function videoAnswer(host, uuid, timestamp = null) {
  return {
    platform: 'peertube',
    kind: 'video',
    ref: { platform: 'peertube', host, videoId: uuid },
    host,
    timestamp,
  }
}

/**
 * @param {string} name
 * @param {string} host
 */
function channelAnswer(name, host) {
  return { platform: 'peertube', kind: 'channel', ref: `${name}@${host}`, host, name }
}

describe('platform layer', () => {
  describe('construction', () => {
    it('holds a frozen copy of its configuration, with defaults for what was not given', () => {
      const given = { backendPreference: 'invidious', currentInvidiousInstanceUrl: 'https://inv.example' }
      const layer = createPlatformLayer({ fetch: createFakeFetch().fetch, config: given })

      given.backendPreference = 'local'

      expect(layer.config).toMatchObject({
        peertubeEnabled: false,
        peertubeSearchSource: 'https://sepiasearch.org',
        peertubeShowNsfw: false,
        backendPreference: 'invidious',
        currentInvidiousInstanceUrl: 'https://inv.example',
        thumbnailPreference: '',
      })
      expect(Object.isFrozen(layer.config)).toBe(true)
    })

    it('keeps what it knows of each host across a rebuild with the same client', async () => {
      let time = Date.parse('2026-09-27T14:30:00Z')
      const now = () => time
      const fake = createFakeFetch([tilvidsConfig])
      const peertubeClient = createPeerTubeClient({ fetch: fake.fetch, now })
      const first = createPlatformLayer({ fetch: fake.fetch, peertubeClient, config: { peertubeEnabled: true } })

      // Confirmed by the first layer, then rate limited
      expect(await first.resolveUrl(`https://tilvids.com/w/${BLENDER_UUID}`)).toEqual(videoAnswer('tilvids.com', BLENDER_UUID))
      fake.respond(/tilvids\.com\/api\/v1\/videos\//, rateLimited)
      await expect(first.resolveUrl('https://tilvids.com/w/shortOne')).rejects.toMatchObject({ kind: 'rateLimited' })
      expect(fake.requests).toHaveLength(2)

      // The settings change and the wiring builds a new layer with the same client
      const rebuilt = createPlatformLayer({
        fetch: fake.fetch,
        peertubeClient,
        config: { peertubeEnabled: true, thumbnailPreference: 'end' },
      })
      time += 3000

      await expect(rebuilt.resolveUrl('https://tilvids.com/w/shortOne')).rejects.toMatchObject({ kind: 'rateLimited', retryAfterMs: 4000 })
      // The host is still known as PeerTube: no second config request either
      expect(await rebuilt.resolveUrl(`https://tilvids.com/w/${BLENDER_UUID}`)).toEqual(videoAnswer('tilvids.com', BLENDER_UUID))
      expect(fake.requests).toHaveLength(2)
    })

    it('starts afresh without a client handed in', async () => {
      const fake = createFakeFetch([tilvidsConfig])
      const config = { peertubeEnabled: true }

      await createPlatformLayer({ fetch: fake.fetch, config }).resolveUrl(`https://tilvids.com/w/${BLENDER_UUID}`)
      await createPlatformLayer({ fetch: fake.fetch, config }).resolveUrl(`https://tilvids.com/w/${BLENDER_UUID}`)

      expect(fake.requests).toHaveLength(2)
    })

    it('describes with its own configuration', () => {
      const layer = createPlatformLayer({
        fetch: createFakeFetch().fetch,
        config: { backendPreference: 'invidious', currentInvidiousInstanceUrl: 'https://inv.example', thumbnailPreference: 'start' },
      })

      expect(layer.describe({ videoId: 'dQw4w9WgXcQ' }).thumbnail).toBe('https://inv.example/vi/dQw4w9WgXcQ/mq1.jpg')
      expect(layer.describe({ videoId: 'dQw4w9WgXcQ' }, { large: true }).thumbnail).toBe('https://inv.example/vi/dQw4w9WgXcQ/hq720_1.jpg')
    })
  })

  describe('resolveUrl', () => {
    describe('PeerTube videos', () => {
      it.each([
        [`https://video.blender.org/w/${BLENDER_UUID}`],
        [`https://video.blender.org/videos/watch/${BLENDER_UUID}`],
        [`https://video.blender.org/videos/watch/${BLENDER_UUID}/`],
        [`https://video.blender.org/videos/embed/${BLENDER_UUID}`],
        [`http://Video.Blender.org/w/${BLENDER_UUID.toUpperCase()}`],
        [`  https://video.blender.org/w/${BLENDER_UUID}  `],
      ])('recognises %s', async (url) => {
        const { layer } = setUp()

        expect(await layer.resolveUrl(url)).toEqual(videoAnswer('video.blender.org', BLENDER_UUID))
      })

      it('carries the start time', async () => {
        const { layer } = setUp()

        expect(await layer.resolveUrl(`https://video.blender.org/w/${BLENDER_UUID}?start=1m30s`))
          .toEqual(videoAnswer('video.blender.org', BLENDER_UUID, 90))
        expect(await layer.resolveUrl(`https://video.blender.org/videos/watch/${BLENDER_UUID}?start=75`))
          .toEqual(videoAnswer('video.blender.org', BLENDER_UUID, 75))
      })

      it('resolves a short uuid to the full uuid through the instance', async () => {
        const { layer, fake } = setUp()
        fake.respond(`https://makertube.net/api/v1/videos/${MAKERTUBE_SHORT}`, makertubeVideo)

        expect(await layer.resolveUrl(`https://makertube.net/w/${MAKERTUBE_SHORT}`)).toEqual(videoAnswer('makertube.net', MAKERTUBE_UUID))
        expect(fake.urls()).toContain(`https://makertube.net/api/v1/videos/${MAKERTUBE_SHORT}`)
      })

      it('makes no video request for a full uuid', async () => {
        const { layer, fake } = setUp()

        await layer.resolveUrl(`https://video.blender.org/w/${BLENDER_UUID}`)

        expect(fake.urls()).toEqual(['https://video.blender.org/api/v1/config'])
      })

      it('fails as not found when a short uuid does not exist on the instance', async () => {
        const { layer, fake } = setUp()
        fake.respond('https://video.blender.org/api/v1/videos/abcdefghijk', blenderNotFound)

        await expect(layer.resolveUrl('https://video.blender.org/w/abcdefghijk')).rejects.toMatchObject({ kind: 'notFound' })
      })
    })

    describe('PeerTube channels', () => {
      it.each([
        ['https://video.blender.org/c/blender_studio'],
        ['https://video.blender.org/c/blender_studio/videos'],
        ['https://video.blender.org/c/blender_studio/video-playlists'],
        ['https://video.blender.org/video-channels/blender_studio'],
        ['https://video.blender.org/video-channels/blender_studio/videos'],
        ['blender_studio@video.blender.org'],
        ['@blender_studio@video.blender.org'],
        ['@blender_studio@Video.Blender.org'],
      ])('recognises %s', async (input) => {
        const { layer } = setUp()

        expect(await layer.resolveUrl(input)).toEqual(channelAnswer('blender_studio', 'video.blender.org'))
      })

      it('takes a remote channel seen on another instance to its origin', async () => {
        const { layer, fake } = setUp()

        expect(await layer.resolveUrl('https://tilvids.com/c/blender_studio@video.blender.org/videos'))
          .toEqual(channelAnswer('blender_studio', 'video.blender.org'))
        expect(await layer.resolveUrl('https://tilvids.com/video-channels/blender_studio%40video.blender.org'))
          .toEqual(channelAnswer('blender_studio', 'video.blender.org'))
        expect(fake.urls()).toEqual(['https://video.blender.org/api/v1/config'])
      })
    })

    describe('PeerTube playlists', () => {
      it.each([
        ['https://video.blender.org/w/p/abcDEF123'],
        ['https://video.blender.org/videos/watch/playlist/abcDEF123'],
      ])('recognises %s, without resolving it', async (url) => {
        const { layer } = setUp()

        expect(await layer.resolveUrl(url)).toEqual({
          platform: 'peertube',
          kind: 'playlist',
          ref: { platform: 'peertube', host: 'video.blender.org', playlistId: 'abcDEF123' },
          host: 'video.blender.org',
          id: 'abcDEF123',
        })
      })
    })

    describe('unknown hosts', () => {
      it('confirms a host as PeerTube through its config before answering', async () => {
        const { layer, fake } = setUp()

        expect(await layer.resolveUrl(`https://tilvids.com/w/${BLENDER_UUID}`)).toEqual(videoAnswer('tilvids.com', BLENDER_UUID))
        expect(fake.urls()).toEqual(['https://tilvids.com/api/v1/config'])
      })

      it('remembers the answer for the session: a second URL on the host asks nothing', async () => {
        const { layer, fake } = setUp()

        await layer.resolveUrl(`https://tilvids.com/w/${BLENDER_UUID}`)
        await layer.resolveUrl('https://tilvids.com/c/somebody')

        expect(fake.urls()).toEqual(['https://tilvids.com/api/v1/config'])
      })

      it('refuses a host whose config is not found, and remembers that too', async () => {
        const { layer, fake } = setUp()
        fake.respond('https://not-peertube.example/api/v1/config', { status: 404, body: '<html>Not found</html>' })

        expect(await layer.resolveUrl(`https://not-peertube.example/w/${BLENDER_UUID}`)).toBeNull()
        expect(await layer.resolveUrl('https://not-peertube.example/c/somebody')).toBeNull()
        expect(fake.urls()).toEqual(['https://not-peertube.example/api/v1/config'])
      })

      it('refuses a host whose config is not JSON, or is JSON without a server version', async () => {
        const { layer, fake } = setUp()
        fake.respond('https://html.example/api/v1/config', { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>hi</html>' })
        fake.respond('https://other.example/api/v1/config', { status: 200, body: { version: '1.0' } })

        expect(await layer.resolveUrl(`https://html.example/w/${BLENDER_UUID}`)).toBeNull()
        expect(await layer.resolveUrl('other@other.example')).toBeNull()
      })

      it('does not remember a host that could not be asked, and says why', async () => {
        const { layer, fake } = setUp()
        fake.respond('https://down.example/api/v1/config', new TypeError('Failed to fetch'))

        const error = await layer.resolveUrl(`https://down.example/w/${BLENDER_UUID}`).catch(e => e)
        expect(error).toBeInstanceOf(PlatformError)
        expect(error.kind).toBe('unavailable')

        fake.respond('https://down.example/api/v1/config', tilvidsConfig)
        expect(await layer.resolveUrl(`https://down.example/w/${BLENDER_UUID}`)).toEqual(videoAnswer('down.example', BLENDER_UUID))
      })

      it.each([[401], [403], [500], [503]])('does not remember a host whose config answered %i', async (status) => {
        const { layer, fake } = setUp()
        fake.respond('https://shy.example/api/v1/config', { status, body: { detail: 'no', status } })

        await expect(layer.resolveUrl(`https://shy.example/w/${BLENDER_UUID}`)).rejects.toBeInstanceOf(PlatformError)

        fake.respond('https://shy.example/api/v1/config', tilvidsConfig)
        expect(await layer.resolveUrl(`https://shy.example/w/${BLENDER_UUID}`)).toEqual(videoAnswer('shy.example', BLENDER_UUID))
      })

      it('remembers a host whose config answered 400 as not PeerTube', async () => {
        const { layer, fake } = setUp()
        fake.respond('https://odd.example/api/v1/config', { status: 400, body: 'bad' })

        expect(await layer.resolveUrl(`https://odd.example/w/${BLENDER_UUID}`)).toBeNull()
        expect(await layer.resolveUrl(`https://odd.example/w/${BLENDER_UUID}`)).toBeNull()
        expect(fake.requests).toHaveLength(1)
      })

      it('says so when the host is rate limiting', async () => {
        const { layer, fake } = setUp()
        fake.respond('https://busy.example/api/v1/config', rateLimited)

        await expect(layer.resolveUrl(`https://busy.example/w/${BLENDER_UUID}`)).rejects.toMatchObject({ kind: 'rateLimited', retryAfterMs: 7000 })
      })
    })

    describe('what is not PeerTube', () => {
      it.each([
        ['https://yewtu.be/watch?v=dQw4w9WgXcQ'],
        ['https://yewtu.be/channel/UCuAXFkgsw1L7xaCfnd5JJOw'],
        ['https://example.com/'],
        ['https://example.com/w/'],
        ['https://example.com/videos/watch/'],
        ['https://example.com/w/has space'],
        ['https://example.com:8443/w/' + BLENDER_UUID],
        ['ftp://video.blender.org/w/' + BLENDER_UUID],
        ['javascript:alert(1)'],
        ['@youtubecreators'],
        ['just some words'],
        [''],
      ])('answers nothing for %j, without a request', async (input) => {
        const { layer, fake } = setUp()

        expect(await layer.resolveUrl(input)).toBeNull()
        expect(fake.requests).toHaveLength(0)
      })

      it.each([
        ['foo@www.youtube.com'],
        ['@foo@youtube.com'],
        ['foo@rr1.googlevideo.com'],
        ['https://rr1.googlevideo.com/c/x'],
        ['https://i.ytimg.com/w/' + BLENDER_UUID],
        ['https://www.google.com/video-channels/x'],
        ['https://tilvids.com/c/x@www.youtube.com'],
        ['https://yt3.ggpht.com/videos/watch/' + BLENDER_UUID],
      ])('never takes a YouTube or Google host for PeerTube: %s', async (input) => {
        const { layer, fake } = setUp()

        expect(await layer.resolveUrl(input)).toBeNull()
        expect(fake.requests).toHaveLength(0)
      })

      it.each([
        ['https://yewtu.be/c/SomeChannel'],
        ['https://yewtu.be/c/SomeChannel/videos'],
        ['https://Yewtu.be/w/' + BLENDER_UUID],
        ['SomeChannel@yewtu.be'],
      ])('never takes the current Invidious instance for PeerTube: %s', async (input) => {
        const { layer, fake } = setUp({ config: { currentInvidiousInstanceUrl: 'https://yewtu.be' } })

        expect(await layer.resolveUrl(input)).toBeNull()
        expect(fake.requests).toHaveLength(0)
      })

      it('answers nothing for what is not a string', async () => {
        const { layer } = setUp()

        expect(await layer.resolveUrl(undefined)).toBeNull()
        expect(await layer.resolveUrl(42)).toBeNull()
      })
    })

    describe('YouTube', () => {
      it.each([
        ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
        ['https://youtube.com/c/YouTubeCreators'],
        ['https://m.youtube.com/watch?v=dQw4w9WgXcQ'],
        ['https://music.youtube.com/watch?v=dQw4w9WgXcQ'],
        ['https://youtu.be/dQw4w9WgXcQ'],
        ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
        ['https://youtube-nocookie.com/embed/dQw4w9WgXcQ'],
      ])('hands %s to the YouTube parser, and never asks PeerTube', async (url) => {
        const answer = { urlType: 'video', videoId: 'dQw4w9WgXcQ' }
        const youtube = { resolveUrl: vi.fn(async () => answer) }
        const { layer, fake } = setUp({ youtube })

        expect(await layer.resolveUrl(url)).toBe(answer)
        expect(youtube.resolveUrl).toHaveBeenCalledWith(url)
        expect(fake.requests).toHaveLength(0)
      })

      it('answers nothing for a YouTube URL when given no YouTube parser', async () => {
        const { layer, fake } = setUp()

        expect(await layer.resolveUrl('https://youtube.com/c/YouTubeCreators')).toBeNull()
        expect(fake.requests).toHaveLength(0)
      })

      it('still hands YouTube URLs over with PeerTube switched off', async () => {
        const youtube = { resolveUrl: vi.fn(async () => 'answer') }
        const { layer } = setUp({ youtube, config: { peertubeEnabled: false } })

        expect(await layer.resolveUrl('https://youtu.be/dQw4w9WgXcQ')).toBe('answer')
      })
    })

    it('recognises no PeerTube URL while PeerTube is switched off', async () => {
      const { layer, fake } = setUp({ config: { peertubeEnabled: false } })

      expect(await layer.resolveUrl(`https://video.blender.org/w/${BLENDER_UUID}`)).toBeNull()
      expect(await layer.resolveUrl('blender_studio@video.blender.org')).toBeNull()
      expect(fake.requests).toHaveLength(0)
    })
  })
})
