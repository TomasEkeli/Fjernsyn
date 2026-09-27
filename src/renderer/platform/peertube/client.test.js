import { describe, expect, it } from 'vitest'

import { PlatformError } from '../errors'
import { createPeerTubeClient, versionAtLeast } from './client'
import { createFakeFetch } from './testing/fakeFetch'

import blenderConfig from './fixtures/video.blender.org--config.json'
import blenderNotFound from './fixtures/video.blender.org--not-found.json'
import fsiBadRequest from './fixtures/peertube.f-si.org--bad-request-sort.json'
import fsiConfig from './fixtures/peertube.f-si.org--config.json'
import makertubeConfig from './fixtures/makertube.net--config.json'
import marcoConfig from './fixtures/video.marcorennmaus.de--config.json'
import passwordIncorrect from './fixtures/synthesised--video-password-incorrect.json'
import passwordRequired from './fixtures/synthesised--video-password-required.json'
import privateVideo from './fixtures/synthesised--video-private.json'
import rateLimited from './fixtures/synthesised--rate-limited.json'
import tilvidsConfig from './fixtures/tilvids.com--config.json'

const OK = { status: 200, body: { total: 0, data: [] } }

/**
 * @param {Promise<unknown>} promise
 * @returns {Promise<PlatformError>}
 */
async function failure(promise) {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(PlatformError)
    return error
  }
  throw new Error('expected the request to fail')
}

function clock(start = Date.parse('2026-09-27T14:30:00Z')) {
  let time = start
  return {
    now: () => time,
    advance: (ms) => { time += ms },
  }
}

describe('PeerTube client', () => {
  describe('requests', () => {
    it('goes to the instance API over https, marked as a probe until the host is confirmed', async () => {
      const fake = createFakeFetch([blenderConfig]).respond(/\/videos\?/, OK)
      const client = createPeerTubeClient({ fetch: fake.fetch })

      await client.get('video.blender.org', '/videos', { start: 5 })
      await client.getConfig('video.blender.org')
      await client.get('video.blender.org', '/videos', { start: 0 })

      expect(fake.requests.map(({ url, headers }) => [url, headers['x-fjernsyn-peertube']])).toEqual([
        ['https://video.blender.org/api/v1/videos?start=5', 'probe'],
        ['https://video.blender.org/api/v1/config', 'probe'],
        ['https://video.blender.org/api/v1/videos?start=0', 'confirmed'],
      ])
    })

    it('keeps marking a host as a probe when its config did not answer as PeerTube', async () => {
      const fake = createFakeFetch().respond('https://yewtu.be/api/v1/config', { status: 200, body: { version: '2.0' } }).respond(/./, OK)
      const client = createPeerTubeClient({ fetch: fake.fetch })

      await failure(client.getConfig('yewtu.be'))
      await client.get('yewtu.be', '/videos')

      expect(fake.requests.map(({ headers }) => headers['x-fjernsyn-peertube'])).toEqual(['probe', 'probe'])
    })

    it('never asks for more than 100 items, nor fewer than one', async () => {
      const fake = createFakeFetch().respond(/./, OK)
      const client = createPeerTubeClient({ fetch: fake.fetch })

      for (const count of [500, 100, 25, 25.9, 0, -3, Number.NaN, 'many', Infinity]) {
        await client.get('video.blender.org', '/videos', { count })
      }

      expect(fake.requests.map(request => new URL(request.url).searchParams.get('count')))
        .toEqual(['100', '100', '25', '25', '20', '20', '20', '20', '20'])
    })

    it.each([
      ['www.youtube.com'],
      ['youtube.com'],
      ['rr1---sn-abc.googlevideo.com'],
      ['i.ytimg.com'],
      ['yt3.ggpht.com'],
      ['www.google.com'],
    ])('never sends a PeerTube request to %s', async (host) => {
      const fake = createFakeFetch().respond(/./, OK)
      const client = createPeerTubeClient({ fetch: fake.fetch })

      expect((await failure(client.get(host, '/videos'))).kind).toBe('invalid')
      expect((await failure(client.getConfig(host))).kind).toBe('invalid')
      expect(await client.isPeerTube(host)).toBe(false)
      expect(fake.requests).toHaveLength(0)
    })

    it('repeats array parameters and leaves out empty ones', async () => {
      const fake = createFakeFetch().respond(/./, OK)
      const client = createPeerTubeClient({ fetch: fake.fetch })

      await client.get('video.blender.org', '/videos', { videoFileIds: [1, 2], nsfw: false, sort: undefined, search: null })

      expect(fake.urls()).toEqual(['https://video.blender.org/api/v1/videos?videoFileIds=1&videoFileIds=2&nsfw=false'])
    })

    it('refuses a host that is not a bare host name, without a request', async () => {
      const fake = createFakeFetch().respond(/./, OK)
      const client = createPeerTubeClient({ fetch: fake.fetch })

      const error = await failure(client.get('evil.example/../x', '/videos'))

      expect(error.kind).toBe('invalid')
      expect(fake.requests).toHaveLength(0)
    })
  })

  describe('instance config', () => {
    it('exposes the server version and not the instance JavaScript or CSS', async () => {
      // makertube.net's config carries real instance CSS
      const fake = createFakeFetch([makertubeConfig])
      const client = createPeerTubeClient({ fetch: fake.fetch })

      const config = await client.getConfig('makertube.net')

      expect(config.serverVersion).toBe('8.3.0')
      expect(config.host).toBe('makertube.net')
      expect(config.instanceName).toBe(makertubeConfig.body.instance.name)
      expect(JSON.stringify(config)).not.toContain('customizations')
      expect(JSON.stringify(config)).not.toContain('.root-header')
    })

    it('asks each host once per session, even when asked twice at once', async () => {
      const fake = createFakeFetch([blenderConfig, tilvidsConfig])
      const client = createPeerTubeClient({ fetch: fake.fetch })

      await Promise.all([client.getConfig('video.blender.org'), client.getConfig('video.blender.org')])
      await client.getConfig('video.blender.org')
      await client.getConfig('tilvids.com')

      expect(fake.urls()).toEqual(['https://video.blender.org/api/v1/config', 'https://tilvids.com/api/v1/config'])
    })

    it('asks again after a failure', async () => {
      const fake = createFakeFetch().respond('https://tilvids.com/api/v1/config', new TypeError('Failed to fetch'))
      const client = createPeerTubeClient({ fetch: fake.fetch })

      expect((await failure(client.getConfig('tilvids.com'))).kind).toBe('unavailable')

      fake.respond('https://tilvids.com/api/v1/config', tilvidsConfig)

      expect((await client.getConfig('tilvids.com')).serverVersion).toBe('8.2.4')
    })

    it('does not take an answer without a server version for PeerTube', async () => {
      const fake = createFakeFetch().respond('https://yewtu.be/api/v1/config', { status: 200, body: { version: '2.0' } })
      const client = createPeerTubeClient({ fetch: fake.fetch })

      const error = await failure(client.getConfig('yewtu.be'))

      expect(error.kind).toBe('unavailable')
      expect(error.status).toBe(200)
    })
  })

  describe('feature detection by server version', () => {
    const client = createPeerTubeClient({
      fetch: createFakeFetch([fsiConfig, marcoConfig, blenderConfig, makertubeConfig]).fetch,
    })

    it.each([
      ['peertube.f-si.org', '6.2.0', { chapters: true, storyboards: true, captionFileUrl: false, commentReplies: false }],
      ['video.marcorennmaus.de', '7.2.0', { chapters: true, storyboards: true, captionFileUrl: true, commentReplies: false }],
      ['video.blender.org', '8.2.4', { chapters: true, storyboards: true, captionFileUrl: true, commentReplies: false }],
      ['makertube.net', '8.3.0', { chapters: true, storyboards: true, captionFileUrl: true, commentReplies: true }],
    ])('%s (%s)', async (host, version, expected) => {
      expect((await client.getConfig(host)).serverVersion).toBe(version)

      for (const [feature, supported] of Object.entries(expected)) {
        expect(await client.supports(host, feature), feature).toBe(supported)
      }
    })

    it('refuses to guess at a feature it does not know', async () => {
      await expect(client.supports('makertube.net', 'teleportation')).rejects.toThrow(/teleportation/)
    })

    it('compares versions by number, ignoring pre-release suffixes', () => {
      expect(versionAtLeast('8.3.0', '8.3.0')).toBe(true)
      expect(versionAtLeast('8.10.0', '8.3.0')).toBe(true)
      expect(versionAtLeast('10.0.0', '8.3.0')).toBe(true)
      expect(versionAtLeast('8.2.4', '8.3.0')).toBe(false)
      expect(versionAtLeast('7.1.0-rc.1', '7.1.0')).toBe(true)
      expect(versionAtLeast('7', '6.0.0')).toBe(true)
      expect(versionAtLeast(undefined, '6.0.0')).toBe(false)
      expect(versionAtLeast('nonsense', '6.0.0')).toBe(false)
    })
  })

  describe('rate limits', () => {
    const VIDEO_URL = 'https://tilvids.com/api/v1/videos/11111111-2222-4333-8444-555555555555'
    const VIDEO_PATH = '/videos/11111111-2222-4333-8444-555555555555'

    it('fails fast for that host until its Retry-After has passed', async () => {
      const time = clock()
      const fake = createFakeFetch().respond(VIDEO_URL, rateLimited).respond(/blender/, OK)
      const client = createPeerTubeClient({ fetch: fake.fetch, now: time.now })

      const first = await failure(client.get('tilvids.com', VIDEO_PATH))
      expect(first.kind).toBe('rateLimited')
      expect(first.status).toBe(429)
      expect(first.retryAfterMs).toBe(7000)
      expect(first.host).toBe('tilvids.com')

      time.advance(3000)
      const second = await failure(client.get('tilvids.com', VIDEO_PATH))
      expect(second.kind).toBe('rateLimited')
      expect(second.retryAfterMs).toBe(4000)
      expect(fake.requests).toHaveLength(1)

      // Another host is not held back
      await client.get('video.blender.org', '/videos')
      expect(fake.requests).toHaveLength(2)

      time.advance(4000)
      fake.respond(VIDEO_URL, OK)
      await expect(client.get('tilvids.com', VIDEO_PATH)).resolves.toEqual(OK.body)
      expect(fake.requests).toHaveLength(3)
    })

    it('reads a Retry-After given as an HTTP date', async () => {
      const time = clock()
      const retryAt = new Date(time.now() + 30_000).toUTCString()
      const fake = createFakeFetch().respond(VIDEO_URL, { ...rateLimited, headers: { ...rateLimited.headers, 'retry-after': retryAt } })
      const client = createPeerTubeClient({ fetch: fake.fetch, now: time.now })

      expect((await failure(client.get('tilvids.com', VIDEO_PATH))).retryAfterMs).toBe(30_000)

      time.advance(29_000)
      expect((await failure(client.get('tilvids.com', VIDEO_PATH))).retryAfterMs).toBe(1000)
      expect(fake.requests).toHaveLength(1)
    })

    it('still backs off when a 429 carries no Retry-After', async () => {
      const time = clock()
      const fake = createFakeFetch().respond(VIDEO_URL, { status: 429, headers: {}, body: 'Too many requests' })
      const client = createPeerTubeClient({ fetch: fake.fetch, now: time.now })

      const error = await failure(client.get('tilvids.com', VIDEO_PATH))
      expect(error.retryAfterMs).toBeGreaterThan(0)

      await failure(client.get('tilvids.com', VIDEO_PATH))
      expect(fake.requests).toHaveLength(1)
    })
  })

  describe('errors', () => {
    const PATH = '/videos/11111111-2222-4333-8444-555555555555'

    /**
     * @param {object} answer
     */
    async function errorFor(answer) {
      const fake = createFakeFetch().respond(/./, answer)
      return failure(createPeerTubeClient({ fetch: fake.fetch }).get('peertube.example', PATH))
    }

    it('reads a password-protected video as refused for a password', async () => {
      expect(await errorFor(passwordRequired)).toMatchObject({ kind: 'refused', status: 401, reason: 'password', host: 'peertube.example' })
      expect(await errorFor(passwordIncorrect)).toMatchObject({ kind: 'refused', status: 403, reason: 'password' })
    })

    it('reads a private, internal or blocked video as refused, without guessing which', async () => {
      expect(await errorFor(privateVideo)).toMatchObject({ kind: 'refused', status: 401, reason: null })
    })

    it('reads 404 as not found', async () => {
      expect(await errorFor(blenderNotFound)).toMatchObject({ kind: 'notFound', status: 404 })
    })

    it('reads 400 as an invalid request', async () => {
      expect(await errorFor(fsiBadRequest)).toMatchObject({ kind: 'invalid', status: 400 })
    })

    it('reads a server error, a network failure and an unparseable answer as unavailable', async () => {
      expect(await errorFor({ status: 502, body: '<html>Bad gateway</html>' })).toMatchObject({ kind: 'unavailable', status: 502 })
      expect(await errorFor(new TypeError('Failed to fetch'))).toMatchObject({ kind: 'unavailable', status: null })
      expect(await errorFor({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html>hello</html>' }))
        .toMatchObject({ kind: 'unavailable', status: 200 })
    })
  })
})
