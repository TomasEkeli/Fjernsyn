import { toValue, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { MAIN_PROFILE_ID } from '../../constants'
import { DBPlaylistHandlers } from '../../datastores/handlers/index'

/**
 * Loads again the sections main's backup keeper changed in the datastores
 * while the app ran, when it merged another machine's changes, so that every
 * window shows them without a relaunch. Each section is loaded as App loads it
 * at startup, with the exceptions below, which keep a load in the middle of a
 * session from doing what only a start should:
 *
 * - settings: only those that changed, with their side effects, rather than
 *   grabUserSettings, which runs every side effect again and so resets the
 *   session's volume and mute to the default;
 * - profiles: the active profile is kept, which grabAllProfiles replaces with
 *   the default profile whenever the list grows; a profile removed falls back
 *   to All Channels, as deleting it here does;
 * - playlists: a datastore left with none empties the list, where
 *   grabAllPlaylists would keep the old ones and make Favorites again, once
 *   in each window. The next start makes it, as every start does.
 *
 * - history: the entries main sends are put in place and the ones gone
 *   removed, rather than the whole history loaded again, which with its
 *   descriptions is tens of megabytes, and would come every minute while
 *   another machine plays.
 *
 * A change that comes before the window's data has loaded is held, and
 * loaded once it has: the startup load may have read the datastores before
 * the change, and nothing may load before the settings have.
 */

/**
 * The sections a sync file holds, as the keeper names them
 * @typedef {'profiles' | 'history' | 'playlists' | 'later' | 'searchHistory' | 'settings' | 'channels' | 'aiVerdicts'} KeeperSection
 */

/** Each section but settings and profiles, which go first, and its action */
const GRAB_ACTIONS = {
  history: 'grabHistory',
  later: 'grabLater',
  searchHistory: 'grabSearchHistoryEntries',
  channels: 'grabChannels',
  aiVerdicts: 'grabAiVerdicts',
}

/**
 * @param {import('vuex').Store<any>} store
 * @param {string} defaultProfileName
 */
async function reloadProfiles(store, defaultProfileName) {
  const active = store.state.profiles.activeProfile

  await store.dispatch('grabAllProfiles', defaultProfileName)

  const kept = store.state.profiles.profileList.some(profile => profile._id === active)
  store.commit('setActiveProfile', kept ? active : MAIN_PROFILE_ID)

  // The subscriptions' cache is kept for the channels the profiles hold
  await store.dispatch('grabAllSubscriptions')
}

/** @param {import('vuex').Store<any>} store */
async function reloadPlaylists(store) {
  const playlists = await DBPlaylistHandlers.find()

  if (playlists.length === 0) {
    store.commit('setAllPlaylists', [])
    return
  }

  await store.dispatch('grabAllPlaylists')
}

/**
 * The history's changes put into the history store as they are, its order by
 * when each was watched kept
 * @param {import('vuex').Store<any>} store
 * @param {{ put: Record<string, any>[], removed: string[] }} changes
 */
function applyHistory(store, { put, removed }) {
  for (const videoId of removed) {
    store.commit('removeFromHistoryCacheById', videoId)
  }

  // Each is put at the top, as a video just watched is; an entry from the
  // other machine may have been watched long ago, so the order is checked
  for (const record of put) {
    store.commit('upsertToHistoryCache', record)
  }

  const sorted = store.state.history.historyCacheSorted
  const inOrder = sorted.every((record, index) => index === 0 || sorted[index - 1].timeWatched >= record.timeWatched)

  if (!inOrder) {
    store.commit('setHistoryCacheSorted', [...sorted].sort((a, b) => b.timeWatched - a.timeWatched))
  }
}

/**
 * @param {import('vuex').Store<any>} store
 * @param {Set<string>} sections
 * @param {string} defaultProfileName
 * @param {{ put: Record<string, any>[], removed: string[] } | null} [historyChanges] the history's changes, applied in place of loading it again
 */
async function reload(store, sections, defaultProfileName, historyChanges = null) {
  // As at startup, the settings before anything that reads them
  if (sections.has('settings')) {
    await store.dispatch('grabChangedUserSettings')
  }

  const loads = []

  if (sections.has('profiles')) {
    loads.push(reloadProfiles(store, defaultProfileName))
  }

  if (sections.has('playlists')) {
    loads.push(reloadPlaylists(store))
  }

  for (const [section, action] of Object.entries(GRAB_ACTIONS)) {
    if (!sections.has(section)) { continue }

    if (section === 'history' && historyChanges !== null) {
      applyHistory(store, historyChanges)
    } else {
      loads.push(store.dispatch(action))
    }
  }

  await Promise.all(loads)
}

/**
 * The bridge the listener is registered on. The preload gives no way to
 * remove a listener, so a window registers one; kept as the bridge rather than
 * a flag, as a test replaces the bridge along with its stubs.
 */
let listeningTo = null

/**
 * What the listener hands the changes to: the window's latest use
 * @type {(changes: { sections: string[], history: { put: Record<string, any>[], removed: string[] } | null }) => void}
 */
let receive = () => {}

/**
 * Registers the window's listener. Called once per window, from a component
 * every window mounts.
 * @param {import('vuex').Store<any>} store
 * @param {import('vue').MaybeRefOrGetter<boolean>} dataLoaded whether the window's data has loaded
 */
export function useKeeperRefresh(store, dataLoaded) {
  if (!process.env.IS_ELECTRON) {
    return
  }

  const { t } = useI18n()

  /** Sections changed before the data had loaded */
  const held = new Set()

  // One load at a time, so that an older one never lands over a newer
  let loading = Promise.resolve()

  /**
   * @param {Iterable<string>} sections
   * @param {{ put: Record<string, any>[], removed: string[] } | null} [historyChanges]
   */
  function load(sections, historyChanges = null) {
    const wanted = new Set(sections)

    loading = loading
      .then(() => reload(store, wanted, t('Profile.All Channels'), historyChanges))
      .catch(error => console.error('Could not load again what the backup keeper changed', error))
  }

  receive = ({ sections, history }) => {
    if (toValue(dataLoaded)) {
      load(sections, history)
    } else {
      // Held changes are loaded whole once the data has: a load in between
      // may or may not have read them
      sections.forEach(section => held.add(section))
    }
  }

  if (listeningTo !== window.ftElectron) {
    listeningTo = window.ftElectron
    window.ftElectron.handleKeeperDataChanged(changes => receive(changes))
  }

  watch(() => toValue(dataLoaded), (loaded) => {
    if (loaded && held.size > 0) {
      const sections = [...held]
      held.clear()
      load(sections)
    }
  })
}
