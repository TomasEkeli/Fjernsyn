import { reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DBCollectionHandlers } from '../../../datastores/handlers/index'
import { fetchHackerTubeBundle } from '../../helpers/collections/hackertubeBundle'
import { hackerTubeShare } from '../../helpers/collections/hackertube'
import { lemmySource } from '../../helpers/collections/kinds/lemmy'
import { wallVideos } from '../../helpers/collections/shares'
import { starterSources } from '../../helpers/collections/starterSet'
import { SyncEvents } from '../../../constants'
import collections from './collections'

// A real feed of lemmy.cafe's mealtimevideos, trimmed to two posts
import mealtimeTopWeek from '../../helpers/collections/kinds/fixtures/lemmy.cafe--mealtimevideos-topweek.xml?raw'

vi.mock('../../../datastores/handlers/index', () => ({
  DBCollectionHandlers: {
    findSources: vi.fn(async () => []),
    findShares: vi.fn(async () => []),
    upsertSource: vi.fn(async () => {}),
    putShares: vi.fn(async () => ({ added: 0, updated: 0 })),
    findVideos: vi.fn(async () => []),
    putVideos: vi.fn(async () => {}),
    findSourceData: vi.fn(async () => []),
    putSourceData: vi.fn(async () => {}),
    removeSource: vi.fn(async () => ({ shares: 0 })),
  },
}))

vi.mock('../../helpers/collections/hackertubeBundle', () => ({
  fetchHackerTubeBundle: vi.fn(),
}))

// HackerTube alone, but where a test follows more on the first open
vi.mock('../../helpers/collections/starterSet', () => ({
  starterSources: vi.fn(() => []),
}))

const NOW = Date.parse('2026-11-01T12:00:00Z')

const BUNDLE = {
  formatVersion: 1,
  generated: '2026-10-31',
  taxonomy: { version: 'v', areas: [] },
  videos: [
    { vid: 'aaaaaaaaaaa', title: 'A', channel: 'Ca', why_hn: 'why a', categories: ['x'], score: 25, hn: { recommenders: 1, first_year: 2018, last_year: 2026 }, quote: { hn_comment_id: 1 } },
    { vid: 'bbbbbbbbbbb', title: 'B', channel: 'Cb', why_hn: null, categories: [], score: 3, hn: { recommenders: 0, first_year: 2011, last_year: 2011 }, quote: null },
  ],
}

function freshState() {
  return { collectionSources: {}, collectionShares: {}, collectionVideos: {}, collectionsReady: false, collectionsGrabFailed: false, collectionsSyncBuffer: null, collectionsLoading: false, collectionsLoadFailed: false, collectionsRefreshing: false, collectionsRefreshProgress: { done: 0, total: 0 }, collectionSourceData: {} }
}

function contextFor(state) {
  const context = {
    state,
    getters: {},
    commit: (type, payload) => collections.mutations[type](state, payload),
    dispatch: (type, payload) => collections.actions[type](context, payload),
  }
  return context
}

const shareIds = state => Object.keys(state.collectionShares).sort()

/**
 * hackertube.org as the update check asks it, answering the manifest with the
 * date given and the two files with the rows given; every other path is a 404
 *
 * @param {{ generated?: string, rows?: object[], down?: boolean }} [options]
 */
function stubHackerTube({ generated = '2026-10-31', rows = BUNDLE.videos, down = false } = {}) {
  const fetch = vi.fn(async (url) => {
    if (down) { throw new TypeError('Failed to fetch') }

    const { pathname } = new URL(url)
    switch (pathname) {
      case '/api/export':
        return new Response(JSON.stringify({ generated, videos: rows.length }))
      case '/download/videos.jsonl':
        return new Response(rows.map(row => JSON.stringify(row)).join('\n'))
      case '/download/taxonomy.json':
        return new Response(JSON.stringify({ version: 'v2', areas: [{ id: 'a', name: 'A', categories: [{ id: 'x', name: 'X' }] }] }))
      default:
        return new Response('not found', { status: 404 })
    }
  })

  vi.stubGlobal('fetch', fetch)
  return fetch
}

/** @param {import('vitest').Mock} fetch */
const pathsAsked = fetch => fetch.mock.calls.map(([url]) => new URL(url).pathname)

/** A state with HackerTube followed and the bundle's two videos loaded, as after the first open */
async function loadedState() {
  const state = freshState()
  await collections.actions.openCollections(contextFor(state))
  vi.clearAllMocks()
  return state
}

describe('the Collections store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    fetchHackerTubeBundle.mockResolvedValue(BUNDLE)
  })

  it('loads the sources and shares the datastore holds', async () => {
    DBCollectionHandlers.findSources.mockResolvedValueOnce([{ _id: 'hackertube', kind: 'hackertube', dataGenerated: '2026-10-31' }])
    DBCollectionHandlers.findShares.mockResolvedValueOnce([{ _id: 'hackertube|aaaaaaaaaaa', sourceId: 'hackertube', videoId: 'aaaaaaaaaaa' }])
    const state = freshState()

    await collections.actions.grabCollections(contextFor(state))

    expect(state.collectionsReady).toBe(true)
    expect(collections.getters.getCollectionSources(state).map(source => source._id)).toEqual(['hackertube'])
    expect(shareIds(state)).toEqual(['hackertube|aaaaaaaaaaa'])
  })

  it('loads the videos\' details the datastore holds, by the video\'s ref', async () => {
    DBCollectionHandlers.findVideos.mockResolvedValueOnce([{ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 1, lengthSeconds: 60 }])
    const state = freshState()

    await collections.actions.grabCollections(contextFor(state))

    expect(collections.getters.getCollectionVideos(state)).toEqual({ aaaaaaaaaaa: { _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 1, lengthSeconds: 60 } })
    expect(Object.isFrozen(state.collectionVideos.aaaaaaaaaaa)).toBe(true)
  })

  it('loads each source\'s own data the datastore holds, by source', async () => {
    DBCollectionHandlers.findSourceData.mockResolvedValueOnce([{ _id: 'hackertube', generated: '2026-10-31', taxonomy: { version: 'v', areas: [] } }])
    const state = freshState()

    await collections.actions.grabCollections(contextFor(state))

    expect(collections.getters.getCollectionSourceData(state)('hackertube')).toEqual({ _id: 'hackertube', generated: '2026-10-31', taxonomy: { version: 'v', areas: [] } })
  })

  it('takes another window\'s source data', () => {
    const state = freshState()

    collections.mutations.applyCollectionsSync(state, { event: SyncEvents.COLLECTIONS.PUT_SOURCE_DATA, data: { _id: 'hackertube', generated: 'g', taxonomy: { areas: [] } } })

    expect(state.collectionSourceData.hackertube.generated).toBe('g')
  })

  it('says the read failed when the details cannot be read, so the crawl does not take every video for missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    DBCollectionHandlers.findVideos.mockRejectedValueOnce(new Error('locked'))
    const state = freshState()

    await collections.actions.grabCollections(contextFor(state))

    expect(collections.getters.getCollectionsGrabFailed(state)).toBe(true)
  })

  it('keeps a video\'s details through the datastore, replacing what it held', async () => {
    const state = freshState()
    state.collectionVideos.aaaaaaaaaaa = Object.freeze({ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 1, viewCount: 5 })
    const record = { _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 2, unavailable: 'gone' }

    await collections.actions.putCollectionVideos(contextFor(state), [record])

    expect(DBCollectionHandlers.putVideos).toHaveBeenCalledWith([record])
    expect(state.collectionVideos.aaaaaaaaaaa).toEqual(record)
  })

  it('adds details to the map it holds rather than copying thousands of records for each one', () => {
    const state = freshState()
    const held = state.collectionVideos

    collections.mutations.putCollectionVideos(state, [{ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 1 }])

    expect(state.collectionVideos).toBe(held)
    expect(Object.isFrozen(held.aaaaaaaaaaa)).toBe(true)
  })

  it('takes another window\'s details', () => {
    const state = freshState()
    const record = { _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 2, lengthSeconds: 9 }

    collections.mutations.applyCollectionsSync(state, { event: SyncEvents.COLLECTIONS.PUT_VIDEOS, data: [record] })

    expect(state.collectionVideos.aaaaaaaaaaa).toEqual(record)
  })

  it('is ready when the datastore cannot be read, and says the read failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    DBCollectionHandlers.findShares.mockRejectedValueOnce(new Error('locked'))
    const state = freshState()

    await collections.actions.grabCollections(contextFor(state))

    expect(state.collectionsReady).toBe(true)
    expect(state.collectionsGrabFailed).toBe(true)
    expect(shareIds(state)).toEqual([])
  })

  it('does not follow HackerTube or load the bundle over a datastore it could not read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // The read at startup, and the read again on open
    DBCollectionHandlers.findShares.mockRejectedValueOnce(new Error('locked')).mockRejectedValueOnce(new Error('locked'))
    const state = freshState()
    const context = contextFor(state)
    await collections.actions.grabCollections(context)

    await collections.actions.openCollections(context)

    expect(DBCollectionHandlers.upsertSource).not.toHaveBeenCalled()
    expect(DBCollectionHandlers.putShares).not.toHaveBeenCalled()
    expect(fetchHackerTubeBundle).not.toHaveBeenCalled()
    expect(state.collectionsLoadFailed).toBe(true)
    expect(state.collectionsLoading).toBe(false)
  })

  it('reads the datastore again on open after a failed read, and goes no further when HackerTube is loaded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    DBCollectionHandlers.findShares.mockRejectedValueOnce(new Error('locked'))
    const state = freshState()
    const context = contextFor(state)
    await collections.actions.grabCollections(context)

    DBCollectionHandlers.findSources.mockResolvedValueOnce([{ _id: 'hackertube', kind: 'hackertube', followedAt: 1, dataGenerated: '2026-10-31' }])
    DBCollectionHandlers.findShares.mockResolvedValueOnce([{ _id: 'hackertube|aaaaaaaaaaa', sourceId: 'hackertube', videoId: 'aaaaaaaaaaa' }])
    await collections.actions.openCollections(context)

    expect(state.collectionsGrabFailed).toBe(false)
    expect(state.collectionsLoadFailed).toBe(false)
    expect(DBCollectionHandlers.upsertSource).not.toHaveBeenCalled()
    expect(fetchHackerTubeBundle).not.toHaveBeenCalled()
  })

  it('keeps another window\'s writes that arrive while the datastore is being read', async () => {
    const state = freshState()
    DBCollectionHandlers.findSources.mockResolvedValueOnce([{ _id: 'x', kind: 'lemmy', name: 'Old' }])
    DBCollectionHandlers.findShares.mockImplementationOnce(async () => {
      collections.mutations.applyCollectionsSync(state, { event: SyncEvents.COLLECTIONS.UPSERT_SOURCE, data: { _id: 'x', kind: 'lemmy', name: 'New' } })
      collections.mutations.applyCollectionsSync(state, { event: SyncEvents.COLLECTIONS.PUT_SHARES, data: [{ _id: 'x|aaaaaaaaaaa', sourceId: 'x', videoId: 'aaaaaaaaaaa', votes: 7 }] })
      return [{ _id: 'x|aaaaaaaaaaa', sourceId: 'x', videoId: 'aaaaaaaaaaa', votes: 1 }, { _id: 'x|bbbbbbbbbbb', sourceId: 'x', videoId: 'bbbbbbbbbbb', votes: 2 }]
    })

    await collections.actions.grabCollections(contextFor(state))

    expect(state.collectionSources.x.name).toBe('New')
    expect(shareIds(state)).toEqual(['x|aaaaaaaaaaa', 'x|bbbbbbbbbbb'])
    expect(state.collectionShares['x|aaaaaaaaaaa'].votes).toBe(7)
    expect(state.collectionsSyncBuffer).toBeNull()
  })

  it('applies another window\'s writes at once when no read is under way', () => {
    const state = freshState()

    collections.mutations.applyCollectionsSync(state, { event: SyncEvents.COLLECTIONS.UPSERT_SOURCE, data: { _id: 'x', kind: 'lemmy' } })

    expect(state.collectionSources.x.kind).toBe('lemmy')
  })

  describe('opening Collections the first time', () => {
    it('follows HackerTube and loads the bundle into the datastore as its shares', async () => {
      const state = freshState()

      await collections.actions.openCollections(contextFor(state))

      expect(DBCollectionHandlers.putShares).toHaveBeenCalledTimes(1)
      const [shares] = DBCollectionHandlers.putShares.mock.calls[0]
      expect(shares.map(share => share._id)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|bbbbbbbbbbb'])
      expect(shares[0]).toMatchObject({ sourceId: 'hackertube', votes: 25, why: 'why a', seenAt: NOW })

      expect(shareIds(state)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|bbbbbbbbbbb'])
      expect(state.collectionSources.hackertube).toMatchObject({ kind: 'hackertube', followedAt: NOW, dataGenerated: '2026-10-31' })
      // The taxonomy apart from the source's record, which is written on every refresh
      expect(state.collectionSources.hackertube).not.toHaveProperty('taxonomy')
      expect(DBCollectionHandlers.putSourceData).toHaveBeenCalledWith({ _id: 'hackertube', generated: '2026-10-31', taxonomy: { version: 'v', areas: [] } })
      expect(collections.getters.getCollectionSourceData(state)('hackertube')).toMatchObject({ generated: '2026-10-31', taxonomy: { version: 'v' } })
      // Followed first, then marked loaded once the shares are written
      expect(DBCollectionHandlers.upsertSource.mock.calls.map(([source]) => source.dataGenerated)).toEqual([null, '2026-10-31'])
    })

    it('shows the loader from the start of the first open, the follow included', async () => {
      const state = freshState()
      const loadingAtFollow = []
      const noteLoading = async () => { loadingAtFollow.push(state.collectionsLoading) }
      DBCollectionHandlers.upsertSource.mockImplementationOnce(noteLoading).mockImplementationOnce(noteLoading)

      await collections.actions.openCollections(contextFor(state))

      expect(loadingAtFollow).toEqual([true, true])
      expect(state.collectionsLoading).toBe(false)
    })

    it('marks loaded the source as it is when the load ends, not as it was when it began', async () => {
      const state = freshState()
      fetchHackerTubeBundle.mockImplementationOnce(async () => {
        collections.mutations.upsertCollectionSource(state, { ...state.collectionSources.hackertube, name: 'Renamed elsewhere' })
        return BUNDLE
      })

      await collections.actions.openCollections(contextFor(state))

      const [last] = DBCollectionHandlers.upsertSource.mock.calls.at(-1)
      expect(last).toMatchObject({ name: 'Renamed elsewhere', dataGenerated: '2026-10-31' })
    })

    it('does not load it again on a later open, or a later start', async () => {
      const state = freshState()
      await collections.actions.openCollections(contextFor(state))
      vi.clearAllMocks()

      await collections.actions.openCollections(contextFor(state))

      expect(fetchHackerTubeBundle).not.toHaveBeenCalled()
      expect(DBCollectionHandlers.putShares).not.toHaveBeenCalled()
      expect(DBCollectionHandlers.upsertSource).not.toHaveBeenCalled()
    })

    it('loads it once when two pages open at the same time', async () => {
      const state = freshState()
      const context = contextFor(state)

      await Promise.all([collections.actions.openCollections(context), collections.actions.openCollections(context)])

      expect(fetchHackerTubeBundle).toHaveBeenCalledTimes(1)
      expect(DBCollectionHandlers.putShares).toHaveBeenCalledTimes(1)
    })

    it('loads it again when HackerTube is followed but its shares are not there, as after a restore', async () => {
      const state = freshState()
      state.collectionSources.hackertube = { _id: 'hackertube', kind: 'hackertube', followedAt: 1, dataGenerated: '2026-10-31' }

      await collections.actions.openCollections(contextFor(state))

      expect(DBCollectionHandlers.putShares).toHaveBeenCalledTimes(1)
      expect(state.collectionSources.hackertube.followedAt).toBe(1)
    })

    it('loads it again when the shares were written but never marked loaded', async () => {
      const state = freshState()
      state.collectionSources.hackertube = { _id: 'hackertube', kind: 'hackertube', followedAt: 1, dataGenerated: null }
      state.collectionShares['hackertube|aaaaaaaaaaa'] = { _id: 'hackertube|aaaaaaaaaaa', sourceId: 'hackertube', videoId: 'aaaaaaaaaaa' }

      await collections.actions.openCollections(contextFor(state))

      expect(DBCollectionHandlers.putShares).toHaveBeenCalledTimes(1)
    })

    it('puts again only the shares of the bundle that are not already kept as it has them', async () => {
      const state = freshState()
      const [kept] = BUNDLE.videos.map(video => hackerTubeShare(video, 1))
      state.collectionSources.hackertube = { _id: 'hackertube', kind: 'hackertube', followedAt: 1, dataGenerated: null }
      state.collectionShares[kept._id] = kept

      await collections.actions.openCollections(contextFor(state))

      expect(DBCollectionHandlers.putShares.mock.calls[0][0].map(share => share._id)).toEqual(['hackertube|bbbbbbbbbbb'])
      expect(state.collectionSources.hackertube.dataGenerated).toBe('2026-10-31')
    })

    it('does not put the bundle over a newer export a refresh brought in while it was loading', async () => {
      const state = freshState()
      state.collectionSources.hackertube = { _id: 'hackertube', kind: 'hackertube', followedAt: 1, dataGenerated: null }
      fetchHackerTubeBundle.mockImplementationOnce(async () => {
        // As a refresh would, from an open whose bundle load had failed
        collections.mutations.upsertCollectionSource(state, { ...state.collectionSources.hackertube, dataGenerated: '2026-11-07' })
        collections.mutations.putCollectionShares(state, [{ _id: 'hackertube|aaaaaaaaaaa', sourceId: 'hackertube', videoId: 'aaaaaaaaaaa', votes: 30 }])
        return BUNDLE
      })

      await collections.actions.openCollections(contextFor(state))

      expect(DBCollectionHandlers.putShares).not.toHaveBeenCalled()
      expect(DBCollectionHandlers.upsertSource).not.toHaveBeenCalled()
      expect(state.collectionSources.hackertube.dataGenerated).toBe('2026-11-07')
      expect(state.collectionShares['hackertube|aaaaaaaaaaa'].votes).toBe(30)
      expect(state.collectionsLoading).toBe(false)
      expect(state.collectionsLoadFailed).toBe(false)
    })

    it('keeps what it has and says so when the bundle cannot be read, and tries again next time', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      fetchHackerTubeBundle.mockRejectedValueOnce(new Error('gone'))
      const state = freshState()

      await collections.actions.openCollections(contextFor(state))

      expect(state.collectionsLoadFailed).toBe(true)
      expect(state.collectionsLoading).toBe(false)
      expect(state.collectionSources.hackertube.dataGenerated).toBeNull()

      await collections.actions.openCollections(contextFor(state))

      expect(state.collectionsLoadFailed).toBe(false)
      expect(state.collectionSources.hackertube.dataGenerated).toBe('2026-10-31')
    })
  })

  describe('refreshing', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('asks HackerTube only for its manifest when its export is the one loaded, and marks it refreshed', async () => {
      const state = await loadedState()
      const fetch = stubHackerTube({ generated: '2026-10-31' })

      await collections.actions.refreshCollections(contextFor(state))

      expect(pathsAsked(fetch)).toEqual(['/api/export'])
      expect(DBCollectionHandlers.putShares).not.toHaveBeenCalled()
      expect(DBCollectionHandlers.putSourceData).not.toHaveBeenCalled()
      expect(state.collectionSources.hackertube).toMatchObject({ dataGenerated: '2026-10-31', checkedAt: NOW, failedAt: null })
      expect(state.collectionSources.hackertube).not.toHaveProperty('taxonomy')
      expect(collections.getters.getCollectionsLastRefreshAt(state)).toBe(NOW)
    })

    it('loads a newer export: new videos become shares, changed ones are updated, and nothing is removed', async () => {
      const state = await loadedState()
      const [a, b] = BUNDLE.videos
      const fetch = stubHackerTube({
        generated: '2026-11-07',
        rows: [
          { ...a, score: 26, why_hn: 'a better why', categories: ['x', 'z'] },
          { vid: 'ccccccccccc', title: 'C', channel: 'Cc', why_hn: 'new', categories: ['x'], score: 9, hn: { recommenders: 2, first_year: 2026, last_year: 2026 }, quote: null },
        ],
      })

      await collections.actions.refreshCollections(contextFor(state))

      expect(pathsAsked(fetch)).toEqual(['/api/export', '/download/videos.jsonl', '/download/taxonomy.json'])
      const [put] = DBCollectionHandlers.putShares.mock.calls[0]
      expect(put.map(share => share._id)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|ccccccccccc'])
      expect(state.collectionShares['hackertube|aaaaaaaaaaa']).toMatchObject({ votes: 26, why: 'a better why', categories: ['x', 'z'] })
      expect(state.collectionShares['hackertube|ccccccccccc']).toMatchObject({ votes: 9, title: 'C' })
      // Not in the new export, and kept as it was
      expect(state.collectionShares[`hackertube|${b.vid}`]).toMatchObject({ votes: 3 })
      expect(state.collectionSources.hackertube).toMatchObject({ dataGenerated: '2026-11-07', checkedAt: NOW, failedAt: null })
      expect(state.collectionSourceData.hackertube).toMatchObject({ generated: '2026-11-07', taxonomy: { version: 'v2' } })
    })

    it('puts only the shares whose numbers changed when a newer export gives the same videos again', async () => {
      const state = await loadedState()
      const [a, b] = BUNDLE.videos
      stubHackerTube({ generated: '2026-11-07', rows: [{ ...a }, { ...b, score: 4, hn: { ...b.hn, last_year: 2025 } }] })

      await collections.actions.refreshCollections(contextFor(state))

      expect(DBCollectionHandlers.putShares).toHaveBeenCalledTimes(1)
      expect(DBCollectionHandlers.putShares.mock.calls[0][0].map(share => share._id)).toEqual(['hackertube|bbbbbbbbbbb'])
      expect(state.collectionShares['hackertube|bbbbbbbbbbb']).toMatchObject({ votes: 4, sharedAt: Date.UTC(2025, 0, 1) })
    })

    it('keeps what is loaded and marks HackerTube failed when hackertube.org cannot be reached', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const state = await loadedState()
      const before = { ...state.collectionShares }
      stubHackerTube({ down: true })

      await collections.actions.refreshCollections(contextFor(state))

      expect(DBCollectionHandlers.putShares).not.toHaveBeenCalled()
      expect(state.collectionShares).toEqual(before)
      expect(state.collectionSources.hackertube).toMatchObject({ dataGenerated: '2026-10-31', attemptedAt: NOW, failedAt: NOW })
      // Never refreshed successfully, so the widget has no age to give
      expect(state.collectionSources.hackertube.checkedAt).toBeUndefined()
      expect(collections.getters.getCollectionsLastRefreshAt(state)).toBe(null)
      expect(collections.getters.getCollectionsRefreshFailures(state).map(source => source._id)).toEqual(['hackertube'])
      expect(state.collectionsRefreshing).toBe(false)
    })

    it('keeps what is loaded when hackertube.org answers with something it cannot read', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const state = await loadedState()
      vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>maintenance</html>')))

      await collections.actions.refreshCollections(contextFor(state))

      expect(DBCollectionHandlers.putShares).not.toHaveBeenCalled()
      expect(state.collectionSources.hackertube).toMatchObject({ dataGenerated: '2026-10-31', failedAt: NOW })
    })

    it('sends main a source it can copy, from state Vue has made reactive, as the store\'s is', async () => {
      const state = reactive(freshState())
      await collections.actions.openCollections(contextFor(state))
      vi.clearAllMocks()
      // What the IPC does to a source on its way to main
      DBCollectionHandlers.upsertSource.mockImplementation(async (source) => { structuredClone(source) })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      stubHackerTube({ generated: '2026-10-31' })

      await collections.actions.refreshCollections(contextFor(state))

      expect(console.warn).not.toHaveBeenCalled()
      expect(state.collectionSources.hackertube).toMatchObject({ checkedAt: NOW, failedAt: null })
    })

    it('keeps when HackerTube last refreshed when a later refresh fails, and does not ask again on open within the hour', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const state = await loadedState()
      stubHackerTube()
      await collections.actions.refreshCollections(contextFor(state))
      const worked = state.collectionSources.hackertube.checkedAt
      Date.now.mockReturnValue(NOW + 2 * 60 * 60_000)

      const down = stubHackerTube({ down: true })
      await collections.actions.refreshCollections(contextFor(state))

      expect(state.collectionSources.hackertube).toMatchObject({ checkedAt: worked, attemptedAt: NOW + 2 * 60 * 60_000, failedAt: NOW + 2 * 60 * 60_000 })
      expect(collections.getters.getCollectionsLastRefreshAt(state)).toBe(worked)

      await collections.actions.refreshCollectionsIfDue(contextFor(state))
      expect(down).toHaveBeenCalledTimes(1)
    })

    it('does not refresh on open with nothing followed', async () => {
      const state = freshState()
      const dispatched = []
      const context = contextFor(state)
      context.dispatch = (type, payload) => {
        dispatched.push(type)
        return collections.actions[type](context, payload)
      }

      await collections.actions.refreshCollectionsIfDue(context)

      expect(dispatched).toEqual([])
    })

    it('stops saying the videos could not be loaded once a refresh brings HackerTube\'s export', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      fetchHackerTubeBundle.mockRejectedValueOnce(new Error('gone'))
      const state = freshState()
      await collections.actions.openCollections(contextFor(state))
      expect(state.collectionsLoadFailed).toBe(true)
      stubHackerTube({ generated: '2026-10-31' })

      await collections.actions.refreshCollections(contextFor(state))

      expect(state.collectionSources.hackertube.dataGenerated).toBe('2026-10-31')
      expect(shareIds(state)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|bbbbbbbbbbb'])
      expect(state.collectionsLoadFailed).toBe(false)
    })

    it('still says the videos could not be loaded when the refresh failed too', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      fetchHackerTubeBundle.mockRejectedValueOnce(new Error('gone'))
      const state = freshState()
      await collections.actions.openCollections(contextFor(state))
      stubHackerTube({ down: true })

      await collections.actions.refreshCollections(contextFor(state))

      expect(state.collectionsLoadFailed).toBe(true)
    })

    it('stops saying it failed once a refresh works', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const state = await loadedState()
      stubHackerTube({ down: true })
      await collections.actions.refreshCollections(contextFor(state))

      stubHackerTube()
      await collections.actions.refreshCollections(contextFor(state))

      expect(collections.getters.getCollectionsRefreshFailures(state)).toEqual([])
    })

    it('says it is refreshing while it is, and how far it has got', async () => {
      const state = await loadedState()
      const seen = []
      vi.stubGlobal('fetch', vi.fn(async () => {
        seen.push({ refreshing: state.collectionsRefreshing, progress: { ...state.collectionsRefreshProgress } })
        return new Response(JSON.stringify({ generated: '2026-10-31' }))
      }))

      await collections.actions.refreshCollections(contextFor(state))

      expect(seen).toEqual([{ refreshing: true, progress: { done: 0, total: 1 } }])
      expect(state.collectionsRefreshing).toBe(false)
      expect(state.collectionsRefreshProgress).toEqual({ done: 1, total: 1 })
    })

    it('runs once when asked twice at the same time', async () => {
      const state = await loadedState()
      const fetch = stubHackerTube()
      const context = contextFor(state)

      await Promise.all([collections.actions.refreshCollections(context), collections.actions.refreshCollections(context)])

      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('does nothing over a datastore it could not read', async () => {
      const state = await loadedState()
      state.collectionsGrabFailed = true
      const fetch = stubHackerTube()

      await collections.actions.refreshCollections(contextFor(state))
      await collections.actions.refreshCollectionsIfDue(contextFor(state))

      expect(fetch).not.toHaveBeenCalled()
    })

    it('refreshes on open when it never has, or last did more than an hour ago', async () => {
      const state = await loadedState()
      const fetch = stubHackerTube()

      await collections.actions.refreshCollectionsIfDue(contextFor(state))
      expect(fetch).toHaveBeenCalledTimes(1)

      state.collectionSources.hackertube = { ...state.collectionSources.hackertube, attemptedAt: NOW - 61 * 60_000 }
      await collections.actions.refreshCollectionsIfDue(contextFor(state))
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('does not refresh on open when the last refresh was within the hour, as one kept from before a restart', async () => {
      const state = await loadedState()
      state.collectionSources.hackertube = { ...state.collectionSources.hackertube, checkedAt: NOW - 5 * 60 * 60_000, attemptedAt: NOW - 59 * 60_000 }
      const fetch = stubHackerTube()

      await collections.actions.refreshCollectionsIfDue(contextFor(state))

      expect(fetch).not.toHaveBeenCalled()
    })

    it('waits for a first open under way before it refreshes, so the bundle is in first', async () => {
      const state = freshState()
      const fetch = stubHackerTube()
      const context = contextFor(state)

      const opened = collections.actions.openCollections(context)
      await collections.actions.refreshCollections(context)
      await opened

      expect(fetchHackerTubeBundle).toHaveBeenCalledTimes(1)
      expect(pathsAsked(fetch)).toEqual(['/api/export'])
      expect(state.collectionSources.hackertube).toMatchObject({ dataGenerated: '2026-10-31', checkedAt: NOW })
    })
  })

  describe('another window\'s writes', () => {
    it('takes a followed source and new shares, and keeps the shares it had', () => {
      const state = freshState()
      state.collectionShares['x|aaaaaaaaaaa'] = { _id: 'x|aaaaaaaaaaa', sourceId: 'x', videoId: 'aaaaaaaaaaa', votes: 1 }

      collections.mutations.applyCollectionsSync(state, { event: SyncEvents.COLLECTIONS.UPSERT_SOURCE, data: { _id: 'x', kind: 'lemmy' } })
      collections.mutations.applyCollectionsSync(state, {
        event: SyncEvents.COLLECTIONS.PUT_SHARES,
        data: [{ _id: 'x|aaaaaaaaaaa', sourceId: 'x', videoId: 'aaaaaaaaaaa', votes: 7 }, { _id: 'x|bbbbbbbbbbb', sourceId: 'x', videoId: 'bbbbbbbbbbb', votes: 2 }],
      })

      expect(state.collectionSources.x.kind).toBe('lemmy')
      expect(shareIds(state)).toEqual(['x|aaaaaaaaaaa', 'x|bbbbbbbbbbb'])
      expect(state.collectionShares['x|aaaaaaaaaaa'].votes).toBe(7)
    })
  })

  describe('a Lemmy community', () => {
    const MEALTIME = lemmySource({ name: 'mealtimevideos', host: 'lemmy.cafe' }, NOW)

    // Its first post (15 points) made a post of HackerTube's first video
    const FEED = mealtimeTopWeek.replaceAll('neGgUavFT0w', 'aaaaaaaaaaa')

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    /**
     * hackertube.org, with its export the one loaded, and lemmy.cafe, with
     * the feed given for each sort, or down
     *
     * @param {{ feed?: string | null }} [options] null for an instance serving no feed
     */
    function stubBoth({ feed = FEED } = {}) {
      const fetch = vi.fn(async (url) => {
        const { origin, pathname } = new URL(url)
        if (origin === 'https://hackertube.org' && pathname === '/api/export') {
          return new Response(JSON.stringify({ generated: '2026-10-31' }))
        }
        if (origin === 'https://lemmy.cafe' && pathname === '/feeds/c/mealtimevideos.xml' && feed !== null) {
          return new Response(feed)
        }
        return new Response('not found', { status: 404 })
      })

      vi.stubGlobal('fetch', fetch)
      return fetch
    }

    /** As after the first open, with the community followed too */
    async function followedState() {
      const state = freshState()
      starterSources.mockReturnValueOnce([MEALTIME])
      await collections.actions.openCollections(contextFor(state))
      vi.clearAllMocks()
      return state
    }

    it('is followed on the first open with HackerTube, and not again on a later open', async () => {
      const state = await followedState()

      expect(collections.getters.getCollectionSources(state).map(source => source._id)).toEqual(['hackertube', 'lemmy:mealtimevideos@lemmy.cafe'])
      expect(state.collectionSources[MEALTIME._id]).toEqual(MEALTIME)

      starterSources.mockReturnValueOnce([MEALTIME])
      await collections.actions.openCollections(contextFor(state))

      expect(DBCollectionHandlers.upsertSource).not.toHaveBeenCalled()
    })

    it('is not followed over itself when it is already followed', async () => {
      const state = freshState()
      state.collectionSources[MEALTIME._id] = { ...MEALTIME, followedAt: 1, checkedAt: 2 }
      starterSources.mockReturnValueOnce([MEALTIME])

      await collections.actions.openCollections(contextFor(state))

      expect(state.collectionSources[MEALTIME._id]).toMatchObject({ followedAt: 1, checkedAt: 2 })
      expect(DBCollectionHandlers.upsertSource.mock.calls.map(([source]) => source._id)).not.toContain(MEALTIME._id)
    })

    it('has its YouTube posts made its shares on a refresh, and a video HackerTube shares too is one card with both', async () => {
      const state = await followedState()
      const fetch = stubBoth()

      await collections.actions.refreshCollections(contextFor(state))

      expect(fetch.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([
        'https://lemmy.cafe/feeds/c/mealtimevideos.xml?sort=New&limit=50',
        'https://lemmy.cafe/feeds/c/mealtimevideos.xml?sort=TopWeek&limit=50',
      ]))
      expect(state.collectionShares['lemmy:mealtimevideos@lemmy.cafe|aaaaaaaaaaa']).toMatchObject({ votes: 15, discussionUrl: 'https://lemmy.cafe/post/42041782' })
      expect(state.collectionShares['lemmy:mealtimevideos@lemmy.cafe|dTXl4RQimbY']).toMatchObject({ votes: 8, title: expect.stringMatching(/^Looking at the architecture of Alhambra/) })
      expect(state.collectionSources[MEALTIME._id]).toMatchObject({ checkedAt: NOW, failedAt: null })

      const wall = wallVideos(collections.getters.getCollectionShares(state))
      const both = wall.filter(video => video.videoId === 'aaaaaaaaaaa')
      expect(both).toHaveLength(1)
      expect(both[0].collection).toMatchObject({ votes: 25 + 15, sourceIds: ['hackertube', MEALTIME._id] })
      expect(wall.map(video => video.videoId).sort()).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'dTXl4RQimbY'])
    })

    it('keeps its shares when a later feed no longer lists them, and updates the votes of one it lists again', async () => {
      const state = await followedState()
      stubBoth()
      await collections.actions.refreshCollections(contextFor(state))
      DBCollectionHandlers.putShares.mockClear()

      // A week on: the first post has left both feeds, the second has 9 points
      const later = FEED
        .replace(/<item><title>Guardrails[\s\S]*?<\/item>/, '')
        .replace('8 points |', '9 points |')
      expect(later).not.toContain('aaaaaaaaaaa')
      stubBoth({ feed: later })
      await collections.actions.refreshCollections(contextFor(state))

      expect(state.collectionShares['lemmy:mealtimevideos@lemmy.cafe|aaaaaaaaaaa']).toMatchObject({ votes: 15 })
      expect(state.collectionShares['lemmy:mealtimevideos@lemmy.cafe|dTXl4RQimbY']).toMatchObject({ votes: 9 })
      expect(DBCollectionHandlers.putShares.mock.calls.flatMap(([shares]) => shares.map(share => share._id))).toEqual(['lemmy:mealtimevideos@lemmy.cafe|dTXl4RQimbY'])
    })

    it('keeps a share\'s votes and why when a later feed lists its post with a header that cannot be read', async () => {
      const state = await followedState()
      stubBoth()
      await collections.actions.refreshCollections(contextFor(state))
      DBCollectionHandlers.putShares.mockClear()

      stubBoth({ feed: FEED.replace('8 points |', '8 votes |') })
      await collections.actions.refreshCollections(contextFor(state))

      expect(state.collectionShares['lemmy:mealtimevideos@lemmy.cafe|dTXl4RQimbY']).toMatchObject({ votes: 8, why: 'I recently stumbled across this channel and like a lot of what he does.' })
      expect(DBCollectionHandlers.putShares).not.toHaveBeenCalled()
    })

    it('keeps every share and is marked failed when no header in its feed can be read, as after Lemmy rewords it', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const state = await followedState()
      stubBoth()
      await collections.actions.refreshCollections(contextFor(state))
      const before = { ...state.collectionShares }
      DBCollectionHandlers.putShares.mockClear()
      Date.now.mockReturnValue(NOW + 2 * 60 * 60_000)

      stubBoth({ feed: FEED.replaceAll(/(\d+) points \|/g, '$1 votes |') })
      await collections.actions.refreshCollections(contextFor(state))

      expect(DBCollectionHandlers.putShares).not.toHaveBeenCalled()
      expect(state.collectionShares).toEqual(before)
      expect(state.collectionSources[MEALTIME._id]).toMatchObject({ failedAt: NOW + 2 * 60 * 60_000 })
    })

    it('keeps its shares and is marked failed when its feed cannot be had, and HackerTube\'s refresh still works', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const state = await followedState()
      stubBoth()
      await collections.actions.refreshCollections(contextFor(state))
      const before = { ...state.collectionShares }
      Date.now.mockReturnValue(NOW + 2 * 60 * 60_000)

      stubBoth({ feed: null })
      await collections.actions.refreshCollections(contextFor(state))

      expect(state.collectionShares).toEqual(before)
      expect(state.collectionSources[MEALTIME._id]).toMatchObject({ checkedAt: NOW, failedAt: NOW + 2 * 60 * 60_000 })
      expect(state.collectionSources.hackertube).toMatchObject({ checkedAt: NOW + 2 * 60 * 60_000, failedAt: null })
      expect(collections.getters.getCollectionsRefreshFailures(state).map(source => source._id)).toEqual([MEALTIME._id])
    })
  })

  describe('following a source by its URL', () => {
    const MEALTIME = lemmySource({ name: 'mealtimevideos', host: 'lemmy.cafe' }, NOW)

    beforeEach(() => {
      // HackerTube alone on the first open, whatever an earlier test left queued
      starterSources.mockReset()
      starterSources.mockReturnValue([])
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    /**
     * lemmy.cafe, serving mealtimevideos' feed for each sort, and slrpnk.net,
     * serving no feed at all, as on 2026-11-01
     */
    function stubInstances() {
      const fetch = vi.fn(async (url) => {
        const { host, pathname } = new URL(url)
        if (host === 'lemmy.cafe' && pathname === '/feeds/c/mealtimevideos.xml') {
          return new Response(mealtimeTopWeek)
        }
        return new Response('not found', { status: 404 })
      })

      vi.stubGlobal('fetch', fetch)
      return fetch
    }

    it('follows a community, and keeps its videos as its shares at once from the feed it was tried with', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const state = await loadedState()
      const fetch = stubInstances()

      const followed = await collections.actions.followCollectionSourceByUrl(contextFor(state), 'https://lemmy.cafe/c/mealtimevideos')

      expect(followed).toEqual({ outcome: 'followed', source: MEALTIME })
      expect(state.collectionSources[MEALTIME._id]).toMatchObject({ ...MEALTIME, checkedAt: NOW, attemptedAt: NOW, failedAt: null })
      expect(DBCollectionHandlers.upsertSource.mock.calls[0][0]).toEqual(MEALTIME)
      expect(Object.keys(state.collectionShares).filter(id => id.startsWith(MEALTIME._id)).sort()).toEqual([
        'lemmy:mealtimevideos@lemmy.cafe|dTXl4RQimbY',
        'lemmy:mealtimevideos@lemmy.cafe|neGgUavFT0w',
      ])
      // Asked once, by the trial: the shares are what it fetched
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('follows a community seen through another instance at its home instance', async () => {
      const state = await loadedState()
      const fetch = stubInstances()

      const followed = await collections.actions.followCollectionSourceByUrl(contextFor(state), 'https://lemmy.world/c/mealtimevideos@lemmy.cafe')

      expect(followed.outcome).toBe('followed')
      expect(Object.keys(state.collectionSources).sort()).toEqual(['hackertube', MEALTIME._id])
      expect(state.collectionSources[MEALTIME._id].url).toBe('https://lemmy.cafe/c/mealtimevideos')
      expect(fetch.mock.calls.every(([url]) => new URL(url).host === 'lemmy.cafe')).toBe(true)
    })

    it('follows nothing when the instance serves no feed, and says so', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const state = await loadedState()
      stubInstances()

      const followed = await collections.actions.followCollectionSourceByUrl(contextFor(state), 'https://slrpnk.net/c/solarpunk')

      expect(followed.outcome).toBe('no-feed')
      expect(followed.source.name).toBe('solarpunk@slrpnk.net')
      expect(Object.keys(state.collectionSources)).toEqual(['hackertube'])
      expect(DBCollectionHandlers.upsertSource).not.toHaveBeenCalled()
      expect(DBCollectionHandlers.putShares).not.toHaveBeenCalled()
    })

    it('follows nothing for a URL no source kind recognises', async () => {
      const state = await loadedState()
      const fetch = stubInstances()

      expect(await collections.actions.followCollectionSourceByUrl(contextFor(state), 'https://example.com/videos')).toEqual({ outcome: 'unrecognised' })
      expect(fetch).not.toHaveBeenCalled()
      expect(DBCollectionHandlers.upsertSource).not.toHaveBeenCalled()
    })

    it('leaves a source followed already as it is', async () => {
      const state = await loadedState()
      state.collectionSources[MEALTIME._id] = Object.freeze({ ...MEALTIME, followedAt: 1, checkedAt: 2 })
      const fetch = stubInstances()

      const followed = await collections.actions.followCollectionSourceByUrl(contextFor(state), '!mealtimevideos@lemmy.cafe')

      expect(followed.outcome).toBe('followed-already')
      expect(state.collectionSources[MEALTIME._id]).toMatchObject({ followedAt: 1, checkedAt: 2 })
      expect(fetch).not.toHaveBeenCalled()
      expect(DBCollectionHandlers.upsertSource).not.toHaveBeenCalled()
    })

    it('follows HackerTube again without asking it, and loads its videos from the bundle', async () => {
      const state = await loadedState()
      await collections.actions.unfollowCollectionSource(contextFor(state), 'hackertube')
      const fetch = stubInstances()

      const followed = await collections.actions.followCollectionSourceByUrl(contextFor(state), 'https://hackertube.org')

      expect(followed.outcome).toBe('followed')
      expect(fetch).not.toHaveBeenCalled()
      expect(fetchHackerTubeBundle).toHaveBeenCalledOnce()
      expect(shareIds(state)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|bbbbbbbbbbb'])
      expect(state.collectionSources.hackertube).toMatchObject({ dataGenerated: '2026-10-31' })
    })

    it('stays followed, marked failed, when what it was tried with cannot be kept', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const state = await loadedState()
      stubInstances()
      DBCollectionHandlers.putShares.mockRejectedValueOnce(new Error('locked'))

      const followed = await collections.actions.followCollectionSourceByUrl(contextFor(state), 'https://lemmy.cafe/c/mealtimevideos')

      expect(followed.outcome).toBe('followed')
      expect(state.collectionSources[MEALTIME._id]).toMatchObject({ attemptedAt: NOW, failedAt: NOW })
      expect(state.collectionSources[MEALTIME._id]).not.toHaveProperty('checkedAt')
    })
  })

  describe('unfollowing a source', () => {
    const MEALTIME = lemmySource({ name: 'mealtimevideos', host: 'lemmy.cafe' }, NOW)

    beforeEach(() => {
      starterSources.mockReset()
      starterSources.mockReturnValue([])
    })

    /** HackerTube loaded, and the community with a share of a video HackerTube shares too */
    async function bothState() {
      const state = await loadedState()
      state.collectionSources[MEALTIME._id] = Object.freeze({ ...MEALTIME })
      state.collectionShares[`${MEALTIME._id}|aaaaaaaaaaa`] = Object.freeze({ _id: `${MEALTIME._id}|aaaaaaaaaaa`, sourceId: MEALTIME._id, videoId: 'aaaaaaaaaaa', votes: 3 })
      state.collectionVideos.aaaaaaaaaaa = Object.freeze({ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 1 })
      return state
    }

    it('removes it, its shares and its own data, through the datastore, and leaves the rest', async () => {
      const state = await bothState()

      await collections.actions.unfollowCollectionSource(contextFor(state), 'hackertube')

      expect(DBCollectionHandlers.removeSource).toHaveBeenCalledWith('hackertube')
      expect(Object.keys(state.collectionSources)).toEqual([MEALTIME._id])
      expect(shareIds(state)).toEqual([`${MEALTIME._id}|aaaaaaaaaaa`])
      expect(collections.getters.getCollectionSourceData(state)('hackertube')).toBeUndefined()
      // Details belong to the video, which another source still shares
      expect(state.collectionVideos.aaaaaaaaaaa).toBeDefined()
    })

    it('keeps everything when the datastore cannot remove it', async () => {
      const state = await bothState()
      DBCollectionHandlers.removeSource.mockRejectedValueOnce(new Error('locked'))

      await expect(collections.actions.unfollowCollectionSource(contextFor(state), MEALTIME._id)).rejects.toThrow('locked')

      expect(Object.keys(state.collectionSources).sort()).toEqual(['hackertube', MEALTIME._id])
      expect(shareIds(state)).toHaveLength(3)
    })

    it('does not bring its shares back when a refresh under way answers for it afterwards', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const state = await bothState()
      const context = contextFor(state)
      // Its two feeds, held until it has been unfollowed
      const answers = []
      vi.stubGlobal('fetch', vi.fn((url) => {
        if (new URL(url).host === 'lemmy.cafe') {
          return new Promise((resolve) => { answers.push(() => resolve(new Response(mealtimeTopWeek))) })
        }
        return Promise.resolve(new Response(JSON.stringify({ generated: '2026-10-31' })))
      }))

      try {
        const refresh = collections.actions.refreshCollections(context)
        await vi.waitFor(() => expect(answers).toHaveLength(2))

        await collections.actions.unfollowCollectionSource(context, MEALTIME._id)
        answers.forEach(answer => answer())
        await refresh

        expect(Object.keys(state.collectionSources)).toEqual(['hackertube'])
        expect(shareIds(state)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|bbbbbbbbbbb'])
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('follows another window\'s unfollow, also while the datastore is being read', async () => {
      const state = await bothState()

      collections.mutations.applyCollectionsSync(state, { event: SyncEvents.COLLECTIONS.REMOVE_SOURCE, data: MEALTIME._id })

      expect(Object.keys(state.collectionSources)).toEqual(['hackertube'])
      expect(shareIds(state)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|bbbbbbbbbbb'])

      const reading = freshState()
      DBCollectionHandlers.findSources.mockResolvedValueOnce([{ _id: 'hackertube' }, { ...MEALTIME }])
      DBCollectionHandlers.findShares.mockImplementationOnce(async () => {
        collections.mutations.applyCollectionsSync(reading, { event: SyncEvents.COLLECTIONS.REMOVE_SOURCE, data: MEALTIME._id })
        return [{ _id: `${MEALTIME._id}|aaaaaaaaaaa`, sourceId: MEALTIME._id, videoId: 'aaaaaaaaaaa' }]
      })

      await collections.actions.grabCollections(contextFor(reading))

      expect(Object.keys(reading.collectionSources)).toEqual(['hackertube'])
      expect(shareIds(reading)).toEqual([])
    })
  })
})
