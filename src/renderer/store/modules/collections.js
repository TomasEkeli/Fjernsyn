import { DBCollectionHandlers } from '../../../datastores/handlers/index'
import { SyncEvents } from '../../../constants'
import { HACKERTUBE_SOURCE_ID, hackerTubeShare, hackerTubeSource } from '../../helpers/collections/hackertube'
import { fetchHackerTubeBundle } from '../../helpers/collections/hackertubeBundle'
import { isNewerExport } from '../../helpers/collections/kinds/hackertube'
import { SOURCE_KINDS_BY_KIND } from '../../helpers/collections/kinds/index'
import { lastAttemptOf, lastRefreshOf, refreshCollectionSources, refreshIsDue } from '../../helpers/collections/refresh'
import { sharesToPut } from '../../helpers/collections/shares'

/**
 * Collections: the sources followed and the shares they made, from
 * `collection-sources.db` and `collection-shares.db`, and each collection
 * video's own details as the crawl fetched them, from `collection-videos.db`,
 * loaded at startup and written through on every change.
 *
 * Each source's own data, too large to rewrite with its record on every
 * refresh (HackerTube's taxonomy), is kept apart, in
 * `collection-source-data.db`, by source id, and is not backed up.
 *
 * Sources, source data, shares and details are frozen as they come in: there are
 * thousands of shares, nothing edits one in place, and a frozen object is
 * one Vue does not make deeply reactive, which also keeps a record one the
 * IPC to main can copy. A change replaces the record.
 *
 * The walls are worked out from the shares in `helpers/collections/shares.js`.
 *
 * A refresh asks every followed source what it shares now
 * (`helpers/collections/refresh.js`), and keeps on each source's record
 * when a refresh last worked for it (`checkedAt`), when one last asked it
 * (`attemptedAt`), and `failedAt` while its last refresh failed.
 */

/** @import { Share, Source } from '../../helpers/collections/shares' */
/** @import { VideoDetails } from '../../helpers/collections/details' */

const state = {
  /** @type {Record<string, Source>} by `_id` */
  collectionSources: {},
  /** @type {Record<string, Share>} by `_id` */
  collectionShares: {},
  /** @type {Record<string, VideoDetails>} by `_id`, the video's ref as one string */
  collectionVideos: {},
  /** @type {Record<string, Record<string, any>>} each source's own data, by source id */
  collectionSourceData: {},
  collectionsReady: false,
  // The last read of the datastore failed, so what is held says nothing about
  // what is followed: nothing may be followed or loaded on the strength of it
  collectionsGrabFailed: false,
  // Other windows' writes that arrived while the datastore was being read,
  // applied once the read is in; null while no read is under way
  collectionsSyncBuffer: null,
  // The bundle being loaded into the datastore, the first time Collections is opened
  collectionsLoading: false,
  collectionsLoadFailed: false,
  // A refresh in this window, and how many of the sources it asks are done
  collectionsRefreshing: false,
  collectionsRefreshProgress: { done: 0, total: 0 },
}

const getters = {
  getCollectionsReady: (state) => state.collectionsReady,
  getCollectionsLoading: (state) => state.collectionsLoading,
  getCollectionsLoadFailed: (state) => state.collectionsLoadFailed,
  getCollectionsGrabFailed: (state) => state.collectionsGrabFailed,
  /** @returns {Source[]} */
  getCollectionSources: (state) => Object.values(state.collectionSources),
  getCollectionSource: (state) => (id) => state.collectionSources[id],
  /** @returns {Share[]} */
  getCollectionShares: (state) => Object.values(state.collectionShares),
  /** @returns {Record<string, VideoDetails>} by the video's ref as one string */
  getCollectionVideos: (state) => state.collectionVideos,
  /** @returns {(sourceId: string) => Record<string, any> | undefined} a source's own data: HackerTube's is `{ generated, taxonomy }` */
  getCollectionSourceData: (state) => (sourceId) => state.collectionSourceData[sourceId],
  getCollectionsRefreshing: (state) => state.collectionsRefreshing,
  /** @returns {{ done: number, total: number }} sources asked, of those being asked */
  getCollectionsRefreshProgress: (state) => state.collectionsRefreshProgress,
  /** @returns {number | null} when every followed source was last refreshed successfully by, in ms; null for never */
  getCollectionsLastRefreshAt: (state) => lastRefreshOf(Object.values(state.collectionSources)),
  /** @returns {Source[]} the followed sources whose last refresh failed */
  getCollectionsRefreshFailures: (state) => Object.values(state.collectionSources).filter(source => typeof source.failedAt === 'number'),
}

/** The one first open in flight, which a second open joins */
let opening = null

/** The one refresh in flight in this window, which a second refresh joins */
let refreshing = null

const actions = {
  /**
   * Reads what the datastore holds, which replaces what is held. Another
   * window's writes that arrive during the read are kept aside and applied
   * after it, so that a read which began before them cannot undo them.
   *
   * @param {any} context
   */
  async grabCollections({ commit }) {
    commit('startCollectionsGrab')

    try {
      // All or none: details that could not be read would make the
      // crawl take every video for missing
      const [sources, shares, videos, sourceData] = await Promise.all([
        DBCollectionHandlers.findSources(),
        DBCollectionHandlers.findShares(),
        DBCollectionHandlers.findVideos(),
        DBCollectionHandlers.findSourceData(),
      ])

      commit('finishCollectionsGrab', { sources, shares, videos, sourceData })
      commit('setCollectionsGrabFailed', false)
    } catch (error) {
      console.error(error)
      commit('finishCollectionsGrab', null)
      commit('setCollectionsGrabFailed', true)
    } finally {
      commit('setCollectionsReady', true)
    }
  },

  /**
   * @param {any} context
   * @param {Source} source
   */
  async followCollectionSource({ commit }, source) {
    await DBCollectionHandlers.upsertSource(source)
    commit('upsertCollectionSource', source)
  },

  /**
   * Adds the shares given, and updates those already kept; drops nothing.
   *
   * @param {any} context
   * @param {Share[]} shares
   */
  async putCollectionShares({ commit }, shares) {
    if (shares.length === 0) { return }

    await DBCollectionHandlers.putShares(shares)
    commit('putCollectionShares', shares)
  },

  /**
   * Keeps a source's own data, replacing what was kept for it
   *
   * @param {any} context
   * @param {{ _id: string }} record the source's id as `_id`, and its data
   */
  async putCollectionSourceData({ commit }, record) {
    await DBCollectionHandlers.putSourceData(record)
    commit('putCollectionSourceData', record)
  },

  /**
   * Keeps videos' details, each replacing what was kept for its video
   *
   * @param {any} context
   * @param {VideoDetails[]} videos
   */
  async putCollectionVideos({ commit }, videos) {
    if (videos.length === 0) { return }

    await DBCollectionHandlers.putVideos(videos)
    commit('putCollectionVideos', videos)
  },

  /**
   * What opening Collections does first, once the datastore has loaded:
   * HackerTube is followed if it is not, and while it is followed its shares
   * are loaded from the bundle shipped with the app if they are not there,
   * which is the first open of all, or the first after a restore that brought
   * the source without its shares. Loaded means shares are there and the
   * source says which export they came from. Anything that fails is tried
   * again on the next open; putting shares twice duplicates nothing. After a
   * failed read of the datastore it is read again first, and nothing more is
   * done while it still cannot be read.
   *
   * @param {any} context
   * @returns {Promise<void>}
   */
  openCollections(context) {
    opening ??= openCollectionsOnce(context).finally(() => { opening = null })
    return opening
  },

  /**
   * Lays the fields given over a followed source's record as it is now, and
   * does nothing for a source no longer followed.
   *
   * @param {any} context
   * @param {{ sourceId: string, fields: Partial<Source> }} payload
   */
  async updateCollectionSource({ state, dispatch }, { sourceId, fields }) {
    const current = state.collectionSources[sourceId]
    if (current === undefined) { return }

    await dispatch('followCollectionSource', { ...current, ...fields })
  },

  /**
   * Asks every followed source what it shares now, whatever the page shows,
   * and keeps what is new or changed; for HackerTube, a newer export when
   * there is one. A source that fails keeps what it has and is marked
   * failed. One refresh at a time: a second call joins the one under way.
   * Nothing over a datastore that could not be read, and not before a first
   * open under way has loaded the bundle.
   *
   * @param {any} context
   * @returns {Promise<void>}
   */
  refreshCollections(context) {
    refreshing ??= refreshCollectionsOnce(context).finally(() => { refreshing = null })
    return refreshing
  },

  /**
   * What opening Collections does once it is open: a refresh, when the last
   * one, worked or not, was more than an hour ago (`refreshIsDue`), or never
   * was. Nothing with nothing followed.
   *
   * @param {any} context
   * @returns {Promise<void>}
   */
  async refreshCollectionsIfDue({ state, dispatch }) {
    const sources = Object.values(state.collectionSources)
    if (state.collectionsGrabFailed || sources.length === 0) { return }

    if (refreshIsDue(lastAttemptOf(sources), Date.now())) {
      await dispatch('refreshCollections')
    }
  },

  setupCollectionsSync({ commit }) {
    window.ftElectron.handleSyncCollections((event, data) => {
      commit('applyCollectionsSync', { event, data })
    })
  },
}

/**
 * @param {any} context
 */
async function openCollectionsOnce({ state, commit, dispatch }) {
  if (state.collectionsGrabFailed) {
    await dispatch('grabCollections')
  }

  // What is held may be empty only because it could not be read: following
  // HackerTube then would overwrite its record, and load the bundle again
  if (state.collectionsGrabFailed) {
    commit('setCollectionsLoadFailed', true)
    return
  }

  let source = state.collectionSources[HACKERTUBE_SOURCE_ID]

  try {
    commit('setCollectionsLoading', true)
    commit('setCollectionsLoadFailed', false)

    if (source == null) {
      source = hackerTubeSource(Date.now())
      await dispatch('followCollectionSource', source)
    }

    const loaded = source.dataGenerated != null &&
      Object.values(state.collectionShares).some(share => share.sourceId === HACKERTUBE_SOURCE_ID)

    if (loaded) { return }

    const bundle = await fetchHackerTubeBundle()

    // A refresh may have loaded a newer export while the bundle was read (an
    // open after a failed load, during a refresh): the bundle must not go
    // over it. Only a change made meanwhile counts: a date that was already
    // there, as after a restore, is one whose shares are missing.
    const meanwhile = state.collectionSources[HACKERTUBE_SOURCE_ID]?.dataGenerated ?? null
    if (meanwhile !== null && meanwhile !== (source.dataGenerated ?? null) && !isNewerExport(bundle.generated, meanwhile)) {
      return
    }

    const seenAt = Date.now()
    const shares = bundle.videos.map(video => hackerTubeShare(video, seenAt)).filter(share => share !== null)

    // Those already kept as the bundle has them need no writing again
    await dispatch('putCollectionShares', sharesToPut(state.collectionShares, shares))
    // As it is now: another window may have written it while the bundle loaded
    const current = state.collectionSources[HACKERTUBE_SOURCE_ID] ?? source
    await dispatch('putCollectionSourceData', { _id: HACKERTUBE_SOURCE_ID, generated: bundle.generated, taxonomy: bundle.taxonomy })
    await dispatch('followCollectionSource', { ...current, dataGenerated: bundle.generated })
  } catch (error) {
    console.error('Collections: could not load the HackerTube bundle', error)
    commit('setCollectionsLoadFailed', true)
  } finally {
    commit('setCollectionsLoading', false)
  }
}

/**
 * @param {any} context
 */
async function refreshCollectionsOnce({ state, commit, dispatch }) {
  if (opening !== null) {
    await opening
  }

  if (state.collectionsGrabFailed) { return }

  commit('setCollectionsRefreshing', true)

  try {
    await refreshCollectionSources({
      sources: Object.values(state.collectionSources),
      kinds: SOURCE_KINDS_BY_KIND,
      // As it is when asked, so that a test can stand in for the network
      fetch: (...args) => fetch(...args),
      now: () => Date.now(),
      keptShares: () => state.collectionShares,
      isFollowed: sourceId => Object.hasOwn(state.collectionSources, sourceId),
      putShares: shares => dispatch('putCollectionShares', shares),
      putSourceData: (sourceId, data) => dispatch('putCollectionSourceData', { ...data, _id: sourceId }),
      updateSource: (sourceId, fields) => dispatch('updateCollectionSource', { sourceId, fields }),
      onProgress: progress => commit('setCollectionsRefreshProgress', progress),
    })
  } finally {
    commit('setCollectionsRefreshing', false)
  }
}

/**
 * @param {Record<string, Share>} kept
 * @param {Share[]} shares
 * @returns {Record<string, Share>}
 */
function withShares(kept, shares) {
  const next = { ...kept }

  for (const share of shares) {
    // As main's put: the fields given replace those kept, and nothing else goes
    next[share._id] = Object.freeze({ ...next[share._id], ...share })
  }

  return next
}

/**
 * Into the map held, not a copy of it: the crawl puts one record at a time,
 * twice a second, into a map of thousands. Whatever reads a record by its key
 * hears of it, as `detailsFor` reads before it looks.
 *
 * @param {Record<string, VideoDetails>} kept
 * @param {VideoDetails[]} videos
 */
function putVideos(kept, videos) {
  for (const video of videos) {
    // As main's put: the record given replaces the one kept
    kept[video._id] = Object.freeze({ ...video })
  }
}

const mutations = {
  setCollectionsReady(state, value) {
    state.collectionsReady = value
  },

  setCollectionsLoading(state, value) {
    state.collectionsLoading = value
  },

  setCollectionsLoadFailed(state, value) {
    state.collectionsLoadFailed = value
  },

  setCollectionsGrabFailed(state, value) {
    state.collectionsGrabFailed = value
  },

  setCollectionsRefreshing(state, value) {
    state.collectionsRefreshing = value
  },

  setCollectionsRefreshProgress(state, progress) {
    state.collectionsRefreshProgress = progress
  },

  startCollectionsGrab(state) {
    state.collectionsSyncBuffer ??= []
  },

  /**
   * @param {any} state
   * @param {{ sources: Source[], shares: Share[], videos: VideoDetails[], sourceData: { _id: string }[] } | null} read null when the read failed
   */
  finishCollectionsGrab(state, read) {
    if (read !== null) {
      state.collectionSources = Object.fromEntries(read.sources.map(source => [source._id, Object.freeze({ ...source })]))
      state.collectionShares = withShares({}, read.shares)
      const videos = {}
      putVideos(videos, read.videos)
      state.collectionVideos = videos
      state.collectionSourceData = Object.fromEntries(read.sourceData.map(record => [record._id, Object.freeze({ ...record })]))
    }

    const buffered = state.collectionsSyncBuffer ?? []
    state.collectionsSyncBuffer = null

    for (const write of buffered) {
      mutations.applyCollectionsSync(state, write)
    }
  },

  /**
   * Frozen, as the shares are, so that Vue leaves it as it is: a source with
   * fields of its own (HackerTube's taxonomy) is otherwise read back with a
   * reactive proxy inside, which the IPC to main cannot copy
   *
   * @param {any} state
   * @param {Source} source
   */
  upsertCollectionSource(state, source) {
    state.collectionSources = { ...state.collectionSources, [source._id]: Object.freeze({ ...source }) }
  },

  putCollectionSourceData(state, record) {
    state.collectionSourceData = { ...state.collectionSourceData, [record._id]: Object.freeze({ ...record }) }
  },

  putCollectionShares(state, shares) {
    state.collectionShares = withShares(state.collectionShares, shares)
  },

  putCollectionVideos(state, videos) {
    putVideos(state.collectionVideos, videos)
  },

  /**
   * Another window's write, as main passed it on
   * @param {any} state
   * @param {{ event: number, data: any }} payload
   */
  applyCollectionsSync(state, { event, data }) {
    if (state.collectionsSyncBuffer !== null) {
      state.collectionsSyncBuffer.push({ event, data })
      return
    }

    switch (event) {
      case SyncEvents.COLLECTIONS.UPSERT_SOURCE:
        mutations.upsertCollectionSource(state, data)
        break

      case SyncEvents.COLLECTIONS.PUT_SHARES:
        mutations.putCollectionShares(state, data)
        break

      case SyncEvents.COLLECTIONS.PUT_VIDEOS:
        mutations.putCollectionVideos(state, data)
        break

      case SyncEvents.COLLECTIONS.PUT_SOURCE_DATA:
        mutations.putCollectionSourceData(state, data)
        break

      default:
        console.error('collections: invalid sync event received')
    }
  },
}

export default {
  state,
  getters,
  actions,
  mutations
}
