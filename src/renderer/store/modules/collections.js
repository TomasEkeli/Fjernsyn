import { DBCollectionHandlers } from '../../../datastores/handlers/index'
import { SyncEvents } from '../../../constants'
import { HACKERTUBE_SOURCE_ID, hackerTubeShare } from '../../helpers/collections/hackertube'
import { fetchHackerTubeBundle } from '../../helpers/collections/hackertubeBundle'
import { isNewerExport } from '../../helpers/collections/kinds/hackertube'
import { SOURCE_KINDS_BY_KIND } from '../../helpers/collections/kinds/index'
import { trySource } from '../../helpers/collections/follow'
import { keepSourceFetch, lastAttemptOf, lastRefreshOf, refreshCollectionSources, refreshIsDue } from '../../helpers/collections/refresh'
import { sharesToPut } from '../../helpers/collections/shares'
import { hiddenSourcesWith } from '../../helpers/collections/sourceChips'
import { starterSources, starterSourcesToFollow } from '../../helpers/collections/starterSet'

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
 *
 * The first open of Collections or a source's page (`openCollections`), or
 * the first visit to the Sources page, follows the starter set once per
 * installation (`applyCollectionsStarterSet`), marked done in the
 * `collectionsStarterSetDone` setting. Only a wall's open loads HackerTube's
 * bundle.
 *
 * A source is followed by a URL pasted on the Sources page, once asking it
 * has shown it can be (`helpers/collections/follow.js`), and unfollowed
 * there, which removes its record, its shares and its own data; the videos'
 * details stay, as they belong to the video.
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

/** The starter set being followed, which a second call joins */
let applyingStarterSet = null

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
   * Follows a source, by every way there is to follow one. A source newly
   * followed has its chip on Collections on, even one unfollowed earlier
   * with its chip off (helpers/collections/sourceChips.js); a chip that
   * cannot be turned on leaves the source followed.
   *
   * @param {any} context
   * @param {Source} source
   */
  async followCollectionSource({ commit, rootGetters, dispatch }, source) {
    await DBCollectionHandlers.upsertSource(source)
    commit('upsertCollectionSource', source)

    const hidden = rootGetters.getCollectionsSourcesHidden
    const shown = hiddenSourcesWith(hidden, source._id, true)

    if (shown !== hidden) {
      try {
        await dispatch('updateCollectionsSourcesHidden', shown)
      } catch (error) {
        console.error(`Collections: followed ${source._id}, but could not turn its chip on`, error)
      }
    }
  },

  /**
   * Follows the source a pasted URL names, once it has been tried
   * (`helpers/collections/follow.js`), and keeps at once what the trial
   * fetched, as a refresh would; HackerTube, whose videos come with the app,
   * has them loaded from the bundle. Nothing is followed when no kind
   * recognises the URL, when the source is followed already, when it serves
   * nothing its kind can read, or when it cannot be reached. A source
   * followed whose videos could then not be kept stays followed, marked
   * failed, for a refresh to bring them.
   *
   * @param {any} context
   * @param {string} url
   * @returns {Promise<{ outcome: 'followed', source: Source } | { outcome: 'unavailable' } | Exclude<import('../../helpers/collections/follow').SourceTrial, { outcome: 'followable' }>>}
   *   `unavailable` before the datastore is read, or when it could not be
   */
  async followCollectionSourceByUrl(context, url) {
    const { state, dispatch } = context

    // What is held says nothing yet of what is followed
    if (!state.collectionsReady || state.collectionsGrabFailed) {
      return { outcome: 'unavailable' }
    }

    const isFollowed = sourceId => Object.hasOwn(state.collectionSources, sourceId)

    const trial = await trySource(url, {
      now: Date.now(),
      // As it is when asked, so that a test can stand in for the network
      fetch: (...args) => fetch(...args),
      isFollowed,
    })

    if (trial.outcome !== 'followable') { return trial }

    const { source, fetched } = trial

    // Followed meanwhile, from another window or by a paste before this one
    if (isFollowed(source._id)) {
      return { outcome: 'followed-already', source }
    }

    await dispatch('followCollectionSource', source)

    if (fetched === null) {
      // Loads the bundle, as the source has no shares and no export yet
      await dispatch('openCollections')
    } else {
      try {
        await keepSourceFetch(refreshDependencies(context), source, fetched)
      } catch (error) {
        console.error(`Collections: could not keep what ${source._id} shares`, error)
        const at = Date.now()
        await dispatch('updateCollectionSource', { sourceId: source._id, fields: { attemptedAt: at, failedAt: at } })
      }
    }

    return { outcome: 'followed', source }
  },

  /**
   * Unfollows a source: its record, its shares and its own data go, here
   * and in every other window. The videos' details stay.
   *
   * Taken out of what is held at once, before main is asked, so that a
   * refresh under way finds it unfollowed and writes nothing more of it;
   * taken out again once main has removed it, for any share a write already
   * on its way put back meanwhile; and put back as it was if main could not
   * remove it.
   *
   * @param {any} context
   * @param {string} sourceId
   */
  async unfollowCollectionSource({ state, commit }, sourceId) {
    const held = {
      source: state.collectionSources[sourceId],
      shares: Object.values(state.collectionShares).filter(share => share.sourceId === sourceId),
      sourceData: state.collectionSourceData[sourceId],
    }

    commit('removeCollectionSource', sourceId)

    try {
      await DBCollectionHandlers.removeSource(sourceId)
    } catch (error) {
      commit('restoreCollectionSource', held)
      throw error
    }

    commit('removeCollectionSource', sourceId)
  },

  /**
   * Adds the shares given, and updates those already kept; drops nothing.
   * Only those main wrote are held, and only of a source still followed:
   * main drops a share of a source with no record, and a source being
   * unfollowed is already gone from what is held.
   *
   * @param {any} context
   * @param {Share[]} shares
   */
  async putCollectionShares({ state, commit }, shares) {
    if (shares.length === 0) { return }

    const put = await DBCollectionHandlers.putShares(shares)
    const dropped = new Set(put?.dropped ?? [])

    const kept = shares.filter(share => !dropped.has(share._id) && Object.hasOwn(state.collectionSources, share.sourceId))
    if (kept.length > 0) {
      commit('putCollectionShares', kept)
    }
  },

  /**
   * Keeps a source's own data, replacing what was kept for it
   *
   * @param {any} context
   * @param {{ _id: string }} record the source's id as `_id`, and its data
   */
  async putCollectionSourceData({ state, commit }, record) {
    const put = await DBCollectionHandlers.putSourceData(record)

    // Not for a source main does not follow, or one being unfollowed
    if (put?.kept !== false && Object.hasOwn(state.collectionSources, record._id)) {
      commit('putCollectionSourceData', record)
    }
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
   * Follows the starter set (`helpers/collections/starterSet.js`), once per
   * installation: each starter source not followed already, and then the
   * `collectionsStarterSetDone` setting says it is done, so that nothing of
   * it is followed again and a starter source unfollowed stays unfollowed.
   * Nothing is asked of the sources: the refresh that opening a wall makes
   * brings their videos. A follow that fails leaves the set unmarked, for the
   * next open to follow the rest. Nothing before the datastore has been read,
   * or over one that could not be. One at a time: a second call joins it.
   *
   * @param {any} context
   * @returns {Promise<void>}
   */
  applyCollectionsStarterSet(context) {
    applyingStarterSet ??= applyStarterSetOnce(context).finally(() => { applyingStarterSet = null })
    return applyingStarterSet
  },

  /**
   * What opening Collections does first, once the datastore has loaded: the
   * starter set is followed, if it never has been; and while HackerTube is
   * followed its shares are loaded from the bundle shipped with the app if
   * they are not there, which is the first open of all, or the first after a
   * restore that brought the source without its shares. Loaded means shares
   * are there and the source says which export they came from. Anything that
   * fails is tried again on the next open; putting shares twice duplicates
   * nothing. After a failed read of the datastore it is read again first, and
   * nothing more is done while it still cannot be read.
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
   * does nothing for a source no longer followed. An update, never a follow:
   * main writes it only over a record it has (`updateSource`), so that a
   * refresh cannot follow again a source unfollowed while it ran.
   *
   * @param {any} context
   * @param {{ sourceId: string, fields: Partial<Source> }} payload
   */
  async updateCollectionSource({ state, commit }, { sourceId, fields }) {
    const current = state.collectionSources[sourceId]
    if (current === undefined) { return }

    const record = { ...current, ...fields }
    const { updated } = await DBCollectionHandlers.updateSource(record)

    if (updated > 0 && Object.hasOwn(state.collectionSources, sourceId)) {
      commit('upsertCollectionSource', record)
    }
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

  // What is held may be empty only because it could not be read: taking it
  // for unfollowed would apply the starter set over it, and load the bundle
  // again
  if (state.collectionsGrabFailed) {
    commit('setCollectionsLoadFailed', true)
    return
  }

  try {
    commit('setCollectionsLoading', true)
    commit('setCollectionsLoadFailed', false)

    await dispatch('applyCollectionsStarterSet')

    // Not followed, as after an unfollow: nothing of its to load
    const source = state.collectionSources[HACKERTUBE_SOURCE_ID]
    if (source == null) { return }

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
    await dispatch('putCollectionSourceData', { _id: HACKERTUBE_SOURCE_ID, generated: bundle.generated, taxonomy: bundle.taxonomy })
    // Over the record as it is now, as another window may have written it
    // while the bundle loaded; and only while it is followed
    await dispatch('updateCollectionSource', { sourceId: HACKERTUBE_SOURCE_ID, fields: { dataGenerated: bundle.generated } })
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
async function applyStarterSetOnce({ state, rootGetters, dispatch }) {
  // What is held says nothing yet of what is followed
  if (!state.collectionsReady || state.collectionsGrabFailed) { return }

  // Applied: not even the mark is written again
  const applied = rootGetters.getCollectionsStarterSetDone === true
  if (applied) { return }

  const toFollow = starterSourcesToFollow(starterSources(Date.now()), {
    applied,
    isFollowed: sourceId => Object.hasOwn(state.collectionSources, sourceId),
  })

  try {
    for (const source of toFollow) {
      // Followed meanwhile, from another window
      if (Object.hasOwn(state.collectionSources, source._id)) { continue }
      await dispatch('followCollectionSource', source)
    }
  } catch (error) {
    // Unmarked, the next open follows what is still not followed
    console.error('Collections: could not follow the starter set', error)
    return
  }

  try {
    await dispatch('updateCollectionsStarterSetDone', true)
  } catch (error) {
    // Unmarked, the next open applies it again, which follows nothing twice,
    // but follows again any of it unfollowed meanwhile
    console.error('Collections: followed the starter set, but could not mark it done', error)
  }
}

/**
 * What a refresh, and the follow that keeps what its trial fetched, need of
 * the store (`helpers/collections/refresh.js`)
 *
 * @param {any} context
 * @returns {Omit<import('../../helpers/collections/refresh').RefreshDependencies, 'sources'>}
 */
function refreshDependencies({ state, dispatch }) {
  return {
    kinds: SOURCE_KINDS_BY_KIND,
    // As it is when asked, so that a test can stand in for the network
    fetch: (...args) => fetch(...args),
    now: () => Date.now(),
    keptShares: () => state.collectionShares,
    isFollowed: sourceId => Object.hasOwn(state.collectionSources, sourceId),
    putShares: shares => dispatch('putCollectionShares', shares),
    putSourceData: (sourceId, data) => dispatch('putCollectionSourceData', { ...data, _id: sourceId }),
    updateSource: (sourceId, fields) => dispatch('updateCollectionSource', { sourceId, fields }),
  }
}

/**
 * @param {any} context
 */
async function refreshCollectionsOnce(context) {
  const { state, commit } = context

  if (opening !== null) {
    await opening
  }

  if (state.collectionsGrabFailed) { return }

  commit('setCollectionsRefreshing', true)

  try {
    const { failed } = await refreshCollectionSources({
      ...refreshDependencies(context),
      sources: Object.values(state.collectionSources),
      onProgress: progress => commit('setCollectionsRefreshProgress', progress),
    })

    // The bundle could not be loaded, but HackerTube's export is in now
    const hackerTube = state.collectionSources[HACKERTUBE_SOURCE_ID]
    if (state.collectionsLoadFailed && hackerTube?.dataGenerated != null && !failed.includes(HACKERTUBE_SOURCE_ID) &&
      Object.values(state.collectionShares).some(share => share.sourceId === HACKERTUBE_SOURCE_ID)) {
      commit('setCollectionsLoadFailed', false)
    }
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

  /**
   * A source unfollowed: its record, its shares and its own data
   *
   * @param {any} state
   * @param {string} sourceId
   */
  removeCollectionSource(state, sourceId) {
    if (Object.hasOwn(state.collectionSources, sourceId)) {
      const { [sourceId]: _source, ...sources } = state.collectionSources
      state.collectionSources = sources
    }

    if (Object.hasOwn(state.collectionSourceData, sourceId)) {
      const { [sourceId]: _data, ...sourceData } = state.collectionSourceData
      state.collectionSourceData = sourceData
    }

    state.collectionShares = Object.fromEntries(Object.entries(state.collectionShares).filter(([, share]) => share.sourceId !== sourceId))
  },

  /**
   * A source whose unfollowing main refused, put back as it was held
   *
   * @param {any} state
   * @param {{ source?: Source, shares: Share[], sourceData?: Record<string, any> }} held
   */
  restoreCollectionSource(state, { source, shares, sourceData }) {
    if (source !== undefined) {
      mutations.upsertCollectionSource(state, source)
    }

    mutations.putCollectionShares(state, shares)

    if (sourceData !== undefined) {
      mutations.putCollectionSourceData(state, sourceData)
    }
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

      case SyncEvents.COLLECTIONS.REMOVE_SOURCE:
        mutations.removeCollectionSource(state, data)
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
