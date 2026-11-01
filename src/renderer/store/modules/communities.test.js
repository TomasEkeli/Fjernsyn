import { reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DBCommunityHandlers } from '../../../datastores/handlers/index'
import { fetchHackerTubeBundle } from '../../helpers/communities/hackertubeBundle'
import { hackerTubeShare, hackerTubeSource } from '../../helpers/communities/hackertube'
import { lemmySource } from '../../helpers/communities/kinds/lemmy'
import { opmlFeedUrls, sourcesOpml } from '../../helpers/communities/opml'
import { wallVideos } from '../../helpers/communities/shares'
import { starterSources } from '../../helpers/communities/starterSet'
import { SyncEvents } from '../../../constants'
import communities from './communities'

// A real feed of lemmy.cafe's mealtimevideos, trimmed to two posts
import mealtimeTopWeek from '../../helpers/communities/kinds/fixtures/lemmy.cafe--mealtimevideos-topweek.xml?raw'

vi.mock('../../../datastores/handlers/index', () => ({
  DBCommunityHandlers: {
    findSources: vi.fn(async () => []),
    findShares: vi.fn(async () => []),
    upsertSource: vi.fn(async () => {}),
    updateSource: vi.fn(async () => ({ updated: 1 })),
    putShares: vi.fn(async () => ({ added: 0, updated: 0 })),
    findVideos: vi.fn(async () => []),
    putVideos: vi.fn(async () => {}),
    findSourceData: vi.fn(async () => []),
    putSourceData: vi.fn(async () => {}),
    removeSource: vi.fn(async () => ({ shares: 0 })),
  },
}))

// The platform layer, which confirms PeerTube links while PeerTube is on
const fakeLayer = vi.hoisted(() => ({ resolveUrl: vi.fn(), getVideoSummary: vi.fn() }))
vi.mock('../../platform/vue', () => ({ getPlatformLayer: () => fakeLayer }))

vi.mock('../../helpers/communities/hackertubeBundle', () => ({
  fetchHackerTubeBundle: vi.fn(),
}))

// The starter set is HackerTube alone, but where a test follows more
vi.mock('../../helpers/communities/starterSet', async (importOriginal) => {
  const actual = await importOriginal()
  const { hackerTubeSource } = await import('../../helpers/communities/hackertube')
  return { ...actual, starterSources: vi.fn(now => [hackerTubeSource(now)]) }
})

/** @param {number} now */
const onlyHackerTube = now => [hackerTubeSource(now)]

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

/** As once the datastore has been read at startup, empty */
function freshState() {
  return { communitySources: {}, communityShares: {}, communityVideos: {}, communitiesReady: true, communitiesGrabFailed: false, communitiesSyncBuffer: null, communitiesLoading: false, communitiesLoadFailed: false, communitiesRefreshing: false, communitiesRefreshProgress: { done: 0, total: 0 }, communitySourceData: {} }
}

/**
 * The settings module's part, one per state, as one installation has one:
 * whether the starter set has been applied, and which sources' chips are off
 *
 * @type {WeakMap<object, { communitiesStarterSetDone: boolean, communitiesSourcesHidden: string[] }>}
 */
const settingsOf = new WeakMap()

/** @param {object} state */
function settingsFor(state) {
  if (!settingsOf.has(state)) {
    settingsOf.set(state, { communitiesStarterSetDone: false, communitiesSourcesHidden: [] })
  }
  return settingsOf.get(state)
}

/** The settings module's updater, which a test may make fail */
const updateStarterSetDone = vi.fn(async (settings, value) => { settings.communitiesStarterSetDone = value })

/** Likewise, for the sources whose chips are off */
const updateSourcesHidden = vi.fn(async (settings, value) => { settings.communitiesSourcesHidden = value })

/** The settings module's updaters, by action */
const SETTINGS_UPDATERS = {
  updateCommunitiesStarterSetDone: updateStarterSetDone,
  updateCommunitiesSourcesHidden: updateSourcesHidden,
}

function contextFor(state) {
  const settings = settingsFor(state)
  const context = {
    state,
    getters: {},
    rootGetters: {
      get getCommunitiesStarterSetDone() { return settings.communitiesStarterSetDone },
      get getCommunitiesSourcesHidden() { return settings.communitiesSourcesHidden },
    },
    commit: (type, payload) => communities.mutations[type](state, payload),
    dispatch: (type, payload) => Object.hasOwn(SETTINGS_UPDATERS, type)
      ? SETTINGS_UPDATERS[type](settings, payload)
      : communities.actions[type](context, payload),
  }
  return context
}

const shareIds = state => Object.keys(state.communityShares).sort()

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
  await communities.actions.openCommunities(contextFor(state))
  vi.clearAllMocks()
  return state
}

describe('the Communities store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    fetchHackerTubeBundle.mockResolvedValue(BUNDLE)
  })

  it('loads the sources and shares the datastore holds', async () => {
    DBCommunityHandlers.findSources.mockResolvedValueOnce([{ _id: 'hackertube', kind: 'hackertube', dataGenerated: '2026-10-31' }])
    DBCommunityHandlers.findShares.mockResolvedValueOnce([{ _id: 'hackertube|aaaaaaaaaaa', sourceId: 'hackertube', videoId: 'aaaaaaaaaaa' }])
    const state = freshState()

    await communities.actions.grabCommunities(contextFor(state))

    expect(state.communitiesReady).toBe(true)
    expect(communities.getters.getCommunitySources(state).map(source => source._id)).toEqual(['hackertube'])
    expect(shareIds(state)).toEqual(['hackertube|aaaaaaaaaaa'])
  })

  it('gives one share by its id, and nothing for one not held', async () => {
    DBCommunityHandlers.findShares.mockResolvedValueOnce([{ _id: 'hackertube|aaaaaaaaaaa', sourceId: 'hackertube', videoId: 'aaaaaaaaaaa', votes: 22.5 }])
    const state = freshState()

    await communities.actions.grabCommunities(contextFor(state))

    expect(communities.getters.getCommunityShare(state)('hackertube|aaaaaaaaaaa')).toMatchObject({ votes: 22.5 })
    expect(communities.getters.getCommunityShare(state)('hackertube|bbbbbbbbbbb')).toBeUndefined()
  })

  it('loads the videos\' details the datastore holds, by the video\'s ref', async () => {
    DBCommunityHandlers.findVideos.mockResolvedValueOnce([{ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 1, lengthSeconds: 60 }])
    const state = freshState()

    await communities.actions.grabCommunities(contextFor(state))

    expect(communities.getters.getCommunityVideos(state)).toEqual({ aaaaaaaaaaa: { _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 1, lengthSeconds: 60 } })
    expect(Object.isFrozen(state.communityVideos.aaaaaaaaaaa)).toBe(true)
  })

  it('loads each source\'s own data the datastore holds, by source', async () => {
    DBCommunityHandlers.findSourceData.mockResolvedValueOnce([{ _id: 'hackertube', generated: '2026-10-31', taxonomy: { version: 'v', areas: [] } }])
    const state = freshState()

    await communities.actions.grabCommunities(contextFor(state))

    expect(communities.getters.getCommunitySourceData(state)('hackertube')).toEqual({ _id: 'hackertube', generated: '2026-10-31', taxonomy: { version: 'v', areas: [] } })
  })

  it('takes another window\'s source data', () => {
    const state = freshState()

    communities.mutations.applyCommunitiesSync(state, { event: SyncEvents.COMMUNITIES.PUT_SOURCE_DATA, data: { _id: 'hackertube', generated: 'g', taxonomy: { areas: [] } } })

    expect(state.communitySourceData.hackertube.generated).toBe('g')
  })

  it('says the read failed when the details cannot be read, so the crawl does not take every video for missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    DBCommunityHandlers.findVideos.mockRejectedValueOnce(new Error('locked'))
    const state = freshState()

    await communities.actions.grabCommunities(contextFor(state))

    expect(communities.getters.getCommunitiesGrabFailed(state)).toBe(true)
  })

  it('keeps a video\'s details through the datastore, replacing what it held', async () => {
    const state = freshState()
    state.communityVideos.aaaaaaaaaaa = Object.freeze({ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 1, viewCount: 5 })
    const record = { _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 2, unavailable: 'gone' }

    await communities.actions.putCommunityVideos(contextFor(state), [record])

    expect(DBCommunityHandlers.putVideos).toHaveBeenCalledWith([record])
    expect(state.communityVideos.aaaaaaaaaaa).toEqual(record)
  })

  it('adds details to the map it holds rather than copying thousands of records for each one', () => {
    const state = freshState()
    const held = state.communityVideos

    communities.mutations.putCommunityVideos(state, [{ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 1 }])

    expect(state.communityVideos).toBe(held)
    expect(Object.isFrozen(held.aaaaaaaaaaa)).toBe(true)
  })

  it('takes another window\'s details', () => {
    const state = freshState()
    const record = { _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 2, lengthSeconds: 9 }

    communities.mutations.applyCommunitiesSync(state, { event: SyncEvents.COMMUNITIES.PUT_VIDEOS, data: [record] })

    expect(state.communityVideos.aaaaaaaaaaa).toEqual(record)
  })

  it('is ready when the datastore cannot be read, and says the read failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    DBCommunityHandlers.findShares.mockRejectedValueOnce(new Error('locked'))
    const state = freshState()

    await communities.actions.grabCommunities(contextFor(state))

    expect(state.communitiesReady).toBe(true)
    expect(state.communitiesGrabFailed).toBe(true)
    expect(shareIds(state)).toEqual([])
  })

  it('does not follow HackerTube or load the bundle over a datastore it could not read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // The read at startup, and the read again on open
    DBCommunityHandlers.findShares.mockRejectedValueOnce(new Error('locked')).mockRejectedValueOnce(new Error('locked'))
    const state = freshState()
    const context = contextFor(state)
    await communities.actions.grabCommunities(context)

    await communities.actions.openCommunities(context)

    expect(DBCommunityHandlers.upsertSource).not.toHaveBeenCalled()
    expect(DBCommunityHandlers.putShares).not.toHaveBeenCalled()
    expect(fetchHackerTubeBundle).not.toHaveBeenCalled()
    expect(state.communitiesLoadFailed).toBe(true)
    expect(state.communitiesLoading).toBe(false)
  })

  it('reads the datastore again on open after a failed read, and goes no further when HackerTube is loaded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    DBCommunityHandlers.findShares.mockRejectedValueOnce(new Error('locked'))
    const state = freshState()
    const context = contextFor(state)
    await communities.actions.grabCommunities(context)

    DBCommunityHandlers.findSources.mockResolvedValueOnce([{ _id: 'hackertube', kind: 'hackertube', followedAt: 1, dataGenerated: '2026-10-31' }])
    DBCommunityHandlers.findShares.mockResolvedValueOnce([{ _id: 'hackertube|aaaaaaaaaaa', sourceId: 'hackertube', videoId: 'aaaaaaaaaaa' }])
    await communities.actions.openCommunities(context)

    expect(state.communitiesGrabFailed).toBe(false)
    expect(state.communitiesLoadFailed).toBe(false)
    expect(DBCommunityHandlers.upsertSource).not.toHaveBeenCalled()
    expect(fetchHackerTubeBundle).not.toHaveBeenCalled()
  })

  it('keeps another window\'s writes that arrive while the datastore is being read', async () => {
    const state = freshState()
    DBCommunityHandlers.findSources.mockResolvedValueOnce([{ _id: 'x', kind: 'lemmy', name: 'Old' }])
    DBCommunityHandlers.findShares.mockImplementationOnce(async () => {
      communities.mutations.applyCommunitiesSync(state, { event: SyncEvents.COMMUNITIES.UPSERT_SOURCE, data: { _id: 'x', kind: 'lemmy', name: 'New' } })
      communities.mutations.applyCommunitiesSync(state, { event: SyncEvents.COMMUNITIES.PUT_SHARES, data: [{ _id: 'x|aaaaaaaaaaa', sourceId: 'x', videoId: 'aaaaaaaaaaa', votes: 7 }] })
      return [{ _id: 'x|aaaaaaaaaaa', sourceId: 'x', videoId: 'aaaaaaaaaaa', votes: 1 }, { _id: 'x|bbbbbbbbbbb', sourceId: 'x', videoId: 'bbbbbbbbbbb', votes: 2 }]
    })

    await communities.actions.grabCommunities(contextFor(state))

    expect(state.communitySources.x.name).toBe('New')
    expect(shareIds(state)).toEqual(['x|aaaaaaaaaaa', 'x|bbbbbbbbbbb'])
    expect(state.communityShares['x|aaaaaaaaaaa'].votes).toBe(7)
    expect(state.communitiesSyncBuffer).toBeNull()
  })

  it('applies another window\'s writes at once when no read is under way', () => {
    const state = freshState()

    communities.mutations.applyCommunitiesSync(state, { event: SyncEvents.COMMUNITIES.UPSERT_SOURCE, data: { _id: 'x', kind: 'lemmy' } })

    expect(state.communitySources.x.kind).toBe('lemmy')
  })

  describe('opening Communities the first time', () => {
    it('follows HackerTube and loads the bundle into the datastore as its shares', async () => {
      const state = freshState()

      await communities.actions.openCommunities(contextFor(state))

      expect(DBCommunityHandlers.putShares).toHaveBeenCalledTimes(1)
      const [shares] = DBCommunityHandlers.putShares.mock.calls[0]
      expect(shares.map(share => share._id)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|bbbbbbbbbbb'])
      expect(shares[0]).toMatchObject({ sourceId: 'hackertube', votes: 25, why: 'why a', seenAt: NOW })

      expect(shareIds(state)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|bbbbbbbbbbb'])
      expect(state.communitySources.hackertube).toMatchObject({ kind: 'hackertube', followedAt: NOW, dataGenerated: '2026-10-31' })
      // The taxonomy apart from the source's record, which is written on every refresh
      expect(state.communitySources.hackertube).not.toHaveProperty('taxonomy')
      expect(DBCommunityHandlers.putSourceData).toHaveBeenCalledWith({ _id: 'hackertube', generated: '2026-10-31', taxonomy: { version: 'v', areas: [] } })
      expect(communities.getters.getCommunitySourceData(state)('hackertube')).toMatchObject({ generated: '2026-10-31', taxonomy: { version: 'v' } })
      // Followed first, then marked loaded once the shares are written
      expect(DBCommunityHandlers.upsertSource.mock.calls.map(([source]) => source.dataGenerated)).toEqual([null])
      // Marked loaded by an update, which would not follow it again had it been unfollowed meanwhile
      expect(DBCommunityHandlers.updateSource.mock.calls.map(([source]) => source.dataGenerated)).toEqual(['2026-10-31'])
    })

    it('shows the loader from the start of the first open, the follow included', async () => {
      const state = freshState()
      const loadingAtFollow = []
      const noteLoading = async () => { loadingAtFollow.push(state.communitiesLoading) }
      DBCommunityHandlers.upsertSource.mockImplementationOnce(noteLoading)
      DBCommunityHandlers.updateSource.mockImplementationOnce(async () => { await noteLoading(); return { updated: 1 } })

      await communities.actions.openCommunities(contextFor(state))

      expect(loadingAtFollow).toEqual([true, true])
      expect(state.communitiesLoading).toBe(false)
    })

    it('marks loaded the source as it is when the load ends, not as it was when it began', async () => {
      const state = freshState()
      fetchHackerTubeBundle.mockImplementationOnce(async () => {
        communities.mutations.upsertCommunitySource(state, { ...state.communitySources.hackertube, name: 'Renamed elsewhere' })
        return BUNDLE
      })

      await communities.actions.openCommunities(contextFor(state))

      const [last] = DBCommunityHandlers.updateSource.mock.calls.at(-1)
      expect(last).toMatchObject({ name: 'Renamed elsewhere', dataGenerated: '2026-10-31' })
    })

    it('does not load it again on a later open, or a later start', async () => {
      const state = freshState()
      await communities.actions.openCommunities(contextFor(state))
      vi.clearAllMocks()

      await communities.actions.openCommunities(contextFor(state))

      expect(fetchHackerTubeBundle).not.toHaveBeenCalled()
      expect(DBCommunityHandlers.putShares).not.toHaveBeenCalled()
      expect(DBCommunityHandlers.upsertSource).not.toHaveBeenCalled()
    })

    it('loads it once when two pages open at the same time', async () => {
      const state = freshState()
      const context = contextFor(state)

      await Promise.all([communities.actions.openCommunities(context), communities.actions.openCommunities(context)])

      expect(fetchHackerTubeBundle).toHaveBeenCalledTimes(1)
      expect(DBCommunityHandlers.putShares).toHaveBeenCalledTimes(1)
    })

    it('loads it again when HackerTube is followed but its shares are not there, as after a restore', async () => {
      const state = freshState()
      state.communitySources.hackertube = { _id: 'hackertube', kind: 'hackertube', followedAt: 1, dataGenerated: '2026-10-31' }

      await communities.actions.openCommunities(contextFor(state))

      expect(DBCommunityHandlers.putShares).toHaveBeenCalledTimes(1)
      expect(state.communitySources.hackertube.followedAt).toBe(1)
    })

    it('loads it again when the shares were written but never marked loaded', async () => {
      const state = freshState()
      state.communitySources.hackertube = { _id: 'hackertube', kind: 'hackertube', followedAt: 1, dataGenerated: null }
      state.communityShares['hackertube|aaaaaaaaaaa'] = { _id: 'hackertube|aaaaaaaaaaa', sourceId: 'hackertube', videoId: 'aaaaaaaaaaa' }

      await communities.actions.openCommunities(contextFor(state))

      expect(DBCommunityHandlers.putShares).toHaveBeenCalledTimes(1)
    })

    it('puts again only the shares of the bundle that are not already kept as it has them', async () => {
      const state = freshState()
      const [kept] = BUNDLE.videos.map(video => hackerTubeShare(video, 1))
      state.communitySources.hackertube = { _id: 'hackertube', kind: 'hackertube', followedAt: 1, dataGenerated: null }
      state.communityShares[kept._id] = kept

      await communities.actions.openCommunities(contextFor(state))

      expect(DBCommunityHandlers.putShares.mock.calls[0][0].map(share => share._id)).toEqual(['hackertube|bbbbbbbbbbb'])
      expect(state.communitySources.hackertube.dataGenerated).toBe('2026-10-31')
    })

    it('does not put the bundle over a newer export a refresh brought in while it was loading', async () => {
      const state = freshState()
      state.communitySources.hackertube = { _id: 'hackertube', kind: 'hackertube', followedAt: 1, dataGenerated: null }
      fetchHackerTubeBundle.mockImplementationOnce(async () => {
        // As a refresh would, from an open whose bundle load had failed
        communities.mutations.upsertCommunitySource(state, { ...state.communitySources.hackertube, dataGenerated: '2026-11-07' })
        communities.mutations.putCommunityShares(state, [{ _id: 'hackertube|aaaaaaaaaaa', sourceId: 'hackertube', videoId: 'aaaaaaaaaaa', votes: 30 }])
        return BUNDLE
      })

      await communities.actions.openCommunities(contextFor(state))

      expect(DBCommunityHandlers.putShares).not.toHaveBeenCalled()
      expect(DBCommunityHandlers.upsertSource).not.toHaveBeenCalled()
      expect(state.communitySources.hackertube.dataGenerated).toBe('2026-11-07')
      expect(state.communityShares['hackertube|aaaaaaaaaaa'].votes).toBe(30)
      expect(state.communitiesLoading).toBe(false)
      expect(state.communitiesLoadFailed).toBe(false)
    })

    it('keeps what it has and says so when the bundle cannot be read, and tries again next time', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      fetchHackerTubeBundle.mockRejectedValueOnce(new Error('gone'))
      const state = freshState()

      await communities.actions.openCommunities(contextFor(state))

      expect(state.communitiesLoadFailed).toBe(true)
      expect(state.communitiesLoading).toBe(false)
      expect(state.communitySources.hackertube.dataGenerated).toBeNull()

      await communities.actions.openCommunities(contextFor(state))

      expect(state.communitiesLoadFailed).toBe(false)
      expect(state.communitySources.hackertube.dataGenerated).toBe('2026-10-31')
    })
  })

  describe('the starter set', () => {
    const MEALTIME = lemmySource({ name: 'mealtimevideos', host: 'lemmy.cafe' }, NOW)
    const TALKS = lemmySource({ name: 'talks', host: 'programming.dev' }, NOW)
    const STARTERS = [hackerTubeSource(NOW), MEALTIME, TALKS]

    beforeEach(() => {
      starterSources.mockReset()
      starterSources.mockImplementation(() => STARTERS)
    })

    afterEach(() => {
      starterSources.mockReset()
      starterSources.mockImplementation(onlyHackerTube)
    })

    const followed = () => DBCommunityHandlers.upsertSource.mock.calls.map(([source]) => source._id)

    it('is followed whole on the first open of a fresh installation, and then marked applied', async () => {
      const state = freshState()
      const order = []
      DBCommunityHandlers.upsertSource.mockImplementation(async (source) => { order.push(source._id) })
      updateStarterSetDone.mockImplementationOnce(async (settings, value) => { order.push('marked'); settings.communitiesStarterSetDone = value })

      await communities.actions.openCommunities(contextFor(state))

      expect(Object.keys(state.communitySources).sort()).toEqual(['hackertube', MEALTIME._id, TALKS._id].sort())
      // Marked only once every one is followed, so a follow that fails is tried again
      expect(order).toEqual(['hackertube', MEALTIME._id, TALKS._id, 'marked'])
      expect(settingsFor(state).communitiesStarterSetDone).toBe(true)
      // HackerTube's videos from the bundle, the communities' left to the refresh
      expect(shareIds(state)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|bbbbbbbbbbb'])
      DBCommunityHandlers.upsertSource.mockImplementation(async () => {})
    })

    it('adds the rest, once, to an installation that followed some of it before the set, and nothing twice', async () => {
      // HackerTube alone, as an installation from before the starter set, and a community followed since
      starterSources.mockImplementationOnce(onlyHackerTube)
      const state = await loadedState()
      settingsFor(state).communitiesStarterSetDone = false
      state.communitySources[MEALTIME._id] = Object.freeze({ ...MEALTIME, followedAt: 1, checkedAt: 2 })

      await communities.actions.openCommunities(contextFor(state))

      expect(followed()).toEqual([TALKS._id])
      expect(state.communitySources.hackertube.dataGenerated).toBe('2026-10-31')
      expect(state.communitySources[MEALTIME._id]).toMatchObject({ followedAt: 1, checkedAt: 2 })
      expect(fetchHackerTubeBundle).not.toHaveBeenCalled()
      expect(settingsFor(state).communitiesStarterSetDone).toBe(true)

      vi.clearAllMocks()
      await communities.actions.openCommunities(contextFor(state))
      expect(followed()).toEqual([])
    })

    it('follows nothing once it has been applied, though none of it is followed', async () => {
      const state = freshState()
      settingsFor(state).communitiesStarterSetDone = true

      await communities.actions.openCommunities(contextFor(state))

      expect(state.communitySources).toEqual({})
      expect(DBCommunityHandlers.upsertSource).not.toHaveBeenCalled()
      expect(updateStarterSetDone).not.toHaveBeenCalled()
      // HackerTube not followed: no bundle to load, and nothing failed
      expect(fetchHackerTubeBundle).not.toHaveBeenCalled()
      expect(state.communitiesLoadFailed).toBe(false)
      expect(state.communitiesLoading).toBe(false)
    })

    it('does not follow again a starter source unfollowed, HackerTube included, on a later open', async () => {
      const state = freshState()
      await communities.actions.openCommunities(contextFor(state))
      await communities.actions.unfollowCommunitySource(contextFor(state), MEALTIME._id)
      await communities.actions.unfollowCommunitySource(contextFor(state), 'hackertube')
      vi.clearAllMocks()

      await communities.actions.openCommunities(contextFor(state))

      expect(Object.keys(state.communitySources)).toEqual([TALKS._id])
      expect(DBCommunityHandlers.upsertSource).not.toHaveBeenCalled()
      expect(fetchHackerTubeBundle).not.toHaveBeenCalled()
    })

    it('is not marked applied when a follow fails, and the next open follows the rest', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const state = freshState()
      DBCommunityHandlers.upsertSource.mockImplementation(async (source) => {
        if (source._id === MEALTIME._id) { throw new Error('locked') }
      })

      await communities.actions.openCommunities(contextFor(state))

      expect(settingsFor(state).communitiesStarterSetDone).toBe(false)
      expect(Object.keys(state.communitySources)).toEqual(['hackertube'])
      // HackerTube's videos are loaded all the same
      expect(state.communitySources.hackertube.dataGenerated).toBe('2026-10-31')

      DBCommunityHandlers.upsertSource.mockImplementation(async () => {})
      vi.clearAllMocks()
      await communities.actions.openCommunities(contextFor(state))

      expect(followed()).toEqual([MEALTIME._id, TALKS._id])
      expect(settingsFor(state).communitiesStarterSetDone).toBe(true)
    })

    it('loads HackerTube all the same when the mark cannot be written, and the next open follows nothing twice', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const state = freshState()
      const locked = new Error('locked')
      updateStarterSetDone.mockRejectedValueOnce(locked)

      await communities.actions.openCommunities(contextFor(state))

      // Told apart from a follow that failed
      expect(logged).toHaveBeenCalledWith('Communities: followed the starter set, but could not mark it done', locked)
      expect(state.communitiesLoadFailed).toBe(false)
      expect(state.communitySources.hackertube.dataGenerated).toBe('2026-10-31')

      vi.clearAllMocks()
      await communities.actions.openCommunities(contextFor(state))

      expect(followed()).toEqual([])
      expect(settingsFor(state).communitiesStarterSetDone).toBe(true)
    })

    it('follows each one once when two pages apply it at the same time, however slow the datastore', async () => {
      const state = freshState()
      const context = contextFor(state)
      // Each follow held in main for a while, so both would ask before either is held
      DBCommunityHandlers.upsertSource.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 5)))

      await Promise.all([
        communities.actions.applyCommunitiesStarterSet(context),
        communities.actions.applyCommunitiesStarterSet(context),
      ])

      expect(followed()).toEqual(['hackertube', MEALTIME._id, TALKS._id])
      expect(updateStarterSetDone).toHaveBeenCalledOnce()
      DBCommunityHandlers.upsertSource.mockImplementation(async () => {})
    })

    it('does not follow over one another window followed while the set was being followed', async () => {
      const state = freshState()
      const elsewhere = Object.freeze({ ...MEALTIME, followedAt: 1, checkedAt: 2 })
      DBCommunityHandlers.upsertSource.mockImplementationOnce(async () => {
        // While HackerTube is being followed here
        communities.mutations.applyCommunitiesSync(state, { event: SyncEvents.COMMUNITIES.UPSERT_SOURCE, data: elsewhere })
      })

      await communities.actions.applyCommunitiesStarterSet(contextFor(state))

      expect(followed()).toEqual(['hackertube', TALKS._id])
      expect(state.communitySources[MEALTIME._id]).toMatchObject({ followedAt: 1, checkedAt: 2 })
      expect(settingsFor(state).communitiesStarterSetDone).toBe(true)
    })

    it('is not applied before the datastore is read, or over one that could not be', async () => {
      for (const fields of [{ communitiesReady: false }, { communitiesGrabFailed: true }]) {
        const state = { ...freshState(), ...fields }

        await communities.actions.applyCommunitiesStarterSet(contextFor(state))

        expect(state.communitySources, JSON.stringify(fields)).toEqual({})
        expect(settingsFor(state).communitiesStarterSetDone).toBe(false)
      }

      expect(DBCommunityHandlers.upsertSource).not.toHaveBeenCalled()
    })
  })

  describe('refreshing', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('asks HackerTube only for its manifest when its export is the one loaded, and marks it refreshed', async () => {
      const state = await loadedState()
      const fetch = stubHackerTube({ generated: '2026-10-31' })

      await communities.actions.refreshCommunities(contextFor(state))

      expect(pathsAsked(fetch)).toEqual(['/api/export'])
      expect(DBCommunityHandlers.putShares).not.toHaveBeenCalled()
      expect(DBCommunityHandlers.putSourceData).not.toHaveBeenCalled()
      expect(state.communitySources.hackertube).toMatchObject({ dataGenerated: '2026-10-31', checkedAt: NOW, failedAt: null })
      expect(state.communitySources.hackertube).not.toHaveProperty('taxonomy')
      expect(communities.getters.getCommunitiesLastRefreshAt(state)).toBe(NOW)
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

      await communities.actions.refreshCommunities(contextFor(state))

      expect(pathsAsked(fetch)).toEqual(['/api/export', '/download/videos.jsonl', '/download/taxonomy.json'])
      const [put] = DBCommunityHandlers.putShares.mock.calls[0]
      expect(put.map(share => share._id)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|ccccccccccc'])
      expect(state.communityShares['hackertube|aaaaaaaaaaa']).toMatchObject({ votes: 26, why: 'a better why', categories: ['x', 'z'] })
      expect(state.communityShares['hackertube|ccccccccccc']).toMatchObject({ votes: 9, title: 'C' })
      // Not in the new export, and kept as it was
      expect(state.communityShares[`hackertube|${b.vid}`]).toMatchObject({ votes: 3 })
      expect(state.communitySources.hackertube).toMatchObject({ dataGenerated: '2026-11-07', checkedAt: NOW, failedAt: null })
      expect(state.communitySourceData.hackertube).toMatchObject({ generated: '2026-11-07', taxonomy: { version: 'v2' } })
    })

    it('puts only the shares whose numbers changed when a newer export gives the same videos again', async () => {
      const state = await loadedState()
      const [a, b] = BUNDLE.videos
      stubHackerTube({ generated: '2026-11-07', rows: [{ ...a }, { ...b, score: 4, hn: { ...b.hn, last_year: 2025 } }] })

      await communities.actions.refreshCommunities(contextFor(state))

      expect(DBCommunityHandlers.putShares).toHaveBeenCalledTimes(1)
      expect(DBCommunityHandlers.putShares.mock.calls[0][0].map(share => share._id)).toEqual(['hackertube|bbbbbbbbbbb'])
      expect(state.communityShares['hackertube|bbbbbbbbbbb']).toMatchObject({ votes: 4, sharedAt: Date.UTC(2025, 0, 1) })
    })

    it('keeps what is loaded and marks HackerTube failed when hackertube.org cannot be reached', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const state = await loadedState()
      const before = { ...state.communityShares }
      stubHackerTube({ down: true })

      await communities.actions.refreshCommunities(contextFor(state))

      expect(DBCommunityHandlers.putShares).not.toHaveBeenCalled()
      expect(state.communityShares).toEqual(before)
      expect(state.communitySources.hackertube).toMatchObject({ dataGenerated: '2026-10-31', attemptedAt: NOW, failedAt: NOW })
      // Never refreshed successfully, so the widget has no age to give
      expect(state.communitySources.hackertube.checkedAt).toBeUndefined()
      expect(communities.getters.getCommunitiesLastRefreshAt(state)).toBe(null)
      expect(communities.getters.getCommunitiesRefreshFailures(state).map(source => source._id)).toEqual(['hackertube'])
      expect(state.communitiesRefreshing).toBe(false)
    })

    it('keeps what is loaded when hackertube.org answers with something it cannot read', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const state = await loadedState()
      vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>maintenance</html>')))

      await communities.actions.refreshCommunities(contextFor(state))

      expect(DBCommunityHandlers.putShares).not.toHaveBeenCalled()
      expect(state.communitySources.hackertube).toMatchObject({ dataGenerated: '2026-10-31', failedAt: NOW })
    })

    it('sends main a source it can copy, from state Vue has made reactive, as the store\'s is', async () => {
      const state = reactive(freshState())
      await communities.actions.openCommunities(contextFor(state))
      vi.clearAllMocks()
      // What the IPC does to a source on its way to main
      DBCommunityHandlers.updateSource.mockImplementationOnce(async (source) => { structuredClone(source); return { updated: 1 } })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      stubHackerTube({ generated: '2026-10-31' })

      await communities.actions.refreshCommunities(contextFor(state))

      expect(console.warn).not.toHaveBeenCalled()
      expect(state.communitySources.hackertube).toMatchObject({ checkedAt: NOW, failedAt: null })
    })

    it('keeps when HackerTube last refreshed when a later refresh fails, and does not ask again on open within the hour', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const state = await loadedState()
      stubHackerTube()
      await communities.actions.refreshCommunities(contextFor(state))
      const worked = state.communitySources.hackertube.checkedAt
      Date.now.mockReturnValue(NOW + 2 * 60 * 60_000)

      const down = stubHackerTube({ down: true })
      await communities.actions.refreshCommunities(contextFor(state))

      expect(state.communitySources.hackertube).toMatchObject({ checkedAt: worked, attemptedAt: NOW + 2 * 60 * 60_000, failedAt: NOW + 2 * 60 * 60_000 })
      expect(communities.getters.getCommunitiesLastRefreshAt(state)).toBe(worked)

      await communities.actions.refreshCommunitiesIfDue(contextFor(state))
      expect(down).toHaveBeenCalledTimes(1)
    })

    it('does not refresh on open with nothing followed', async () => {
      const state = freshState()
      const dispatched = []
      const context = contextFor(state)
      context.dispatch = (type, payload) => {
        dispatched.push(type)
        return communities.actions[type](context, payload)
      }

      await communities.actions.refreshCommunitiesIfDue(context)

      expect(dispatched).toEqual([])
    })

    it('stops saying the videos could not be loaded once a refresh brings HackerTube\'s export', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      fetchHackerTubeBundle.mockRejectedValueOnce(new Error('gone'))
      const state = freshState()
      await communities.actions.openCommunities(contextFor(state))
      expect(state.communitiesLoadFailed).toBe(true)
      stubHackerTube({ generated: '2026-10-31' })

      await communities.actions.refreshCommunities(contextFor(state))

      expect(state.communitySources.hackertube.dataGenerated).toBe('2026-10-31')
      expect(shareIds(state)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|bbbbbbbbbbb'])
      expect(state.communitiesLoadFailed).toBe(false)
    })

    it('still says the videos could not be loaded when the refresh failed too', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      fetchHackerTubeBundle.mockRejectedValueOnce(new Error('gone'))
      const state = freshState()
      await communities.actions.openCommunities(contextFor(state))
      stubHackerTube({ down: true })

      await communities.actions.refreshCommunities(contextFor(state))

      expect(state.communitiesLoadFailed).toBe(true)
    })

    it('stops saying it failed once a refresh works', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const state = await loadedState()
      stubHackerTube({ down: true })
      await communities.actions.refreshCommunities(contextFor(state))

      stubHackerTube()
      await communities.actions.refreshCommunities(contextFor(state))

      expect(communities.getters.getCommunitiesRefreshFailures(state)).toEqual([])
    })

    it('says it is refreshing while it is, and how far it has got', async () => {
      const state = await loadedState()
      const seen = []
      vi.stubGlobal('fetch', vi.fn(async () => {
        seen.push({ refreshing: state.communitiesRefreshing, progress: { ...state.communitiesRefreshProgress } })
        return new Response(JSON.stringify({ generated: '2026-10-31' }))
      }))

      await communities.actions.refreshCommunities(contextFor(state))

      expect(seen).toEqual([{ refreshing: true, progress: { done: 0, total: 1 } }])
      expect(state.communitiesRefreshing).toBe(false)
      expect(state.communitiesRefreshProgress).toEqual({ done: 1, total: 1 })
    })

    it('runs once when asked twice at the same time', async () => {
      const state = await loadedState()
      const fetch = stubHackerTube()
      const context = contextFor(state)

      await Promise.all([communities.actions.refreshCommunities(context), communities.actions.refreshCommunities(context)])

      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('does nothing over a datastore it could not read', async () => {
      const state = await loadedState()
      state.communitiesGrabFailed = true
      const fetch = stubHackerTube()

      await communities.actions.refreshCommunities(contextFor(state))
      await communities.actions.refreshCommunitiesIfDue(contextFor(state))

      expect(fetch).not.toHaveBeenCalled()
    })

    it('refreshes on open when it never has, or last did more than an hour ago', async () => {
      const state = await loadedState()
      const fetch = stubHackerTube()

      await communities.actions.refreshCommunitiesIfDue(contextFor(state))
      expect(fetch).toHaveBeenCalledTimes(1)

      state.communitySources.hackertube = { ...state.communitySources.hackertube, attemptedAt: NOW - 61 * 60_000 }
      await communities.actions.refreshCommunitiesIfDue(contextFor(state))
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('does not refresh on open when the last refresh was within the hour, as one kept from before a restart', async () => {
      const state = await loadedState()
      state.communitySources.hackertube = { ...state.communitySources.hackertube, checkedAt: NOW - 5 * 60 * 60_000, attemptedAt: NOW - 59 * 60_000 }
      const fetch = stubHackerTube()

      await communities.actions.refreshCommunitiesIfDue(contextFor(state))

      expect(fetch).not.toHaveBeenCalled()
    })

    it('waits for a first open under way before it refreshes, so the bundle is in first', async () => {
      const state = freshState()
      const fetch = stubHackerTube()
      const context = contextFor(state)

      const opened = communities.actions.openCommunities(context)
      await communities.actions.refreshCommunities(context)
      await opened

      expect(fetchHackerTubeBundle).toHaveBeenCalledTimes(1)
      expect(pathsAsked(fetch)).toEqual(['/api/export'])
      expect(state.communitySources.hackertube).toMatchObject({ dataGenerated: '2026-10-31', checkedAt: NOW })
    })
  })

  describe('another window\'s writes', () => {
    it('takes a followed source and new shares, and keeps the shares it had', () => {
      const state = freshState()
      state.communityShares['x|aaaaaaaaaaa'] = { _id: 'x|aaaaaaaaaaa', sourceId: 'x', videoId: 'aaaaaaaaaaa', votes: 1 }

      communities.mutations.applyCommunitiesSync(state, { event: SyncEvents.COMMUNITIES.UPSERT_SOURCE, data: { _id: 'x', kind: 'lemmy' } })
      communities.mutations.applyCommunitiesSync(state, {
        event: SyncEvents.COMMUNITIES.PUT_SHARES,
        data: [{ _id: 'x|aaaaaaaaaaa', sourceId: 'x', videoId: 'aaaaaaaaaaa', votes: 7 }, { _id: 'x|bbbbbbbbbbb', sourceId: 'x', videoId: 'bbbbbbbbbbb', votes: 2 }],
      })

      expect(state.communitySources.x.kind).toBe('lemmy')
      expect(shareIds(state)).toEqual(['x|aaaaaaaaaaa', 'x|bbbbbbbbbbb'])
      expect(state.communityShares['x|aaaaaaaaaaa'].votes).toBe(7)
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
      starterSources.mockReturnValueOnce([hackerTubeSource(NOW), MEALTIME])
      await communities.actions.openCommunities(contextFor(state))
      vi.clearAllMocks()
      return state
    }

    it('is followed on the first open with HackerTube, and not again on a later open', async () => {
      const state = await followedState()

      expect(communities.getters.getCommunitySources(state).map(source => source._id)).toEqual(['hackertube', 'lemmy:mealtimevideos@lemmy.cafe'])
      expect(state.communitySources[MEALTIME._id]).toEqual(MEALTIME)

      starterSources.mockReturnValueOnce([hackerTubeSource(NOW), MEALTIME])
      await communities.actions.openCommunities(contextFor(state))

      expect(DBCommunityHandlers.upsertSource).not.toHaveBeenCalled()
      starterSources.mockReset()
      starterSources.mockImplementation(onlyHackerTube)
    })

    it('is not followed over itself when it is already followed', async () => {
      const state = freshState()
      state.communitySources[MEALTIME._id] = { ...MEALTIME, followedAt: 1, checkedAt: 2 }
      starterSources.mockReturnValueOnce([hackerTubeSource(NOW), MEALTIME])

      await communities.actions.openCommunities(contextFor(state))

      expect(state.communitySources[MEALTIME._id]).toMatchObject({ followedAt: 1, checkedAt: 2 })
      expect(DBCommunityHandlers.upsertSource.mock.calls.map(([source]) => source._id)).not.toContain(MEALTIME._id)
    })

    describe('linking a PeerTube video', () => {
      const UUID = '059ca8df-3049-44a3-93a9-d603327f2e74'
      const ORIGIN = 'peertube.v1.root42.de'
      // Its second post (8 points) made a post of a PeerTube video, linked on
      // an instance that is not its origin
      const PEERTUBE_FEED = FEED.replaceAll('https://www.youtube.com/watch?v=dTXl4RQimbY', 'https://fedi.video/w/1GcddTf1uzhyXscJ4ymdEG')

      beforeEach(() => {
        localStorage.clear()
        fakeLayer.resolveUrl.mockReset()
        fakeLayer.getVideoSummary.mockReset()
        fakeLayer.resolveUrl.mockImplementation(async url => ({ platform: 'peertube', kind: 'video', ref: { platform: 'peertube', host: new URL(url).hostname, videoId: UUID }, host: new URL(url).hostname, timestamp: null }))
        fakeLayer.getVideoSummary.mockImplementation(async () => ({
          type: 'video',
          platform: 'peertube',
          host: ORIGIN,
          videoId: UUID,
          title: 'Its own title',
          author: 'Its channel',
          authorId: `channel@${ORIGIN}`,
          lengthSeconds: 2719,
          viewCount: 10,
          published: 5,
          liveNow: false,
          isUpcoming: false,
          nsfw: false,
          thumbnail: `https://${ORIGIN}/t.jpg`,
        }))
      })

      /** @param {object} state */
      function withPeerTube(state, enabled) {
        const context = contextFor(state)
        context.rootGetters = { ...context.rootGetters, getEnablePeerTube: enabled }
        return context
      }

      it('makes it a share of the video at its origin, confirmed through the platform layer, its details kept at once, while PeerTube is on', async () => {
        const state = await followedState()
        stubBoth({ feed: PEERTUBE_FEED })

        await communities.actions.refreshCommunities(withPeerTube(state, true))

        expect(fakeLayer.resolveUrl).toHaveBeenCalledWith(`https://fedi.video/videos/watch/${UUID}`)
        expect(state.communityShares[`lemmy:mealtimevideos@lemmy.cafe|${UUID}@${ORIGIN}`]).toMatchObject({ videoId: UUID, platform: 'peertube', host: ORIGIN, votes: 8 })
        expect(state.communityVideos[`${UUID}@${ORIGIN}`]).toMatchObject({ platform: 'peertube', host: ORIGIN, lengthSeconds: 2719, authorId: `channel@${ORIGIN}`, thumbnail: `https://${ORIGIN}/t.jpg` })
        expect(DBCommunityHandlers.putVideos).toHaveBeenCalledTimes(1)

        const [video] = wallVideos(Object.values(state.communityShares), state.communityVideos).filter(video => video.platform === 'peertube')
        expect(video).toMatchObject({ videoId: UUID, host: ORIGIN, title: 'Its own title', lengthSeconds: 2719, thumbnail: `https://${ORIGIN}/t.jpg` })
      })

      it('asks nothing about it again on the next refresh, as the video is kept', async () => {
        const state = await followedState()
        stubBoth({ feed: PEERTUBE_FEED })
        await communities.actions.refreshCommunities(withPeerTube(state, true))
        fakeLayer.resolveUrl.mockClear()
        fakeLayer.getVideoSummary.mockClear()

        await communities.actions.refreshCommunities(withPeerTube(state, true))

        expect(fakeLayer.resolveUrl).not.toHaveBeenCalled()
        expect(fakeLayer.getVideoSummary).not.toHaveBeenCalled()
      })

      it('takes it for nothing, and asks nothing, while PeerTube is off', async () => {
        const state = await followedState()
        stubBoth({ feed: PEERTUBE_FEED })

        await communities.actions.refreshCommunities(withPeerTube(state, false))

        expect(fakeLayer.resolveUrl).not.toHaveBeenCalled()
        expect(Object.values(state.communityShares).some(share => share.platform === 'peertube')).toBe(false)
        expect(state.communitySources[MEALTIME._id]).toMatchObject({ checkedAt: NOW, failedAt: null })
      })
    })

    it('has its YouTube posts made its shares on a refresh, and a video HackerTube shares too is one card with both', async () => {
      const state = await followedState()
      const fetch = stubBoth()

      await communities.actions.refreshCommunities(contextFor(state))

      expect(fetch.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([
        'https://lemmy.cafe/feeds/c/mealtimevideos.xml?sort=New&limit=50',
        'https://lemmy.cafe/feeds/c/mealtimevideos.xml?sort=TopWeek&limit=50',
      ]))
      expect(state.communityShares['lemmy:mealtimevideos@lemmy.cafe|aaaaaaaaaaa']).toMatchObject({ votes: 15, discussionUrl: 'https://lemmy.cafe/post/42041782' })
      expect(state.communityShares['lemmy:mealtimevideos@lemmy.cafe|dTXl4RQimbY']).toMatchObject({ votes: 8, title: expect.stringMatching(/^Looking at the architecture of Alhambra/) })
      expect(state.communitySources[MEALTIME._id]).toMatchObject({ checkedAt: NOW, failedAt: null })

      const wall = wallVideos(communities.getters.getCommunityShares(state))
      const both = wall.filter(video => video.videoId === 'aaaaaaaaaaa')
      expect(both).toHaveLength(1)
      expect(both[0].community).toMatchObject({ votes: 25 + 15, sourceIds: ['hackertube', MEALTIME._id] })
      expect(wall.map(video => video.videoId).sort()).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'dTXl4RQimbY'])
    })

    it('keeps its shares when a later feed no longer lists them, and updates the votes of one it lists again', async () => {
      const state = await followedState()
      stubBoth()
      await communities.actions.refreshCommunities(contextFor(state))
      DBCommunityHandlers.putShares.mockClear()

      // A week on: the first post has left both feeds, the second has 9 points
      const later = FEED
        .replace(/<item><title>Guardrails[\s\S]*?<\/item>/, '')
        .replace('8 points |', '9 points |')
      expect(later).not.toContain('aaaaaaaaaaa')
      stubBoth({ feed: later })
      await communities.actions.refreshCommunities(contextFor(state))

      expect(state.communityShares['lemmy:mealtimevideos@lemmy.cafe|aaaaaaaaaaa']).toMatchObject({ votes: 15 })
      expect(state.communityShares['lemmy:mealtimevideos@lemmy.cafe|dTXl4RQimbY']).toMatchObject({ votes: 9 })
      expect(DBCommunityHandlers.putShares.mock.calls.flatMap(([shares]) => shares.map(share => share._id))).toEqual(['lemmy:mealtimevideos@lemmy.cafe|dTXl4RQimbY'])
    })

    it('keeps a share\'s votes and why when a later feed lists its post with a header that cannot be read', async () => {
      const state = await followedState()
      stubBoth()
      await communities.actions.refreshCommunities(contextFor(state))
      DBCommunityHandlers.putShares.mockClear()

      stubBoth({ feed: FEED.replace('8 points |', '8 votes |') })
      await communities.actions.refreshCommunities(contextFor(state))

      expect(state.communityShares['lemmy:mealtimevideos@lemmy.cafe|dTXl4RQimbY']).toMatchObject({ votes: 8, why: 'I recently stumbled across this channel and like a lot of what he does.' })
      expect(DBCommunityHandlers.putShares).not.toHaveBeenCalled()
    })

    it('keeps every share and is marked failed when no header in its feed can be read, as after Lemmy rewords it', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const state = await followedState()
      stubBoth()
      await communities.actions.refreshCommunities(contextFor(state))
      const before = { ...state.communityShares }
      DBCommunityHandlers.putShares.mockClear()
      Date.now.mockReturnValue(NOW + 2 * 60 * 60_000)

      stubBoth({ feed: FEED.replaceAll(/(\d+) points \|/g, '$1 votes |') })
      await communities.actions.refreshCommunities(contextFor(state))

      expect(DBCommunityHandlers.putShares).not.toHaveBeenCalled()
      expect(state.communityShares).toEqual(before)
      expect(state.communitySources[MEALTIME._id]).toMatchObject({ failedAt: NOW + 2 * 60 * 60_000 })
    })

    it('keeps its shares and is marked failed when its feed cannot be had, and HackerTube\'s refresh still works', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const state = await followedState()
      stubBoth()
      await communities.actions.refreshCommunities(contextFor(state))
      const before = { ...state.communityShares }
      Date.now.mockReturnValue(NOW + 2 * 60 * 60_000)

      stubBoth({ feed: null })
      await communities.actions.refreshCommunities(contextFor(state))

      expect(state.communityShares).toEqual(before)
      expect(state.communitySources[MEALTIME._id]).toMatchObject({ checkedAt: NOW, failedAt: NOW + 2 * 60 * 60_000 })
      expect(state.communitySources.hackertube).toMatchObject({ checkedAt: NOW + 2 * 60 * 60_000, failedAt: null })
      expect(communities.getters.getCommunitiesRefreshFailures(state).map(source => source._id)).toEqual([MEALTIME._id])
    })
  })

  describe('following a source by its URL', () => {
    const MEALTIME = lemmySource({ name: 'mealtimevideos', host: 'lemmy.cafe' }, NOW)

    beforeEach(() => {
      // HackerTube alone on the first open, whatever an earlier test left queued
      starterSources.mockReset()
      starterSources.mockImplementation(onlyHackerTube)
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

    describe('a community linking PeerTube videos', () => {
      const UUID = '059ca8df-3049-44a3-93a9-d603327f2e74'
      const ORIGIN = 'peertube.v1.root42.de'
      const FEED = mealtimeTopWeek.replaceAll('https://www.youtube.com/watch?v=dTXl4RQimbY', 'https://fedi.video/w/1GcddTf1uzhyXscJ4ymdEG')

      /** lemmy.cafe serving that feed, or failing once the trial has had it */
      function stubFeed({ failAfter = Infinity } = {}) {
        let served = 0
        const fetch = vi.fn(async (url) => {
          const { host, pathname } = new URL(url)
          if (host !== 'lemmy.cafe' || pathname !== '/feeds/c/mealtimevideos.xml') { return new Response('not found', { status: 404 }) }
          return ++served > failAfter ? new Response('down', { status: 503 }) : new Response(FEED)
        })
        vi.stubGlobal('fetch', fetch)
        return fetch
      }

      /** @param {object} state */
      function withPeerTube(state, enabled) {
        const context = contextFor(state)
        context.rootGetters = { ...context.rootGetters, getEnablePeerTube: enabled }
        return context
      }

      /** The layer, answering the video at its origin once `release` is called */
      function layerHeldBack() {
        let release
        const held = new Promise((resolve) => { release = resolve })
        fakeLayer.resolveUrl.mockReset()
        fakeLayer.getVideoSummary.mockReset()
        fakeLayer.resolveUrl.mockImplementation(async (url) => {
          await held
          return { platform: 'peertube', kind: 'video', ref: { platform: 'peertube', host: new URL(url).hostname, videoId: UUID }, host: new URL(url).hostname, timestamp: null }
        })
        fakeLayer.getVideoSummary.mockImplementation(async () => ({
          type: 'video', platform: 'peertube', host: ORIGIN, videoId: UUID, title: 'Own', author: 'C', authorId: `c@${ORIGIN}`, lengthSeconds: 60, liveNow: false, isUpcoming: false, nsfw: false, thumbnail: '',
        }))
        return () => release()
      }

      beforeEach(() => {
        localStorage.clear()
        vi.spyOn(console, 'warn').mockImplementation(() => {})
      })

      it('answers the follow from the trial alone, which confirms no PeerTube link, and then refreshes that source in the background, which does', async () => {
        const state = await loadedState()
        const fetch = stubFeed()
        const release = layerHeldBack()

        const followed = await communities.actions.followCommunitySourceByUrl(withPeerTube(state, true), 'https://lemmy.cafe/c/mealtimevideos')

        // Answered while the layer still has not: the PeerTube link waits for the background refresh
        expect(followed.outcome).toBe('followed')
        expect(Object.keys(state.communityShares).filter(id => id.startsWith(MEALTIME._id))).toEqual(['lemmy:mealtimevideos@lemmy.cafe|neGgUavFT0w'])

        release()

        await vi.waitFor(() => expect(state.communityShares[`${MEALTIME._id}|${UUID}@${ORIGIN}`]).toMatchObject({ platform: 'peertube', host: ORIGIN }))
        expect(state.communityVideos[`${UUID}@${ORIGIN}`]).toMatchObject({ lengthSeconds: 60 })
        // The trial's two feeds, then the refresh's two, of this source alone
        expect(fetch.mock.calls.map(([url]) => new URL(url).host)).toEqual(['lemmy.cafe', 'lemmy.cafe', 'lemmy.cafe', 'lemmy.cafe'])
        await vi.waitFor(() => expect(state.communitySources[MEALTIME._id]).toMatchObject({ failedAt: null }))
      })

      it('marks the source failed, as a refresh does, when the background refresh cannot have its feed', async () => {
        const state = await loadedState()
        stubFeed({ failAfter: 2 })
        layerHeldBack()()

        const followed = await communities.actions.followCommunitySourceByUrl(withPeerTube(state, true), 'https://lemmy.cafe/c/mealtimevideos')

        expect(followed.outcome).toBe('followed')
        await vi.waitFor(() => expect(state.communitySources[MEALTIME._id]).toMatchObject({ failedAt: NOW, attemptedAt: NOW }))
        expect(Object.keys(state.communityShares).filter(id => id.startsWith(MEALTIME._id))).toEqual(['lemmy:mealtimevideos@lemmy.cafe|neGgUavFT0w'])
      })

      it('asks nothing more while PeerTube is off, as there is nothing to confirm', async () => {
        const state = await loadedState()
        const fetch = stubFeed()
        layerHeldBack()()

        await communities.actions.followCommunitySourceByUrl(withPeerTube(state, false), 'https://lemmy.cafe/c/mealtimevideos')
        await new Promise(resolve => setTimeout(resolve, 10))

        expect(fetch).toHaveBeenCalledTimes(2)
        expect(fakeLayer.resolveUrl).not.toHaveBeenCalled()
      })
    })

    it('follows a community, and keeps its videos as its shares at once from the feed it was tried with', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const state = await loadedState()
      const fetch = stubInstances()

      const followed = await communities.actions.followCommunitySourceByUrl(contextFor(state), 'https://lemmy.cafe/c/mealtimevideos')

      expect(followed).toEqual({ outcome: 'followed', source: MEALTIME })
      expect(state.communitySources[MEALTIME._id]).toMatchObject({ ...MEALTIME, checkedAt: NOW, attemptedAt: NOW, failedAt: null })
      expect(DBCommunityHandlers.upsertSource.mock.calls[0][0]).toEqual(MEALTIME)
      expect(Object.keys(state.communityShares).filter(id => id.startsWith(MEALTIME._id)).sort()).toEqual([
        'lemmy:mealtimevideos@lemmy.cafe|dTXl4RQimbY',
        'lemmy:mealtimevideos@lemmy.cafe|neGgUavFT0w',
      ])
      // Asked once, by the trial: the shares are what it fetched
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('follows a community with its chip on, though it was unfollowed with its chip off', async () => {
      const state = await loadedState()
      stubInstances()
      settingsFor(state).communitiesSourcesHidden = ['hackertube', MEALTIME._id]

      await communities.actions.followCommunitySourceByUrl(contextFor(state), 'https://lemmy.cafe/c/mealtimevideos')

      expect(settingsFor(state).communitiesSourcesHidden).toEqual(['hackertube'])
    })

    it('writes no chip setting for a source whose chip was never off', async () => {
      const state = await loadedState()
      stubInstances()
      updateSourcesHidden.mockClear()

      await communities.actions.followCommunitySourceByUrl(contextFor(state), 'https://lemmy.cafe/c/mealtimevideos')

      expect(updateSourcesHidden).not.toHaveBeenCalled()
    })

    it('follows the source even when its chip cannot be turned on', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const state = await loadedState()
      stubInstances()
      settingsFor(state).communitiesSourcesHidden = [MEALTIME._id]
      updateSourcesHidden.mockRejectedValueOnce(new Error('settings.db is gone'))

      const followed = await communities.actions.followCommunitySourceByUrl(contextFor(state), 'https://lemmy.cafe/c/mealtimevideos')

      expect(followed.outcome).toBe('followed')
      expect(state.communitySources[MEALTIME._id]).toBeDefined()
    })

    it('follows a community seen through another instance at its home instance', async () => {
      const state = await loadedState()
      const fetch = stubInstances()

      const followed = await communities.actions.followCommunitySourceByUrl(contextFor(state), 'https://lemmy.world/c/mealtimevideos@lemmy.cafe')

      expect(followed.outcome).toBe('followed')
      expect(Object.keys(state.communitySources).sort()).toEqual(['hackertube', MEALTIME._id])
      expect(state.communitySources[MEALTIME._id].url).toBe('https://lemmy.cafe/c/mealtimevideos')
      expect(fetch.mock.calls.every(([url]) => new URL(url).host === 'lemmy.cafe')).toBe(true)
    })

    it('follows nothing when the instance serves no feed, and says so', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const state = await loadedState()
      stubInstances()

      const followed = await communities.actions.followCommunitySourceByUrl(contextFor(state), 'https://slrpnk.net/c/solarpunk')

      expect(followed.outcome).toBe('no-feed')
      expect(followed.source.name).toBe('solarpunk@slrpnk.net')
      expect(Object.keys(state.communitySources)).toEqual(['hackertube'])
      expect(DBCommunityHandlers.upsertSource).not.toHaveBeenCalled()
      expect(DBCommunityHandlers.putShares).not.toHaveBeenCalled()
    })

    it('follows nothing, and asks nothing, before the datastore is read or after it could not be', async () => {
      const fetch = stubInstances()

      for (const fields of [{ communitiesReady: false }, { communitiesReady: true, communitiesGrabFailed: true }]) {
        const state = { ...freshState(), ...fields }

        const followed = await communities.actions.followCommunitySourceByUrl(contextFor(state), 'https://lemmy.cafe/c/mealtimevideos')

        expect(followed, JSON.stringify(fields)).toEqual({ outcome: 'unavailable' })
        expect(state.communitySources).toEqual({})
      }

      expect(fetch).not.toHaveBeenCalled()
      expect(DBCommunityHandlers.upsertSource).not.toHaveBeenCalled()
    })

    it('follows nothing for a URL no source kind recognises', async () => {
      const state = await loadedState()
      const fetch = stubInstances()

      expect(await communities.actions.followCommunitySourceByUrl(contextFor(state), 'https://example.com/videos')).toEqual({ outcome: 'unrecognised' })
      expect(fetch).not.toHaveBeenCalled()
      expect(DBCommunityHandlers.upsertSource).not.toHaveBeenCalled()
    })

    it('leaves a source followed already as it is', async () => {
      const state = await loadedState()
      state.communitySources[MEALTIME._id] = Object.freeze({ ...MEALTIME, followedAt: 1, checkedAt: 2 })
      const fetch = stubInstances()

      const followed = await communities.actions.followCommunitySourceByUrl(contextFor(state), '!mealtimevideos@lemmy.cafe')

      expect(followed.outcome).toBe('followed-already')
      expect(state.communitySources[MEALTIME._id]).toMatchObject({ followedAt: 1, checkedAt: 2 })
      expect(fetch).not.toHaveBeenCalled()
      expect(DBCommunityHandlers.upsertSource).not.toHaveBeenCalled()
    })

    it('follows HackerTube again without asking it, and loads its videos from the bundle', async () => {
      const state = await loadedState()
      await communities.actions.unfollowCommunitySource(contextFor(state), 'hackertube')
      const fetch = stubInstances()

      const followed = await communities.actions.followCommunitySourceByUrl(contextFor(state), 'https://hackertube.org')

      expect(followed.outcome).toBe('followed')
      expect(fetch).not.toHaveBeenCalled()
      expect(fetchHackerTubeBundle).toHaveBeenCalledOnce()
      expect(shareIds(state)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|bbbbbbbbbbb'])
      expect(state.communitySources.hackertube).toMatchObject({ dataGenerated: '2026-10-31' })
    })

    it('stays followed, marked failed, when what it was tried with cannot be kept', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const state = await loadedState()
      stubInstances()
      DBCommunityHandlers.putShares.mockRejectedValueOnce(new Error('locked'))

      const followed = await communities.actions.followCommunitySourceByUrl(contextFor(state), 'https://lemmy.cafe/c/mealtimevideos')

      expect(followed.outcome).toBe('followed')
      expect(state.communitySources[MEALTIME._id]).toMatchObject({ attemptedAt: NOW, failedAt: NOW })
      expect(state.communitySources[MEALTIME._id]).not.toHaveProperty('checkedAt')
    })
  })

  describe('unfollowing a source', () => {
    const MEALTIME = lemmySource({ name: 'mealtimevideos', host: 'lemmy.cafe' }, NOW)

    beforeEach(() => {
      starterSources.mockReset()
      starterSources.mockImplementation(onlyHackerTube)
    })

    /** HackerTube loaded, and the community with a share of a video HackerTube shares too */
    async function bothState() {
      const state = await loadedState()
      state.communitySources[MEALTIME._id] = Object.freeze({ ...MEALTIME })
      state.communityShares[`${MEALTIME._id}|aaaaaaaaaaa`] = Object.freeze({ _id: `${MEALTIME._id}|aaaaaaaaaaa`, sourceId: MEALTIME._id, videoId: 'aaaaaaaaaaa', votes: 3 })
      state.communityVideos.aaaaaaaaaaa = Object.freeze({ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 1 })
      return state
    }

    it('removes it, its shares and its own data, through the datastore, and leaves the rest', async () => {
      const state = await bothState()

      await communities.actions.unfollowCommunitySource(contextFor(state), 'hackertube')

      expect(DBCommunityHandlers.removeSource).toHaveBeenCalledWith('hackertube')
      expect(Object.keys(state.communitySources)).toEqual([MEALTIME._id])
      expect(shareIds(state)).toEqual([`${MEALTIME._id}|aaaaaaaaaaa`])
      expect(communities.getters.getCommunitySourceData(state)('hackertube')).toBeUndefined()
      // Details belong to the video, which another source still shares
      expect(state.communityVideos.aaaaaaaaaaa).toBeDefined()
    })

    it('takes it off at once, and puts everything back when the datastore cannot remove it', async () => {
      const state = await bothState()
      const before = { sources: { ...state.communitySources }, shares: { ...state.communityShares } }
      let fail
      DBCommunityHandlers.removeSource.mockImplementationOnce(() => new Promise((resolve, reject) => { fail = reject }))

      const unfollow = communities.actions.unfollowCommunitySource(contextFor(state), MEALTIME._id)

      expect(Object.keys(state.communitySources)).toEqual(['hackertube'])
      expect(shareIds(state)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|bbbbbbbbbbb'])

      fail(new Error('locked'))
      await expect(unfollow).rejects.toThrow('locked')

      expect(state.communitySources).toEqual(before.sources)
      expect(state.communityShares).toEqual(before.shares)
    })

    it('does not come back when a refresh was already writing its shares as it was unfollowed', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const state = await bothState()
      const context = contextFor(state)
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (new URL(url).host === 'lemmy.cafe') { return new Response(mealtimeTopWeek) }
        return new Response(JSON.stringify({ generated: '2026-10-31' }))
      }))
      // The community's put held in main, past the refresh's own check that it is followed
      let release
      DBCommunityHandlers.putShares.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ added: 2, updated: 0, dropped: [] }) }))

      try {
        const refresh = communities.actions.refreshCommunities(context)
        await vi.waitFor(() => expect(release).toBeTypeOf('function'))

        // Main answers the removal first, as a client cannot rely on the order of answers
        const unfollow = communities.actions.unfollowCommunitySource(context, MEALTIME._id)
        await unfollow
        release()
        await refresh

        expect(Object.keys(state.communitySources)).toEqual(['hackertube'])
        expect(shareIds(state)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|bbbbbbbbbbb'])
        // Never followed again: not created, and not even asked to be updated
        expect(DBCommunityHandlers.upsertSource.mock.calls.map(([source]) => source._id)).not.toContain(MEALTIME._id)
        expect(DBCommunityHandlers.updateSource.mock.calls.map(([source]) => source._id)).not.toContain(MEALTIME._id)
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('keeps only the shares main wrote, none of a source it no longer follows', async () => {
      const state = await bothState()
      DBCommunityHandlers.putShares.mockResolvedValueOnce({ added: 1, updated: 0, dropped: ['lemmy:gone@b.example|ccccccccccc'] })

      await communities.actions.putCommunityShares(contextFor(state), [
        { _id: `${MEALTIME._id}|ccccccccccc`, sourceId: MEALTIME._id, videoId: 'ccccccccccc' },
        { _id: 'lemmy:gone@b.example|ccccccccccc', sourceId: 'lemmy:gone@b.example', videoId: 'ccccccccccc' },
      ])

      expect(shareIds(state)).toContain(`${MEALTIME._id}|ccccccccccc`)
      expect(shareIds(state)).not.toContain('lemmy:gone@b.example|ccccccccccc')
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
        const refresh = communities.actions.refreshCommunities(context)
        await vi.waitFor(() => expect(answers).toHaveLength(2))

        await communities.actions.unfollowCommunitySource(context, MEALTIME._id)
        answers.forEach(answer => answer())
        await refresh

        expect(Object.keys(state.communitySources)).toEqual(['hackertube'])
        expect(shareIds(state)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|bbbbbbbbbbb'])
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('follows another window\'s unfollow, also while the datastore is being read', async () => {
      const state = await bothState()

      communities.mutations.applyCommunitiesSync(state, { event: SyncEvents.COMMUNITIES.REMOVE_SOURCE, data: MEALTIME._id })

      expect(Object.keys(state.communitySources)).toEqual(['hackertube'])
      expect(shareIds(state)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|bbbbbbbbbbb'])

      const reading = freshState()
      DBCommunityHandlers.findSources.mockResolvedValueOnce([{ _id: 'hackertube' }, { ...MEALTIME }])
      DBCommunityHandlers.findShares.mockImplementationOnce(async () => {
        communities.mutations.applyCommunitiesSync(reading, { event: SyncEvents.COMMUNITIES.REMOVE_SOURCE, data: MEALTIME._id })
        return [{ _id: `${MEALTIME._id}|aaaaaaaaaaa`, sourceId: MEALTIME._id, videoId: 'aaaaaaaaaaa' }]
      })

      await communities.actions.grabCommunities(contextFor(reading))

      expect(Object.keys(reading.communitySources)).toEqual(['hackertube'])
      expect(shareIds(reading)).toEqual([])
    })
  })

  describe('importing sources from an OPML file', () => {
    const MEALTIME = lemmySource({ name: 'mealtimevideos', host: 'lemmy.cafe' }, NOW)
    const TALKS = lemmySource({ name: 'talks', host: 'programming.dev' }, NOW)

    beforeEach(() => {
      starterSources.mockReset()
      starterSources.mockImplementation(onlyHackerTube)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('follows every recognised source not followed, asks none of them anything, and counts what it did', async () => {
      const state = await loadedState()
      const fetch = vi.fn()
      vi.stubGlobal('fetch', fetch)

      const imported = await communities.actions.importCommunitySources(contextFor(state), [
        'https://hackertube.org/api/export',
        'https://lemmy.cafe/feeds/c/mealtimevideos.xml?sort=New&limit=50',
        'https://www.youtube.com/feeds/videos.xml?channel_id=UC1',
        // Twice in the file: followed by the first
        'https://lemmy.cafe/feeds/c/mealtimevideos.xml?sort=New&limit=50',
      ])

      expect(imported).toEqual({ outcome: 'imported', followed: 1, followedAlready: 2, refused: 1 })
      expect(Object.keys(state.communitySources).sort()).toEqual(['hackertube', MEALTIME._id])
      expect(DBCommunityHandlers.upsertSource).toHaveBeenCalledTimes(1)
      expect(fetch).not.toHaveBeenCalled()
    })

    it('follows at most 100 new sources from one file, and counts the rest refused', async () => {
      const state = await loadedState()
      const urls = [
        'https://hackertube.org/api/export',
        ...Array.from({ length: 105 }, (_, i) => `https://lemmy.cafe/c/community${i}`),
        'https://www.youtube.com/feeds/videos.xml?channel_id=UC1',
      ]

      const imported = await communities.actions.importCommunitySources(contextFor(state), urls)

      expect(imported).toEqual({ outcome: 'imported', followed: 100, followedAlready: 1, refused: 6 })
      expect(Object.keys(state.communitySources)).toHaveLength(101)
      expect(state.communitySources['lemmy:community99@lemmy.cafe']).toBeDefined()
      expect(state.communitySources['lemmy:community100@lemmy.cafe']).toBeUndefined()
    })

    it('imports nothing before the datastore is read, or after it could not be', async () => {
      for (const field of ['communitiesReady', 'communitiesGrabFailed']) {
        const state = freshState()
        state[field] = field === 'communitiesGrabFailed'

        const imported = await communities.actions.importCommunitySources(contextFor(state), ['https://hackertube.org'])

        expect(imported, field).toEqual({ outcome: 'unavailable' })
        expect(DBCommunityHandlers.upsertSource).not.toHaveBeenCalled()
      }
    })

    it('round-trips: exported, every source unfollowed, and imported again, the same sources are followed', async () => {
      const state = await loadedState()
      const context = contextFor(state)
      await communities.actions.followCommunitySource(context, MEALTIME)
      await communities.actions.followCommunitySource(context, TALKS)
      const before = communities.getters.getCommunitySources(state)
      const followed = sources => sources.map(({ _id, kind, url, name }) => ({ _id, kind, url, name })).sort((a, b) => a._id.localeCompare(b._id))

      const file = sourcesOpml(before)
      for (const source of before) {
        await communities.actions.unfollowCommunitySource(context, source._id)
      }
      expect(communities.getters.getCommunitySources(state)).toEqual([])

      const imported = await communities.actions.importCommunitySources(context, opmlFeedUrls(file))

      expect(imported).toEqual({ outcome: 'imported', followed: 3, followedAlready: 0, refused: 0 })
      expect(followed(communities.getters.getCommunitySources(state))).toEqual(followed(before))
    })
  })
})
