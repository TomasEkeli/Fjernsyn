import { describe, expect, it } from 'vitest'

import { PlatformError } from '../errors'
import { createPlatformLayer } from '../index'
import { createFakeFetch } from './testing/fakeFetch'

import accountChannels from './fixtures/synthesised--account-video-channels.json'

import blenderChannel from './fixtures/video.blender.org--channel.json'
import blenderNewest from './fixtures/video.blender.org--channel-videos-newest.json'
import blenderNewestPage2 from './fixtures/video.blender.org--channel-videos-newest-page2.json'
import blenderNotFound from './fixtures/video.blender.org--not-found.json'
import blenderOldest from './fixtures/video.blender.org--channel-videos-oldest.json'
import blenderPlaylists from './fixtures/video.blender.org--channel-playlists.json'
import blenderViews from './fixtures/video.blender.org--channel-videos-views.json'
import blurtChannel from './fixtures/blurt.media--channel.json'
import blurtNewest from './fixtures/blurt.media--channel-videos-newest.json'
import fsiChannel from './fixtures/peertube.f-si.org--channel.json'
import fsiNewest from './fixtures/peertube.f-si.org--channel-videos-newest.json'
import liveNow from './fixtures/peertube.livespotting.com--video-live.json'
import scheduledLive from './fixtures/tube.xy-space.de--video-live-scheduled.json'

const BLENDER = 'blender_studio@video.blender.org'
const BLENDER_API = `https://video.blender.org/api/v1/video-channels/${BLENDER}`
const BLURT = 'surfgrrl@blurt.media'
const FSI = 'fsic2025@peertube.f-si.org'

/**
 * The URL a channel's videos are asked at, with the parameters the layer sends
 *
 * @param {string} api
 * @param {{ start?: number, sort?: string, nsfw?: string }} [params]
 */
function videosUrl(api, { start = 0, sort = '-publishedAt', nsfw = 'false' } = {}) {
  return `${api}/videos?start=${start}&count=30&sort=${sort}&nsfw=${nsfw}`
}

/**
 * @param {object} [options]
 * @param {object} [options.config]
 */
function setUp({ config } = {}) {
  const fake = createFakeFetch([blenderChannel, blurtChannel, fsiChannel])
    .respond(videosUrl(BLENDER_API), blenderNewest)
    .respond(videosUrl(BLENDER_API, { start: 5 }), blenderNewestPage2)
    .respond(videosUrl(BLENDER_API, { sort: '-views' }), blenderViews)
    .respond(videosUrl(BLENDER_API, { sort: 'publishedAt' }), blenderOldest)
    .respond(`${BLENDER_API}/video-playlists?start=0&count=30`, blenderPlaylists)
    .respond(videosUrl(`https://blurt.media/api/v1/video-channels/${BLURT}`), blurtNewest)
    .respond(videosUrl(`https://peertube.f-si.org/api/v1/video-channels/${FSI}`), fsiNewest)
  const layer = createPlatformLayer({ fetch: fake.fetch, config: { peertubeEnabled: true, ...config } })
  return { fake, layer }
}

/**
 * @template T
 * @param {T} fixture
 * @returns {T}
 */
function copy(fixture) {
  return structuredClone(fixture)
}

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
  throw new Error('expected the call to fail')
}

describe('getChannel (PeerTube)', () => {
  it('reads a channel from its own instance, by its handle (video.blender.org, 8.2)', async () => {
    const { fake, layer } = setUp()

    const channel = await layer.getChannel(BLENDER)

    expect(fake.urls()).toEqual([BLENDER_API])
    expect(channel).toEqual({
      platform: 'peertube',
      host: 'video.blender.org',
      id: BLENDER,
      handle: BLENDER,
      name: 'Blender Studio',
      // The 120 px avatar, as a stored subscription stub holds it
      thumbnail: 'https://video.blender.org/lazy-static/avatars/e2519482-f087-4965-899b-cc8b7a2921f0.webp',
      // The largest avatar and banner, for the channel header
      avatarLarge: 'https://video.blender.org/lazy-static/avatars/cf1a28ef-a26f-4c8b-b46c-e00ea90dce5f.webp',
      banner: 'https://video.blender.org/lazy-static/banners/85199ab2-1a34-4206-a5cd-788f692f6d5b.jpg',
      description: blenderChannel.body.description,
      descriptionKind: 'markdown',
      support: blenderChannel.body.support,
      subscriberCount: 33,
      url: 'https://video.blender.org/video-channels/blender_studio',
    })
  })

  it('accepts the handle with a leading @ and any case of host', async () => {
    const { fake, layer } = setUp()

    const channel = await layer.getChannel('@blender_studio@Video.Blender.org')

    expect(fake.urls()).toEqual([BLENDER_API])
    expect(channel.id).toBe(BLENDER)
  })

  it('makes the paths of an older instance absolute (blurt.media, 6.3: no fileUrl)', async () => {
    const { layer } = setUp()

    const channel = await layer.getChannel(BLURT)

    expect(channel).toMatchObject({
      host: 'blurt.media',
      name: 'SurfGrrl',
      thumbnail: 'https://blurt.media/lazy-static/avatars/732606b4-5910-4fe3-922d-80ac921c13e3.jpg',
      avatarLarge: 'https://blurt.media/lazy-static/avatars/5d96d7cb-adff-4ada-9477-cd2d9c63082f.jpg',
      banner: 'https://blurt.media/lazy-static/banners/795db3ec-4d3c-4acb-9ecd-7a85950cc90e.jpg',
      subscriberCount: 13,
      support: null,
    })
  })

  it('has no avatar, banner or description where the channel has none (peertube.f-si.org, 6.2)', async () => {
    const { layer } = setUp()

    const channel = await layer.getChannel(FSI)

    expect(channel).toMatchObject({ thumbnail: '', avatarLarge: '', banner: null, description: '', support: null, subscriberCount: 1 })
  })

  it.each([
    ['absent', undefined],
    ['empty', []],
  ])('reads the singular avatar and banner of older instances, the lists %s', async (_, list) => {
    const old = copy(blurtChannel)
    old.body.avatars = list
    old.body.banners = list
    old.body.avatar = { width: 120, path: '/lazy-static/avatars/old.jpg' }
    old.body.banner = { width: 1920, path: '/lazy-static/banners/old.jpg' }
    const { layer, fake } = setUp()
    fake.respond(old.url, old)

    const channel = await layer.getChannel(BLURT)

    expect(channel.thumbnail).toBe('https://blurt.media/lazy-static/avatars/old.jpg')
    expect(channel.avatarLarge).toBe('https://blurt.media/lazy-static/avatars/old.jpg')
    expect(channel.banner).toBe('https://blurt.media/lazy-static/banners/old.jpg')
  })

  it('keeps only https image URLs', async () => {
    const hostile = copy(blurtChannel)
    hostile.body.avatars = [{ width: 120, path: 'javascript:alert(1)' }]
    hostile.body.banners = [{ width: 1920, fileUrl: 'http://blurt.media/banner.jpg' }]
    const { layer, fake } = setUp()
    fake.respond(hostile.url, hostile)

    expect(await layer.getChannel(BLURT)).toMatchObject({ thumbnail: '', avatarLarge: '', banner: null })
  })

  it('is not found when the instance has no such channel', async () => {
    const { layer, fake } = setUp()
    fake.respond(BLENDER_API, blenderNotFound)

    expect(await failure(layer.getChannel(BLENDER))).toMatchObject({ kind: 'notFound', status: 404 })
  })

  it.each([
    ['blender_studio'],
    ['blender_studio@www.youtube.com'],
    ['https://video.blender.org/c/blender_studio'],
    [null],
  ])('refuses %s as a handle, without a request', async (handle) => {
    const { layer, fake } = setUp()

    expect((await failure(layer.getChannel(handle))).kind).toBe('invalid')
    expect(fake.requests).toHaveLength(0)
  })
})

describe('listChannelVideos (PeerTube)', () => {
  it('lists the newest first by default, as summaries the existing card reads', async () => {
    const { fake, layer } = setUp()

    const page = await layer.listChannelVideos(BLENDER)

    expect(fake.urls()).toEqual([videosUrl(BLENDER_API)])
    expect(page.items.map(video => video.videoId)).toEqual(blenderNewest.body.data.map(video => video.uuid))
    expect(page.items[0]).toEqual({
      type: 'video',
      platform: 'peertube',
      host: 'video.blender.org',
      videoId: '2c9347ab-7090-4f5a-a541-ca27340e9c9b',
      title: 'OVERGROWN Project: What will you get?',
      author: 'Blender Studio',
      authorId: BLENDER,
      thumbnail: expect.stringMatching(/^https:\/\/video\.blender\.org\/lazy-static\/thumbnails\//),
      lengthSeconds: 281,
      published: Date.parse('2026-09-15T10:43:46.032Z'),
      viewCount: 94,
      liveNow: false,
      isUpcoming: false,
      nsfw: false,
    })
  })

  it.each([
    ['newest', '-publishedAt', blenderNewest],
    ['popular', '-views', blenderViews],
    ['oldest', 'publishedAt', blenderOldest],
  ])('sorts by %s (sort=%s)', async (sort, param, fixture) => {
    const { fake, layer } = setUp()

    const page = await layer.listChannelVideos(BLENDER, { sort })

    expect(new URL(fake.urls()[0]).searchParams.get('sort')).toBe(param)
    expect(page.items.map(video => video.videoId)).toEqual(fixture.body.data.map(video => video.uuid))
  })

  it('orders the results as asked: most viewed first, oldest first', async () => {
    const { layer } = setUp()

    const popular = (await layer.listChannelVideos(BLENDER, { sort: 'popular' })).items.map(video => video.viewCount)
    const oldest = (await layer.listChannelVideos(BLENDER, { sort: 'oldest' })).items.map(video => video.published)

    expect(popular).toEqual([...popular].sort((a, b) => b - a))
    expect(oldest).toEqual([...oldest].sort((a, b) => a - b))
  })

  it('pages by offset, and ends with a null cursor', async () => {
    const { fake, layer } = setUp()
    const last = copy(blenderNewestPage2)
    last.body.total = 10
    fake.respond(videosUrl(BLENDER_API, { start: 5 }), last)

    const first = await layer.listChannelVideos(BLENDER)
    expect(first.cursor).not.toBeNull()

    const second = await layer.listChannelVideos(BLENDER, { cursor: first.cursor })

    expect(fake.urls()).toEqual([videosUrl(BLENDER_API), videosUrl(BLENDER_API, { start: 5 })])
    expect(second.items.map(video => video.videoId)).toEqual(blenderNewestPage2.body.data.map(video => video.uuid))
    expect(second.cursor).toBeNull()
  })

  it('ends on an empty page, whatever the total says', async () => {
    const { fake, layer } = setUp()
    fake.respond(videosUrl(BLENDER_API), { status: 200, body: { total: 152, data: [] } })

    expect(await layer.listChannelVideos(BLENDER)).toEqual({ items: [], cursor: null })
  })

  it('keeps the sort across pages', async () => {
    const { fake, layer } = setUp()
    fake.respond(videosUrl(BLENDER_API, { start: 5, sort: '-views' }), { status: 200, body: { total: 152, data: [] } })

    const first = await layer.listChannelVideos(BLENDER, { sort: 'popular' })
    await layer.listChannelVideos(BLENDER, { sort: 'popular', cursor: first.cursor })

    expect(fake.urls()[1]).toBe(videosUrl(BLENDER_API, { start: 5, sort: '-views' }))
  })

  it('lists lives and scheduled lives with their flags', async () => {
    const withLives = copy(blenderNewest)
    withLives.body.data.splice(1, 0, liveNow.body, scheduledLive.body)
    const { fake, layer } = setUp()
    fake.respond(videosUrl(BLENDER_API), withLives)

    const { items } = await layer.listChannelVideos(BLENDER)

    expect(items[1]).toMatchObject({ videoId: liveNow.body.uuid, liveNow: true, isUpcoming: false })
    expect(items[1]).not.toHaveProperty('lengthSeconds')
    expect(items[2]).toMatchObject({
      videoId: scheduledLive.body.uuid,
      liveNow: false,
      isUpcoming: true,
      premiereDate: new Date('2026-10-04T07:30:00.000Z'),
      // A remote channel's video keeps its own origin
      host: 'tube.xy-space.de',
    })
  })

  it('reads older instances (peertube.f-si.org 6.2, blurt.media 6.3: paths only, no thumbnails[])', async () => {
    const { layer } = setUp()

    const fsi = await layer.listChannelVideos(FSI)
    const blurt = await layer.listChannelVideos(BLURT)

    expect(fsi.items).toHaveLength(5)
    expect(fsi.items[0]).toMatchObject({
      host: 'peertube.f-si.org',
      authorId: FSI,
      // The larger preview, made absolute on the instance
      thumbnail: 'https://peertube.f-si.org/lazy-static/previews/4ad4047e-bdab-41bf-b247-06a319a89878.jpg',
    })
    expect(fsi.cursor).not.toBeNull()
    expect(blurt.items[0]).toMatchObject({
      host: 'blurt.media',
      authorId: BLURT,
      thumbnail: 'https://blurt.media/lazy-static/previews/336869ee-2032-4a9a-b1d9-62c2b5ff6f32.jpg',
    })
  })

  describe('NSFW', () => {
    function withOneNsfw() {
      const fixture = copy(blenderNewest)
      fixture.body.data[1].nsfw = true
      return fixture
    }

    it('asks for none and drops any the instance sends anyway, by default', async () => {
      const { fake, layer } = setUp()
      fake.respond(videosUrl(BLENDER_API), withOneNsfw())

      const page = await layer.listChannelVideos(BLENDER)

      expect(new URL(fake.urls()[0]).searchParams.get('nsfw')).toBe('false')
      expect(page.items).toHaveLength(4)
      expect(page.items.some(video => video.nsfw)).toBe(false)
      // The next page starts after everything the instance sent, dropped or not
      fake.respond(videosUrl(BLENDER_API, { start: 5 }), { status: 200, body: { total: 152, data: [] } })
      await layer.listChannelVideos(BLENDER, { cursor: page.cursor })
      expect(fake.urls()[1]).toBe(videosUrl(BLENDER_API, { start: 5 }))
    })

    /**
     * @param {object} fixture
     */
    function allNsfw(fixture) {
      const flagged = copy(fixture)
      for (const video of flagged.body.data) {
        video.nsfw = true
      }
      return flagged
    }

    it('follows a page the filter empties with the next', async () => {
      const { fake, layer } = setUp()
      fake.respond(videosUrl(BLENDER_API), allNsfw(blenderNewest))

      const page = await layer.listChannelVideos(BLENDER)

      expect(fake.urls()).toEqual([videosUrl(BLENDER_API), videosUrl(BLENDER_API, { start: 5 })])
      expect(page.items.map(video => video.videoId)).toEqual(blenderNewestPage2.body.data.map(video => video.uuid))
      expect(page.cursor).toBe(10)
    })

    it('gives up after three more pages, empty but not at the end', async () => {
      const { fake, layer } = setUp()
      fake.respond(/\/videos\?/, allNsfw(blenderNewest))

      const page = await layer.listChannelVideos(BLENDER)

      expect(fake.requests).toHaveLength(4)
      expect(page.items).toEqual([])
      expect(page.cursor).not.toBeNull()
    })

    it('asks for both and keeps them when the setting shows NSFW', async () => {
      const { fake, layer } = setUp({ config: { peertubeShowNsfw: true } })
      fake.respond(videosUrl(BLENDER_API, { nsfw: 'both' }), withOneNsfw())

      const page = await layer.listChannelVideos(BLENDER)

      expect(fake.urls()).toEqual([videosUrl(BLENDER_API, { nsfw: 'both' })])
      expect(page.items).toHaveLength(5)
      expect(page.items[1].nsfw).toBe(true)
    })
  })

  it.each([
    [{ sort: 'trending' }],
    [{ cursor: -5 }],
    [{ cursor: 'next' }],
    [{ cursor: 2.5 }],
  ])('refuses %o, without a request', async (options) => {
    const { fake, layer } = setUp()

    expect((await failure(layer.listChannelVideos(BLENDER, options))).kind).toBe('invalid')
    expect(fake.requests).toHaveLength(0)
  })
})

describe('page sizes (PeerTube)', () => {
  it('never asks a channel for more than 100 at a time', async () => {
    const { fake, layer } = setUp()

    await layer.listChannelVideos(BLENDER)
    await layer.listChannelPlaylists(BLENDER)

    for (const url of fake.urls()) {
      const count = Number(new URL(url).searchParams.get('count'))
      expect(count).toBeGreaterThan(0)
      expect(count).toBeLessThanOrEqual(100)
    }
  })
})

describe('listChannelPlaylists (PeerTube)', () => {
  it('lists the channel playlists as summaries', async () => {
    const { fake, layer } = setUp()

    const page = await layer.listChannelPlaylists(BLENDER)

    expect(fake.urls()).toEqual([`${BLENDER_API}/video-playlists?start=0&count=30`])
    expect(page.items.map(playlist => playlist.title)).toEqual([
      'Blender Studio Logs', 'Project Gold', 'Pet Projects', '#NODEVEMBER', 'Sprite Fright Weekly',
    ])
    expect(page.items[0]).toEqual({
      type: 'playlist',
      platform: 'peertube',
      host: 'video.blender.org',
      playlistId: 'fed086ba-4d6a-4816-8362-787880c8b0a6',
      title: 'Blender Studio Logs',
      // The largest landscape thumbnail, not the square one
      thumbnail: 'https://video.blender.org/lazy-static/thumbnails/playlist-72ea5298-0240-483e-b476-29a2b6a6470b.png',
      videoCount: 31,
      url: 'https://video.blender.org/video-playlists/fed086ba-4d6a-4816-8362-787880c8b0a6',
      description: blenderPlaylists.body.data[0].description,
      channelName: 'Blender Studio',
      channelId: BLENDER,
    })
    // total 5, all five sent
    expect(page.cursor).toBeNull()
  })

  it('pages by offset', async () => {
    const { fake, layer } = setUp()
    const more = copy(blenderPlaylists)
    more.body.total = 40
    fake.respond(`${BLENDER_API}/video-playlists?start=0&count=30`, more)
    fake.respond(`${BLENDER_API}/video-playlists?start=5&count=30`, { status: 200, body: { total: 40, data: [] } })

    const first = await layer.listChannelPlaylists(BLENDER)
    const second = await layer.listChannelPlaylists(BLENDER, { cursor: first.cursor })

    expect(fake.urls()[1]).toBe(`${BLENDER_API}/video-playlists?start=5&count=30`)
    expect(second).toEqual({ items: [], cursor: null })
  })

  it.each([
    [{ cursor: -1 }],
    [{ cursor: '5' }],
  ])('refuses %o, without a request', async (options) => {
    const { fake, layer } = setUp()

    expect((await failure(layer.listChannelPlaylists(BLENDER, options))).kind).toBe('invalid')
    expect(fake.requests).toHaveLength(0)
  })

  it('reads a playlist with only a thumbnail path, and one with no thumbnail', async () => {
    const old = copy(blenderPlaylists)
    delete old.body.data[0].thumbnails
    delete old.body.data[1].thumbnails
    old.body.data[1].thumbnailPath = null
    const { fake, layer } = setUp()
    fake.respond(`${BLENDER_API}/video-playlists?start=0&count=30`, old)

    const { items } = await layer.listChannelPlaylists(BLENDER)

    expect(items[0].thumbnail).toBe('https://video.blender.org/lazy-static/thumbnails/playlist-759335bd-eed5-41ce-9a83-cca8f60201d6.png')
    expect(items[1].thumbnail).toBe('')
  })
})

describe('listAccountChannels (PeerTube)', () => {
  const ACCOUNT = 'blender@video.blender.org'
  const ACCOUNT_CHANNELS_URL = `https://video.blender.org/api/v1/accounts/${ACCOUNT}/video-channels?count=100`

  it('lists every channel of an account, from the account\'s instance, as channel summaries', async () => {
    const { fake, layer } = setUp()
    fake.respond(ACCOUNT_CHANNELS_URL, accountChannels)

    const channels = await layer.listAccountChannels(ACCOUNT)

    expect(fake.urls()).toEqual([ACCOUNT_CHANNELS_URL])
    expect(channels).toEqual([
      {
        platform: 'peertube',
        host: 'video.blender.org',
        id: 'blender_studio@video.blender.org',
        handle: 'blender_studio@video.blender.org',
        name: 'Blender Studio',
        thumbnail: 'https://video.blender.org/lazy-static/avatars/e2519482-f087-4965-899b-cc8b7a2921f0.webp',
        url: 'https://video.blender.org/video-channels/blender_studio',
        subscriberCount: 33,
      },
      {
        platform: 'peertube',
        host: 'video.blender.org',
        id: 'blender_developers@video.blender.org',
        handle: 'blender_developers@video.blender.org',
        name: 'Blender Developers',
        thumbnail: '',
        url: 'https://video.blender.org/video-channels/blender_developers',
        subscriberCount: 7,
      },
    ])
  })

  it('accepts the handle with a leading @ and any case of host', async () => {
    const { fake, layer } = setUp()
    fake.respond(ACCOUNT_CHANNELS_URL, accountChannels)

    expect(await layer.listAccountChannels('@blender@Video.Blender.org')).toHaveLength(2)
    expect(fake.urls()).toEqual([ACCOUNT_CHANNELS_URL])
  })

  it('leaves out a channel that cannot be named, and is empty for an account with none', async () => {
    const odd = copy(accountChannels)
    odd.body.data[1].name = 'not a name'
    const { fake, layer } = setUp()
    fake.respond(ACCOUNT_CHANNELS_URL, odd)

    expect((await layer.listAccountChannels(ACCOUNT)).map(channel => channel.handle)).toEqual(['blender_studio@video.blender.org'])

    fake.respond(ACCOUNT_CHANNELS_URL, { status: 200, body: { total: 0, data: [] } })
    expect(await layer.listAccountChannels(ACCOUNT)).toEqual([])
  })

  it('is not found when the instance has no such account', async () => {
    const { fake, layer } = setUp()
    fake.respond(ACCOUNT_CHANNELS_URL, blenderNotFound)

    expect(await failure(layer.listAccountChannels(ACCOUNT))).toMatchObject({ kind: 'notFound', status: 404 })
  })

  it('is unavailable when the instance answers without a list', async () => {
    const { fake, layer } = setUp()
    fake.respond(ACCOUNT_CHANNELS_URL, { status: 200, body: { detail: 'odd' } })

    expect((await failure(layer.listAccountChannels(ACCOUNT))).kind).toBe('unavailable')
  })

  it.each([
    ['blender'],
    ['blender@www.youtube.com'],
    ['https://video.blender.org/accounts/blender'],
    [null],
  ])('refuses %s as a handle, without a request', async (handle) => {
    const { fake, layer } = setUp()

    expect((await failure(layer.listAccountChannels(handle))).kind).toBe('invalid')
    expect(fake.requests).toHaveLength(0)
  })
})
