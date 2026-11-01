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
  return { collectionSources: {}, collectionShares: {}, collectionsReady: false, collectionsLoading: false, collectionsLoadFailed: false }
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

  it('is ready even when the datastore cannot be read, with nothing in it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    DBCollectionHandlers.findShares.mockRejectedValueOnce(new Error('locked'))
    const state = freshState()

    await collections.actions.grabCollections(contextFor(state))

    expect(state.collectionsReady).toBe(true)
    expect(shareIds(state)).toEqual([])
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
