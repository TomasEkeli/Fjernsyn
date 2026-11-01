import { DBCommunityHandlers } from '../../../datastores/handlers/index'
import { SyncEvents } from '../../../constants'
import { HACKERTUBE_SOURCE_ID, hackerTubeShare } from '../../helpers/communities/hackertube'
import { fetchHackerTubeBundle } from '../../helpers/communities/hackertubeBundle'
import { isNewerExport } from '../../helpers/communities/kinds/hackertube'
import { SOURCE_KINDS_BY_KIND, recogniseSource } from '../../helpers/communities/kinds/index'
import { trySource } from '../../helpers/communities/follow'
import { createHostMemory, createPeerTubeLinkResolver, knownPeerTubeVideos } from '../../helpers/communities/peertubeLinks'
import { keepSourceFetch, lastAttemptOf, lastRefreshOf, refreshCommunitySources, refreshIsDue } from '../../helpers/communities/refresh'
import { sharesToPut } from '../../helpers/communities/shares'
import { hiddenSourcesWith } from '../../helpers/communities/sourceChips'
import { starterSources, starterSourcesToFollow } from '../../helpers/communities/starterSet'

/**
 * Communities: the sources followed and the shares they made, from
 * `community-sources.db` and `community-shares.db`, and each community
 * video's own details as the crawl fetched them, from `community-videos.db`,
 * loaded at startup and written through on every change.
 *
 * Each source's own data, too large to rewrite with its record on every
 * refresh (HackerTube's taxonomy), is kept apart, in
 * `community-source-data.db`, by source id, and is not backed up.
 *
 * Sources, source data, shares and details are frozen as they come in: there are
 * thousands of shares, nothing edits one in place, and a frozen object is
 * one Vue does not make deeply reactive, which also keeps a record one the
 * IPC to main can copy. A change replaces the record.
 *
 * The walls are worked out from the shares in `helpers/communities/shares.js`.
 *
 * A refresh asks every followed source what it shares now
 * (`helpers/communities/refresh.js`), and keeps on each source's record
 * when a refresh last worked for it (`checkedAt`), when one last asked it
 * (`attemptedAt`), and `failedAt` while its last refresh failed.
 *
 * The first open of Communities or a source's page (`openCommunities`), or
 * the first visit to the Sources page, follows the starter set once per
 * installation (`applyCommunitiesStarterSet`), marked done in the
 * `communitiesStarterSetDone` setting. Only a wall's open loads HackerTube's
 * bundle.
 *
 * A source is followed by a URL pasted on the Sources page, once asking it
 * has shown it can be (`helpers/communities/follow.js`), and unfollowed
 * there, which removes its record, its shares and its own data; the videos'
 * details stay, as they belong to the video.
 */

/** @import { Share, Source } from '../../helpers/communities/shares' */
/** @import { VideoDetails } from '../../helpers/communities/details' */

const state = {
  /** @type {Record<string, Source>} by `_id` */
  communitySources: {},
  /** @type {Record<string, Share>} by `_id` */
  communityShares: {},
  /** @type {Record<string, VideoDetails>} by `_id`, the video's ref as one string */
  communityVideos: {},
  /** @type {Record<string, Record<string, any>>} each source's own data, by source id */
  communitySourceData: {},
  communitiesReady: false,
  // The last read of the datastore failed, so what is held says nothing about
  // what is followed: nothing may be followed or loaded on the strength of it
  communitiesGrabFailed: false,
  // Other windows' writes that arrived while the datastore was being read,
  // applied once the read is in; null while no read is under way
  communitiesSyncBuffer: null,
  // The bundle being loaded into the datastore, the first time Communities is opened
  communitiesLoading: false,
  communitiesLoadFailed: false,
  // A refresh in this window, and how many of the sources it asks are done
  communitiesRefreshing: false,
  communitiesRefreshProgress: { done: 0, total: 0 },
}

const getters = {
  getCommunitiesReady: (state) => state.communitiesReady,
  getCommunitiesLoading: (state) => state.communitiesLoading,
  getCommunitiesLoadFailed: (state) => state.communitiesLoadFailed,
  getCommunitiesGrabFailed: (state) => state.communitiesGrabFailed,
  /** @returns {Source[]} */
  getCommunitySources: (state) => Object.values(state.communitySources),
  getCommunitySource: (state) => (id) => state.communitySources[id],
  /** @returns {Share[]} */
  getCommunityShares: (state) => Object.values(state.communityShares),
  /** @returns {(id: string) => Share | undefined} one share by its id (`shareId`), as the vote badge looks it up */
  getCommunityShare: (state) => (id) => state.communityShares[id],
  /** @returns {Record<string, VideoDetails>} by the video's ref as one string */
  getCommunityVideos: (state) => state.communityVideos,
  /** @returns {(sourceId: string) => Record<string, any> | undefined} a source's own data: HackerTube's is `{ generated, taxonomy }` */
  getCommunitySourceData: (state) => (sourceId) => state.communitySourceData[sourceId],
  getCommunitiesRefreshing: (state) => state.communitiesRefreshing,
  /** @returns {{ done: number, total: number }} sources asked, of those being asked */
  getCommunitiesRefreshProgress: (state) => state.communitiesRefreshProgress,
  /** @returns {number | null} when every followed source was last refreshed successfully by, in ms; null for never */
  getCommunitiesLastRefreshAt: (state) => lastRefreshOf(Object.values(state.communitySources)),
  /** @returns {Source[]} the followed sources whose last refresh failed */
  getCommunitiesRefreshFailures: (state) => Object.values(state.communitySources).filter(source => typeof source.failedAt === 'number'),
}

/** The one first open in flight, which a second open joins */
let opening = null

/** The one refresh in flight in this window, which a second refresh joins */
let refreshing = null

/** How many new sources one imported file may follow */
const IMPORT_FOLLOWS_AT_MOST = 100

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
  async grabCommunities({ commit }) {
    commit('startCommunitiesGrab')

    try {
      // All or none: details that could not be read would make the
      // crawl take every video for missing
      const [sources, shares, videos, sourceData] = await Promise.all([
        DBCommunityHandlers.findSources(),
        DBCommunityHandlers.findShares(),
        DBCommunityHandlers.findVideos(),
        DBCommunityHandlers.findSourceData(),
      ])

      commit('finishCommunitiesGrab', { sources, shares, videos, sourceData })
      commit('setCommunitiesGrabFailed', false)
    } catch (error) {
      console.error(error)
      commit('finishCommunitiesGrab', null)
      commit('setCommunitiesGrabFailed', true)
    } finally {
      commit('setCommunitiesReady', true)
    }
  },

  /**
   * Follows a source, by every way there is to follow one. A source newly
   * followed has its chip on Communities on, even one unfollowed earlier
   * with its chip off (helpers/communities/sourceChips.js); a chip that
   * cannot be turned on leaves the source followed.
   *
   * @param {any} context
   * @param {Source} source
   */
  async followCommunitySource({ commit, rootGetters, dispatch }, source) {
    await DBCommunityHandlers.upsertSource(source)
    commit('upsertCommunitySource', source)

    const hidden = rootGetters.getCommunitiesSourcesHidden
    const shown = hiddenSourcesWith(hidden, source._id, true)

    if (shown !== hidden) {
      try {
        await dispatch('updateCommunitiesSourcesHidden', shown)
      } catch (error) {
        console.error(`Communities: followed ${source._id}, but could not turn its chip on`, error)
      }
    }
  },

  /**
   * Follows the source a pasted URL names, once it has been tried
   * (`helpers/communities/follow.js`), and keeps at once what the trial
   * fetched, as a refresh would; HackerTube, whose videos come with the app,
   * has them loaded from the bundle. Nothing is followed when no kind
   * recognises the URL, when the source is followed already, when it serves
   * nothing its kind can read, or when it cannot be reached. A source
   * followed whose videos could then not be kept stays followed, marked
   * failed, for a refresh to bring them.
   *
   * The trial confirms no PeerTube link, so that following answers at the
   * pace of the feed alone. While PeerTube is switched on, a refresh of that
   * source alone then runs in the background, not waited for, which confirms
   * them, and marks the source failed if it fails, as any refresh does.
   *
   * @param {any} context
   * @param {string} url
   * @returns {Promise<{ outcome: 'followed', source: Source } | { outcome: 'unavailable' } | Exclude<import('../../helpers/communities/follow').SourceTrial, { outcome: 'followable' }>>}
   *   `unavailable` before the datastore is read, or when it could not be
   */
  async followCommunitySourceByUrl(context, url) {
    const { state, dispatch } = context

    // What is held says nothing yet of what is followed
    if (!state.communitiesReady || state.communitiesGrabFailed) {
      return { outcome: 'unavailable' }
    }

    const isFollowed = sourceId => Object.hasOwn(state.communitySources, sourceId)

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

    await dispatch('followCommunitySource', source)

    if (fetched === null) {
      // Loads the bundle, as the source has no shares and no export yet
      await dispatch('openCommunities')
    } else {
      try {
        await keepSourceFetch(refreshDependencies(context), source, fetched)
      } catch (error) {
        console.error(`Communities: could not keep what ${source._id} shares`, error)
        const at = Date.now()
        await dispatch('updateCommunitySource', { sourceId: source._id, fields: { attemptedAt: at, failedAt: at } })
      }

      // The trial confirms no PeerTube link; a refresh of this source alone,
      // not waited for, does, so that they need not wait for the next one
      if (context.rootGetters.getEnablePeerTube === true) {
        refreshCommunitySources({ ...refreshDependencies(context), sources: [source] }).catch((error) => {
          console.error(`Communities: could not refresh ${source._id} after following it`, error)
        })
      }
    }

    return { outcome: 'followed', source }
  },

  /**
   * Follows the sources an imported OPML file lists (`helpers/communities/opml.js`):
   * each feed URL a kind recognises, unless its source is followed already
   * (by an earlier line of the same file too). Nothing is asked of them
   * first, as the starter set asks nothing: a trial of each would make a
   * large file crawl, at up to 20 seconds a source that is down. Their videos
   * come with the refresh the next wall opened makes, due for a source never
   * asked; HackerTube's from the bundle, on that same open. A source that is
   * down is then followed and marked failed, as any refresh marks it.
   *
   * A follow that cannot be written stops the import and rejects; what was
   * followed before it stays followed.
   *
   * At most `IMPORT_FOLLOWS_AT_MOST` new sources are followed from one file,
   * as each is asked on every refresh; the rest are counted refused.
   *
   * @param {any} context
   * @param {string[]} urls the file's feed URLs, in its order
   * @returns {Promise<{ outcome: 'imported', followed: number, followedAlready: number, refused: number } | { outcome: 'unavailable' }>}
   *   `refused` counts the URLs no kind recognises; `unavailable` before the
   *   datastore is read, or when it could not be
   */
  async importCommunitySources({ state, dispatch }, urls) {
    // What is held says nothing yet of what is followed
    if (!state.communitiesReady || state.communitiesGrabFailed) {
      return { outcome: 'unavailable' }
    }

    const counts = { followed: 0, followedAlready: 0, refused: 0 }
    const now = Date.now()

    for (const url of urls) {
      const source = recogniseSource(url, now)

      if (source === null) {
        counts.refused++
      } else if (Object.hasOwn(state.communitySources, source._id)) {
        counts.followedAlready++
      } else if (counts.followed >= IMPORT_FOLLOWS_AT_MOST) {
        counts.refused++
      } else {
        await dispatch('followCommunitySource', source)
        counts.followed++
      }
    }

    return { outcome: 'imported', ...counts }
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
  async unfollowCommunitySource({ state, commit }, sourceId) {
    const held = {
      source: state.communitySources[sourceId],
      shares: Object.values(state.communityShares).filter(share => share.sourceId === sourceId),
      sourceData: state.communitySourceData[sourceId],
    }

    commit('removeCommunitySource', sourceId)

    try {
      await DBCommunityHandlers.removeSource(sourceId)
    } catch (error) {
      commit('restoreCommunitySource', held)
      throw error
    }

    commit('removeCommunitySource', sourceId)
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
  async putCommunityShares({ state, commit }, shares) {
    if (shares.length === 0) { return }

    const put = await DBCommunityHandlers.putShares(shares)
    const dropped = new Set(put?.dropped ?? [])

    const kept = shares.filter(share => !dropped.has(share._id) && Object.hasOwn(state.communitySources, share.sourceId))
    if (kept.length > 0) {
      commit('putCommunityShares', kept)
    }
  },

  /**
   * Keeps a source's own data, replacing what was kept for it
   *
   * @param {any} context
   * @param {{ _id: string }} record the source's id as `_id`, and its data
   */
  async putCommunitySourceData({ state, commit }, record) {
    const put = await DBCommunityHandlers.putSourceData(record)

    // Not for a source main does not follow, or one being unfollowed
    if (put?.kept !== false && Object.hasOwn(state.communitySources, record._id)) {
      commit('putCommunitySourceData', record)
    }
  },

  /**
   * Keeps videos' details, each replacing what was kept for its video
   *
   * @param {any} context
   * @param {VideoDetails[]} videos
   */
  async putCommunityVideos({ commit }, videos) {
    if (videos.length === 0) { return }

    await DBCommunityHandlers.putVideos(videos)
    commit('putCommunityVideos', videos)
  },

  /**
   * Follows the starter set (`helpers/communities/starterSet.js`), once per
   * installation: each starter source not followed already, and then the
   * `communitiesStarterSetDone` setting says it is done, so that nothing of
   * it is followed again and a starter source unfollowed stays unfollowed.
   * Nothing is asked of the sources: the refresh that opening a wall makes
   * brings their videos. A follow that fails leaves the set unmarked, for the
   * next open to follow the rest. Nothing before the datastore has been read,
   * or over one that could not be. One at a time: a second call joins it.
   *
   * @param {any} context
   * @returns {Promise<void>}
   */
  applyCommunitiesStarterSet(context) {
    applyingStarterSet ??= applyStarterSetOnce(context).finally(() => { applyingStarterSet = null })
    return applyingStarterSet
  },

  /**
   * What opening Communities does first, once the datastore has loaded: the
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
  openCommunities(context) {
    opening ??= openCommunitiesOnce(context).finally(() => { opening = null })
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
  async updateCommunitySource({ state, commit }, { sourceId, fields }) {
    const current = state.communitySources[sourceId]
    if (current === undefined) { return }

    const record = { ...current, ...fields }
    const { updated } = await DBCommunityHandlers.updateSource(record)

    if (updated > 0 && Object.hasOwn(state.communitySources, sourceId)) {
      commit('upsertCommunitySource', record)
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
  refreshCommunities(context) {
    refreshing ??= refreshCommunitiesOnce(context).finally(() => { refreshing = null })
    return refreshing
  },

  /**
   * What opening Communities does once it is open: a refresh, when the last
   * one, worked or not, was more than an hour ago (`refreshIsDue`), or never
   * was. Nothing with nothing followed.
   *
   * @param {any} context
   * @returns {Promise<void>}
   */
  async refreshCommunitiesIfDue({ state, dispatch }) {
    const sources = Object.values(state.communitySources)
    if (state.communitiesGrabFailed || sources.length === 0) { return }

    if (refreshIsDue(lastAttemptOf(sources), Date.now())) {
      await dispatch('refreshCommunities')
    }
  },

  setupCommunitiesSync({ commit }) {
    window.ftElectron.handleSyncCommunities((event, data) => {
      commit('applyCommunitiesSync', { event, data })
    })
  },
}

/**
 * @param {any} context
 */
async function openCommunitiesOnce({ state, commit, dispatch }) {
  if (state.communitiesGrabFailed) {
    await dispatch('grabCommunities')
  }

  // What is held may be empty only because it could not be read: taking it
  // for unfollowed would apply the starter set over it, and load the bundle
  // again
  if (state.communitiesGrabFailed) {
    commit('setCommunitiesLoadFailed', true)
    return
  }

  try {
    commit('setCommunitiesLoading', true)
    commit('setCommunitiesLoadFailed', false)

    await dispatch('applyCommunitiesStarterSet')

    // Not followed, as after an unfollow: nothing of its to load
    const source = state.communitySources[HACKERTUBE_SOURCE_ID]
    if (source == null) { return }

    const loaded = source.dataGenerated != null &&
      Object.values(state.communityShares).some(share => share.sourceId === HACKERTUBE_SOURCE_ID)

    if (loaded) { return }

    const bundle = await fetchHackerTubeBundle()

    // A refresh may have loaded a newer export while the bundle was read (an
    // open after a failed load, during a refresh): the bundle must not go
    // over it. Only a change made meanwhile counts: a date that was already
    // there, as after a restore, is one whose shares are missing.
    const meanwhile = state.communitySources[HACKERTUBE_SOURCE_ID]?.dataGenerated ?? null
    if (meanwhile !== null && meanwhile !== (source.dataGenerated ?? null) && !isNewerExport(bundle.generated, meanwhile)) {
      return
    }

    const seenAt = Date.now()
    const shares = bundle.videos.map(video => hackerTubeShare(video, seenAt)).filter(share => share !== null)

    // Those already kept as the bundle has them need no writing again
    await dispatch('putCommunityShares', sharesToPut(state.communityShares, shares))
    await dispatch('putCommunitySourceData', { _id: HACKERTUBE_SOURCE_ID, generated: bundle.generated, taxonomy: bundle.taxonomy })
    // Over the record as it is now, as another window may have written it
    // while the bundle loaded; and only while it is followed
    await dispatch('updateCommunitySource', { sourceId: HACKERTUBE_SOURCE_ID, fields: { dataGenerated: bundle.generated } })
  } catch (error) {
    console.error('Communities: could not load the HackerTube bundle', error)
    commit('setCommunitiesLoadFailed', true)
  } finally {
    commit('setCommunitiesLoading', false)
  }
}

/**
 * @param {any} context
 */
async function applyStarterSetOnce({ state, rootGetters, dispatch }) {
  // What is held says nothing yet of what is followed
  if (!state.communitiesReady || state.communitiesGrabFailed) { return }

  // Applied: not even the mark is written again
  const applied = rootGetters.getCommunitiesStarterSetDone === true
  if (applied) { return }

  const toFollow = starterSourcesToFollow(starterSources(Date.now()), {
    applied,
    isFollowed: sourceId => Object.hasOwn(state.communitySources, sourceId),
  })

  try {
    for (const source of toFollow) {
      // Followed meanwhile, from another window
      if (Object.hasOwn(state.communitySources, source._id)) { continue }
      await dispatch('followCommunitySource', source)
    }
  } catch (error) {
    // Unmarked, the next open follows what is still not followed
    console.error('Communities: could not follow the starter set', error)
    return
  }

  try {
    await dispatch('updateCommunitiesStarterSetDone', true)
  } catch (error) {
    // Unmarked, the next open applies it again, which follows nothing twice,
    // but follows again any of it unfollowed meanwhile
    console.error('Communities: followed the starter set, but could not mark it done', error)
  }
}

/**
 * The platform layer, as it is now. Imported when first asked for: the
 * wiring reaches the router and the store, which import this module.
 */
async function platformLayer() {
  const { getPlatformLayer } = await import('../../platform/vue')
  return getPlatformLayer()
}

/**
 * What confirms the PeerTube links a source shares, for one refresh
 * (`helpers/communities/peertubeLinks.js`); not for the trial of a source
 * followed by URL, which answers at the pace of its feed alone and leaves
 * its PeerTube links to the next refresh: through the platform
 * layer, while PeerTube is switched on; the videos kept known by uuid, and
 * what each host was found to be remembered in this installation's
 * localStorage; each confirmed video's details kept at once.
 *
 * @param {any} context
 * @returns {import('../../helpers/communities/kinds/index').PeerTubeLinks}
 */
function peerTubeLinks({ state, dispatch, rootGetters }) {
  return createPeerTubeLinkResolver({
    enabled: () => rootGetters.getEnablePeerTube === true,
    known: () => knownPeerTubeVideos(Object.values(state.communityShares), state.communityVideos),
    hosts: createHostMemory(localStorage),
    resolveUrl: async url => (await platformLayer()).resolveUrl(url),
    getVideoSummary: async ref => (await platformLayer()).getVideoSummary(ref),
    putDetails: records => dispatch('putCommunityVideos', records),
    now: () => Date.now(),
    onFailure: (message, error) => console.warn(message, error ?? ''),
  })
}

/**
 * What a refresh, and the follow that keeps what its trial fetched, need of
 * the store (`helpers/communities/refresh.js`)
 *
 * @param {any} context
 * @returns {Omit<import('../../helpers/communities/refresh').RefreshDependencies, 'sources'>}
 */
function refreshDependencies(context) {
  const { state, dispatch } = context

  return {
    kinds: SOURCE_KINDS_BY_KIND,
    // As it is when asked, so that a test can stand in for the network
    fetch: (...args) => fetch(...args),
    peertube: peerTubeLinks(context),
    now: () => Date.now(),
    keptShares: () => state.communityShares,
    isFollowed: sourceId => Object.hasOwn(state.communitySources, sourceId),
    putShares: shares => dispatch('putCommunityShares', shares),
    putSourceData: (sourceId, data) => dispatch('putCommunitySourceData', { ...data, _id: sourceId }),
    updateSource: (sourceId, fields) => dispatch('updateCommunitySource', { sourceId, fields }),
  }
}

/**
 * @param {any} context
 */
async function refreshCommunitiesOnce(context) {
  const { state, commit } = context

  if (opening !== null) {
    await opening
  }

  if (state.communitiesGrabFailed) { return }

  commit('setCommunitiesRefreshing', true)

  try {
    const { failed } = await refreshCommunitySources({
      ...refreshDependencies(context),
      sources: Object.values(state.communitySources),
      onProgress: progress => commit('setCommunitiesRefreshProgress', progress),
    })

    // The bundle could not be loaded, but HackerTube's export is in now
    const hackerTube = state.communitySources[HACKERTUBE_SOURCE_ID]
    if (state.communitiesLoadFailed && hackerTube?.dataGenerated != null && !failed.includes(HACKERTUBE_SOURCE_ID) &&
      Object.values(state.communityShares).some(share => share.sourceId === HACKERTUBE_SOURCE_ID)) {
      commit('setCommunitiesLoadFailed', false)
    }
  } finally {
    commit('setCommunitiesRefreshing', false)
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
  setCommunitiesReady(state, value) {
    state.communitiesReady = value
  },

  setCommunitiesLoading(state, value) {
    state.communitiesLoading = value
  },

  setCommunitiesLoadFailed(state, value) {
    state.communitiesLoadFailed = value
  },

  setCommunitiesGrabFailed(state, value) {
    state.communitiesGrabFailed = value
  },

  setCommunitiesRefreshing(state, value) {
    state.communitiesRefreshing = value
  },

  setCommunitiesRefreshProgress(state, progress) {
    state.communitiesRefreshProgress = progress
  },

  startCommunitiesGrab(state) {
    state.communitiesSyncBuffer ??= []
  },

  /**
   * @param {any} state
   * @param {{ sources: Source[], shares: Share[], videos: VideoDetails[], sourceData: { _id: string }[] } | null} read null when the read failed
   */
  finishCommunitiesGrab(state, read) {
    if (read !== null) {
      state.communitySources = Object.fromEntries(read.sources.map(source => [source._id, Object.freeze({ ...source })]))
      state.communityShares = withShares({}, read.shares)
      const videos = {}
      putVideos(videos, read.videos)
      state.communityVideos = videos
      state.communitySourceData = Object.fromEntries(read.sourceData.map(record => [record._id, Object.freeze({ ...record })]))
    }

    const buffered = state.communitiesSyncBuffer ?? []
    state.communitiesSyncBuffer = null

    for (const write of buffered) {
      mutations.applyCommunitiesSync(state, write)
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
  upsertCommunitySource(state, source) {
    state.communitySources = { ...state.communitySources, [source._id]: Object.freeze({ ...source }) }
  },

  /**
   * A source unfollowed: its record, its shares and its own data
   *
   * @param {any} state
   * @param {string} sourceId
   */
  removeCommunitySource(state, sourceId) {
    if (Object.hasOwn(state.communitySources, sourceId)) {
      const { [sourceId]: _source, ...sources } = state.communitySources
      state.communitySources = sources
    }

    if (Object.hasOwn(state.communitySourceData, sourceId)) {
      const { [sourceId]: _data, ...sourceData } = state.communitySourceData
      state.communitySourceData = sourceData
    }

    state.communityShares = Object.fromEntries(Object.entries(state.communityShares).filter(([, share]) => share.sourceId !== sourceId))
  },

  /**
   * A source whose unfollowing main refused, put back as it was held
   *
   * @param {any} state
   * @param {{ source?: Source, shares: Share[], sourceData?: Record<string, any> }} held
   */
  restoreCommunitySource(state, { source, shares, sourceData }) {
    if (source !== undefined) {
      mutations.upsertCommunitySource(state, source)
    }

    mutations.putCommunityShares(state, shares)

    if (sourceData !== undefined) {
      mutations.putCommunitySourceData(state, sourceData)
    }
  },

  putCommunitySourceData(state, record) {
    state.communitySourceData = { ...state.communitySourceData, [record._id]: Object.freeze({ ...record }) }
  },

  putCommunityShares(state, shares) {
    state.communityShares = withShares(state.communityShares, shares)
  },

  putCommunityVideos(state, videos) {
    putVideos(state.communityVideos, videos)
  },

  /**
   * Another window's write, as main passed it on
   * @param {any} state
   * @param {{ event: number, data: any }} payload
   */
  applyCommunitiesSync(state, { event, data }) {
    if (state.communitiesSyncBuffer !== null) {
      state.communitiesSyncBuffer.push({ event, data })
      return
    }

    switch (event) {
      case SyncEvents.COMMUNITIES.UPSERT_SOURCE:
        mutations.upsertCommunitySource(state, data)
        break

      case SyncEvents.COMMUNITIES.REMOVE_SOURCE:
        mutations.removeCommunitySource(state, data)
        break

      case SyncEvents.COMMUNITIES.PUT_SHARES:
        mutations.putCommunityShares(state, data)
        break

      case SyncEvents.COMMUNITIES.PUT_VIDEOS:
        mutations.putCommunityVideos(state, data)
        break

      case SyncEvents.COMMUNITIES.PUT_SOURCE_DATA:
        mutations.putCommunitySourceData(state, data)
        break

      default:
        console.error('communities: invalid sync event received')
    }
  },
}

export default {
  state,
  getters,
  actions,
  mutations
}
