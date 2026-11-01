import { DBCollectionHandlers } from '../../../datastores/handlers/index'
import { SyncEvents } from '../../../constants'
import { HACKERTUBE_SOURCE_ID, hackerTubeShare, hackerTubeSource } from '../../helpers/collections/hackertube'
import { fetchHackerTubeBundle } from '../../helpers/collections/hackertubeBundle'

/**
 * Collections: the sources followed and the shares they made, from
 * `collection-sources.db` and `collection-shares.db`, loaded at startup and
 * written through on every change.
 *
 * Shares are frozen as they come in: there are thousands of them, nothing
 * edits one in place, and a frozen object is one Vue does not make deeply
 * reactive. A change replaces the share.
 *
 * The walls are worked out from the shares in `helpers/collections/shares.js`.
 */

/** @import { Share, Source } from '../../helpers/collections/hackertube' */

const state = {
  /** @type {Record<string, Source>} by `_id` */
  collectionSources: {},
  /** @type {Record<string, Share>} by `_id` */
  collectionShares: {},
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
}

const getters = {
  getCollectionsReady: (state) => state.collectionsReady,
  getCollectionsLoading: (state) => state.collectionsLoading,
  getCollectionsLoadFailed: (state) => state.collectionsLoadFailed,
  /** @returns {Source[]} */
  getCollectionSources: (state) => Object.values(state.collectionSources),
  getCollectionSource: (state) => (id) => state.collectionSources[id],
  /** @returns {Share[]} */
  getCollectionShares: (state) => Object.values(state.collectionShares),
}

/** The one first open in flight, which a second open joins */
let opening = null

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
      const [sources, shares] = await Promise.all([
        DBCollectionHandlers.findSources(),
        DBCollectionHandlers.findShares(),
      ])

      commit('finishCollectionsGrab', { sources, shares })
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
    const seenAt = Date.now()
    const shares = bundle.videos.map(video => hackerTubeShare(video, seenAt)).filter(share => share !== null)

    await dispatch('putCollectionShares', shares)
    // As it is now: another window may have written it while the bundle loaded
    const current = state.collectionSources[HACKERTUBE_SOURCE_ID] ?? source
    await dispatch('followCollectionSource', { ...current, dataGenerated: bundle.generated })
  } catch (error) {
    console.error('Collections: could not load the HackerTube bundle', error)
    commit('setCollectionsLoadFailed', true)
  } finally {
    commit('setCollectionsLoading', false)
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

  startCollectionsGrab(state) {
    state.collectionsSyncBuffer ??= []
  },

  /**
   * @param {any} state
   * @param {{ sources: Source[], shares: Share[] } | null} read null when the read failed
   */
  finishCollectionsGrab(state, read) {
    if (read !== null) {
      state.collectionSources = Object.fromEntries(read.sources.map(source => [source._id, source]))
      state.collectionShares = withShares({}, read.shares)
    }

    const buffered = state.collectionsSyncBuffer ?? []
    state.collectionsSyncBuffer = null

    for (const write of buffered) {
      mutations.applyCollectionsSync(state, write)
    }
  },

  upsertCollectionSource(state, source) {
    state.collectionSources = { ...state.collectionSources, [source._id]: source }
  },

  putCollectionShares(state, shares) {
    state.collectionShares = withShares(state.collectionShares, shares)
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
