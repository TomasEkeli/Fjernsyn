import { reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DBCollectionHandlers } from '../../../datastores/handlers/index'
import { fetchHackerTubeBundle } from '../../helpers/collections/hackertubeBundle'
import { hackerTubeShare } from '../../helpers/collections/hackertube'
import { SyncEvents } from '../../../constants'
import collections from './collections'

vi.mock('../../../datastores/handlers/index', () => ({
  DBCollectionHandlers: {
    findSources: vi.fn(async () => []),
    findShares: vi.fn(async () => []),
    upsertSource: vi.fn(async () => {}),
    putShares: vi.fn(async () => ({ added: 0, updated: 0 })),
    findVideos: vi.fn(async () => []),
    putVideos: vi.fn(async () => {}),
  },
}))

vi.mock('../../helpers/collections/hackertubeBundle', () => ({
  fetchHackerTubeBundle: vi.fn(),
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
  return { collectionSources: {}, collectionShares: {}, collectionVideos: {}, collectionsReady: false, collectionsGrabFailed: false, collectionsSyncBuffer: null, collectionsLoading: false, collectionsLoadFailed: false, collectionsRefreshing: false, collectionsRefreshProgress: { done: 0, total: 0 } }
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
      expect(state.collectionSources.hackertube).toMatchObject({ kind: 'hackertube', followedAt: NOW, dataGenerated: '2026-10-31', taxonomy: { version: 'v', areas: [] } })
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
      expect(state.collectionSources.hackertube).toMatchObject({ dataGenerated: '2026-10-31', checkedAt: NOW, failedAt: null })
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
      expect(state.collectionSources.hackertube).toMatchObject({
        dataGenerated: '2026-11-07',
        taxonomy: { version: 'v2' },
        checkedAt: NOW,
        failedAt: null,
      })
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
      expect(state.collectionSources.hackertube).toMatchObject({ checkedAt: NOW, failedAt: null, taxonomy: { version: 'v' } })
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
})
