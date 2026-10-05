import i18n, { loadLocale } from '../../i18n/index'
import allLocales from '../../../../static/locales/activeLocales.json'
import { MAIN_PROFILE_ID, SyncEvents } from '../../../constants'
import { DBSettingHandlers } from '../../../datastores/handlers/index'
import { getSystemLocale, showToast } from '../../helpers/utils'

/*
 * Due to the complexity of the settings module in FreeTube, a more
 * in-depth explanation for adding new settings is required.
 *
 * The explanation will be written with the assumption that
 * the reader knows how Vuex works.
 *
 * And no, there's no need to read the entire wall of text.
 * We'll direct you where you need to go as we walk you through it.
 * Additionally, the text actually looks bigger than it truly is.
 * Each line has, at most, 72 characters.
 *
 ****
 * Introduction
 *
 * You can add a new setting in two different methods.
 *
 * The first method benefits from the auto-generation of
 * a getter, a mutation and a few actions related to the setting.
 * This method should be preferred whenever possible:
 * - `state`
 *
 * The last one DOES NOT feature any kind of auto-generation and should
 * only be used in scenarios that don't fall under the other 2 options:
 * - `customState`
 *
 ****
 * ASIDE:
 * The aforementioned "side effects" cover a large area
 * of interactions with other modules
 * A good example would be a setting that utilizes the Electron API
 * when its value changes.
 *
 ****
 * First and foremost, you have to understand what type of setting
 * you intend to add to the app.
 *
 * You'll have to select one of these three scenarios:
 *
 * 1) You just want to add a simple setting that does not actively
 *    interact with the Electron API, `localStorage` or
 *    other parts outside of the settings module.
 * -> Please consult the `state` section.
 *
 * 2) You want to add a more complex setting that interacts
 *    with other parts of the app and tech stack.
 * -> Please consult the `state` and `sideEffectHandlers` sections.
 *
 * 3) You want to add a completely custom state based setting
 *    that does not work like the usual settings.
 * -> Please consult the `state` and `customState` sections.
 *
 ****
 * `state`
 * This object contains settings that have NO SIDE EFFECTS.
 *
 * A getter, mutation and an action function is auto-generated
 * for every setting present in the `state` object.
 * They have the following format (exemplified with setting 'example'):
 *
 * Getter: `getExample` (gets the value from current state)
 * Mutation:
 *   `setExample`
 *     (takes a value
 *      and uses it to update the current state)
 * Action:
 *   `updateExample`
 *     (takes a value,
 *      saves it to the database
 *      and calls `setExample` with it)
 *
 ***
 * `sideEffectHandlers`
 * This object contains the side-effect handlers for settings that have SIDE EFFECTS.
 *
 * Each one of these settings must specify a handler,
 *   which should essentially be a callback of type
 *   `(store, value) => void` (the same as you would use for an `action`)
 *   that deals with the side effects for that setting
 *
 * NOTE: Example implementations of such handlers can be found
 * in the `sideEffectHandlers` object in case
 * the explanation isn't clear enough.
 *
 * All functions auto-generated for settings in `state`
 * (if you haven't read the `state` section, do it now),
 * are also auto-generated for settings in `sideEffectHandlers,
 * with a few key differences (exemplified with setting 'example'):
 *
 * - an additional action is auto-generated:
 *   - `triggerExampleSideEffects`
 *       (triggers the `handler` for that setting;
 *        you'll most likely never call this directly)
 *
 * - the behavior of `updateExample` changes a bit:
 *   - `updateExample`
 *       (saves value to the database,
 *        calls `triggerExampleSideEffects` and calls `setExample`)
 *
 ***
 * `customState`
 * This object contains settings that
 * don't linearly fall under the other two options.
 *
 * No auto-generation of any kind is performed
 * when a setting is added to `customState`
 *
 * You must manually add any getters, mutations and actions to
 * `customGetters`, `customMutations` and `customActions` respectively
 * that you find appropriate for that setting.
 *
 * NOTE:
 * When adding a setting to the `customState`,
 * additional consultation with the FreeTube team is preferred
 * to evaluate if it is truly necessary
 * and to ensure that the implementation works as intended.
 *
 ***
 * `NON_TRANSFERABLE_SETTINGS`
 * This set contains setting keys
 * that should not be exported when a user chooses to "Export settings".
 *
 * When adding a new setting, it should be considered
 * whether this setting can be exported or not. For example, settings
 * that are OS or user specific like paths should not be exported.
 *
 ****
 * ENDING NOTES
 *
 * Only two more things that need mentioning.
 *
 * 1) It's perfectly fine to add extra functionality
 *    to the `customGetters`, `customMutations` and `customActions`,
 *    whether it's related to a setting or just serving as
 *    standalone functionality for the module
 *    (e.g. `grabUserSettings` (standalone action))
 *
 * 2) It's also possible to OVERRIDE auto-generated functionality by
 *    adding functions with the same identifier to
 *    the respective `custom__` object,
 *    but you must have an acceptable reason for doing so.
 ****
 */

// HELPERS
const capitalize = str => str.charAt(0).toUpperCase() + str.slice(1)
const defaultGetterId = settingId => 'get' + capitalize(settingId)
const defaultMutationId = settingId => 'set' + capitalize(settingId)
export const defaultUpdaterId = settingId => 'update' + capitalize(settingId)
const defaultSideEffectsTriggerId = settingId =>
  'trigger' + capitalize(settingId) + 'SideEffects'
/*****/

const state = {
  autoplayPlaylists: true,
  autoplayVideos: true,
  backendFallback: false,
  backendPreference: !process.env.SUPPORTS_LOCAL_API ? 'invidious' : 'local',
  barColor: false,
  baseTheme: 'system',
  mainColor: 'Red',
  secColor: 'Blue',
  defaultAutoplayInterruptionIntervalHours: 3,
  defaultCaptionSettings: '{}',
  defaultInterval: 5,
  defaultPlayback: 1,
  defaultProfile: MAIN_PROFILE_ID,
  defaultQuality: '720',
  defaultSkipInterval: 5,
  defaultViewingMode: 'default',
  defaultVideoFormat: 'dash',
  // Which profiles are open as columns on the Channels page, by id, in the
  // order they were opened, as last changed in any window. Each window keeps
  // its own open columns; this is where a new window, or the first after a
  // restart, starts from. A profile deleted since is dropped when read.
  channelsOverviewOpenProfiles: [],
  // The user's order of profiles, by id, which every list of profiles
  // follows. All Channels is always first and is never in it; a profile it
  // does not name comes after those it does, alphabetically, and a deleted
  // one is skipped when read.
  profileOrder: [],
  // Channels the Channels page is not to suggest moving, as the user said to
  // keep them where they are: channel id to the profile kept in. An entry
  // applies only while that is the channel's one profile, and is dropped the
  // next time one is added once it no longer does.
  profileSuggestionKeeps: {},
  // Each profile's picture, drawn in its bubble in place of its initial:
  // profile id to a symbol, an icon or an image (see
  // helpers/profilePictures.js). Read through readProfilePicture, never
  // directly; a deleted profile's entry is dropped by the next write.
  profilePictures: {},
  disableSmoothScrolling: false,
  // No title bar from the OS; the window moves by a long press and a drag.
  // Read by the main process at startup, so a change applies on the next start.
  framelessWindow: true,
  disableChannelLinks: false,
  displayVideoPlayButton: false,
  enableRegulatedStreaming: false,
  // PeerTube through the platform layer (experimental): the switch, the search source, NSFW results
  enablePeerTube: false,
  peerTubeSearchSource: 'https://sepiasearch.org',
  peerTubeShowNsfw: false,
  // The search page on the platform layer: where the search box searches by
  // default (`youtube`, `peertube` or `all`), the parameters of the last
  // filtered search (`null` for none; read through platform/search/query.js
  // `readRemembered`), and whether the next search from the search box gets them
  defaultSearchScope: 'all',
  searchRememberedParameters: null,
  searchLatched: false,
  // The surface switch (experimental, ADR-0018): the layer's views in place of
  // upstream's for every YouTube surface on it (platform/routes.js `layerSurface`)
  enableLayerSurfaces: false,
  enableSearchSuggestions: true,
  enableSubtitlesByDefault: false,
  enterFullscreenOnDisplayRotate: false,
  // Reshape the window to the video's ratio while the player is in full
  // window, so it has no black bars (see src/main/windowGeometry.js)
  fitWindowToVideo: true,
  externalLinkHandling: '',
  externalPlayer: '',
  externalPlayerExecutable: '',
  externalPlayerIgnoreWarnings: false,
  externalPlayerIgnoreDefaultArgs: false,
  externalPlayerCustomArgs: '[]',
  showAddedExternalPlayerCustomArgs: true,
  expandSideBar: false,
  hideActiveSubscriptions: false,
  hideChannelCommunity: false,
  hideChannelHome: false,
  hideChannelPlaylists: false,
  hideChannelReleases: false,
  hideChannelPodcasts: false,
  hideChannelCourses: false,
  hideChannelShorts: false,
  hideChannelSubscriptions: false,
  hideCommentLikes: false,
  hideCommentPhotos: false,
  hideComments: false,
  // Whether the Explore page is offered at all: sidebar entry, app menu entry
  // and landing-page choice. Called `hideTrendingVideos` until the page was
  // renamed; the old row is left where it lies, unread by anything.
  hideExplore: false,
  hideFeaturedChannels: false,
  channelsHidden: '[]',
  forbiddenTitles: '[]',
  showAddedChannelsHidden: true,
  showAddedForbiddenTitles: true,
  hideVideoDescription: false,
  hideLiveChat: false,
  hideLiveStreams: false,
  hideHeaderLogo: false,
  hidePlaylists: false,
  hidePopularVideos: false,
  hideRecommendedVideos: false,
  hideSearchBar: false,
  hideSharingActions: false,
  hideUnsubscribeButton: false,
  hideUpcomingPremieres: false,
  hideVideoLikesAndDislikes: false,
  hideVideoViews: false,
  hideWatchedSubs: false,
  // Whether the walls hide videos made with AI: YouTube's "Made with AI"
  // label and the channels marked as AI below. Off, so they are shown and
  // marked; the AI pill on each wall switches it (helpers/aiShown.js)
  hideAiVideos: false,
  // Channels the user marked as AI, every video of which carries the AI
  // marker without being asked about: a JSON list of { id, name }, as
  // channelsHidden is a JSON list, so a settings export carries it
  aiChannels: '[]',
  hideUploader: false,
  unsubscriptionPopupStatus: false,
  hideLabelsSideBar: false,
  hideChapters: false,
  showDistractionFreeTitles: false,
  listType: 'grid',
  // Shows a live's chat over the video, on its right, in every viewing mode.
  // Toggled from the chat button on the player only, as the pin is, and kept
  // from one live to the next.
  liveChatOverlay: false,
  maxVideoPlaybackRate: 3,
  // The volume slider's ceiling, as a percentage. Anything above 100% is
  // achieved with a Web Audio gain stage, as the video element itself stops at 100%.
  // 1000% is +20 dB, which covers the quietest content seen in the wild
  // (-18.9 dB, needing 883%) without the loudness correction being clamped.
  // Set this to 100 to disable volume boost entirely.
  maxVolume: 1000,
  // Correct each video's volume for how loud it was mastered, using the loudness
  // YouTube reports. Off by default because it is two-way: loud videos get quieter.
  normalizeLoudness: false,
  onlyShowLatestFromChannel: false,
  onlyShowLatestFromChannelNumber: 1,
  openDeepLinksInNewWindow: false,
  // Keeps the player's controls on screen instead of letting them fade once the
  // mouse goes still. Toggled from the pin button on the player itself, so the
  // choice is made where it is felt and outlives the video it was made on.
  pinPlayerControls: false,
  playNextVideo: false,
  proxyHostname: '127.0.0.1',
  proxyPort: '9050',
  proxyUsername: '',
  proxyPassword: '',
  proxyProtocol: 'socks5',
  proxyVideos: !process.env.SUPPORTS_LOCAL_API,
  region: 'US',
  // The Explore destinations the reader has switched off, by id. What is off
  // rather than what is on, so that a destination the app learns about later
  // arrives switched on: the page is there to show what YouTube is pushing, and
  // a new chart nobody has an opinion about yet belongs in the stream.
  //
  // A standing preference rather than a session's, like the subscriptions
  // chips: whoever has no use for sport today has none tomorrow either.
  exploreCategoriesHidden: [],
  // The regions Explore offers as one-click shortcuts. Two lists, because they
  // answer two different questions: `Recent` is where you have been, kept
  // automatically and short; `Pinned` is where you mean to keep going, said
  // deliberately and kept until unsaid. Newest first in both.
  exploreRegionsRecent: [],
  exploreRegionsPinned: [],
  rememberHistory: true,
  rememberSearchHistory: true,
  // 'auto', 'semi-auto', 'never'
  watchedProgressSavingMode: 'auto',
  saveVideoHistoryWithLastViewedPlaylist: true,
  showFamilyFriendlyOnly: false,
  // YouTube's "most replayed" curve above the player's seek bar, shown with the
  // controls, for videos YouTube sends one for.
  showMostReplayedHeatmap: true,
  // Which kinds the subscriptions stream shows, one per chip in the row above
  // it. A standing preference rather than a session's, which is why it is here
  // and not in `sessionStorage`: the reader who never watches shorts wants them
  // gone tomorrow as well.
  //
  // Only what is shown. Every kind is fetched every refresh whatever these say
  // — see `fetchedSubscriptionFeeds` — so that switching one on is instant.
  showSubscriptionsVideos: true,
  showSubscriptionsShorts: true,
  showSubscriptionsLive: true,
  showSubscriptionsPosts: true,
  // Whether the shelf of scheduled premieres and live streams over the
  // subscriptions stream is open. Here rather than in `sessionStorage` because
  // whoever folded it away meant it, and meant it tomorrow as well. Folded to
  // begin with: the shelf is a schedule rather than news, and its one line says
  // it is there without opening itself over the stream anyone came for. Only
  // the default moved — a stored choice is read as it always was, so nobody who
  // opened it finds it closed again.
  upcomingShelfExpanded: false,
  // Whether the Scheduled shelf over the Later page's queue is open. Kept for
  // the same reason as the one above. Open to begin with, unlike that one: its
  // rows are one line each and only the soonest few are shown, so open it
  // costs a few lines, and folded it would hide which streams are coming.
  laterScheduleExpanded: true,
  sponsorBlockShowSkippedToast: true,
  sponsorBlockUrl: 'https://sponsor.ajay.app',
  sponsorBlockSponsor: {
    color: 'Green',
    skip: 'autoSkip'
  },
  sponsorBlockSelfPromo: {
    color: 'Yellow',
    skip: 'showInSeekBar'
  },
  sponsorBlockInteraction: {
    color: 'Pink',
    skip: 'showInSeekBar'
  },
  sponsorBlockIntro: {
    color: 'Cyan',
    skip: 'doNothing'
  },
  sponsorBlockOutro: {
    color: 'Blue',
    skip: 'doNothing'
  },
  sponsorBlockRecap: {
    color: 'Indigo',
    skip: 'doNothing'
  },
  sponsorBlockMusicOffTopic: {
    color: 'Orange',
    skip: 'doNothing'
  },
  sponsorBlockFiller: {
    color: 'Purple',
    skip: 'doNothing'
  },
  thumbnailPreference: '',
  blurThumbnails: false,
  useProxy: false,
  userPlaylistSortOrder: 'date_added_descending',
  useRssFeeds: false,
  useSponsorBlock: false,
  videoVolumeMouseScroll: false,
  videoPlaybackRateMouseScroll: false,
  videoSkipMouseScroll: false,
  videoPlaybackRateInterval: 0.25,
  enableScreenshot: false,
  screenshotMode: 'prompt_folder',
  screenshotFormat: 'png',
  screenshotQuality: 95,
  screenshotFolderPath: '',
  screenshotFilenamePattern: '%Y%M%D-%H%N%S',
  settingsSectionSortEnabled: false,
  fetchSubscriptionsAutomatically: true,
  // Fill in the details RSS feeds leave out, notably the video duration, in the
  // background for the part of the subscription feed on screen
  subscriptionBackfillDetails: true,
  // After a refresh that could not reach some channels, go back for them in the
  // background: by profile, then one at a time
  subscriptionAutoRecovery: true,
  settingsPassword: '',
  useDeArrowTitles: false,
  useDeArrowThumbnails: false,
  deArrowThumbnailGeneratorUrl: 'https://dearrow-thumb.ajay.app',
  sponsorBlockExcludedChannels: '[]',
  sponsorBlockShowExcludedChannels: true,
  // This makes the `favorites` playlist uses as quick bookmark target
  // If the playlist is removed quick bookmark is disabled
  quickBookmarkTargetPlaylistId: 'favorites',
  // Set once the built-in Watch Later playlist has been moved into the Later
  // list (composables/useLaterTakeover.js), so that a playlist named Watch
  // Later made afterwards, which upstream gives the same id, stays a playlist
  laterTakeoverDone: false,
  generalAutoLoadMorePaginatedItemsEnabled: false,
  commentAutoLoadEnabled: true,
  hideToTrayOnMinimize: false,
  // Claim freetube:// links as well as fjernsyn:// ones, for the browser
  // redirect extensions. Electron only; main claims or releases the scheme.
  handleFreeTubeLinks: true,
  // Download with yt-dlp, Electron only. The button on the watch page shows
  // only while this is on.
  ytDlpEnabled: false,
  // Empty for the system Downloads folder. Only main's folder picker may set
  // it; the renderer may only clear it.
  ytDlpDownloadFolder: '',
  // Empty to look in FreeTube's own tools folder and then on PATH. Only main's
  // file picker may set it; the renderer may only clear it.
  ytDlpExecutablePath: '',
  // A JSON array of strings, like the external player's
  ytDlpCustomArgs: '[]',
  // A random id made once per data folder by main (src/main/backup/), which
  // goes in every backup's header so a backup says which installation wrote
  // it. Nothing in the renderer writes it, and no backup carries it as a
  // setting, so no restore overwrites it.
  installationId: '',

  // The settings below have side effects
  currentLocale: 'system',
  defaultInvidiousInstance: '',
  defaultVolume: 1,
  uiScale: 100,
  userPlaylistsSortBy: 'latest_played_first',
  userHistorySortBy: 'latest_played_first',
}

const sideEffectHandlers = {
  currentLocale: async ({ dispatch }, value) => {
    const fallbackLocale = 'en-US'

    let targetLocale = value
    if (value === 'system') {
      const systemLocaleName = (await getSystemLocale()).replace('_', '-') // ex: en-US
      const systemLocaleSplit = systemLocaleName.split('-') // ex: en
      const targetLocaleOptions = allLocales.filter((locale) => {
        // filter out other languages
        const localeLang = locale.split('-')[0]
        return localeLang.includes(systemLocaleSplit[0])
      }).sort((aLocaleName, bLocaleName) => {
        const aLocale = aLocaleName.split('-') // ex: [en, US]
        const bLocale = bLocaleName.split('-')

        if (aLocaleName === systemLocaleName) { // country & language match, prefer a
          return -1
        } else if (bLocaleName === systemLocaleName) { // country & language match, prefer b
          return 1
        } else if (aLocale.length === 1) { // no country code for a, prefer a
          return -1
        } else if (bLocale.length === 1) { // no country code for b, prefer b
          return 1
        } else { // a & b have different country code from system, sort alphabetically
          return aLocaleName.localeCompare(bLocaleName)
        }
      })

      if (targetLocaleOptions.length > 0) {
        targetLocale = targetLocaleOptions[0]
      } else {
        // Go back to default value if locale is unavailable
        targetLocale = fallbackLocale
        // Translating this string isn't necessary
        // because the user will always see it in the default locale
        // (in this case, English (US))
        showToast(`Locale not found, defaulting to ${fallbackLocale}`)
      }
    }

    const loadPromises = []

    // "es" is used as a fallback for "es-AR" and "es-MX"
    if (targetLocale === 'es-AR' || targetLocale === 'es-MX') {
      loadPromises.push(
        loadLocale('es')
      )
    }

    // "pt" is used as a fallback for "pt-PT" and "pt-BR"
    if (targetLocale === 'pt-PT' || targetLocale === 'pt-BR') {
      loadPromises.push(
        loadLocale('pt')
      )
    }

    loadPromises.push(
      loadLocale(targetLocale)
    )

    await Promise.allSettled(loadPromises)

    i18n.global.locale.value = targetLocale
    await dispatch('getRegionData', targetLocale)
  },

  defaultInvidiousInstance: ({ commit, rootState }, value) => {
    if (value !== '' && rootState.invidious.currentInvidiousInstance !== value) {
      commit('setCurrentInvidiousInstance', value)
    }
  },

  defaultVolume: (_, value) => {
    // The video element refuses volumes above 1, so a preference above 100% is
    // split into the part it can do and a gain factor for the rest.
    // `volume` and `gain` always multiply to the requested volume.
    sessionStorage.setItem('volume', Math.min(value, 1).toString())
    sessionStorage.setItem('gain', Math.max(value, 1).toString())
    value === 0 ? sessionStorage.setItem('muted', 'true') : sessionStorage.setItem('muted', 'false')
    sessionStorage.setItem('defaultVolume', value)
  },

  uiScale: (_, value) => {
    if (process.env.IS_ELECTRON) {
      window.ftElectron.setZoomFactor(value / 100)
    }
  },

  maxVideoPlaybackRate: ({ dispatch, state }, value) => {
    if (state.defaultPlayback > value) {
      dispatch('updateDefaultPlayback', value)
    }
  },

  maxVolume: ({ dispatch, state }, value) => {
    if (state.defaultVolume * 100 > value) {
      dispatch('updateDefaultVolume', value / 100)
    }
  },

  videoPlaybackRateInterval: ({ dispatch, state }, value) => {
    const correctedDefaultPlaybackRate = value * Math.round(state.defaultPlayback / value)

    if (state.defaultPlayback !== correctedDefaultPlaybackRate) {
      dispatch('updateDefaultPlayback', correctedDefaultPlaybackRate)
    }
  },
}

const settingsWithSideEffects = Object.keys(sideEffectHandlers)

export const NON_TRANSFERABLE_SETTINGS = new Set([
  /* Depends on process.env.IS_ELECTRON */
  // ProxySettings
  'useProxy',
  'proxyProtocol',
  'proxyHostname',
  'proxyPort',
  'proxyUsername',
  'proxyPassword',
  // ExternalPlayerSettings
  'externalPlayer',
  'externalPlayerExecutable',
  'externalPlayerIgnoreWarnings',
  'externalPlayerIgnoreDefaultArgs',
  'externalPlayerCustomArgs',
  'showAddedExternalPlayerCustomArgs',
  // Others
  'disableSmoothScrolling',
  'framelessWindow',
  'fitWindowToVideo',
  'hideToTrayOnMinimize',
  'handleFreeTubeLinks',
  'screenshotAskPath',
  'screenshotFolderPath',
  // YtDlpSettings
  'ytDlpEnabled',
  'ytDlpDownloadFolder',
  'ytDlpExecutablePath',
  'ytDlpCustomArgs',
  // Backup
  'installationId',

  /* Depends on process.env.SUPPORTS_LOCAL_API */
  'backendFallback',
  'backendPreference',
  'proxyVideos',
])

const customState = {
}

const customGetters = {
}

const customMutations = {}

const customActions = {
  grabUserSettings: async ({ commit, dispatch, state }) => {
    try {
      const userSettings = await DBSettingHandlers.find()

      const mutationIds = Object.keys(mutations)

      const alreadyTriggeredSideEffects = []

      for (const { _id, value } of userSettings) {
        if (settingsWithSideEffects.includes(_id)) {
          dispatch(defaultSideEffectsTriggerId(_id), value)
          alreadyTriggeredSideEffects.push(_id)
        }

        if (mutationIds.includes(defaultMutationId(_id))) {
          commit(defaultMutationId(_id), value)
        }
      }

      for (const _id of settingsWithSideEffects) {
        if (!alreadyTriggeredSideEffects.includes(_id)) {
          dispatch(defaultSideEffectsTriggerId(_id), state[_id])
        }
      }
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  // Should be a root action, but we'll tolerate
  setupListenersToSyncWindows: ({ commit, dispatch }) => {
    if (process.env.IS_ELECTRON) {
      window.ftElectron.handleSyncSettings((event, data) => {
        switch (event) {
          case SyncEvents.GENERAL.UPSERT:
            if (settingsWithSideEffects.includes(data._id)) {
              dispatch(defaultSideEffectsTriggerId(data._id), data.value)
            }

            commit(defaultMutationId(data._id), data.value)
            break

          default:
            console.error('settings: invalid sync event received')
        }
      })

      window.ftElectron.handleSyncHistory((event, data) => {
        switch (event) {
          case SyncEvents.GENERAL.UPSERT:
            commit('upsertToHistoryCache', data)
            break

          case SyncEvents.GENERAL.OVERWRITE: {
            const byId = {}
            data.forEach(video => {
              byId[video.videoId] = video
            })

            // It comes pre-sorted, so we don't have to sort it here
            commit('setHistoryCacheSorted', data)
            commit('setHistoryCacheById', byId)
            break
          }

          case SyncEvents.HISTORY.UPDATE_WATCH_PROGRESS:
            commit('updateRecordWatchProgressInHistoryCache', data)
            break

          case SyncEvents.HISTORY.UPDATE_PLAYLIST:
            commit('updateRecordLastViewedPlaylistIdInHistoryCache', data)
            break

          case SyncEvents.GENERAL.DELETE:
            commit('removeFromHistoryCacheById', data)
            break

          case SyncEvents.GENERAL.DELETE_ALL:
            commit('setHistoryCacheSorted', [])
            commit('setHistoryCacheById', {})
            break

          default:
            console.error('history: invalid sync event received')
        }
      })

      window.ftElectron.handleSyncSearchHistory((event, data) => {
        switch (event) {
          case SyncEvents.GENERAL.UPSERT:
            commit('upsertSearchHistoryEntryToList', data)
            break

          case SyncEvents.GENERAL.OVERWRITE:
            // It comes pre-sorted, so we don't have to sort it here
            commit('setSearchHistoryEntries', data)
            break

          case SyncEvents.GENERAL.DELETE:
            commit('removeSearchHistoryEntryFromList', data)
            break

          case SyncEvents.GENERAL.DELETE_ALL:
            commit('setSearchHistoryEntries', [])
            break

          default:
            console.error('search history: invalid sync event received')
        }
      })

      window.ftElectron.handleSyncProfiles((event, data) => {
        switch (event) {
          case SyncEvents.GENERAL.CREATE:
            commit('addProfileToList', data)
            break

          case SyncEvents.GENERAL.UPSERT:
            commit('upsertProfileToList', data)
            break

          case SyncEvents.PROFILES.ADD_CHANNEL:
            commit('addChannelToProfiles', data)
            break

          case SyncEvents.PROFILES.REMOVE_CHANNEL:
            commit('removeChannelFromProfiles', data)
            break

          case SyncEvents.PROFILES.REMOVE_CHANNELS:
            commit('removeChannelsFromProfiles', data)
            break

          case SyncEvents.GENERAL.DELETE:
            commit('removeProfileFromList', data)
            break

          default:
            console.error('profiles: invalid sync event received')
        }
      })

      window.ftElectron.handleSyncPlaylists((event, data) => {
        switch (event) {
          case SyncEvents.GENERAL.CREATE:
            commit('addPlaylists', data)
            break

          case SyncEvents.GENERAL.DELETE:
            commit('removePlaylist', data)
            break

          case SyncEvents.GENERAL.UPSERT:
            commit('upsertPlaylistToList', data)
            break

          case SyncEvents.PLAYLISTS.UPSERT_VIDEO:
            commit('addVideo', data)
            break

          case SyncEvents.PLAYLISTS.UPSERT_VIDEOS:
            commit('addVideos', data)
            break

          case SyncEvents.PLAYLISTS.DELETE_VIDEO:
            commit('removeVideo', data)
            break

          case SyncEvents.PLAYLISTS.DELETE_VIDEOS:
            commit('removeVideos', data)
            break

          default:
            console.error('playlists: invalid sync event received')
        }
      })

      window.ftElectron.handleSyncChannels((event, data) => {
        switch (event) {
          case SyncEvents.CHANNELS.UPDATE_TAGS:
            commit('updateChannelTagsByChannel', data)
            break

          case SyncEvents.CHANNELS.UPDATE_VIDEO_SAMPLES:
            commit('updateVideoSamplesByChannel', data)
            break

          default:
            console.error('channels: invalid sync event received')
        }
      })

      window.ftElectron.handleSyncLater((event, data) => {
        switch (event) {
          case SyncEvents.GENERAL.UPSERT:
            commit('upsertLaterItem', data)
            break

          case SyncEvents.LATER.UPDATE_POSITION:
            commit('setLaterPosition', data)
            break

          case SyncEvents.LATER.UPDATE_ALARM:
            commit('setLaterAlarm', data)
            break

          case SyncEvents.LATER.UPDATE_VIEW_COUNT:
            commit('setLaterViewCount', data)
            break

          case SyncEvents.GENERAL.DELETE:
            commit('removeLaterItem', data)
            break

          case SyncEvents.GENERAL.DELETE_ALL:
            commit('setLaterItems', {})
            break

          default:
            console.error('later: invalid sync event received')
        }
      })

      window.ftElectron.handleSyncSubscriptionCache((event, data) => {
        switch (event) {
          case SyncEvents.SUBSCRIPTION_CACHE.UPDATE_VIDEOS_BY_CHANNEL:
            commit('updateVideoCacheByChannel', data)
            break

          case SyncEvents.SUBSCRIPTION_CACHE.UPDATE_LIVE_STREAMS_BY_CHANNEL:
            commit('updateLiveCacheByChannel', data)
            break

          case SyncEvents.SUBSCRIPTION_CACHE.UPDATE_SHORTS_BY_CHANNEL:
            commit('updateShortsCacheByChannel', data)
            break

          case SyncEvents.SUBSCRIPTION_CACHE.UPDATE_VIDEOS_WITH_CHANNEL_PAGE_VIDEOS_BY_CHANNEL:
            commit('updateVideoCacheWithChannelPageVideos', data)
            break

          case SyncEvents.SUBSCRIPTION_CACHE.UPDATE_LIVE_STREAMS_WITH_CHANNEL_PAGE_VIDEOS_BY_CHANNEL:
            commit('updateLiveCacheWithChannelPageVideos', data)
            break

          case SyncEvents.SUBSCRIPTION_CACHE.UPDATE_SHORTS_WITH_CHANNEL_PAGE_SHORTS_BY_CHANNEL:
            commit('updateShortsCacheWithChannelPageShorts', data)
            break

          case SyncEvents.SUBSCRIPTION_CACHE.UPDATE_COMMUNITY_POSTS_BY_CHANNEL:
            commit('updatePostsCacheByChannel', data)
            break

          case SyncEvents.GENERAL.DELETE_MULTIPLE:
            commit('clearCachesForManyChannels', data)
            break

          case SyncEvents.GENERAL.DELETE_ALL:
            commit('clearCaches', data)
            break

          default:
            console.error('subscription-cache: invalid sync event received')
        }
      })
    }
  }
}

/**********************/
/*
 * DO NOT TOUCH ANYTHING BELOW
 * (unless you plan to change the architecture of this module)
 */

const getters = {}
const mutations = {}
const actions = {}

// Build default getters, mutations and actions for every setting id
for (const settingId of Object.keys(state)) {
  const getterId = defaultGetterId(settingId)
  const mutationId = defaultMutationId(settingId)
  const updaterId = defaultUpdaterId(settingId)

  getters[getterId] = (state) => state[settingId]
  mutations[mutationId] = (state, value) => { state[settingId] = value }

  if (settingsWithSideEffects.includes(settingId)) {
    const triggerId = defaultSideEffectsTriggerId(settingId)

    // If setting has side effects, generate action to handle them
    actions[triggerId] = sideEffectHandlers[settingId]

    actions[updaterId] = async ({ commit, dispatch }, value) => {
      try {
        await DBSettingHandlers.upsert(settingId, value)

        dispatch(triggerId, value)

        commit(mutationId, value)
      } catch (errMessage) {
        console.error(errMessage)
      }
    }
  } else {
    actions[updaterId] = async ({ commit }, value) => {
      try {
        await DBSettingHandlers.upsert(settingId, value)

        commit(mutationId, value)
      } catch (errMessage) {
        console.error(errMessage)
      }
    }
  }
}

// Add all custom data/logic to their respective objects
Object.assign(state, customState)
Object.assign(getters, customGetters)
Object.assign(mutations, customMutations)
Object.assign(actions, customActions)

export default {
  state,
  getters,
  actions,
  mutations
}
