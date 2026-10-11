import { defineComponent, markRaw } from 'vue'
import { isNavigationFailure, NavigationFailureType } from 'vue-router'
import { mapActions, mapMutations } from 'vuex'
import shaka from 'shaka-player'
import { Utils, YTNodes } from 'youtubei.js'
import FtLoader from '../../components/FtLoader/FtLoader.vue'
import FtShakaVideoPlayer from '../../components/ft-shaka-video-player/ft-shaka-video-player.vue'
import WatchVideoInfo from '../../components/WatchVideoInfo/WatchVideoInfo.vue'
import WatchVideoChapters from '../../components/WatchVideoChapters/WatchVideoChapters.vue'
import WatchVideoDescription from '../../components/WatchVideoDescription/WatchVideoDescription.vue'
import CommentSection from '../../components/CommentSection/CommentSection.vue'
import WatchVideoLiveChat from '../../components/WatchVideoLiveChat/WatchVideoLiveChat.vue'
import WatchVideoPlaylist from '../../components/WatchVideoPlaylist/WatchVideoPlaylist.vue'
import WatchVideoRecommendations from '../../components/WatchVideoRecommendations/WatchVideoRecommendations.vue'
import FtAgeRestricted from '../../components/FtAgeRestricted/FtAgeRestricted.vue'
import FtButton from '../../components/FtButton/FtButton.vue'
import { calculateColorLuminance } from '../../helpers/colors'
import {
  buildChaptersVttFile,
  buildVTTFileLocally,
  copyToClipboard,
  extractNumberFromString,
  formatDurationAsTimestamp,
  formatNumber,
  getLocalesWithFallback,
  showToast
} from '../../helpers/utils'
import {
  getLocalVideoInfo,
  mapLocalLegacyFormat,
  parseLocalSubscriberCount,
  parseLocalTextRuns,
  parseLocalWatchNextVideo
} from '../../helpers/api/local'
import {
  convertInvidiousToLocalFormat,
  generateInvidiousDashManifestLocally,
  getProxyUrl,
  invidiousGetVideoInformation,
  mapInvidiousLegacyFormat,
  youtubeImageUrlToInvidious
} from '../../helpers/api/invidious'
import { sortCaptions } from '../../helpers/player/utils'
import { selectLiveManifest } from '../../helpers/player/liveManifest'
import { classifyPlayabilityError, getPlayabilityExplanation } from '../../helpers/player/playability'
import { getLocalVideoTitle } from '../../helpers/player/watchMetadata'
import { traceWatch } from '../../helpers/watchTrace'
import { VERDICT_AI } from '../../helpers/aiMarker/label'
import { buildFormatId, MANIFEST_TYPE_SABR } from '../../helpers/player/SabrManifestParser'
import { createSabrRegulator, SabrGiveUpError } from '../../helpers/player/SabrRegulator'
import { useI18n } from 'vue-i18n'

/**
 * @typedef {{
 *   url: string,
 *   videoId: string,
 *   poToken: string,
 *   ustreamerConfig: string,
 *   clientInfo: {
 *     clientName: number,
 *     clientVersion: string,
 *     osName: string,
 *     osVersion: string
 *   }
 * }} SabrData
 */

const MANIFEST_TYPE_DASH = 'application/dash+xml'
const MANIFEST_TYPE_HLS = 'application/x-mpegurl'
class NoPlayableLiveStreamError extends Error {
  constructor(videoId) {
    super(`No playable livestream source for ${videoId}`)
    this.name = 'NoPlayableLiveStreamError'
  }
}
const UNAVAILABLE_VIDEO_THUMBNAILS = {
  light: 'https://www.youtube.com/img/desktop/unavailable/unavailable_video.png',
  dark: 'https://www.youtube.com/img/desktop/unavailable/unavailable_video_dark_theme.png'
}

export default defineComponent({
  name: 'Watch',
  components: {
    'ft-loader': FtLoader,
    'ft-shaka-video-player': FtShakaVideoPlayer,
    'watch-video-info': WatchVideoInfo,
    'watch-video-chapters': WatchVideoChapters,
    'watch-video-description': WatchVideoDescription,
    CommentSection,
    'watch-video-live-chat': WatchVideoLiveChat,
    'watch-video-playlist': WatchVideoPlaylist,
    'watch-video-recommendations': WatchVideoRecommendations,
    'ft-age-restricted': FtAgeRestricted,
    FtButton
  },
  beforeRouteLeave: async function (to, from, next) {
    this.handleRouteChange()
    window.removeEventListener('beforeunload', this.handleWatchProgressAutoSave)
    document.removeEventListener('keydown', this.resetAutoplayInterruptionTimeout)
    document.removeEventListener('click', this.resetAutoplayInterruptionTimeout)

    if (this.$refs.player) {
      await this.destroyPlayer()
    }

    next()
  },
  setup: function () {
    const { t, locale } = useI18n()

    return { t, currentLocale: locale }
  },
  data: function () {
    return {
      startNextVideoInFullscreen: false,
      startNextVideoInFullwindow: false,
      startNextVideoInPip: false,
      isLoading: true,
      firstLoad: true,
      useTheatreMode: false,
      videoPlayerLoaded: false,
      isFamilyFriendly: false,
      isLive: false,
      liveChat: null,
      isLiveContent: false,
      isUpcoming: false,
      isPostLiveDvr: false,
      isUnlisted: false,
      upcomingTimestamp: null,
      upcomingTimeLeft: null,
      /** @type {'dash' | 'audio' | 'legacy'} */
      activeFormat: 'legacy',
      thumbnail: '',
      videoId: '',
      videoTitle: '',
      videoDescription: '',
      videoDescriptionHtml: '',
      license: '',
      videoViewCount: 0,
      videoLikeCount: 0,
      videoDislikeCount: 0,
      videoLengthSeconds: 0,
      videoChapters: [],
      videoCurrentChapterIndex: 0,
      /** @type {'chapters' | 'keyMoments'} */
      videoChaptersKind: 'chapters',
      channelName: '',
      channelThumbnail: '',
      channelId: '',
      channelSubscriptionCountText: '',
      videoPublished: 0,
      premiereDate: undefined,
      videoStoryboardSrc: '',
      /** @type {string|null} */
      manifestSrc: null,
      /** @type {(MANIFEST_TYPE_DASH|MANIFEST_TYPE_HLS|MANIFEST_TYPE_SABR)} */
      manifestMimeType: MANIFEST_TYPE_DASH,
      /** @type {SabrData | null} */
      sabrData: null,
      /**
       * The storyboards the SABR manifest carries. Kept because a session
       * rebuild builds a fresh manifest from a fresh player response, and
       * storyboards come from the `/next` half, which the rebuild does not
       * re-read.
       * @type {import('../../helpers/player/SabrManifestParser').SabrManifest['storyboards']}
       */
      sabrStoryboards: [],
      /**
       * Owns the SABR transport and the recovery ladder for this view.
       * @type {?import('../../helpers/player/SabrRegulator').SabrRegulator}
       */
      sabrRegulator: null,
      legacyFormats: [],
      /**
       * Formats the automatic fallback has already tried and seen fail for
       * this load, so it cannot offer them again and ring the changes forever.
       * @type {('dash'|'audio'|'legacy')[]}
       */
      attemptedFormats: [],
      captions: [],
      /** @type {'EQUIRECTANGULAR' | 'EQUIRECTANGULAR_THREED_TOP_BOTTOM' | 'MESH'| null} */
      vrProjection: null,
      autoplayNextRecommendedVideo: false,
      autoplayNextPlaylistVideo: false,
      recommendedVideos: [],
      watchingPlaylist: false,
      playlistId: '',
      playlistType: '',
      playlistItemId: null,
      /** @type {number|null} */
      timestamp: null,
      // This should never be saved into history
      /** @type {number|null} */
      oneTimeTimestamp: null,
      playNextTimeout: null,
      playNextCountDownIntervalId: null,
      blockVideoAutoplay: false,
      autoplayInterruptionTimeout: null,
      playabilityStatus: '',
      totalAdTimeSeconds: 0,
      adEndTimeUnixMs: 0,
      /**
       * How much louder this video is than YouTube's reference loudness, in dB.
       * Only the local API reports it, Invidious never does, so `null` means unknown.
       * @type {number|null}
       */
      loudnessDb: null,

      onMountedRun: false,

      // error handling/messages
      /** @type {string|null} */
      errorMessage: null,
      /** @type {string[]|null} */
      customErrorIcon: null,
      /** Whether reopening the video is worth offering for this error */
      errorIsRetryable: false,
      /**
       * Where playback had reached when the error hit. Captured then, because
       * the player is unmounted the moment an error is shown and cannot be
       * asked afterwards.
       * @type {number}
       */
      errorRetryTimestamp: 0,
      videoGenreIsMusic: false,
      /**
       * The video's YouTube category, as the backend names it, kept on its
       * history entry so the Channels page can tell what a channel makes.
       * Empty when the backend gave none.
       */
      videoCategory: '',
      /**
       * YouTube's "How this was made" disclosures, shown as YouTube words them
       * in the description. Display only: whether the video was made with AI
       * is `madeWithAi`, from the AI label, never from these words.
       * @type {{ label: string, description: string, attribution: string }[] | null}
       */
      contentDisclosures: null,
      /** Whether YouTube labels the video "Made with AI" (helpers/aiMarker/label.js) */
      madeWithAi: false,
      /** @type {Date|null} */
      streamingDataExpiryDate: null,
      currentPlaybackRate: null,
    }
  },
  computed: {
    historyEntry: function () {
      return this.$store.getters.getHistoryCacheById[this.videoId]
    },
    historyEntryExists: function () {
      return typeof this.historyEntry !== 'undefined'
    },
    rememberHistory: function () {
      return this.$store.getters.getRememberHistory
    },
    watchedProgressSavingEnabled: function () {
      return this.$store.getters.getWatchedProgressSavingMode !== 'never'
    },
    autosaveWatchedProgress: function () {
      return this.$store.getters.getWatchedProgressSavingMode === 'auto'
    },
    saveVideoHistoryWithLastViewedPlaylist: function () {
      return this.$store.getters.getSaveVideoHistoryWithLastViewedPlaylist
    },
    backendPreference: function () {
      return this.$store.getters.getBackendPreference
    },
    backendFallback: function () {
      return this.$store.getters.getBackendFallback
    },
    currentInvidiousInstanceUrl: function () {
      return this.$store.getters.getCurrentInvidiousInstanceUrl
    },
    proxyVideos: function () {
      return this.$store.getters.getProxyVideos
    },
    defaultAutoplayInterruptionIntervalHours: function () {
      return this.$store.getters.getDefaultAutoplayInterruptionIntervalHours
    },
    defaultInterval: function () {
      return this.$store.getters.getDefaultInterval
    },
    defaultViewingMode: function () {
      return this.$store.getters.getDefaultViewingMode
    },
    defaultVideoFormat: function () {
      return this.$store.getters.getDefaultVideoFormat
    },
    enableRegulatedStreaming: function () {
      return this.$store.getters.getEnableRegulatedStreaming
    },
    autoplayEnabled: function () {
      return this.watchingPlaylist ? this.autoplayNextPlaylistVideo : this.autoplayNextRecommendedVideo
    },
    thumbnailPreference: function () {
      return this.$store.getters.getThumbnailPreference
    },
    autoplayNextRecommendedVideoByDefault: function () {
      return this.$store.getters.getPlayNextVideo
    },
    autoplayNextPlaylistVideoByDefault: function () {
      return this.$store.getters.getAutoplayPlaylists
    },
    hideRecommendedVideos: function () {
      return this.$store.getters.getHideRecommendedVideos
    },
    hideLiveChat: function () {
      return this.$store.getters.getHideLiveChat
    },
    hideComments: function () {
      return this.$store.getters.getHideComments
    },
    hideVideoDescription: function () {
      return this.$store.getters.getHideVideoDescription
    },
    showFamilyFriendlyOnly: function () {
      return this.$store.getters.getShowFamilyFriendlyOnly
    },
    hideChannelSubscriptions: function () {
      return this.$store.getters.getHideChannelSubscriptions
    },
    hideVideoLikesAndDislikes: function () {
      return this.$store.getters.getHideVideoLikesAndDislikes
    },
    theatrePossible: function () {
      return !this.hideRecommendedVideos || (!this.hideLiveChat && this.isLive) || this.watchingPlaylist
    },
    autoplayPossible: function () {
      return (!this.watchingPlaylist && !this.hideRecommendedVideos && !!this.nextRecommendedVideo) ||
      (this.watchingPlaylist && !this.$refs.watchVideoPlaylist?.shouldStopDueToPlaylistEnd)
    },
    hideChapters: function () {
      return this.$store.getters.getHideChapters
    },
    channelsHidden() {
      return JSON.parse(this.$store.getters.getChannelsHidden).map((ch) => {
        // Legacy support
        if (typeof ch === 'string') {
          return { name: ch, preferredName: '', icon: '' }
        }
        return ch
      })
    },
    forbiddenTitles() {
      return JSON.parse(this.$store.getters.getForbiddenTitles.toLowerCase())
    },
    isUserPlaylistRequested: function () {
      return this.$route.query.playlistType === 'user'
    },
    userPlaylistsReady: function () {
      return this.$store.getters.getPlaylistsReady
    },
    selectedUserPlaylist: function () {
      if (this.playlistId == null || this.playlistId === '') { return null }
      if (!this.isUserPlaylistRequested) { return null }

      return this.$store.getters.getPlaylist(this.playlistId)
    },
    nextRecommendedVideo: function () {
      return this.recommendedVideos.find((video) =>
        !this.isHiddenVideo(this.forbiddenTitles, this.channelsHidden, video)
      )
    },
    startTimeSeconds: function () {
      if (this.isLoading || this.isLive) {
        return null
      }

      if (this.oneTimeTimestamp !== null && this.oneTimeTimestamp < this.videoLengthSeconds) {
        return this.oneTimeTimestamp
      } else if (this.timestamp !== null && this.timestamp < this.videoLengthSeconds) {
        return this.timestamp
      } else if (this.watchedProgressSavingEnabled && this.historyEntryExists) {
        // For UX consistency, no progress reading if writing disabled

        /** @type {number} */
        const watchProgress = this.historyEntry.watchProgress

        if (watchProgress > 0 && watchProgress < this.videoLengthSeconds - 2) {
          return watchProgress
        }
      }

      return null
    },

    canSaveWatchProgress() {
      if (this.isUpcoming || this.isLive) { return false }

      // `this.$refs.player?.hasLoaded` cannot be used in computed property
      return !this.isLoading
    },

    chaptersSrc() {
      if (this.videoChapters.length > 0) {
        const vttText = buildChaptersVttFile(this.videoChapters)

        return `data:text/vtt,${encodeURIComponent(vttText)}`
      } else {
        return ''
      }
    }
  },
  watch: {
    async $route() {
      await this.reloadView()
    },
    userPlaylistsReady() {
      this.onMountedDependOnLocalStateLoading()
    },
  },
  created: function () {
    if (process.env.SUPPORTS_LOCAL_API) {
      // The regulator owns the SABR transport and every recovery decision for
      // as long as this view lives. It belongs here rather than to the player
      // because its own ladder reloads the player, and a budget destroyed by
      // the remedy it bounds bounds nothing. `markRaw` because it holds a live
      // session and event handlers, none of which want a reactive proxy.
      //
      // The policy is passed as a reader rather than a value because this
      // hook runs once per view instance, not once per video: the router
      // reuses the watch view across a param change, which is the same
      // property that lets the regulator outlive every rung. Passing the
      // value here fixed the policy for as long as the viewer stayed on watch
      // pages, so the setting's promise that it takes effect on the next
      // video was false. The regulator re-reads it when the video changes.
      this.sabrRegulator = markRaw(createSabrRegulator({
        isRegulated: () => this.enableRegulatedStreaming,
      }))
    }

    this.videoId = this.$route.params.id
    this.activeFormat = this.defaultVideoFormat
    // So that the value for this session remains unchanged even if setting changed
    this.autoplayNextRecommendedVideo = this.autoplayNextRecommendedVideoByDefault
    this.autoplayNextPlaylistVideo = this.autoplayNextPlaylistVideoByDefault

    this.checkIfTimestamp()
    this.currentPlaybackRate = this.$store.getters.getDefaultPlayback
  },
  mounted: function () {
    this.onMountedDependOnLocalStateLoading()
  },
  methods: {
    async reloadView() {
      await this.handleRouteChange()

      if (this.$refs.player) {
        await this.destroyPlayer()
      }

      // react to route changes...
      this.videoId = this.$route.params.id
      this.resetVideoState()

      this.firstLoad = true
      this.videoPlayerLoaded = false
      this.activeFormat = this.defaultVideoFormat

      this.checkIfTimestamp()
      this.checkIfPlaylist()
      this.setViewingModeOnRouteChange()

      switch (this.backendPreference) {
        case 'local':
          await this.getVideoInformationLocal()
          break
        case 'invidious':
          this.getVideoInformationInvidious()
          break
      }
    },

    resetVideoState: function () {
      this.isLoading = true
      this.isFamilyFriendly = false
      this.isLive = false
      this.liveChat = null
      this.isLiveContent = false
      this.isUpcoming = false
      this.isPostLiveDvr = false
      this.isUnlisted = false
      this.upcomingTimestamp = null
      this.upcomingTimeLeft = null
      this.thumbnail = ''
      this.videoTitle = ''
      this.videoDescription = ''
      this.videoDescriptionHtml = ''
      this.license = ''
      this.contentDisclosures = null
      this.madeWithAi = false
      this.videoViewCount = 0
      this.videoLikeCount = 0
      this.videoDislikeCount = 0
      this.videoLengthSeconds = 0
      this.videoChapters = []
      this.videoCurrentChapterIndex = 0
      this.videoChaptersKind = 'chapters'
      this.channelName = ''
      this.channelThumbnail = ''
      this.channelId = ''
      this.channelSubscriptionCountText = ''
      this.videoPublished = 0
      this.premiereDate = undefined
      this.videoStoryboardSrc = ''
      this.manifestSrc = null
      this.manifestMimeType = MANIFEST_TYPE_DASH
      this.sabrData = null
      this.sabrStoryboards = []
      this.legacyFormats = []
      this.attemptedFormats = []
      this.captions = []
      this.vrProjection = null
      this.recommendedVideos = []
      this.playabilityStatus = ''
      this.adEndTimeUnixMs = 0
      this.loudnessDb = null
      this.errorMessage = null
      this.customErrorIcon = null
      this.errorIsRetryable = false
      this.errorRetryTimestamp = 0
      this.videoGenreIsMusic = false
      this.videoCategory = ''
      this.streamingDataExpiryDate = null
      this.updateTitle()
    },

    onMountedDependOnLocalStateLoading() {
      // Prevent running twice
      if (this.onMountedRun) { return }
      // Stuff that require user playlists to be ready
      if (this.isUserPlaylistRequested && !this.userPlaylistsReady) { return }

      this.onMountedRun = true

      this.checkIfPlaylist()

      // this has to be below checkIfPlaylist() as theatrePossible needs to know if there is a playlist or not
      this.setViewingModeOnFirstLoad()

      if (!process.env.SUPPORTS_LOCAL_API || this.backendPreference === 'invidious') {
        this.getVideoInformationInvidious()
      } else {
        this.getVideoInformationLocal()
      }

      document.removeEventListener('keydown', this.resetAutoplayInterruptionTimeout)
      document.removeEventListener('click', this.resetAutoplayInterruptionTimeout)
      document.addEventListener('keydown', this.resetAutoplayInterruptionTimeout)
      document.addEventListener('click', this.resetAutoplayInterruptionTimeout)

      window.addEventListener('beforeunload', this.handleWatchProgressAutoSave)
      this.resetAutoplayInterruptionTimeout()
    },

    setViewingModeOnFirstLoad: function () {
      switch (this.defaultViewingMode) {
        case 'theatre':
          this.useTheatreMode = this.theatrePossible
          break
        case 'fullscreen':
        case 'fullscreen_always_on':
          this.startNextVideoInFullscreen = true
          break
        case 'fullwindow':
        case 'fullwindow_always_on':
          this.startNextVideoInFullwindow = true
          break
        case 'pip':
          this.startNextVideoInPip = true
      }
    },

    setViewingModeOnRouteChange: function () {
      switch (this.defaultViewingMode) {
        case 'fullscreen_always_on':
          this.startNextVideoInFullscreen = true
          break
        case 'fullwindow_always_on':
          this.startNextVideoInFullwindow = true
          break
      }
    },

    changeTimestamp: function (timestamp) {
      const player = this.$refs.player

      if (!this.isLoading && player?.hasLoaded) {
        player.setCurrentTime(timestamp)
      }
    },

    getVideoInformationLocal: async function () {
      let watchInfoStage = 'request'

      if (this.firstLoad) {
        this.isLoading = true
      }

      try {
        const videoInfo = await getLocalVideoInfo(this.videoId)
        const { info: result, poToken, clientInfo, adEndTimeUnixMs, aiVerdict, contentDisclosures } = videoInfo
        this.contentDisclosures = contentDisclosures || null
        this.madeWithAi = aiVerdict === VERDICT_AI

        const playabilityStatus = result.playability_status
        this.playabilityStatus = playabilityStatus.status

        if (playabilityStatus.status === 'LOGIN_REQUIRED' && playabilityStatus.error_screen?.reason?.text === 'Private video') {
          // Private videos cannot be played in FreeTube, as they require to be logged as the owner of the video
          // so there is no point continuing or trying any other backends as it will always fail
          this.errorMessage = this.t('Video.Private')
          this.thumbnail = this.getUnavailableVideoThumbnail()
          this.isLoading = false
          this.updateTitle()
          return
        }

        this.adEndTimeUnixMs = adEndTimeUnixMs

        // Copied out here because `result` is local to this function, so it is gone
        // by the time the player needs the loudness.
        // `0` is a legitimate loudness, so this must not be a truthiness check.
        this.loudnessDb = result.player_config?.audio_config?.loudness_db ?? null

        this.isFamilyFriendly = result.basic_info.is_family_safe

        // Read before the presentational metadata below, because the playback
        // branches further down depend on them and that section is allowed to
        // fail.
        this.isLive = !!result.basic_info.is_live
        this.isUpcoming = !!result.basic_info.is_upcoming
        this.isLiveContent = !!result.basic_info.is_live_content
        this.isPostLiveDvr = !!result.basic_info.is_post_live_dvr
        this.isUnlisted = !!result.basic_info.is_unlisted

        watchInfoStage = 'recommendations'
        this.recommendedVideos = result.watch_next_feed
          ?.filter((item) => {
            return item.type === 'CompactVideo' || item.type === 'CompactMovie' ||
              (item.type === 'LockupView' && (item.content_type === 'VIDEO' || item.content_type === 'STATION'))
          })
          .map(parseLocalWatchNextVideo).filter(_ => _)
          // place watched recommended videos last
          .sort(this.sortWatchedVideosLast) ?? []

        if (this.showFamilyFriendlyOnly && !this.isFamilyFriendly) {
          this.isLoading = false
          this.handleVideoEnded()
          return
        }

        // Everything in here describes the video rather than plays it, and
        // YouTube reshapes these fields without warning. A single one of them
        // turning up null used to throw out of this whole function, so a
        // perfectly playable video would not play at all. Losing a subtitle
        // line is a much smaller loss than losing the video, so this section
        // says what it could not read and carries on.
        try {
          watchInfoStage = 'metadata-shape'
          traceWatch(watchInfoStage, {
            videoId: this.videoId,
            playabilityStatus: playabilityStatus.status,
            hasBasicInfo: !!result.basic_info,
            hasPrimaryInfo: !!result.primary_info,
            hasPrimaryTitle: !!result.primary_info?.title,
            hasSecondaryInfo: !!result.secondary_info,
            hasSecondaryOwner: !!result.secondary_info?.owner,
            hasSubscriberCount: !!result.secondary_info?.owner?.subscriber_count,
            hasDescription: !!result.secondary_info?.description
          })

          watchInfoStage = 'title'
          // extract localised title first and fall back to the not localised one
          this.videoTitle = getLocalVideoTitle(result)

          watchInfoStage = 'view-count'
          this.videoViewCount = result.basic_info.view_count ?? (result.primary_info?.view_count ? extractNumberFromString(result.primary_info.view_count.text) : null)

          watchInfoStage = 'licence'
          this.license = result.secondary_info?.metadata?.rows?.find(element => element.title?.text === 'License')?.contents?.[0]?.text

          watchInfoStage = 'channel'
          this.channelId = result.basic_info.channel_id ?? result.secondary_info?.owner?.author?.id
          this.channelName = result.basic_info.author ?? result.secondary_info?.owner?.author?.name

          if (result.secondary_info?.owner?.author) {
            this.channelThumbnail = result.secondary_info.owner.author.best_thumbnail?.url ?? ''
          } else {
            this.channelThumbnail = ''
          }

          this.videoGenreIsMusic = result.basic_info.category === 'Music'
          this.videoCategory = typeof result.basic_info.category === 'string' ? result.basic_info.category.trim() : ''

          this.updateSubscriptionDetails({
            channelThumbnailUrl: this.channelThumbnail.length === 0 ? null : this.channelThumbnail,
            channelName: this.channelName,
            channelId: this.channelId
          })

          watchInfoStage = 'published-date'
          if (result.page[0]?.microformat?.publish_date) {
            // `result.page[0].microformat.publish_date` example value: `2023-08-12T08:59:59-07:00`
            this.videoPublished = Date.parse(result.page[0].microformat.publish_date)
          } else if (result.primary_info?.published) {
            // text date Jan 1, 2000, not as accurate but better than nothing
            this.videoPublished = Date.parse(result.primary_info.published)
          }

          watchInfoStage = 'description'
          if (result.secondary_info?.description?.runs) {
            try {
              this.videoDescription = parseLocalTextRuns(result.secondary_info.description.runs)
            } catch (error) {
              console.error('Failed to extract the localised description, falling back to the standard one.', error, JSON.stringify(result.secondary_info.description.runs))
              this.videoDescription = result.basic_info.short_description
            }
          } else {
            this.videoDescription = result.basic_info.short_description
          }

          watchInfoStage = 'thumbnail'
          switch (this.thumbnailPreference) {
            case 'start':
              this.thumbnail = `https://i.ytimg.com/vi/${this.videoId}/maxres1.jpg`
              break
            case 'middle':
              this.thumbnail = `https://i.ytimg.com/vi/${this.videoId}/maxres2.jpg`
              break
            case 'end':
              this.thumbnail = `https://i.ytimg.com/vi/${this.videoId}/maxres3.jpg`
              break
            default:
              this.thumbnail = result.basic_info.thumbnail?.[0]?.url ?? `https://i.ytimg.com/vi/${this.videoId}/maxresdefault.jpg`
              break
          }

          watchInfoStage = 'like-count'
          if (this.hideVideoLikesAndDislikes) {
            this.videoLikeCount = null
            this.videoDislikeCount = null
          } else {
            this.videoLikeCount = isNaN(result.basic_info.like_count) ? 0 : result.basic_info.like_count

            // YouTube doesn't return dislikes anymore
            this.videoDislikeCount = 0
          }

          watchInfoStage = 'subscriber-count'
          const subscriberCount = result.secondary_info?.owner?.subscriber_count
          const subCount = subscriberCount && !subscriberCount.isEmpty() ? parseLocalSubscriberCount(subscriberCount.text) : NaN

          if (!isNaN(subCount)) {
            this.channelSubscriptionCountText = formatNumber(subCount, subCount >= 10000 ? { notation: 'compact' } : undefined)
          } else {
            this.channelSubscriptionCountText = ''
          }

          watchInfoStage = 'chapters'
          let chapters = []
          let chaptersKind = 'chapters'
          if (!this.hideChapters) {
            const rawChapters = result.player_overlays?.decorated_player_bar?.player_bar?.markers_map
              ?.find(marker => marker.marker_key === 'DESCRIPTION_CHAPTERS')?.value?.chapters

            if (rawChapters) {
              for (const chapter of rawChapters) {
                const start = chapter.time_range_start_millis / 1000

                chapters.push({
                  title: chapter.title?.text ?? '',
                  timestamp: formatDurationAsTimestamp(start),
                  startSeconds: start,
                  endSeconds: 0,
                  thumbnail: chapter.thumbnail?.[0]
                })
              }
            } else {
              /** @type {import('youtubei.js').YTNodes.MacroMarkersList | null | undefined} */
              const macroMarkersList = result.page[1]?.engagement_panels
                ?.find(pannel => pannel.panel_identifier === 'engagement-panel-macro-markers-auto-chapters')?.content

              if (macroMarkersList) {
                for (const item of macroMarkersList.contents) {
                  if (item instanceof YTNodes.MacroMarkersListItem) {
                    chapters.push({
                      title: item.title?.text ?? '',
                      timestamp: item.time_description?.text ?? '',
                      startSeconds: Utils.timeToSeconds(item.time_description?.text ?? ''),
                      endSeconds: 0,
                      thumbnail: item.thumbnail?.[0]
                    })
                  }
                }
                chaptersKind = 'keyMoments'
              } else {
                chapters = this.extractChaptersFromDescription(result.basic_info.short_description ?? result.secondary_info?.description?.text ?? '')
              }
            }

            if (chapters.length > 0) {
              this.addChaptersEndSeconds(chapters, result.basic_info.duration)

              // prevent vue from adding reactivity which isn't needed
              // as the chapter objects are read-only after this anyway
              // the chapters are checked for every timeupdate event that the player emits
              // this should lessen the performance and memory impact of the chapters
              chapters.forEach(Object.freeze)
            }
          }

          this.videoChapters = chapters
          this.videoChaptersKind = chaptersKind
        } catch (error) {
          // `resetVideoState` has already blanked every one of these fields,
          // so whatever this section did not reach is simply absent rather
          // than left over from the previous video.
          console.error(
            `Could not read all of the watch page metadata for ${this.videoId}, stopped at "${watchInfoStage}". Playing the video without it.`,
            error
          )
          traceWatch('metadata-failed', {
            stage: watchInfoStage,
            videoId: this.videoId,
            error: error.toString(),
            stack: error.stack
          })

          if (!this.videoTitle) {
            this.videoTitle = result.basic_info.title ?? ''
          }
          if (!this.videoDescription) {
            this.videoDescription = result.basic_info.short_description ?? ''
          }
          if (!this.thumbnail) {
            this.thumbnail = `https://i.ytimg.com/vi/${this.videoId}/maxresdefault.jpg`
          }
          this.videoChapters = []
        }

        const isDrmProtected = result.streaming_data?.adaptive_formats?.some(format => format.drm_families || format.drm_track_type)

        watchInfoStage = 'playability'
        if (playabilityStatus.status === 'UNPLAYABLE' || playabilityStatus.status === 'LOGIN_REQUIRED' || isDrmProtected) {
          if (playabilityStatus.error_screen?.offer_id === 'sponsors_only_video') {
            // Members-only videos can only be watched while logged into a Google account that is a paid channel member
            // so there is no point trying any other backends as it will always fail
            this.errorMessage = this.t('Video.MembersOnly')
            this.customErrorIcon = ['fas', 'money-check-dollar']
            this.isLoading = false
            this.updateTitle()
            return
          } else if (playabilityStatus.reason === 'Sign in to confirm your age' || (result.has_trailer && result.getTrailerInfo() === null)) {
            // Age-restricted videos can only be watched while logged into a Google account that is age-verified
            // so there is no point trying any other backends as it will always fail
            this.errorMessage = this.t('Video.AgeRestricted')
            this.isLoading = false
            this.updateTitle()
            return
          } else if (isDrmProtected) {
            // DRM protected videos (e.g. movies) cannot be played in FreeTube,
            // as they require the proprietary and closed source Wideview CDM which is understandably not included in standard Electron builds
            this.errorMessage = this.t('Video.DRMProtected')
            this.isLoading = false
            this.updateTitle()
            return
          }

          let errorText
          const errorKind = classifyPlayabilityError(playabilityStatus)

          if (errorKind === 'ip-block') {
            errorText = this.t('Video.IP block')
          } else if (errorKind === 'unexplained-refusal') {
            errorText = this.t('Video.Unexplained playback refusal')
          } else {
            errorText = `[${playabilityStatus.status}] ${playabilityStatus.reason}`
            const explanation = getPlayabilityExplanation(playabilityStatus)

            if (explanation && explanation !== playabilityStatus.reason) {
              errorText += `: ${explanation}`
            }
          }

          if (this.backendFallback) {
            throw new Error(errorText)
          } else {
            this.errorMessage = errorText
            this.isLoading = false
            this.updateTitle()
            return
          }
        }

        if (!this.hideLiveChat && (this.isLive || this.isUpcoming) && result.livechat) {
          this.liveChat = result.getLiveChat()
        } else {
          this.liveChat = null
        }

        if ((this.isLive || this.isPostLiveDvr) && !this.isUpcoming) {
          let useRemoteManifest = true

          if (this.isPostLiveDvr) {
            // I wasn't able to get SABR working with Post-Live-DVR yet, so for the moment we'll use YouTube's provided DASH manifest instead.
            // It only contains the last 4 hours of the stream, instead of starting from the beginning but that is better than nothing.
            if (
              result.streaming_data.adaptive_formats[0]?.url ||
              result.streaming_data.adaptive_formats[0]?.signature_cipher ||
              result.streaming_data.adaptive_formats[0]?.cipher
            ) {
              try {
                this.manifestSrc = await this.createLocalDashManifest(result, true)
                this.manifestMimeType = MANIFEST_TYPE_DASH
                useRemoteManifest = false
              } catch (error) {
                console.error(`Failed to generate DASH manifest for this Post Live DVR video ${this.videoId}, falling back to using YouTube's provided one...`, error)
              }
            }
          }

          if (useRemoteManifest) {
            const liveManifest = selectLiveManifest(result.streaming_data)

            if (!liveManifest) {
              throw new NoPlayableLiveStreamError(this.videoId)
            }

            this.manifestSrc = liveManifest.src
            this.manifestMimeType = liveManifest.mimeType
          }

          this.streamingDataExpiryDate = result.streaming_data.expires

          if (this.activeFormat === 'legacy') {
            this.activeFormat = 'dash'
          }
        } else if (this.isUpcoming) {
          const upcomingTimestamp = result.basic_info.start_timestamp

          if (upcomingTimestamp) {
            const timestampOptions = {
              month: 'long',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit'
            }
            const now = new Date()
            if (now.getFullYear() < upcomingTimestamp.getFullYear()) {
              Object.defineProperty(timestampOptions, 'year', {
                value: 'numeric'
              })
            }
            const locales = getLocalesWithFallback(this.currentLocale)
            this.upcomingTimestamp = Intl.DateTimeFormat(locales, timestampOptions).format(upcomingTimestamp)

            let upcomingTimeLeft = upcomingTimestamp - now

            // Convert from ms to second to minute
            upcomingTimeLeft = (upcomingTimeLeft / 1000) / 60
            let timeUnit = 'minute'

            // Youtube switches to showing time left in minutes at 120 minutes remaining
            if (upcomingTimeLeft > 120) {
              upcomingTimeLeft /= 60
              timeUnit = 'hour'
            }

            if (timeUnit === 'hour' && upcomingTimeLeft > 24) {
              upcomingTimeLeft /= 24
              timeUnit = 'day'
            }

            // Value after decimal not to be displayed
            // e.g. > 2 days = display as `2 days`
            upcomingTimeLeft = Math.floor(upcomingTimeLeft)

            // Displays when less than a minute remains
            // Looks better than `Premieres in x seconds`
            if (upcomingTimeLeft < 1) {
              this.upcomingTimeLeft = this.t('Video.Published.In less than a minute').toLowerCase()
            } else {
              const locales = getLocalesWithFallback(this.currentLocale)
              // TODO a I18n entry for time format might be needed here
              this.upcomingTimeLeft = new Intl.RelativeTimeFormat(locales).format(upcomingTimeLeft, timeUnit)
            }

            this.premiereDate = upcomingTimestamp
          } else {
            this.upcomingTimestamp = null
            this.upcomingTimeLeft = null
            this.premiereDate = undefined
          }
        }

        watchInfoStage = 'formats'
        if ((!this.isUpcoming && !this.isLive && !this.isPostLiveDvr) || (this.isUpcoming && this.playabilityStatus === 'OK')) {
          this.videoLengthSeconds = result.basic_info.duration
          if (result.streaming_data) {
            this.streamingDataExpiryDate = result.streaming_data.expires

            if (result.streaming_data.formats.length > 0) {
              this.legacyFormats = result.streaming_data.formats.map(mapLocalLegacyFormat)
            }

            if (result.captions) {
              const captionTracks = result.captions?.caption_tracks?.map((caption) => {
                const url = new URL(caption.base_url)
                url.searchParams.set('fmt', 'vtt')

                return {
                  id: caption.vss_id,
                  url: url.toString(),
                  label: caption.name?.text ?? caption.language_code,
                  language: caption.language_code,
                  mimeType: 'text/vtt'
                }
              }) ?? []

              if (captionTracks.length > 0) {
                const languagesSet = new Set([this.currentLocale, this.currentLocale.split('-')[0]])

                // special cases
                switch (this.currentLocale) {
                  case 'nn':
                  case 'nb-NO':
                    // according to https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes
                    // "no" is the macro language for "nb" and "nn"
                    languagesSet.add('no')
                    break
                  case 'he':
                    // according to https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes
                    // "iw" is the old/original code for Hewbrew, these days it's "he"
                    languagesSet.add('iw')
                    break
                }

                if (!captionTracks.some(captionTrack => languagesSet.has(captionTrack.language))) {
                  const translatedCaptionTrack = this.getTranslatedLocaleCaption(result.captions, languagesSet)

                  if (translatedCaptionTrack) {
                    captionTracks.push(translatedCaptionTrack)
                  }
                }
              }

              this.captions = sortCaptions(captionTracks)
            }
          } else {
            // video might be region locked or something else. This leads to no formats being available
            showToast(
              this.t('This video is unavailable because of missing formats. This can happen due to country unavailability.'),
              7000
            )
            this.handleVideoEnded()
            return
          }

          let storyboard

          if (result.storyboards?.type === 'PlayerStoryboardSpec') {
            /** @type {import('youtubei.js/dist/src/parser/classes/PlayerStoryboardSpec').StoryboardData[]} */
            let source = result.storyboards.boards
            if (window.innerWidth < 500) {
              source = source.filter((board) => board.thumbnail_height <= 90)
            }

            storyboard = source.at(-1)
            this.videoStoryboardSrc = this.createLocalStoryboardUrls(storyboard)
          }

          if (result.streaming_data?.adaptive_formats?.length > 0) {
            this.vrProjection = result.streaming_data.adaptive_formats
              .find(format => {
                return format.has_video &&
                  typeof format.projection_type === 'string' &&
                  format.projection_type !== 'RECTANGULAR'
              })
              ?.projection_type ?? null

            if (
              // Without a PO token a SABR session is walled from the first
              // request, so fall through to DASH instead
              poToken &&
              videoInfo.info.streaming_data?.server_abr_streaming_url &&
              videoInfo.info.player_config.media_common_config.media_ustreamer_request_config
            ) {
              const storyboards = storyboard
                ? [{
                    templateUrl: storyboard.template_url,
                    mimeType: 'image/webp',
                    columns: storyboard.columns,
                    rows: storyboard.rows,
                    thumbnailCount: storyboard.thumbnail_count,
                    thumbnailWidth: storyboard.thumbnail_width,
                    thumbnailHeight: storyboard.thumbnail_height,
                    storyboardCount: storyboard.storyboard_count,
                    interval: storyboard.interval > 0 ? storyboard.interval / 1000 : 0
                  }]
                : []

              this.manifestSrc = this.createLocalSabrManifest(result, poToken, clientInfo, storyboards)
              this.manifestMimeType = MANIFEST_TYPE_SABR
            } else if (
              result.streaming_data.adaptive_formats[0]?.url ||
              result.streaming_data.adaptive_formats[0]?.signature_cipher ||
              result.streaming_data.adaptive_formats[0]?.cipher
            ) {
              this.manifestSrc = await this.createLocalDashManifest(result)
              this.manifestMimeType = MANIFEST_TYPE_DASH
            } else {
              this.manifestSrc = null
              this.enableLegacyFormat()
            }
          } else {
            this.manifestSrc = null
            this.enableLegacyFormat()
          }
        }

        if (this.activeFormat === 'legacy' && (this.isLive || this.isPostLiveDvr || this.legacyFormats.length === 0)) {
          // Legacy wanted as default but unavailable
          showToast(this.t('Change Format.Legacy formats are not available for this video'))
          this.handleActiveFormatUnavailable()
        }

        if (!this.isUpcoming && this.activeFormat !== 'legacy' && !this.manifestSrc) {
          this.showRetryableError(this.t('Video.No playable video source'))
        }

        this.isLoading = false
        this.updateTitle()
      } catch (err) {
        console.error(err)
        traceWatch('local-video-information-failed', {
          stage: watchInfoStage,
          videoId: this.videoId,
          error: err.toString(),
          stack: err.stack
        })
        if (this.backendPreference === 'local' && this.backendFallback && !err.toString().includes('private') && !err.toString().includes('unavailable')) {
          const errorMessage = this.t('Local API Error (Click to copy)')
          showToast(`${errorMessage}: ${err}`, 10000, () => {
            copyToClipboard(err)
          })
          showToast(this.t('Falling back to Invidious API'))
          this.getVideoInformationInvidious()
        } else {
          this.isLoading = false

          if (!this.thumbnail) {
            this.thumbnail = this.getUnavailableVideoThumbnail()
          }
          if (err instanceof NoPlayableLiveStreamError) {
            this.showRetryableError(this.t('Video.No playable livestream source'))
          } else {
            this.errorMessage = err.message || err.toString()
          }
        }
      }
    },

    getVideoInformationInvidious: function () {
      if (this.firstLoad) {
        this.isLoading = true
      }

      invidiousGetVideoInformation(this.videoId)
        .then(async result => {
          if (result.error) {
            throw new Error(result.error)
          }

          this.videoTitle = result.title
          this.videoViewCount = result.viewCount

          const subCount = parseLocalSubscriberCount(result.subCountText)
          if (!isNaN(subCount)) {
            this.channelSubscriptionCountText = formatNumber(subCount, subCount >= 10000 ? { notation: 'compact' } : undefined)
          } else {
            this.channelSubscriptionCountText = ''
          }

          if (this.hideVideoLikesAndDislikes) {
            this.videoLikeCount = null
            this.videoDislikeCount = null
          } else {
            this.videoLikeCount = result.likeCount
            this.videoDislikeCount = result.dislikeCount
          }

          this.videoGenreIsMusic = result.genre === 'Music'
          this.videoCategory = typeof result.genre === 'string' ? result.genre.trim() : ''

          this.channelId = result.authorId
          this.channelName = result.author
          const channelThumb = result.authorThumbnails[1]
          this.channelThumbnail = channelThumb ? youtubeImageUrlToInvidious(channelThumb.url, this.currentInvidiousInstanceUrl) : ''
          this.updateSubscriptionDetails({
            channelThumbnailUrl: channelThumb?.url,
            channelName: result.author,
            channelId: result.authorId
          })

          this.videoPublished = result.published * 1000
          this.videoDescriptionHtml = result.descriptionHtml
          const recommendedVideos = result.recommendedVideos

          // The recommended videos currently use yyyy-mm-ddThh:mm:ss for the published timestamp
          // whereas the rest of the API uses unix timestamps, correct that here
          recommendedVideos.forEach((video) => {
            if (typeof video.published === 'string') {
              video.published = Date.parse(video.published)
            }
          })

          // place watched recommended videos last
          this.recommendedVideos = recommendedVideos.sort(this.sortWatchedVideosLast)

          this.isLive = result.liveNow
          this.isFamilyFriendly = result.isFamilyFriendly
          this.isPostLiveDvr = !!result.isPostLiveDvr
          this.isUnlisted = !result.isListed
          this.contentDisclosures = null
          this.madeWithAi = false

          this.captions = sortCaptions(result.captions.map(caption => {
            return {
              url: this.currentInvidiousInstanceUrl + caption.url,
              label: caption.label,
              language: caption.language_code,
              mimeType: 'text/vtt'
            }
          }))

          if (!this.isLive && !this.isPostLiveDvr) {
            this.videoStoryboardSrc = `${this.currentInvidiousInstanceUrl}/api/v1/storyboards/${this.videoId}?height=90`
          }

          switch (this.thumbnailPreference) {
            case 'start':
              this.thumbnail = `${this.currentInvidiousInstanceUrl}/vi/${this.videoId}/maxres1.jpg`
              break
            case 'middle':
              this.thumbnail = `${this.currentInvidiousInstanceUrl}/vi/${this.videoId}/maxres2.jpg`
              break
            case 'end':
              this.thumbnail = `${this.currentInvidiousInstanceUrl}/vi/${this.videoId}/maxres3.jpg`
              break
            default:
              this.thumbnail = result.videoThumbnails[0].url
              break
          }

          let chapters = []
          if (!this.hideChapters) {
            chapters = this.extractChaptersFromDescription(result.description)

            if (chapters.length > 0) {
              this.addChaptersEndSeconds(chapters, result.lengthSeconds)

              // prevent vue from adding reactivity which isn't needed
              // as the chapter objects are read-only after this anyway
              // the chapters are checked for every timeupdate event that the player emits
              // this should lessen the performance and memory impact of the chapters
              chapters.forEach(Object.freeze)
            }
          }
          this.videoChapters = chapters
          this.videoChaptersKind = 'chapters'

          if (this.isLive || this.isPostLiveDvr) {
            // The live DASH manifest is currently unusable as it returns 403s after 1 minute of playback
            // so we have to use the HLS one for now.
            // Leaving the code here commented out in case we can use it again in the future
            // const url = `${this.currentInvidiousInstanceUrl}/api/manifest/dash/id/${this.videoId}`

            // // Proxying doesn't work for live or post live DVR DASH, so use HLS instead
            // // https://github.com/iv-org/invidious/pull/4589
            // if (this.proxyVideos) {

            let hlsManifestUrl = result.hlsUrl

            if (!hlsManifestUrl) {
              throw new NoPlayableLiveStreamError(this.videoId)
            }

            this.streamingDataExpiryDate = this.extractExpiryDateFromStreamingUrl(result.adaptiveFormats[0]?.url ?? hlsManifestUrl)

            if (this.proxyVideos) {
              const url = new URL(hlsManifestUrl)
              url.searchParams.set('local', 'true')
              hlsManifestUrl = url.toString()
            }

            this.manifestSrc = hlsManifestUrl
            this.manifestMimeType = MANIFEST_TYPE_HLS

            // The HLS manifests only contain combined audio+video streams, so we can't do audio only
            if (this.activeFormat === 'audio') {
              this.activeFormat = 'dash'
            }
            // } else {
            //   this.manifestSrc = url
            //   this.manifestMimeType = MANIFEST_TYPE_DASH
            // }

            this.legacyFormats = []

            if (this.activeFormat === 'legacy') {
              this.activeFormat = 'dash'
            }
          } else {
            this.videoLengthSeconds = result.lengthSeconds

            this.streamingDataExpiryDate = this.extractExpiryDateFromStreamingUrl(result.adaptiveFormats[0].url)

            this.legacyFormats = result.formatStreams.map(mapInvidiousLegacyFormat)

            if (!process.env.SUPPORTS_LOCAL_API || this.proxyVideos) {
              this.legacyFormats.forEach(format => {
                format.url = getProxyUrl(format.url)
              })
            }

            this.vrProjection = result.adaptiveFormats
              .find(stream => {
                return typeof stream.projectionType === 'string' &&
                  stream.projectionType !== 'RECTANGULAR'
              })
              ?.projectionType ?? null

            this.manifestSrc = await this.createInvidiousDashManifest(result)
            this.manifestMimeType = MANIFEST_TYPE_DASH
          }

          this.updateTitle()

          this.isLoading = false
        })
        .catch(err => {
          console.error(err)
          if (process.env.SUPPORTS_LOCAL_API && this.backendPreference === 'invidious' && this.backendFallback) {
            const errorMessage = this.t('Invidious API Error (Click to copy)')
            showToast(`${errorMessage}: ${err}`, 10000, () => {
              copyToClipboard(err)
            })
            showToast(this.t('Falling back to Local API'))
            this.getVideoInformationLocal()
          } else {
            this.isLoading = false

            if (!this.thumbnail) {
              this.thumbnail = this.getUnavailableVideoThumbnail()
            }
            if (err instanceof NoPlayableLiveStreamError) {
              this.showRetryableError(this.t('Video.No playable livestream source'))
            } else {
              this.errorMessage = err.message || err.toString()
            }
          }
        })
    },

    extractExpiryDateFromStreamingUrl: function (url) {
      const expireString = new URL(url).searchParams.get('expire')

      return new Date(parseInt(expireString) * 1000)
    },

    getUnavailableVideoThumbnail: function () {
      const backgroundColor = window.getComputedStyle(document.body).backgroundColor
      const isLightTheme = calculateColorLuminance(backgroundColor) === '#000000'

      return isLightTheme
        ? UNAVAILABLE_VIDEO_THUMBNAILS.light
        : UNAVAILABLE_VIDEO_THUMBNAILS.dark
    },

    /**
     * @param {string?} description
     */
    extractChaptersFromDescription: function (description) {
      if (description == null) { return [] }

      /** @type {{title: string, timestamp: string, startSeconds: number, endSeconds: number}[]} */
      const chapters = []

      // HH:MM:SS Text
      // MM:SS Text
      // HH:MM:SS - Text // separator is one of '-', '–', '•', '—'
      // MM:SS - Text
      // HH:MM:SS - HH:MM:SS - Text // end timestamp is ignored, separator is one of '-', '–', '—'
      // HH:MM - HH:MM - Text // end timestamp is ignored
      const chapterMatches = description.matchAll(/^(?<timestamp>((?<hours>\d+):)?(?<minutes>\d+):(?<seconds>\d+))(\s*[–—-]\s*(?:\d+:){1,2}\d+)?\s+([–—•-]\s*)?(?<title>.+)$/gm)

      for (const { groups } of chapterMatches) {
        let start = 60 * Number(groups.minutes) + Number(groups.seconds)

        if (groups.hours) {
          start += 3600 * Number(groups.hours)
        }

        // replace previous chapter with current one if they have an identical start time
        if (chapters.length > 0 && chapters[chapters.length - 1].startSeconds === start) {
          chapters.pop()
        }

        chapters.push({
          title: groups.title.trim(),
          timestamp: groups.timestamp,
          startSeconds: start,
          endSeconds: 0
        })
      }

      return chapters
    },

    addChaptersEndSeconds: function (chapters, videoLengthSeconds) {
      for (let i = 0; i < chapters.length - 1; i++) {
        chapters[i].endSeconds = chapters[i + 1].startSeconds
      }
      chapters.at(-1).endSeconds = videoLengthSeconds
    },

    /**
     * @param {number} currentSeconds
     */
    updateCurrentChapter: function (currentSeconds) {
      const chapters = this.videoChapters

      if (this.hideChapters || chapters.length === 0) {
        return
      }

      const currentChapterStart = chapters[this.videoCurrentChapterIndex].startSeconds

      if (currentSeconds !== currentChapterStart) {
        let i = currentSeconds < currentChapterStart ? 0 : this.videoCurrentChapterIndex

        for (; i < chapters.length; i++) {
          if (currentSeconds < chapters[i].endSeconds) {
            this.videoCurrentChapterIndex = i
            break
          }
        }
      }
    },

    addToHistory: function (watchProgress) {
      const videoData = {
        videoId: this.videoId,
        title: this.videoTitle,
        author: this.channelName,
        authorId: this.channelId,
        published: this.videoPublished,
        description: this.videoDescription,
        viewCount: this.videoViewCount,
        lengthSeconds: this.videoLengthSeconds,
        watchProgress: watchProgress,
        timeWatched: Date.now(),
        isLive: false,
        type: 'video',
      }

      if (this.videoCategory !== '') {
        videoData.category = this.videoCategory
      }

      this.updateHistory(videoData)
    },

    handleWatchProgressManualSave() {
      // Should be called by manual action, settings should be checked in UI
      this._saveWatchProgress()
      showToast(this.t('Video.Watched Progress Saved'))
    },
    handleWatchProgressAutoSave() {
      if (!this.rememberHistory || !this.autosaveWatchedProgress) { return }
      this._saveWatchProgress()
    },
    handleWatchProgressAutoSaveWhenProgressEnabled() {
      if (!this.rememberHistory || !this.watchedProgressSavingEnabled) { return }
      this._saveWatchProgress()
    },
    _saveWatchProgress() {
      if (!this.canSaveWatchProgress) { return }
      if (!this.$refs.player?.hasLoaded) { return }

      const currentTime = this.getWatchedProgress()
      const payload = {
        videoId: this.videoId,
        watchProgress: currentTime
      }
      this.updateWatchProgress(payload)
    },

    handlePlaylistPersisting: function () {
      // Only save playlist ID if enabled, and it's not special video types
      if (!(this.rememberHistory && this.saveVideoHistoryWithLastViewedPlaylist)) { return }
      if (this.isUpcoming || this.isLive) { return }

      this.updateLastViewedPlaylist({
        videoId: this.videoId,
        // Whether there is a playlist ID or not, save it
        lastViewedPlaylistId: this.playlistId,
        lastViewedPlaylistType: this.playlistType,
        lastViewedPlaylistItemId: this.playlistItemId,
      })
    },

    /**
     * @param {{ videoId: string }} a
     * @param {{ videoId: string }} b
     */
    sortWatchedVideosLast: function (a, b) {
      const aWasWatched = this.isRecommendedVideoWatched(a.videoId)
      const bWasWatched = this.isRecommendedVideoWatched(b.videoId)

      if (aWasWatched && !bWasWatched) {
        return 1
      } else if (!aWasWatched && bWasWatched) {
        return -1
      } else {
        return 0
      }
    },

    isRecommendedVideoWatched: function (videoId) {
      return Object.hasOwn(this.$store.getters.getHistoryCacheById, videoId)
    },

    handleVideoLoaded: function () {
      // Only used one time = remove after use
      this.oneTimeTimestamp = null

      // will trigger again if you switch formats or change legacy quality
      // Check isUpcoming to avoid marking upcoming videos as watched if the user has only watched the trailer
      if (!this.videoPlayerLoaded && !this.isUpcoming) {
        this.videoPlayerLoaded = true

        if (this.rememberHistory) {
          if (this.timestamp) {
            this.addToHistory(this.timestamp)
          } else if (this.historyEntryExists) {
            this.addToHistory(this.historyEntry.watchProgress)
          } else {
            this.addToHistory(0)
          }

          // Must be called AFTER history entry inserted
          // Otherwise the value is not saved for first time watched videos
          this.handlePlaylistPersisting()
        }

        this.updateLocalPlaylistLastPlayedAtSometimes()
      }
    },

    checkIfPlaylist: function () {
      if (this.$route.query == null) {
        this.watchingPlaylist = false
        return
      }

      this.playlistId = this.$route.query.playlistId
      this.playlistItemId = this.$route.query.playlistItemId

      if (this.playlistId == null || this.playlistId.length === 0) {
        this.playlistType = ''
        this.playlistItemId = null
        this.watchingPlaylist = false
        return
      }

      // `playlistId` present
      if (this.selectedUserPlaylist != null) {
        // If the page is accessed through navigation via router history, 'playlistId' is still specified
        // but the video could have been removed from the playlist in the meantime
        if (!this.selectedUserPlaylist.videos.some((video) => video.videoId === this.videoId)) {
          this.playlistId = ''
          this.playlistType = ''
          this.playlistItemId = null
          this.watchingPlaylist = false
          return
        }

        // If playlist ID matches a user playlist, it must be user playlist
        this.playlistType = 'user'
        this.watchingPlaylist = true
        return
      }

      // Still possible to be a user playlist from history
      // (but user playlist could be already removed)
      this.playlistType = this.$route.query.playlistType
      if (this.playlistType !== 'user') {
        // Remote playlist
        this.playlistItemId = null
        this.watchingPlaylist = true
        return
      }

      // At this point `playlistType === 'user'`
      // But the playlist might be already removed
      if (this.selectedUserPlaylist == null) {
        // Clear playlist data so that watch history will be properly updated
        this.playlistId = ''
        this.playlistType = ''
        this.playlistItemId = null
      }
      this.watchingPlaylist = this.selectedUserPlaylist != null
    },

    checkIfTimestamp: function () {
      const oneTimeTimestamp = parseInt(this.$route.query.oneTimeTimestamp)
      this.oneTimeTimestamp = isNaN(oneTimeTimestamp) || oneTimeTimestamp < 0 ? null : oneTimeTimestamp

      const timestamp = parseInt(this.$route.query.timestamp)
      this.timestamp = isNaN(timestamp) || timestamp < 0 ? null : timestamp
    },

    handleFormatChange: function (format) {
      switch (format) {
        case 'dash':
          this.enableDashFormat()
          break
        case 'legacy':
          this.enableLegacyFormat()
          break
        case 'audio':
          this.enableAudioFormat()
          break
      }
    },

    /**
     * Whether this video can be played in the given format at all. One place
     * to ask, so the automatic fallback can look before it leaps rather than
     * finding out by way of a toast meant for someone who chose the format
     * from the menu.
     * @param {'dash'|'audio'|'legacy'} format
     * @returns {boolean}
     */
    canUseFormat: function (format) {
      switch (format) {
        case 'dash':
          return this.manifestSrc !== null
        case 'legacy':
          // YouTube serves no progressive formats for most videos now, so this
          // is usually false, which is why it can no longer be the only rung
          // the fallback tries
          return !this.isLive && !this.isPostLiveDvr && this.legacyFormats.length > 0
        case 'audio':
          return this.manifestSrc !== null &&
            !((this.isLive || this.isPostLiveDvr) &&
              // The WEB HLS manifests only contain combined audio and video files, so we can't do audio only
              // The IOS HLS manifests have audio-only streams
              this.manifestMimeType === MANIFEST_TYPE_HLS && !this.manifestSrc.includes('/demuxed/1'))
        default:
          return false
      }
    },

    enableDashFormat: function () {
      if (this.activeFormat === 'dash') {
        return false
      }

      if (!this.canUseFormat('dash')) {
        showToast(this.t('Change Format.Dash formats are not available for this video'))
        return false
      }

      this.activeFormat = 'dash'
      return true
    },

    enableLegacyFormat: function () {
      if (this.activeFormat === 'legacy') {
        return false
      }

      if (!this.canUseFormat('legacy')) {
        showToast(this.t('Change Format.Legacy formats are not available for this video'))
        return false
      }

      this.activeFormat = 'legacy'
      return true
    },

    enableAudioFormat: function () {
      if (this.activeFormat === 'audio') {
        return false
      }

      if (!this.canUseFormat('audio')) {
        showToast(this.t('Change Format.Audio formats are not available for this video'))
        return false
      }

      this.activeFormat = 'audio'
      return true
    },

    handleVideoEnded: function () {
      this.handleWatchProgressAutoSaveWhenProgressEnabled()
      if (!this.autoplayEnabled) {
        return
      }

      if (this.blockVideoAutoplay) {
        showToast(this.t('Autoplay Interruption Timer',
          this.defaultAutoplayInterruptionIntervalHours,
          {
            autoplayInterruptionIntervalHours: this.defaultAutoplayInterruptionIntervalHours
          }),
        3_600_000
        )
        this.resetAutoplayInterruptionTimeout()
        return
      }

      if (this.watchingPlaylist && this.$refs.watchVideoPlaylist?.shouldStopDueToPlaylistEnd) {
        // Let `watchVideoPlaylist` handle end of playlist, no countdown needed
        this.$refs.watchVideoPlaylist.playNextVideo()
        return
      }

      let nextVideoId = null
      if (!this.watchingPlaylist) {
        nextVideoId = this.nextRecommendedVideo?.videoId
        if (!nextVideoId) {
          return
        }
      }

      const nextVideoInterval = this.defaultInterval
      this.playNextTimeout = setTimeout(() => {
        const player = this.$refs.player

        if (player?.isPaused()) {
          if (this.watchingPlaylist) {
            this.$refs.watchVideoPlaylist.playNextVideo()
          } else {
            this.$router.push({
              path: `/watch/${nextVideoId}`
            })
            showToast(this.t('Playing Next Video'))
          }
        }
        this.playNextTimeout = null
      }, nextVideoInterval * 1000)

      if (nextVideoInterval > 0) {
        // No countdown for 0s interval
        showToast(
          ({ remainingMs }) => {
            const countDownTimeLeftInSecond = remainingMs / 1000
            return this.t('Playing Next Video Interval', { nextVideoInterval: countDownTimeLeftInSecond }, countDownTimeLeftInSecond)
          },
          // So that we don't see last countdown text like 0/N
          nextVideoInterval * 1000,
          this.abortAutoplayCountdown,
        )
      }
    },

    // Skip to the next video if in a playlist
    // else next recommended video if autoplay enabled
    handleSkipToNext: function () {
      if (this.watchingPlaylist) {
        this.$refs.watchVideoPlaylist?.playNextVideo()
      } else if (!this.hideRecommendedVideos && this.nextRecommendedVideo) {
        this.$router.push({
          path: `/watch/${this.nextRecommendedVideo.videoId}`
        })
        showToast(this.t('Playing Next Video'))
      }
    },

    // Skip to the previous video in a playlist
    handleSkipToPrev: function () {
      this.$refs.watchVideoPlaylist?.playPreviousVideo()
    },

    abortAutoplayCountdown: function (hideToast = false) {
      clearTimeout(this.playNextTimeout)
      clearInterval(this.playNextCountDownIntervalId)
      this.playNextTimeout = null

      if (!hideToast) {
        showToast(this.t('Canceled next video autoplay'))
      }
    },

    handleRouteChange: function () {
      this.abortAutoplayCountdown(true)
      this.handleWatchProgressAutoSave()
    },

    /**
     * Shows an error the viewer can do something about, and remembers where
     * playback was so the retry can resume there. The player is unmounted as
     * soon as `errorMessage` is set, so the position has to be taken now.
     * @param {string} message
     * @param {string[]|null} icon
     */
    showRetryableError: function (message, icon = null) {
      this.handleWatchProgressAutoSaveWhenProgressEnabled()

      this.errorRetryTimestamp = this.getTimestamp()
      this.errorIsRetryable = true
      this.errorMessage = message
      this.customErrorIcon = icon
    },

    /**
     * Reopens the video from scratch at the position it stopped, which is what
     * the viewer would otherwise do by navigating away and back.
     *
     * Asking for it explicitly resets the regulator to how it started: a full
     * recovery budget, no session, and no claim on the SABR transport. Its
     * counters are meant to outlive a player reload, since reloading is one of
     * the things they bound, so this is the one way back for a viewer who has
     * decided that whatever it is holding onto is the problem.
     */
    async retryVideo() {
      this.sabrRegulator?.reset(this.videoId)

      const timestamp = this.errorRetryTimestamp

      // The error stays on screen until reloadView clears it. Clearing it here
      // would remount the player against the credentials that just failed, for
      // the moment it takes to get to the reload.

      if (timestamp > 0) {
        try {
          await this.$router.replace({
            path: this.$route.path,
            query: { ...this.$route.query, oneTimeTimestamp: timestamp },
          })
        } catch (failure) {
          if (!isNavigationFailure(failure, NavigationFailureType.duplicated)) {
            throw failure
          }
        }
      }

      await this.reloadView()
    },

    /**
     * @param {import('shaka-player/dist/shaka-player.ui').default.util.Error} error
     */
    handlePlayerError: function (error) {
      // the error is logged to the console inside the player so we don't have to do it here

      const { Code } = shaka.util.Error

      if (error.code === Code.HTTP_ERROR) {
        if (error.data[1] instanceof SabrGiveUpError) {
          // Every automatic recovery is spent. The format fallback below
          // cannot help here (the legacy URLs answer to the same distrusted
          // session), so show an honest error instead of stalling silently.
          this.showRetryableError(
            'YouTube is not serving this video to the current session (PO token rejected). Trying again sometimes works, otherwise wait a while or switch networks.',
            ['fas', 'shield']
          )
          return
        }

        if (error.data[1]?.message === 'Failed to fetch' && !navigator.onLine) {
          // Internet connection was lost, do nothing on our side as
          // shaka-player will keep trying until the internet connection returns and resume playback automatically when it does
          return
        }
      } else if (error.code === Code.BAD_HTTP_STATUS) {
        switch (error.data[1]) {
          case 429:
            this.showRetryableError('[BAD_HTTP_STATUS: 429] Ratelimited')
            return
          case 403:
            if (new Date() > this.streamingDataExpiryDate) {
              this.showRetryableError(
                '[BAD_HTTP_STATUS: 403] YouTube watch session expired.',
                ['fas', 'clock']
              )
              return
            }

            this.handleWatchProgressAutoSaveWhenProgressEnabled()

            if (this.videoGenreIsMusic) {
              this.errorMessage = '[BAD_HTTP_STATUS: 403] Potential causes: IP block, streaming URL deciphering failed or music video geo-block'
            } else {
              this.errorMessage = '[BAD_HTTP_STATUS: 403] Potential causes: IP block or streaming URL deciphering failed'
            }
            return
        }
      } else if (error.code === Code.VIDEO_ERROR) {
        if (this.activeFormat === 'legacy') {
          if (new Date() > this.streamingDataExpiryDate) {
            this.showRetryableError(
              '[VIDEO_ERROR] YouTube watch session expired.',
              ['fas', 'clock']
            )
            return
          }
        }
      }

      // A failure of the SABR transport is not a failure of the formats, and
      // the regulator has already spent everything it has on it by the time
      // one reaches us. DASH and audio are the same session in different
      // clothes, so offering them is offering the thing that just refused us;
      // only legacy is fetched over its own URLs and can genuinely differ.
      // This is what the evidence says too: a video that died this way played
      // again on reopening, in the very formats that had just failed.
      const failedTransport = error.category === shaka.util.Error.Category.NETWORK &&
        typeof error.data?.[0] === 'string' &&
        error.data[0].startsWith('sabr:')

      this.handleActiveFormatUnavailable(failedTransport)
    },

    /**
     * Leave the active format behind, because it has either just failed or
     * turned out not to exist for this video, and pick the best remaining one.
     *
     * Two ways in: a player error, which is the common one, and loading a
     * video with legacy chosen as the default when the video has no
     * progressive formats. The second never reaches the player at all, so
     * without its own way in it used to leave the viewer on a format that
     * could not play.
     *
     * @param {boolean} failedTransport whether what failed was the SABR
     *   transport rather than the format, which narrows what is worth trying
     */
    handleActiveFormatUnavailable: function (failedTransport = false) {
      // What to try instead, best first. Live streams have no legacy formats,
      // so they only move between DASH and audio.
      //
      // Upstream cycles DASH -> legacy -> audio -> DASH, which is a rotation
      // and says nothing about which alternative is better. Read as an order of
      // preference it gives the wrong answer for a video with no progressive
      // formats: someone whose default is legacy asked for video, and audio
      // throws the picture away when DASH is right there carrying the same
      // stream. Video formats come first here, and audio is the last resort it
      // ought to be.
      const alternatives = this.isLive || this.isPostLiveDvr
        ? { dash: ['audio'], legacy: ['dash'], audio: ['dash'] }
        : { dash: ['legacy', 'audio'], legacy: ['dash', 'audio'], audio: ['dash', 'legacy'] }

      if (!this.attemptedFormats.includes(this.activeFormat)) {
        this.attemptedFormats.push(this.activeFormat)
      }

      const ring = failedTransport
        ? ['legacy']
        : (alternatives[this.activeFormat] ?? [])

      // Take the first one this video actually has and has not already failed.
      // Trying only the next one in the ring and stopping if it was missing is
      // what left a dead player behind: for most videos YouTube now serves no
      // progressive formats, so `legacy` is absent and it was the first thing
      // a failed DASH stream reached for. The viewer got a toast about legacy
      // formats, which named neither what had gone wrong nor anything they
      // could act on, and since the format never changed the player was never
      // reloaded and every further error was ignored.
      const nextFormat = ring
        .find(format => !this.attemptedFormats.includes(format) && this.canUseFormat(format))

      if (nextFormat) {
        console.error(`Unable to play ${this.activeFormat} formats. Reverting to ${nextFormat} formats...`)
        this.handleFormatChange(nextFormat)
        return
      }

      // Nothing left to switch to. Say so, and offer the one thing that is
      // known to work: reopening the video, which builds a new session and
      // usually plays the very formats that just failed.
      console.error(`Unable to play ${this.activeFormat} formats, and this video has no other format to fall back to.`)

      this.showRetryableError(this.t('Video.This video stopped playing and there is no other format to try'))
    },

    /**
     * @param {import('youtubei.js').YT.VideoInfo} videoInfo
     * @param {boolean} includeThumbnails
     */
    createLocalDashManifest: async function (videoInfo, includeThumbnails = false) {
      const xmlData = await videoInfo.toDash({
        manifest_options: {
          include_thumbnails: includeThumbnails,
        },
      })

      return `data:application/dash+xml;charset=UTF-8,${encodeURIComponent(xmlData)}`
    },

    /**
     * Builds just the credential half of the SABR setup. Split out of
     * createLocalSabrManifest so a credential refresh can reuse it without
     * rebuilding the manifest.
     * @param {import('youtubei.js').IParsedResponse} videoInfo
     * @param {string} poToken
     * @param {SabrData['clientInfo']} clientInfo
     * @returns {SabrData}
     */
    buildSabrData: function (videoInfo, poToken, clientInfo) {
      const url = new URL(videoInfo.streaming_data.server_abr_streaming_url)
      url.searchParams.set('alr', 'yes')
      url.searchParams.set('cpn', videoInfo.cpn)

      return {
        url: url.toString(),
        videoId: this.videoId,
        poToken,
        ustreamerConfig: videoInfo.player_config.media_common_config.media_ustreamer_request_config.video_playback_ustreamer_config,
        clientInfo
      }
    },

    /**
     * @param {import('youtubei.js').IParsedResponse} videoInfo
     * @param {string} poToken
     * @param {SabrData['clientInfo']} clientInfo
     * @param {import('../../helpers/player/SabrManifestParser').SabrManifest['storyboards']} storyboards
     */
    createLocalSabrManifest: function (videoInfo, poToken, clientInfo, storyboards) {
      this.sabrData = this.buildSabrData(videoInfo, poToken, clientInfo)
      this.sabrStoryboards = storyboards

      /** @type {import('../../helpers/player/SabrManifestParser').SabrManifest} */
      const sabrManifest = {
        // Different formats have different durations and
        // use of slightly longer duration in PresentationTimeline causes player to stuck at the end
        duration: Math.min(...videoInfo.streaming_data.adaptive_formats.map(f => f.approx_duration_ms)) / 1000,
        formats: videoInfo.streaming_data.adaptive_formats.map((format) => ({
          itag: format.itag,
          lastModified: format.last_modified_ms,
          mimeType: format.mime_type,
          xtags: format.xtags,
          bitrate: format.bitrate,
          initRange: format.init_range,
          indexRange: format.index_range,
          width: format.width,
          height: format.height,
          frameRate: format.fps,
          quality: format.quality,
          language: format.language,
          audioSampleRate: format.audio_sample_rate,
          audioChannels: format.audio_channels,
          isDrc: format.is_drc,
          isVoiceBoost: format.is_vb,
          isOriginal: format.is_original,
          isDubbed: format.is_dubbed,
          isAutoDubbed: format.is_auto_dubbed,
          isDescriptive: format.is_descriptive,
          isSecondary: format.is_secondary,
          spatialAudio: !!format.spatial_audio_type,
          label: format.audio_track?.display_name,
          colorTransferCharacteristics: format.color_info?.transfer_characteristics,
          colorPrimaries: format.color_info?.primaries
        })),
        captions: this.captions,
        chapters: this.videoChapters,
        storyboards
      }

      return `data:${MANIFEST_TYPE_SABR},${encodeURIComponent(JSON.stringify(sabrManifest))}`
    },

    createInvidiousDashManifest: async function (result) {
      let url = `${this.currentInvidiousInstanceUrl}/api/manifest/dash/id/${this.videoId}`

      // If we are in Electron,
      // we can use YouTube.js' DASH manifest generator to generate the manifest.
      // Using YouTube.js' gives us support for multiple audio tracks (currently not supported by Invidious)
      if (process.env.SUPPORTS_LOCAL_API) {
        const adaptiveFormats = await this.getAdaptiveFormatsInvidious(result)

        /** @type {import('youtubei.js').Misc.Format[]} */
        const formats = []

        /** @type {import('youtubei.js').Misc.Format[]} */
        const audioFormats = []

        let hasMultipleAudioTracks = false

        for (const format of adaptiveFormats) {
          const localFormat = convertInvidiousToLocalFormat(format)

          if (localFormat.has_audio) {
            audioFormats.push(localFormat)

            if (localFormat.is_dubbed || localFormat.is_descriptive || localFormat.is_secondary || localFormat.is_auto_dubbed) {
              hasMultipleAudioTracks = true
            }
          }

          formats.push(localFormat)
        }

        if (hasMultipleAudioTracks) {
          // match YouTube's local API response with English
          const languageNames = new Intl.DisplayNames('en-US', { type: 'language', languageDisplay: 'standard' })
          for (const format of audioFormats) {
            this.generateAudioTrackFieldInvidious(format, languageNames)
          }
        }

        const manifest = await generateInvidiousDashManifestLocally(formats)

        url = `data:application/dash+xml;charset=UTF-8,${encodeURIComponent(manifest)}`
      } else if (this.proxyVideos) {
        url += '?local=true'
      }

      return url
    },

    /**
     * @param {import('youtubei.js').Misc.Format} format
     * @param {Intl.DisplayNames} languageNames
     */
    generateAudioTrackFieldInvidious: function (format, languageNames) {
      let type

      // use the same id numbers as YouTube (except -1, when we aren't sure what it is)
      let idNumber

      if (format.is_descriptive) {
        type = ' descriptive'
        idNumber = 2
      } else if (format.is_dubbed) {
        type = ''
        idNumber = 3
      } else if (format.is_original) {
        type = ' original'
        idNumber = 4
      } else if (format.is_secondary) {
        type = ' secondary'
        idNumber = 6
      } else if (format.is_auto_dubbed) {
        type = ''
        idNumber = 10
      } else {
        type = ' alternative'
        idNumber = -1
      }

      const languageName = languageNames.of(format.language)

      format.audio_track = {
        audio_is_default: !!format.is_original,
        id: `${format.language}.${idNumber}`,
        display_name: `${languageName}${type}`
      }
    },

    getAdaptiveFormatsInvidious: async function (existingInfoResult = null) {
      let result
      if (existingInfoResult) {
        result = existingInfoResult
      } else {
        result = await invidiousGetVideoInformation(this.videoId)
      }

      result.adaptiveFormats.forEach((format) => {
        format.bitrate = parseInt(format.bitrate)

        // audio streams don't have a size property
        if (typeof format.size === 'string') {
          const [stringWidth, stringHeight] = format.size.split('x')

          format.width = parseInt(stringWidth)
          format.height = parseInt(stringHeight)
        }
      })

      return result.adaptiveFormats
    },

    /**
     * @param {import('youtubei.js/dist/src/parser/classes/PlayerStoryboardSpec').StoryboardData} storyboardInfo
     * @returns {string}
     */
    createLocalStoryboardUrls: function (storyboardInfo) {
      const results = buildVTTFileLocally(storyboardInfo, this.videoLengthSeconds)

      return `data:text/vtt;charset=utf-8,${encodeURIComponent(results)}`
    },

    /**
     * @param {import('youtubei.js').YTNodes.PlayerCaptionsTracklist} captions
     * @param {Set<string>} userLanguages
     * @returns {null|{ url: string, label: string, language: string, mimeType: string, isAutotranslated: boolean }}
     */
    getTranslatedLocaleCaption: function (captions, userLanguages) {
      // check if we can translate to the users language
      const translationLanguage = captions.translation_languages.find(language => userLanguages.has(language.language_code))

      let translationName, translationCode
      // otherwise just fallback to the FreeTube display language and hope that YouTube will be able to handle it
      if (!translationLanguage) {
        translationName = this.t('Locale Name')
        translationCode = userLanguages.values().next().value
      } else {
        translationName = translationLanguage.language_name?.text ?? translationLanguage.language_code
        translationCode = translationLanguage.language_code
      }

      let trackToTranslate

      const autoGeneratedCaptionTrack = captions.caption_tracks.find(track => track.kind === 'asr')
      if (autoGeneratedCaptionTrack) {
        // Check if there is a user uploaded caption track in the language of the video, as that is more trustworthy than auto-generated captions
        const userUploadedCaptionTrack = captions.caption_tracks.find(track => track.kind !== 'asr' && track.language_code === autoGeneratedCaptionTrack.language_code)

        // Fallback to the auto-generated track if there is no user uploaded one that matches the video language
        trackToTranslate = userUploadedCaptionTrack ?? autoGeneratedCaptionTrack
      } else {
        // if there is no auto-generated track choose the first translatable track
        trackToTranslate = captions.caption_tracks.find(track => track.is_translatable) ?? captions.caption_tracks[0]
      }

      const url = new URL(trackToTranslate.base_url)
      // Requesting fmt=vtt with the tlang parameter set returns HTTP 429 errors, but requesting srt instead seems to work
      url.searchParams.set('fmt', 'srt')
      url.searchParams.set('tlang', translationCode)

      const label = this.t('Video.Player.TranslatedCaptionTemplate', {
        language: translationName,
        originalLanguage: trackToTranslate.name?.text ?? trackToTranslate.language_code
      })

      return {
        id: `${trackToTranslate.vss_id}.${translationCode}`,
        url: url.toString(),
        label,
        language: translationCode,
        mimeType: 'text/srt',
        isAutotranslated: true
      }
    },

    pausePlayer: function () {
      const player = this.$refs.player

      if (player && !player.isPaused()) {
        player.pause()
      }
    },

    getWatchedProgress: function () {
      const player = this.$refs.player

      if (!this.isLoading && player?.hasLoaded) {
        return player.getCurrentTime()
      }

      return 0
    },

    getTimestamp: function () {
      return Math.floor(this.getWatchedProgress())
    },

    getPlaylistState: function () {
      return this.$refs.watchVideoPlaylist?.getState() ??
        { index: -1, reverse: false, shuffle: false, loop: false }
    },

    updateTitle: function () {
      this.setAppTitle(this.videoTitle)
    },

    isHiddenVideo: function (forbiddenTitles, channelsHidden, video) {
      return channelsHidden.some(ch => ch.name === video.authorId) ||
        channelsHidden.some(ch => ch.name === video.author) ||
        forbiddenTitles.some((text) => video.title?.toLowerCase().includes(text)) ||
        forbiddenTitles.some((text) => video.author?.toLowerCase().includes(text))
    },

    toggleAutoplay: function() {
      if (this.autoplayEnabled && this.playNextTimeout) {
        this.abortAutoplayCountdown()
      }

      if (this.watchingPlaylist) {
        this.autoplayNextPlaylistVideo = !this.autoplayEnabled
      } else {
        this.autoplayNextRecommendedVideo = !this.autoplayEnabled
      }
    },

    updateLocalPlaylistLastPlayedAtSometimes() {
      if (this.selectedUserPlaylist == null) { return }

      const playlist = this.selectedUserPlaylist
      this.updatePlaylistLastPlayedAt({ _id: playlist._id })
    },

    resetAutoplayInterruptionTimeout() {
      clearTimeout(this.autoplayInterruptionTimeout)
      this.autoplayInterruptionTimeout = setTimeout(() => { this.blockVideoAutoplay = true }, this.defaultAutoplayInterruptionIntervalHours * 3_600_000)
      this.blockVideoAutoplay = false
    },

    updatePlaybackRate(newRate) {
      this.currentPlaybackRate = newRate
    },

    destroyPlayer: async function() {
      const uiState = await this.$refs.player.destroyPlayer()
      this.startNextVideoInFullscreen = uiState.startNextVideoInFullscreen
      this.startNextVideoInFullwindow = uiState.startNextVideoInFullwindow
      this.startNextVideoInPip = uiState.startNextVideoInPip
    },

    /**
     * Fetches fresh SABR credentials (a new player response and PO token)
     * without touching the rest of the view. Calls back with null if that is
     * impossible, in which case the player falls back to a full reload.
     *
     * Also reports the format identifiers the refreshed session serves. The
     * player cannot derive these itself: its own cache only records what the
     * old session served, and reusing a buffer across a format change
     * corrupts playback.
     *
     * A rebuild asks for a manifest as well, and gets one built from this very
     * response. It throws its media source away anyway, so nothing it keeps
     * refers to the old formats, and a manifest that agrees with the fresh
     * session is what makes changed format identifiers stop being a failure.
     * A refresh must not have one: it keeps the buffer, so its formats have to
     * be the ones already playing.
     *
     * @param {{
     *   onResult: (result: {
     *     sabrData: SabrData,
     *     formatIds: string[],
     *     manifestSrc?: string,
     *     manifestMimeType?: string
     *   } | null) => void,
     *   reloadPlaybackContext?: object,
     *   rebuilding?: boolean
     * }} payload `reloadPlaybackContext` is the server's own reload token, set
     * only when a `RELOAD_PLAYER_RESPONSE` part asked for this. It has to ride
     * on the `/player` call, or the response describes the same finished
     * playback context we were told to leave.
     */
    async onSabrRefreshRequested({ onResult, reloadPlaybackContext, rebuilding = false }) {
      if (this.backendPreference !== 'local') {
        onResult(null)
        return
      }

      try {
        const { info, poToken, clientInfo } = await getLocalVideoInfo(this.videoId, { reloadPlaybackContext })

        // No token means getLocalVideoInfo could not mint one even with
        // retries; a refresh with it would just install a walled session
        if (!poToken ||
          !info.streaming_data?.server_abr_streaming_url ||
          !info.player_config?.media_common_config?.media_ustreamer_request_config) {
          onResult(null)
          return
        }

        this.streamingDataExpiryDate = info.streaming_data.expires

        // Reuses the manifest parser's own identifier builder so the two can
        // never drift
        const formatIds = info.streaming_data.adaptive_formats.map(format => buildFormatId({
          itag: format.itag,
          lastModified: format.last_modified_ms,
          xtags: format.xtags,
        }))

        if (!rebuilding) {
          const sabrData = this.buildSabrData(info, poToken, clientInfo)
          this.sabrData = sabrData

          onResult({ sabrData, formatIds })
          return
        }

        // Sets `sabrData` and `sabrStoryboards` as the first load does, so the
        // view's own copy describes what the player is about to load rather
        // than what it was playing
        const manifestSrc = this.createLocalSabrManifest(info, poToken, clientInfo, this.sabrStoryboards)

        this.manifestSrc = manifestSrc
        this.manifestMimeType = MANIFEST_TYPE_SABR

        onResult({
          sabrData: this.sabrData,
          formatIds,
          manifestSrc,
          manifestMimeType: MANIFEST_TYPE_SABR,
        })
      } catch (error) {
        console.error('SABR credential refresh failed', error)
        onResult(null)
      }
    },

    /**
     * Reloads the watch page, the most expensive remedy in the ladder: the
     * buffer, the player and the page all go. Several unrelated causes end
     * here, and every one of them used to show the same message, so the
     * reason now travels with the request and is shown.
     *
     * @param {string} [reason] what asked for the reload. Optional because the
     * view binds this straight to the event, so an emitter that sends no
     * payload must still reload.
     */
    async onPlayerReloadRequested(reason) {
      const cause = reason ?? 'a SABR request'

      console.warn(`[SABR recovery] reloading the page: ${cause}`)
      showToast(`Reloading player: ${cause}`)

      const timestamp = this.getTimestamp()
      if (timestamp > 0) {
        // Reload at the middle should restart at current timestamp
        try {
          await this.$router.replace({
            path: this.$route.path,
            query: { ...this.$route.query, oneTimeTimestamp: timestamp },
          })
        } catch (failure) {
          if (isNavigationFailure(failure, NavigationFailureType.duplicated)) {
            // Already on route with same timestamp, allow reloadView to run instead
          } else {
            throw failure
          }
        }
      }
      await this.reloadView()
    },

    ...mapActions([
      'updateHistory',
      'updateWatchProgress',
      'updateLastViewedPlaylist',
      'updatePlaylistLastPlayedAt',
      'updateSubscriptionDetails',
    ]),

    ...mapMutations([
      'setAppTitle'
    ])
  }
})
