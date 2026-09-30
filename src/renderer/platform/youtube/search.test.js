import { describe, expect, it, vi } from 'vitest'

import { PlatformError } from '../errors'
import { createPlatformLayer } from '../index'
import { defaults, withParameter, withText } from '../search/query'

const video = (id) => ({ type: 'video', videoId: id, title: `Video ${id}` })
const channel = { type: 'channel', id: 'UCaaaaaaaaaaaaaaaaaaaaaa', name: 'A channel' }
const playlist = { type: 'playlist', playlistId: 'PL1', title: 'A playlist' }
const hashtag = { type: 'hashtag', title: '#blender' }

const PLAIN = { prioritize: 'relevance', time: '', type: 'all', duration: '', features: [] }

/**
 * @param {object} [options]
 * @param {object} [options.config]
 */
function setUp({ config } = {}) {
  const localContinuation = { a: 'YT.Search instance' }
  const youtube = {
    getLocalSearchResults: vi.fn(async () => ({ results: [video('l1'), hashtag, channel, playlist], continuationData: localContinuation })),
    getLocalSearchContinuation: vi.fn(async () => ({ results: [video('l2')], continuationData: null })),
    getInvidiousSearchResults: vi.fn(async (_query, page) => page < 3 ? [video(`i${page}`), hashtag] : []),
  }
  const layer = createPlatformLayer({
    fetch: () => Promise.reject(new TypeError('no network in tests')),
    youtube,
    config: { backendPreference: 'local', backendFallback: false, ...config },
  })

  return { youtube, layer, localContinuation }
}

/**
 * @param {Record<string, unknown>} [filters]
 * @param {string} [text]
 */
function youtubeQuery(filters = {}, text = 'blender') {
  let query = withText(defaults('youtube'), text)
  for (const [name, value] of Object.entries(filters)) {
    query = withParameter(query, name, value)
  }
  return query
}

async function failure(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the search to fail')
}

describe('YouTube search through the layer', () => {
  it('asks Local, the preferred backend, with the plain filters and the safety mode', async () => {
    const { layer, youtube } = setUp({ config: { showFamilyFriendlyOnly: true } })

    await layer.searchQuery(youtubeQuery())

    expect(youtube.getLocalSearchResults).toHaveBeenCalledWith('blender', PLAIN, true)
    expect(youtube.getInvidiousSearchResults).not.toHaveBeenCalled()
  })

  it.each([
    [{ sort: 'views' }, { prioritize: 'popularity' }],
    [{ time: 'week' }, { time: 'week' }],
    [{ type: 'shorts' }, { type: 'shorts' }],
    [{ type: 'movie' }, { type: 'movie' }],
    [{ length: 'short' }, { duration: 'under_three_mins' }],
    [{ length: 'medium' }, { duration: 'three_to_twenty_mins' }],
    [{ length: 'long' }, { duration: 'over_twenty_mins' }],
    [{ live: true }, { features: ['live'] }],
  ])('hands both backends the filters object for %o', async (filters, expected) => {
    const local = setUp()
    await local.layer.searchQuery(youtubeQuery(filters))
    expect(local.youtube.getLocalSearchResults).toHaveBeenCalledWith('blender', { ...PLAIN, ...expected }, false)

    const invidious = setUp({ config: { backendPreference: 'invidious' } })
    await invidious.layer.searchQuery(youtubeQuery(filters))
    expect(invidious.youtube.getInvidiousSearchResults).toHaveBeenCalledWith('blender', 1, { ...PLAIN, ...expected })
  })

  it('sends a sort YouTube does not have as relevance, and does not list it as applied', async () => {
    const { layer, youtube } = setUp()

    const page = await layer.searchQuery(youtubeQuery({ sort: 'date', time: 'year' }))

    expect(youtube.getLocalSearchResults).toHaveBeenCalledWith('blender', { ...PLAIN, time: 'year' }, false)
    expect(page.applied).toEqual(['time'])
  })

  it('sends a channel search none of what it does not take, and says so', async () => {
    const { layer, youtube } = setUp()

    const page = await layer.searchQuery(youtubeQuery({ time: 'week', length: 'long', live: true, type: 'channel' }))

    expect(youtube.getLocalSearchResults).toHaveBeenCalledWith('blender', { ...PLAIN, type: 'channel' }, false)
    expect(page.applied).toEqual(['type'])
  })

  it('lists what it honoured as applied', async () => {
    const { layer } = setUp()

    const page = await layer.searchQuery(youtubeQuery({ sort: 'views', type: 'video', length: 'long', live: true }))

    expect(page.applied).toEqual(['sort', 'type', 'length', 'live'])
  })

  it('answers the results as the cards read them, without hashtags', async () => {
    const { layer } = setUp()

    const page = await layer.searchQuery(youtubeQuery())

    expect(page.items).toEqual([video('l1'), channel, playlist])
  })

  it('continues on Local from the cursor, until it ends', async () => {
    const { layer, youtube, localContinuation } = setUp()

    const first = await layer.searchQuery(youtubeQuery())
    expect(first.cursor).toEqual({ backend: 'local', continuation: localContinuation })

    const second = await layer.searchQuery(youtubeQuery(), { cursor: first.cursor })

    expect(youtube.getLocalSearchContinuation).toHaveBeenCalledWith(localContinuation)
    expect(second.items).toEqual([video('l2')])
    expect(second.cursor).toBeNull()
  })

  it('pages Invidious by number, ending at an empty answer', async () => {
    const { layer, youtube } = setUp({ config: { backendPreference: 'invidious' } })

    const first = await layer.searchQuery(youtubeQuery())
    const second = await layer.searchQuery(youtubeQuery(), { cursor: first.cursor })
    const third = await layer.searchQuery(youtubeQuery(), { cursor: second.cursor })

    expect(youtube.getInvidiousSearchResults.mock.calls.map(call => call[1])).toEqual([1, 2, 3])
    expect([first.items, second.items]).toEqual([[video('i1')], [video('i2')]])
    expect(third).toEqual({ items: [], cursor: null, applied: [] })
  })

  it('ends an Invidious search that answers nothing', async () => {
    const { layer, youtube } = setUp({ config: { backendPreference: 'invidious' } })
    youtube.getInvidiousSearchResults.mockResolvedValue(null)

    expect((await layer.searchQuery(youtubeQuery())).cursor).toBeNull()
  })

  it('asks nothing for blank text', async () => {
    const { layer, youtube } = setUp()

    expect(await layer.searchQuery(youtubeQuery({}, '  '))).toEqual({ items: [], cursor: null, applied: [] })
    expect(youtube.getLocalSearchResults).not.toHaveBeenCalled()
  })

  it('uses Invidious alone where the build has no Local API', async () => {
    const { layer, youtube } = setUp({ config: { supportsLocalApi: false, backendFallback: true } })
    youtube.getInvidiousSearchResults.mockRejectedValue(new Error('down'))

    await failure(layer.searchQuery(youtubeQuery()))

    expect(youtube.getLocalSearchResults).not.toHaveBeenCalled()
  })
})

describe('the backend preference and fallback', () => {
  it('falls back to Invidious when Local fails and fallback is on', async () => {
    const { layer, youtube } = setUp({ config: { backendFallback: true } })
    youtube.getLocalSearchResults.mockRejectedValue(new Error('Innertube broke'))

    const page = await layer.searchQuery(youtubeQuery())

    expect(youtube.getInvidiousSearchResults).toHaveBeenCalledWith('blender', 1, PLAIN)
    expect(page.items).toEqual([video('i1')])
    expect(page.cursor).toEqual({ backend: 'invidious', page: 2 })
  })

  it('falls back to Local when Invidious fails and fallback is on', async () => {
    const { layer, youtube } = setUp({ config: { backendPreference: 'invidious', backendFallback: true } })
    youtube.getInvidiousSearchResults.mockRejectedValue(new Error('instance down'))

    const page = await layer.searchQuery(youtubeQuery())

    expect(page.items).toEqual([video('l1'), channel, playlist])
  })

  it('surfaces the failure as unavailable, with the cause, when fallback is off', async () => {
    const { layer, youtube } = setUp()
    const cause = new Error('Innertube broke')
    youtube.getLocalSearchResults.mockRejectedValue(cause)

    const error = await failure(layer.searchQuery(youtubeQuery()))

    expect(error).toBeInstanceOf(PlatformError)
    expect(error.kind).toBe('unavailable')
    expect(error.cause).toBe(cause)
    expect(youtube.getInvidiousSearchResults).not.toHaveBeenCalled()
  })

  it('surfaces the last failure when both fail', async () => {
    const { layer, youtube } = setUp({ config: { backendFallback: true } })
    youtube.getLocalSearchResults.mockRejectedValue(new Error('Innertube broke'))
    youtube.getInvidiousSearchResults.mockRejectedValue(new Error('instance down'))

    const error = await failure(layer.searchQuery(youtubeQuery()))

    expect(error.message).toContain('instance down')
  })

  it('never falls back in the middle of a list: the next page goes to the backend that made the cursor', async () => {
    const { layer, youtube } = setUp({ config: { backendFallback: true } })
    youtube.getLocalSearchContinuation.mockRejectedValue(new Error('continuation broke'))

    const error = await failure(layer.searchQuery(youtubeQuery(), { cursor: { backend: 'local', continuation: {} } }))

    expect(error.kind).toBe('unavailable')
    expect(youtube.getInvidiousSearchResults).not.toHaveBeenCalled()
  })

  it('refuses a cursor it did not hand out', async () => {
    const { layer } = setUp()

    expect((await failure(layer.searchQuery(youtubeQuery(), { cursor: 20 }))).kind).toBe('invalid')
  })
})
