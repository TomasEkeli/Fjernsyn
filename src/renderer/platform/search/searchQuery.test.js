import { describe, expect, it, vi } from 'vitest'

import { PlatformError } from '../errors'
import { createPlatformLayer } from '../index'
import { createFakeFetch } from '../peertube/testing/fakeFetch'
import { defaults, withParameter, withText } from './query'

import sepiaChannels from '../peertube/fixtures/sepiasearch.org--search-channels.json'
import sepiaVideos from '../peertube/fixtures/sepiasearch.org--search-videos.json'

const NOW = Date.parse('2026-09-30T12:00:00.000Z')

const youtubeVideo = { type: 'video', videoId: 'dQw4w9WgXcQ', title: 'A YouTube video' }

/**
 * @param {object} [options]
 * @param {object} [options.config]
 */
function setUp({ config } = {}) {
  const fake = createFakeFetch()
    .respond(/^https:\/\/sepiasearch\.org\/api\/v1\/search\/videos\?/, sepiaVideos)
    .respond(/^https:\/\/sepiasearch\.org\/api\/v1\/search\/video-channels\?/, sepiaChannels)
    .respond(/^https:\/\/tilvids\.com\/api\/v1\/search\/videos\?/, sepiaVideos)
  const youtube = {
    getLocalSearchResults: vi.fn(async () => ({ results: [youtubeVideo], continuationData: null })),
    getLocalSearchContinuation: vi.fn(),
    getInvidiousSearchResults: vi.fn(),
  }
  const layer = createPlatformLayer({
    fetch: fake.fetch,
    youtube,
    now: () => NOW,
    config: { peertubeEnabled: true, ...config },
  })

  return { fake, youtube, layer }
}

/**
 * @param {string} scope
 * @param {Record<string, unknown>} [filters]
 */
function queryOf(scope, filters = {}) {
  let query = withText(defaults(scope), 'blender')
  for (const [name, value] of Object.entries(filters)) {
    query = withParameter(query, name, value)
  }
  return query
}

/**
 * The fields of the only request made, as `name` to its values
 *
 * @param {ReturnType<typeof createFakeFetch>} fake
 */
function sentFields(fake) {
  expect(fake.requests).toHaveLength(1)
  const url = new URL(fake.requests[0].url)
  const fields = {}
  for (const name of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(name)
    fields[name] = values.length === 1 ? values[0] : values
  }
  return { origin: url.origin, path: url.pathname, fields }
}

const BASE = { search: 'blender', start: '0', count: '30', nsfw: 'false' }

describe('PeerTube search by query', () => {
  it('sends a plain query as today\'s search', async () => {
    const { fake, layer } = setUp()

    const page = await layer.searchQuery(queryOf('peertube'))

    expect(sentFields(fake)).toEqual({ origin: 'https://sepiasearch.org', path: '/api/v1/search/videos', fields: BASE })
    expect(page.items.map(video => video.videoId)).toEqual(sepiaVideos.body.data.map(video => video.uuid))
    expect(page.applied).toEqual([])
  })

  it.each([
    [{ sort: 'date' }, { sort: '-publishedAt' }],
    [{ sort: 'views' }, { sort: '-views' }],
    [{ sort: 'trending' }, { sort: '-trending' }],
    [{ time: 'today' }, { startDate: '2026-09-29T12:00:00.000Z' }],
    [{ time: 'week' }, { startDate: '2026-09-23T12:00:00.000Z' }],
    [{ time: 'month' }, { startDate: '2026-08-31T12:00:00.000Z' }],
    [{ time: 'year' }, { startDate: '2025-09-30T12:00:00.000Z' }],
    [{ after: '2024-06-01' }, { startDate: '2024-06-01T00:00:00.000Z' }],
    [{ before: '2024-06-30' }, { endDate: '2024-06-30T23:59:59.999Z' }],
    [{ length: 'short' }, { durationMax: '180' }],
    [{ length: 'medium' }, { durationMin: '180', durationMax: '1200' }],
    [{ length: 'long' }, { durationMin: '1200' }],
    [{ live: true }, { isLive: 'true' }],
    [{ language: ['no'] }, { 'languageOneOf[]': 'no', 'boostedLanguages[]': 'no' }],
    [{ language: ['no', 'nb'] }, { 'languageOneOf[]': ['no', 'nb'], 'boostedLanguages[]': ['no', 'nb'] }],
    [{ nsfw: true }, { nsfw: 'both' }],
    [{ type: 'video' }, {}],
  ])('sends %o as %o', async (filters, fields) => {
    const { fake, layer } = setUp()

    const page = await layer.searchQuery(queryOf('peertube', filters))

    expect(sentFields(fake).fields).toEqual({ ...BASE, ...fields })
    expect(page.applied).toEqual(Object.keys(filters))
  })

  it('searches videos for a type it has not, and does not list the type as applied', async () => {
    const { fake, layer } = setUp()

    const page = await layer.searchQuery(queryOf('peertube', { type: 'playlist' }))

    expect(sentFields(fake).path).toBe('/api/v1/search/videos')
    expect(page.applied).toEqual([])
  })

  it('searches channels for type channel, with the text alone', async () => {
    const { fake, layer } = setUp()

    const page = await layer.searchQuery(queryOf('peertube', { type: 'channel', sort: 'date', language: ['no'], nsfw: true }))

    expect(sentFields(fake)).toEqual({
      origin: 'https://sepiasearch.org',
      path: '/api/v1/search/video-channels',
      fields: { search: 'blender', start: '0', count: '30' },
    })
    expect(page.items.map(item => item.type)).toEqual(sepiaChannels.body.data.map(() => 'channel'))
    expect(page.applied).toEqual(['type'])
  })

  it('searches one instance on its own API, local results only, without boosting', async () => {
    const { fake, layer } = setUp()

    const page = await layer.searchQuery(queryOf('peertube', { instance: 'tilvids.com', language: ['en'] }))

    expect(sentFields(fake)).toEqual({
      origin: 'https://tilvids.com',
      path: '/api/v1/search/videos',
      fields: { ...BASE, searchTarget: 'local', 'languageOneOf[]': 'en' },
    })
    expect(page.applied).toEqual(['instance', 'language'])
  })

  it('hides NSFW for this search, whatever the setting, in the request and after it', async () => {
    const flagged = structuredClone(sepiaVideos)
    flagged.body.data[0].nsfw = true
    const { fake, layer } = setUp({ config: { peertubeShowNsfw: true } })
    fake.respond(/sepiasearch\.org\/api\/v1\/search\/videos\?/, flagged)

    const page = await layer.searchQuery(queryOf('peertube', { nsfw: false }))

    expect(sentFields(fake).fields.nsfw).toBe('false')
    expect(page.items.map(video => video.videoId)).not.toContain(flagged.body.data[0].uuid)
    expect(page.items).toHaveLength(flagged.body.data.length - 1)
  })

  it('shows NSFW for this search, whatever the setting, in the request and after it', async () => {
    const flagged = structuredClone(sepiaVideos)
    flagged.body.data[0].nsfw = true
    const { fake, layer } = setUp({ config: { peertubeShowNsfw: false } })
    fake.respond(/sepiasearch\.org\/api\/v1\/search\/videos\?/, flagged)

    const page = await layer.searchQuery(queryOf('peertube', { nsfw: true }))

    expect(sentFields(fake).fields.nsfw).toBe('both')
    expect(page.items).toHaveLength(flagged.body.data.length)
  })

  it('follows the setting when the query does not say', async () => {
    const { fake, layer } = setUp({ config: { peertubeShowNsfw: true } })

    await layer.searchQuery(queryOf('peertube'))

    expect(sentFields(fake).fields.nsfw).toBe('both')
  })

  it('pages on from the cursor', async () => {
    const { fake, layer } = setUp()

    await layer.searchQuery(queryOf('peertube', { sort: 'date' }), { cursor: 30 })

    expect(sentFields(fake).fields).toMatchObject({ start: '30', sort: '-publishedAt' })
  })
})

describe('the All scope', () => {
  it('asks both platforms the same query, and answers a section for each', async () => {
    const { fake, youtube, layer } = setUp()

    const answer = await layer.searchQuery(queryOf('all', { sort: 'views', time: 'week' }))

    expect(youtube.getLocalSearchResults).toHaveBeenCalledWith('blender', expect.objectContaining({ prioritize: 'popularity', time: 'week' }), false)
    expect(sentFields(fake).fields).toMatchObject({ sort: '-views', startDate: '2026-09-23T12:00:00.000Z' })
    expect(answer.sections.youtube).toEqual({ items: [youtubeVideo], cursor: null, applied: ['sort', 'time'] })
    expect(answer.sections.peertube.items).toHaveLength(sepiaVideos.body.data.length)
    expect(answer.sections.peertube.applied).toEqual(['sort', 'time'])
  })

  it('reports per section what each platform honoured', async () => {
    const { layer } = setUp()

    const answer = await layer.searchQuery(queryOf('all', { sort: 'trending', language: ['no'] }))

    expect(answer.sections.youtube.applied).toEqual([])
    expect(answer.sections.peertube.applied).toEqual(['sort', 'language'])
  })

  it('keeps one platform\'s results when the other fails', async () => {
    const { layer, youtube } = setUp()
    youtube.getLocalSearchResults.mockRejectedValue(new Error('Innertube broke'))

    const answer = await layer.searchQuery(queryOf('all'))

    expect(answer.sections.youtube).toBeInstanceOf(PlatformError)
    expect(answer.sections.youtube.kind).toBe('unavailable')
    expect(answer.sections.peertube.items).toHaveLength(sepiaVideos.body.data.length)
  })

  it('keeps YouTube\'s results when PeerTube fails', async () => {
    const { layer, fake } = setUp()
    fake.respond(/sepiasearch\.org/, { status: 503, body: 'down' })

    const answer = await layer.searchQuery(queryOf('all'))

    expect(answer.sections.youtube.items).toEqual([youtubeVideo])
    expect(answer.sections.peertube).toBeInstanceOf(PlatformError)
  })

  it('pages a section on through that section\'s scope, and refuses a cursor for both', async () => {
    const { fake, layer } = setUp()

    await layer.searchQuery({ ...queryOf('all'), scope: 'peertube' }, { cursor: 30 })
    expect(sentFields(fake).fields.start).toBe('30')

    await expect(layer.searchQuery(queryOf('all'), { cursor: 30 })).rejects.toMatchObject({ kind: 'invalid' })
  })
})

describe('while PeerTube is off', () => {
  it('searches YouTube', async () => {
    const { layer } = setUp({ config: { peertubeEnabled: false } })

    expect((await layer.searchQuery(queryOf('youtube'))).items).toEqual([youtubeVideo])
  })

  it('refuses a scope naming PeerTube, without a request', async () => {
    const { layer, fake } = setUp({ config: { peertubeEnabled: false } })

    await expect(layer.searchQuery(queryOf('peertube'))).rejects.toMatchObject({ kind: 'invalid' })
    await expect(layer.searchQuery(queryOf('all'))).rejects.toMatchObject({ kind: 'invalid' })
    expect(fake.requests).toHaveLength(0)
  })
})
