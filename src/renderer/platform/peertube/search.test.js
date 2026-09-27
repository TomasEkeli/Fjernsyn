import { describe, expect, it } from 'vitest'

import { PlatformError } from '../errors'
import { createPlatformLayer } from '../index'
import { createFakeFetch } from './testing/fakeFetch'

import blenderSearch from './fixtures/video.blender.org--search-videos.json'
import sepiaChannels from './fixtures/sepiasearch.org--search-channels.json'
import sepiaNsfwBoth from './fixtures/sepiasearch.org--search-videos-nsfw-both.json'
import sepiaVideos from './fixtures/sepiasearch.org--search-videos.json'
import sepiaVideosPage2 from './fixtures/sepiasearch.org--search-videos-page2.json'

const SEPIA = 'https://sepiasearch.org/api/v1'
const BLENDER = 'https://video.blender.org/api/v1'

/**
 * @param {string} api
 * @param {string} query
 * @param {{ start?: number, nsfw?: string }} [params]
 */
function videosUrl(api, query, { start = 0, nsfw = 'false' } = {}) {
  return `${api}/search/videos?search=${query}&start=${start}&count=30&nsfw=${nsfw}`
}

/**
 * @param {string} api
 * @param {string} query
 * @param {{ start?: number }} [params]
 */
function channelsUrl(api, query, { start = 0 } = {}) {
  return `${api}/search/video-channels?search=${query}&start=${start}&count=30`
}

/**
 * @param {object} [options]
 * @param {object} [options.config]
 */
function setUp({ config } = {}) {
  const fake = createFakeFetch()
    .respond(videosUrl(SEPIA, 'blender'), sepiaVideos)
    .respond(videosUrl(SEPIA, 'blender', { start: 5 }), sepiaVideosPage2)
    .respond(videosUrl(SEPIA, 'horror', { nsfw: 'both' }), sepiaNsfwBoth)
    .respond(channelsUrl(SEPIA, 'blender'), sepiaChannels)
    .respond(videosUrl(BLENDER, 'spring'), blenderSearch)
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
  throw new Error('expected the search to fail')
}

describe('search (PeerTube)', () => {
  describe('SepiaSearch, the default source', () => {
    it('asks the index alone, not an instance config, marked so that main sets the User-Agent', async () => {
      const { fake, layer } = setUp()

      await layer.search('blender')

      expect(fake.requests.map(({ url, headers }) => [url, headers['x-fjernsyn-peertube']])).toEqual([
        [videosUrl(SEPIA, 'blender'), 'probe'],
      ])
    })

    it('answers video summaries carrying their origin host, so that they play from there', async () => {
      const { layer } = setUp()

      const page = await layer.search('blender')

      expect(page.items.map(video => video.videoId)).toEqual(sepiaVideos.body.data.map(video => video.uuid))
      expect(page.items[0]).toEqual({
        type: 'video',
        platform: 'peertube',
        host: 'video.blender.org',
        videoId: 'b29290cc-dc51-4a12-bcb2-2aa5fece7605',
        title: 'OVERGROWN: a feature film project by Blender Studio',
        author: 'Blender Studio',
        authorId: 'blender_studio@video.blender.org',
        // The index's absolute URL on the origin, largest landscape
        thumbnail: 'https://video.blender.org/lazy-static/thumbnails/057e35a6-c5b8-4fb4-8230-0f5df412ca50.jpg',
        lengthSeconds: 70,
        published: Date.parse('2026-07-10T14:00:16.560Z'),
        viewCount: 12696,
        liveNow: false,
        isUpcoming: false,
        nsfw: false,
      })
    })

    it('makes an index result path absolute on the origin, not on the index', async () => {
      const pathsOnly = copy(sepiaVideos)
      delete pathsOnly.body.data[0].thumbnails
      delete pathsOnly.body.data[0].channel.avatars[0].fileUrl
      const { fake, layer } = setUp()
      fake.respond(videosUrl(SEPIA, 'blender'), pathsOnly)

      const [first] = (await layer.search('blender')).items

      expect(first.thumbnail).toBe(`https://video.blender.org${sepiaVideos.body.data[0].previewPath}`)
    })

    it('pages by offset, to a null cursor at the end', async () => {
      const { fake, layer } = setUp()
      const last = copy(sepiaVideosPage2)
      last.body.total = 10
      fake.respond(videosUrl(SEPIA, 'blender', { start: 5 }), last)

      const first = await layer.search('blender')
      const second = await layer.search('blender', { cursor: first.cursor })

      expect(fake.urls()).toEqual([videosUrl(SEPIA, 'blender'), videosUrl(SEPIA, 'blender', { start: 5 })])
      expect(first.cursor).not.toBeNull()
      expect(second.items.map(video => video.videoId)).toEqual(sepiaVideosPage2.body.data.map(video => video.uuid))
      expect(second.cursor).toBeNull()
    })

    it('encodes the query', async () => {
      const { fake, layer } = setUp()
      fake.respond(/./, { status: 200, body: { total: 0, data: [] } })

      expect(await layer.search('  a&b=c #1  ')).toEqual({ items: [], cursor: null })
      expect(new URL(fake.urls()[0]).searchParams.get('search')).toBe('a&b=c #1')
    })

    it('answers a blank query with an empty page, without a request', async () => {
      const { fake, layer } = setUp()

      expect(await layer.search('   ')).toEqual({ items: [], cursor: null })
      expect(fake.requests).toHaveLength(0)
    })

    it('drops a result whose origin is never PeerTube', async () => {
      const hostile = copy(sepiaVideos)
      hostile.body.data[0].channel.host = 'www.youtube.com'
      const { fake, layer } = setUp()
      fake.respond(videosUrl(SEPIA, 'blender'), hostile)

      const { items } = await layer.search('blender')

      expect(items).toHaveLength(4)
      expect(items.map(video => video.host)).not.toContain('www.youtube.com')
    })
  })

  describe('a single instance as the source (video.blender.org)', () => {
    it('asks that instance search API, with or without a trailing slash', async () => {
      for (const source of ['https://video.blender.org', 'https://video.blender.org/']) {
        const { fake, layer } = setUp({ config: { peertubeSearchSource: source } })

        const page = await layer.search('spring')

        expect(fake.urls()).toEqual([videosUrl(BLENDER, 'spring')])
        expect(page.items.map(video => video.videoId)).toEqual(blenderSearch.body.data.map(video => video.uuid))
        expect(page.items[0]).toMatchObject({
          host: 'video.blender.org',
          authorId: 'blender_channel@video.blender.org',
          thumbnail: 'https://video.blender.org/lazy-static/thumbnails/346f34e6-e6b6-4c7f-8e4d-2bfe2fb1b8a4.jpg',
        })
      }
    })

    it('makes a remote result path absolute on the instance searched, which caches it, and keeps its origin', async () => {
      const remote = copy(blenderSearch)
      const video = remote.body.data[0]
      video.isLocal = false
      video.channel.host = 'other.example'
      video.account.host = 'other.example'
      delete video.thumbnails
      video.previewPath = '/lazy-static/previews/cached.jpg'
      const { fake, layer } = setUp({ config: { peertubeSearchSource: 'https://video.blender.org' } })
      fake.respond(videosUrl(BLENDER, 'spring'), remote)

      const [first] = (await layer.search('spring')).items

      expect(first).toMatchObject({
        host: 'other.example',
        authorId: 'blender_channel@other.example',
        thumbnail: 'https://video.blender.org/lazy-static/previews/cached.jpg',
      })
    })

    it.each([
      ['https://video.blender.org/api/v1'],
      ['https://video.blender.org/api/v1/'],
    ])('takes %s for the same source', async (source) => {
      const { fake, layer } = setUp({ config: { peertubeSearchSource: source } })

      await layer.search('spring')

      expect(fake.urls()).toEqual([videosUrl(BLENDER, 'spring')])
    })

    it.each([
      ['http://video.blender.org'],
      ['http://sepiasearch.org/'],
      ['https://www.youtube.com'],
      ['https://youtube.com/api/v1'],
      ['not a url'],
    ])('refuses %s as a source, without a request', async (source) => {
      const { fake, layer } = setUp({ config: { peertubeSearchSource: source } })

      expect((await failure(layer.search('spring'))).kind).toBe('invalid')
      expect(fake.requests).toHaveLength(0)
    })
  })

  describe('NSFW (sepiasearch.org, 3 of 10 flagged)', () => {
    const FLAGGED = sepiaNsfwBoth.body.data.filter(video => video.nsfw).map(video => video.uuid)

    it('asks for none, and drops the flagged results a source sends anyway, by default', async () => {
      const { fake, layer } = setUp()
      // A source that ignores nsfw=false
      fake.respond(videosUrl(SEPIA, 'horror'), sepiaNsfwBoth)

      const page = await layer.search('horror')

      expect(FLAGGED).toHaveLength(3)
      expect(new URL(fake.urls()[0]).searchParams.get('nsfw')).toBe('false')
      expect(page.items).toHaveLength(7)
      expect(page.items.map(video => video.videoId)).not.toEqual(expect.arrayContaining([FLAGGED[0]]))
      expect(page.items.every(video => video.nsfw === false)).toBe(true)
      // The next page starts after all ten
      expect(page.cursor).toBe(10)
    })

    it('follows a page the filter empties with the next, up to three more', async () => {
      const flagged = copy(sepiaNsfwBoth)
      for (const video of flagged.body.data) {
        video.nsfw = true
      }
      const { fake, layer } = setUp()
      fake.respond(videosUrl(SEPIA, 'horror'), flagged)
      fake.respond(videosUrl(SEPIA, 'horror', { start: 10 }), flagged)
      fake.respond(videosUrl(SEPIA, 'horror', { start: 20 }), sepiaNsfwBoth)

      const page = await layer.search('horror')

      expect(fake.urls()).toEqual([
        videosUrl(SEPIA, 'horror'),
        videosUrl(SEPIA, 'horror', { start: 10 }),
        videosUrl(SEPIA, 'horror', { start: 20 }),
      ])
      expect(page.items).toHaveLength(7)
      expect(page.cursor).toBe(30)

      fake.clearRequests()
      fake.respond(/\/search\/videos/, flagged)
      const empty = await layer.search('horror')

      // One page and three more, then an empty page that is not the end
      expect(fake.requests).toHaveLength(4)
      expect(empty.items).toEqual([])
      expect(empty.cursor).toBe(40)
    })

    it('asks for both and keeps them when the setting shows NSFW', async () => {
      const { fake, layer } = setUp({ config: { peertubeShowNsfw: true } })

      const page = await layer.search('horror')

      expect(fake.urls()).toEqual([videosUrl(SEPIA, 'horror', { nsfw: 'both' })])
      expect(page.items).toHaveLength(10)
      expect(page.items.filter(video => video.nsfw).map(video => video.videoId)).toEqual(FLAGGED)
    })
  })

  describe('channels', () => {
    it('answers channels the existing channel card renders, carrying their origin host', async () => {
      const { fake, layer } = setUp()

      const page = await layer.search('blender', { type: 'channel' })

      expect(fake.urls()).toEqual([channelsUrl(SEPIA, 'blender')])
      expect(page.items.map(channel => channel.id)).toEqual([
        'blender_channel@video.blender.org',
        'blenderdevelopers@video.blender.org',
        'blender_open_movies@video.blender.org',
        'blender_studio@video.blender.org',
        'blender_stuff@makertube.net',
      ])
      expect(page.items[0]).toEqual({
        type: 'channel',
        dataSource: 'local',
        platform: 'peertube',
        host: 'video.blender.org',
        id: 'blender_channel@video.blender.org',
        handle: 'blender_channel@video.blender.org',
        name: 'Blender',
        thumbnail: 'https://video.blender.org/lazy-static/avatars/5720b4a8-d244-4fae-a2bf-3474caa8f644.png',
        url: 'https://video.blender.org/video-channels/blender_channel',
        subscriberCount: 1187,
        subscribers: 1187,
        videos: 868,
        description: sepiaChannels.body.data[0].description,
        // Whitespace collapsed for the card
        descriptionShort: 'Official PeerTube channel for Blender, the Free and Open Source 3D Creation Suite. **The Freedom to Create**',
      })
      expect(page.items[4].host).toBe('makertube.net')
      expect(page.cursor).toBe(5)
    })

    it('hands the card a short, escaped plain snippet of the description, never markup', async () => {
      const hostile = copy(sepiaChannels)
      hostile.body.data[0].description = 'Hi <img src=https://tracker.example/p.gif style="position:fixed;inset:0"> & ' +
        '<script>alert(1)</script>\n\nline two ' + 'word '.repeat(60)
      const { fake, layer } = setUp()
      fake.respond(channelsUrl(SEPIA, 'blender'), hostile)

      const [first] = (await layer.search('blender', { type: 'channel' })).items

      expect(first.descriptionShort).not.toMatch(/[<>"]/)
      expect(first.descriptionShort).toMatch(/^Hi &lt;img src=https:\/\/tracker\.example\/p\.gif style=&quot;position:fixed;inset:0&quot;&gt; &amp; &lt;script&gt;alert\(1\)&lt;\/script&gt; line two word /)
      // Cut on a word boundary, with an ellipsis
      expect(first.descriptionShort).toMatch(/ word…$/)
      expect(first.descriptionShort.replaceAll(/&\w+;/g, '_').length).toBeLessThanOrEqual(201)
      // The whole description stays as the instance sent it
      expect(first.description).toBe(hostile.body.data[0].description)
    })

    it('makes an index avatar path absolute on the origin', async () => {
      const pathsOnly = copy(sepiaChannels)
      const avatars = pathsOnly.body.data[4].avatars
      for (const avatar of avatars) {
        delete avatar.fileUrl
      }
      const { fake, layer } = setUp()
      fake.respond(channelsUrl(SEPIA, 'blender'), pathsOnly)

      const { items } = await layer.search('blender', { type: 'channel' })

      expect(items[4].thumbnail).toMatch(/^https:\/\/makertube\.net\/lazy-static\/avatars\//)
    })
  })

  it('never asks for more than 100 at a time', async () => {
    const { fake, layer } = setUp()

    await layer.search('blender')
    await layer.search('blender', { type: 'channel' })

    for (const url of fake.urls()) {
      const count = Number(new URL(url).searchParams.get('count'))
      expect(count).toBeGreaterThan(0)
      expect(count).toBeLessThanOrEqual(100)
    }
  })

  it('searches PeerTube when asked for it by name', async () => {
    const { fake, layer } = setUp()

    await layer.search('blender', { platform: 'peertube' })

    expect(fake.urls()).toEqual([videosUrl(SEPIA, 'blender')])
  })

  it.each([
    [{ type: 'playlist' }],
    [{ cursor: 'more' }],
    [{ cursor: -30 }],
    [{ platform: 'youtube' }],
    [{ platform: null }],
  ])('refuses %o, without a request', async (options) => {
    const { fake, layer } = setUp()

    expect((await failure(layer.search('blender', options))).kind).toBe('invalid')
    expect(fake.requests).toHaveLength(0)
  })
})
