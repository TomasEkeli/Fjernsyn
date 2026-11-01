import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DBCollectionHandlers } from '../../../datastores/handlers/index'
import { fetchHackerTubeBundle } from '../../helpers/collections/hackertubeBundle'
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
  return { collectionSources: {}, collectionShares: {}, collectionVideos: {}, collectionsReady: false, collectionsGrabFailed: false, collectionsSyncBuffer: null, collectionsLoading: false, collectionsLoadFailed: false }
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
