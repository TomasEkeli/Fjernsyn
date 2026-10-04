<template>
  <div
    class="videoLayout"
    :class="{
      isLoading,
      useTheatreMode: useTheatreMode && !isLoading,
      noSidebar: !sidebarShown
    }"
  >
    <FtLoader
      v-if="isLoading"
      :fullscreen="true"
    />
    <!-- As Watch.vue: nothing of the video but that it is age restricted -->
    <FtAgeRestricted
      v-else-if="hiddenAsNotFamilyFriendly"
      class="ageRestricted"
    />
    <template v-else>
      <div class="videoArea">
        <div class="videoAreaMargin">
          <FtShakaVideoPlayer
            v-if="showPlayer"
            ref="player"
            :key="video.videoId"
            :format="activeFormat"
            :manifest-src="manifestSrc"
            :manifest-mime-type="manifestMimeType"
            :sabr-data="sabrData"
            :sabr-regulator="isSabr ? sabrRegulator : null"
            :legacy-formats="source.legacyFormats"
            :start-time="startTime"
            :captions="captions"
            :chapters="chaptersShown ? chapters : []"
            :current-chapter-index="currentChapterIndex"
            :chapters-src="chaptersShown ? (source.chaptersSrc ?? '') : ''"
            :storyboard-src="storyboardSrc"
            :video-id="video.videoId"
            :channel-id="video.authorId"
            :title="video.title"
            :thumbnail="video.thumbnail"
            :platform="platformOf(video)"
            :video-url="videoUrl"
            :live-chat="liveChatShown ? video.liveChat : null"
            :loudness-db="source.loudnessDb ?? null"
            :delay-load-until-unix="source.delayLoadUntilMs ?? 0"
            :vr-projection="source.vrProjection ?? null"
            :theatre-possible="theatrePossible"
            :use-theatre-mode="useTheatreMode"
            :autoplay-possible="autoplayPossible"
            :autoplay-enabled="autoplayEnabled"
            :watching-playlist="playlist !== null"
            :start-in-fullscreen="startInFullscreen"
            :start-in-fullwindow="startInFullwindow"
            :start-in-pip="startInPip"
            :current-playback-rate="currentPlaybackRate"
            class="videoPlayer"
            @error="handlePlayerError"
            @loaded="handleVideoLoaded"
            @timeupdate="updateCurrentChapter"
            @ended="handlePlayerEnded"
            @toggle-theatre-mode="useTheatreMode = !useTheatreMode"
            @toggle-autoplay="toggleAutoplay"
            @skip-to-next="handleSkipToNext"
            @skip-to-prev="handleSkipToPrev"
            @playback-rate-updated="currentPlaybackRate = $event"
            @sabr-refresh-requested="onSabrRefreshRequested"
            @player-reload-requested="onPlayerReloadRequested"
          />
          <!-- Beside the player only to hold the premiere's text below a trailer, as Watch.vue does -->
          <div
            v-if="showPlayer ? premiereShown : (message || premiereShown)"
            class="videoPlayer"
            :class="{ withoutThumbnail: !showPlayer && !video?.thumbnail }"
          >
            <img
              v-if="!showPlayer && video?.thumbnail"
              :src="video.thumbnail"
              class="videoThumbnail"
              alt=""
            >
            <div
              v-if="premiereShown"
              class="premiereDate"
              :class="{ trailer: showPlayer }"
            >
              <FontAwesomeIcon
                :icon="['fas', 'satellite-dish']"
                class="premiereIcon"
              />
              <p
                v-if="premiere.timestamp"
                class="premiereText"
              >
                <span class="premiereTextTimeLeft">
                  {{ t('Video.Premieres') }} {{ premiere.timeLeft }}
                </span>
                <br>
                <span class="premiereTextTimestamp">
                  {{ premiere.timestamp }}
                </span>
              </p>
              <p
                v-else
                class="premiereText"
              >
                {{ t('Video.Starting soon, please refresh the page to check again') }}
              </p>
            </div>
            <div
              v-else
              class="errorContainer"
            >
              <div class="errorWrapper">
                <FontAwesomeIcon
                  :icon="message.icon"
                  aria-hidden="true"
                  class="errorIcon"
                />
                <div class="errorText">
                  <p class="errorMessage">
                    {{ message.text }}
                  </p>
                  <p
                    v-if="message.detail"
                    class="errorDetail"
                  >
                    {{ message.detail }}
                  </p>
                  <FtButton
                    v-if="message.retryable"
                    :label="t('Video.Try Again')"
                    :icon="['fas', 'sync']"
                    class="errorRetryButton"
                    @click="retry"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div
        v-if="video"
        class="infoArea"
      >
        <LayerVideoInfo
          :video="video"
          :can-save-watched-progress="canSaveWatchProgress"
          :get-timestamp="currentPosition"
          class="watchVideo"
          @save-watched-progress="handleWatchProgressManualSave"
          @pause-player="pausePlayer"
          @opened-in-external-player="markWatchedInExternalPlayer"
        >
          <template
            v-if="video.channel"
            #subscribe
          >
            <LayerSubscribeButton :channel="video.channel" />
          </template>
          <template #actions>
            <!-- The Later list's buttons, as on a card: YouTube only -->
            <FtIconButton
              v-if="isYouTube"
              :title="isInLater ? t('Later.Remove from Later') : t('Later.Add to Later')"
              :icon="isInLater ? ['fas', 'clock'] : ['far', 'clock']"
              :theme="isInLater ? 'secondary' : 'base'"
              class="laterButton"
              @click="toggleLater"
            />
            <FtIconButton
              v-if="isYouTube && (isArmed || armableAt !== null)"
              :title="isArmed ? t('Later.Disarm') : t('Later.Arm')"
              :icon="isArmed ? ['fas', 'calendar-check'] : ['far', 'calendar-plus']"
              :theme="isArmed ? 'secondary' : 'base'"
              class="armButton"
              @click="toggleArmed"
            />
            <FtIconButton
              v-if="canUseFormat('audio')"
              :title="activeFormat === 'audio' ? t('PeerTube.Watch.Play video') : t('PeerTube.Watch.Audio only')"
              :icon="activeFormat === 'audio' ? ['fas', 'film'] : ['fas', 'volume-high']"
              theme="secondary"
              @click="toggleAudioOnly"
            />
            <!-- A YouTube video downloads through yt-dlp, a PeerTube one from its instance (phase 2, Q9) -->
            <FtYtDlpDownloadButton
              v-if="isYouTube"
              :video-id="video.videoId"
              :title="video.title"
              :is-live="isLive"
              :is-upcoming="video.isUpcoming"
            />
            <LayerDownloadButton
              v-else
              :video="video"
            />
          </template>
        </LayerVideoInfo>
        <LayerVideoDescription
          v-if="!hideVideoDescription"
          :description="video.description"
          :kind="video.descriptionKind"
          :base-url="video.host ? `https://${video.host}` : ''"
          class="watchVideo"
          @timestamp-event="changeTimestamp"
        />
        <!-- As the old watch page: no comments for a live that is live -->
        <LayerComments
          v-if="!isLive && videoRef"
          :key="video.videoId"
          :video-ref="videoRef"
          :comments-enabled="video.commentsEnabled !== false"
          :base-url="video.host ? `https://${video.host}` : ''"
          :sortable="isYouTube"
          class="watchVideo"
        />
      </div>
    </template>
    <!-- Kept through the loads of the playlist's videos, as Watch.vue keeps the
    playlist panel, so that loop, shuffle and reverse carry on to the next -->
    <div
      v-if="hasSidePanel"
      v-show="sidebarShown"
      class="sidebarArea"
    >
      <!-- As Watch.vue: first in the sidebar, sized as the playlist panel -->
      <WatchVideoLiveChat
        v-if="liveChatShown && !isLoading && !hiddenAsNotFamilyFriendly"
        :key="video.videoId"
        :live-chat="video.liveChat"
        :video-id="video.videoId"
        :channel-id="video.authorId"
        class="watchVideoSidebar watchVideoPlaylist"
      />
      <WatchVideoPlaylist
        v-if="playlist !== null"
        ref="playlistPanel"
        :watch-view-loading="isLoading"
        :playlist-id="playlist.id"
        :playlist-type="playlist.type"
        :video-id="routeVideoId"
        :playlist-item-id="playlist.itemId"
        cross-platform
        class="watchVideoSidebar watchVideoPlaylist"
        @pause-player="pausePlayer"
      />
      <template v-if="!isLoading && !hiddenAsNotFamilyFriendly">
        <WatchVideoChapters
          v-if="chaptersShown"
          :chapters="chapters"
          :current-chapter-index="currentChapterIndex"
          :kind="video.chaptersKind ?? 'chapters'"
          class="watchVideoSidebar"
          @timestamp-event="changeTimestamp"
        />
        <WatchVideoRecommendations
          v-if="recommendationsShown"
          :data="recommendedVideos"
          class="watchVideoSidebar"
          ai-wall
          @pause-player="pausePlayer"
        />
      </template>
    </div>
  </div>
</template>

<script setup>
// The platform layer's watch view. It talks only to the injected layer and
// reads only the common shapes (platform/shapes.js). The route names the
// video: `/watch/:id` a YouTube one by its id, as upstream's route does, and
// the PeerTube route one by host and uuid. Where the two platforms differ is
// in what is written beside the player, chosen by `platformOf(video)`: the
// history entry's extra fields, the subscription details refresh and the
// download button. The recommendations, and the autoplay into them, are the
// details' `related`, which only YouTube answers. A playlist is the route's
// query, as upstream's, and its panel is upstream's `WatchVideoPlaylist`,
// which fetches a YouTube playlist itself; here it plays a user playlist
// through both platforms, each video on its own route, with the router
// keeping this view between the two. A live's chat is upstream's
// `WatchVideoLiveChat`, handed the chat the details hold (YouTube Local's
// only). Upstream's Watch view (views/Watch) is the model for
// everything a viewer sees and for when history and progress are written; it
// is not edited. A `sabr` source's regulator is hosted by `useSabrHosting`,
// beside this view (ADR-0006, ADR-0016).

import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import shaka from 'shaka-player'
import { computed, getCurrentInstance, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

import FtAgeRestricted from '../../components/FtAgeRestricted/FtAgeRestricted.vue'
import FtButton from '../../components/FtButton/FtButton.vue'
import FtIconButton from '../../components/FtIconButton/FtIconButton.vue'
import FtLoader from '../../components/FtLoader/FtLoader.vue'
import FtShakaVideoPlayer from '../../components/ft-shaka-video-player/ft-shaka-video-player.vue'
import FtYtDlpDownloadButton from '../../components/FtYtDlpDownloadButton/FtYtDlpDownloadButton.vue'
import LayerComments from '../../components/LayerComments/LayerComments.vue'
import LayerDownloadButton from '../../components/LayerDownloadButton/LayerDownloadButton.vue'
import LayerSubscribeButton from '../../components/LayerSubscribeButton/LayerSubscribeButton.vue'
import LayerVideoDescription from '../../components/LayerVideoDescription/LayerVideoDescription.vue'
import LayerVideoInfo from '../../components/LayerVideoInfo/LayerVideoInfo.vue'
import WatchVideoChapters from '../../components/WatchVideoChapters/WatchVideoChapters.vue'
import WatchVideoLiveChat from '../../components/WatchVideoLiveChat/WatchVideoLiveChat.vue'
import WatchVideoPlaylist from '../../components/WatchVideoPlaylist/WatchVideoPlaylist.vue'
import WatchVideoRecommendations from '../../components/WatchVideoRecommendations/WatchVideoRecommendations.vue'
import { toStoredPlainText } from '../../components/LayerMarkdown/plainText'
import { routeView } from '../../components/LayerSurfaceSwitch/surfaceSwitch'

import store from '../../store/index'
import { formatScheduledTime, getLocalesWithFallback, showToast } from '../../helpers/utils'
import { isHiddenAsAi } from '../../helpers/aiShown'
import { PLATFORM_YOUTUBE, isYouTubeVideoRef, peerTubeVideoRef, platformOf } from '../../platform/refs'
import { usePlatformLayer } from '../../platform/vue'
import { useSabrHosting } from './useSabrHosting'
import { subscriptionEntryIsUpcoming, subscriptionEntryScheduledAt } from '../../../subscriptionFeedMerge'

/** @typedef {'dash' | 'legacy' | 'audio'} Format */
/** @typedef {{ icon: string[], text: string, detail?: string, retryable?: boolean }} Message */

/**
 * The format ring: adaptive first, then the legacy (single file) formats,
 * then audio only. A format the video does not have is never tried: the
 * player given `legacy` without legacy formats loads nothing, silently.
 *
 * @type {Format[]}
 */
const FORMAT_RING = ['dash', 'legacy', 'audio']

const layer = usePlatformLayer()
const route = useRoute()
const router = useRouter()
const { locale, t } = useI18n()

const player = useTemplateRef('player')
const playlistPanel = useTemplateRef('playlistPanel')
/** This view, which the router keeps between its two watch routes */
const thisView = getCurrentInstance().type

const rememberHistory = computed(() => store.getters.getRememberHistory)
const watchedProgressSavingEnabled = computed(() => store.getters.getWatchedProgressSavingMode !== 'never')
const autosaveWatchedProgress = computed(() => store.getters.getWatchedProgressSavingMode === 'auto')
const hideChapters = computed(() => store.getters.getHideChapters)
const hideVideoDescription = computed(() => store.getters.getHideVideoDescription)
const showFamilyFriendlyOnly = computed(() => store.getters.getShowFamilyFriendlyOnly)
const hideRecommendedVideos = computed(() => store.getters.getHideRecommendedVideos)
const hideLiveChat = computed(() => store.getters.getHideLiveChat)
const saveVideoHistoryWithLastViewedPlaylist = computed(() => store.getters.getSaveVideoHistoryWithLastViewedPlaylist)

const isLoading = ref(true)
/** @type {import('vue').ShallowRef<import('../../platform/shapes').VideoDetails | null>} */
const video = shallowRef(null)
/** @type {import('vue').ShallowRef<{ kind?: string, reason?: string | null, host?: string | null } | null>} */
const loadError = shallowRef(null)

/** @type {import('vue').Ref<Format>} */
const activeFormat = ref('dash')
/** The formats that have failed for this video */
const failedFormats = new Set()
/**
 * Why the video stopped playing, once nothing more is tried, `null` while it
 * plays
 *
 * @type {import('vue').ShallowRef<Message | null>}
 */
const playbackFailure = shallowRef(null)
/** Whether the window was narrower than 500px when the video was opened */
const narrowWindow = ref(false)

/** @type {import('vue').Ref<number | null>} */
const startTime = ref(null)
const currentChapterIndex = ref(0)
const currentPlaybackRate = ref(store.getters.getDefaultPlayback)

/**
 * The video's recommendations, those already watched last, ordered once when
 * the video is opened, as Watch.js orders them
 *
 * @type {import('vue').ShallowRef<import('../../platform/shapes').VideoSummary[]>}
 */
const recommendedVideos = shallowRef([])
// For as long as the viewer stays on watch pages, whatever the setting says
// meanwhile, as Watch.js keeps it
const autoplayNextRecommendedVideo = ref(store.getters.getPlayNextVideo)
const autoplayNextPlaylistVideo = ref(store.getters.getAutoplayPlaylists)

const useTheatreMode = ref(false)
const startInFullscreen = ref(false)
const startInFullwindow = ref(false)
const startInPip = ref(false)

/** The `timestamp` query the video was opened with */
let timestamp = null
/** Where the ladder's page reload or a retry asked the next load to start, once */
let resumeAt = null
/** Where playback was when nothing more was tried, for a retry to resume there */
let retryAt = null
/** Whether the history entry has been written for this video */
let historyWritten = false
/** Whether leaving the page has already saved the position */
let savedOnLeave = false
/** Tells a load apart from the one that replaced it */
let loadsStarted = 0
/** Set by the route guard once it lets a navigation leave the video, until the next load */
let leavingVideo = false
/** Whether a video has been shown, and the default viewing mode applied to it */
let viewingModeApplied = false
/** The player whose destruction has begun, and that destruction */
let destroyedPlayer = null
/** @type {Promise<void>} */
let destruction = Promise.resolve()
/** The countdown to the next video, and what closes its toast, while it runs */
let playNextTimeout = null
/** @type {AbortController | null} */
let playNextToast = null
/** Set once the viewer has done nothing for the interruption interval */
let blockVideoAutoplay = false
let autoplayInterruptionTimeout = null

/** What the player plays from, either transport */
const source = computed(() => video.value?.playbackSource ?? null)

/**
 * A `sabr` source (YouTube Local) plays over SABR, with the regulator this
 * view hosts (useSabrHosting.js). Its `audio` is the same SABR manifest.
 */
const isSabr = computed(() => source.value?.transport === 'sabr')

const {
  regulator: sabrRegulator,
  sabrData,
  expiresAt: sabrExpiresAt,
  manifestUrl: sabrManifestUrl,
  manifestMimeType: sabrManifestMimeType,
  onSabrRefreshRequested,
  onPlayerReloadRequested,
  isEndOfLadder,
  isTransportFailure,
} = useSabrHosting(source, {
  isRegulated: () => store.getters.getEnableRegulatedStreaming,
  currentPosition,
  reload: reloadKeepingPosition,
})

const isYouTube = computed(() => video.value !== null && platformOf(video.value) === PLATFORM_YOUTUBE)

const isLive = computed(() => video.value?.liveStatus === 'live' || source.value?.isLive === true)

/** The canonical URL the player's copy link button copies, as LayerVideoInfo shares it */
const videoUrl = computed(() => {
  if (video.value === null) {
    return ''
  }
  return video.value.url || layer.describe(video.value).shareUrl || ''
})

/**
 * As Watch.vue under `showFamilyFriendlyOnly`: a YouTube video YouTube does
 * not rate family friendly is not shown. PeerTube's flag is `nsfw`, which the
 * layer filters itself.
 */
const hiddenAsNotFamilyFriendly = computed(() => {
  return isYouTube.value && showFamilyFriendlyOnly.value && video.value.isFamilyFriendly !== true
})

/**
 * The caption tracks, a translated one labelled in the display language, as
 * Watch.js's `getTranslatedLocaleCaption` labels it: the layer, without i18n,
 * can only fill the template in English. Under SABR the manifest carries the
 * tracks as the layer labelled them.
 */
const captions = computed(() => {
  return (source.value?.captions ?? []).map((track) => {
    if (!track.translation) {
      return track
    }

    return {
      ...track,
      label: t('Video.Player.TranslatedCaptionTemplate', {
        language: track.translation.language ?? t('Locale Name'),
        originalLanguage: track.translation.originalLanguage,
      }),
    }
  })
})

/**
 * The storyboard, from the smaller board where the layer has one and the
 * window was narrower than 500px when the video was opened, as Watch.js
 * chooses (`narrowStoryboard`, YouTube Local only)
 */
const storyboardSrc = computed(() => {
  const playbackSource = source.value

  if (narrowWindow.value && playbackSource.narrowStoryboard !== undefined) {
    return playbackSource.narrowStoryboard ?? ''
  }

  return playbackSource.storyboard ?? ''
})

/** When the streaming URLs playing now expire: the session's under SABR, else the source's */
const expiresAt = computed(() => (isSabr.value ? sabrExpiresAt.value : source.value?.expiresAt) ?? null)

/** The video as the layer names it, for its comments */
const videoRef = computed(() => {
  if (video.value === null) {
    return null
  }

  return isYouTube.value ? video.value.videoId : peerTubeVideoRef(video.value.host, video.value.videoId)
})

/**
 * The video's id as the route names it, before the layer answers: a YouTube
 * id, or a PeerTube uuid as the stored records keep it, in lower case
 */
const routeVideoId = computed(() => {
  if (route.params.id !== undefined) {
    return String(route.params.id)
  }

  return typeof route.params.uuid === 'string' ? route.params.uuid.toLowerCase() : ''
})

/**
 * The playlist the video is played in, as Watch.js's `checkIfPlaylist` reads
 * the route's query: a YouTube playlist by its id; a user playlist only while
 * it exists and holds the video (until the user playlists are ready, none).
 * `null` for none.
 *
 * @type {import('vue').ComputedRef<{ id: string, type: string, itemId: string | null, userPlaylistId: string | null } | null>}
 */
const playlist = computed(() => {
  const { playlistId, playlistType, playlistItemId } = route.query

  if (typeof playlistId !== 'string' || playlistId === '') {
    return null
  }

  if (playlistType !== 'user') {
    return { id: playlistId, type: typeof playlistType === 'string' ? playlistType : '', itemId: null, userPlaylistId: null }
  }

  const userPlaylist = store.getters.getPlaylist(playlistId)

  if (userPlaylist == null || !userPlaylist.videos.some(item => item.videoId === routeVideoId.value)) {
    return null
  }

  return {
    id: playlistId,
    type: 'user',
    itemId: typeof playlistItemId === 'string' ? playlistItemId : null,
    userPlaylistId: userPlaylist._id,
  }
})

const chapters = computed(() => source.value?.chapters ?? [])
// Hidden chapters are hidden from the player's progress bar too, as Watch.js
// does by not reading them at all
const chaptersShown = computed(() => !hideChapters.value && chapters.value.length > 0)

/**
 * As Watch.vue under `hideRecommendedVideos`, for a video with a watch-next
 * list: YouTube's. PeerTube's details have none, and so no panel.
 */
const recommendationsShown = computed(() => !hideRecommendedVideos.value && Array.isArray(video.value?.related))

/**
 * As Watch.vue under `hideLiveChat`, for a live or upcoming video whose
 * details hold a chat to open: YouTube's from Local. Invidious answers none,
 * and so no panel. The handle is the details', handed on as it is, to the
 * panel, which starts it, and to the player, which can show it over the video.
 */
const liveChatShown = computed(() => {
  return !hideLiveChat.value && video.value?.liveChat != null && (isLive.value || video.value.isUpcoming)
})

/**
 * Whether the sidebar has a panel to show: the live chat, the playlist, the
 * chapters or the recommendations. A new side panel joins here, and theatre
 * mode comes with it.
 */
const hasSidePanel = computed(() => liveChatShown.value || playlist.value !== null || chaptersShown.value || recommendationsShown.value)

/** The sidebar is shown with a side panel in it, once the video is in and shown */
const sidebarShown = computed(() => {
  return !isLoading.value && !hiddenAsNotFamilyFriendly.value && hasSidePanel.value
})

// As Watch.js: theatre mode moves the sidebar out of the way, whichever panel
// it holds; without one there is nothing to move
const theatrePossible = sidebarShown

/**
 * As Watch.js's `nextRecommendedVideo`: the first recommendation not of a
 * hidden channel nor matching a forbidden title. None while the
 * recommendations are hidden, as the player's skip to next has it (hiding
 * them switches `playNextVideo` off too).
 */
const nextRecommendedVideo = computed(() => {
  if (hideRecommendedVideos.value) {
    return null
  }

  const channelsHidden = JSON.parse(store.getters.getChannelsHidden).map((channel) => {
    // Legacy support, as Watch.js has it
    return typeof channel === 'string' ? { name: channel } : channel
  })
  const forbiddenTitles = JSON.parse(store.getters.getForbiddenTitles.toLowerCase())

  return recommendedVideos.value.find((recommended) => {
    return !(channelsHidden.some(channel => channel.name === recommended.authorId || channel.name === recommended.author) ||
      forbiddenTitles.some(text => recommended.title?.toLowerCase().includes(text) || recommended.author?.toLowerCase().includes(text)) ||
      // Nor one the AI pill hides: autoplay does not lead where the list does not show
      isHiddenAsAi(recommended))
  }) ?? null
})

/**
 * Whether the end of the video plays the next one, and the player's toggle
 * says so: in a playlist, the playlist's own (`autoplayPlaylists`), and
 * possible until the playlist ends, as Watch.js has it
 */
const autoplayEnabled = computed(() => playlist.value !== null ? autoplayNextPlaylistVideo.value : autoplayNextRecommendedVideo.value)
const autoplayPossible = computed(() => {
  if (playlist.value !== null) {
    return playlistPanel.value != null && !playlistPanel.value.shouldStopDueToPlaylistEnd
  }

  return nextRecommendedVideo.value !== null
})

// A SABR source's adaptive and audio are one manifest, the one held for the
// session: the source's, or a rebuild's since
const manifestSrc = computed(() => {
  if (isSabr.value) {
    return sabrManifestUrl.value
  }

  return activeFormat.value === 'audio' ? source.value.audio.manifestUrl : source.value.manifestUrl
})

const manifestMimeType = computed(() => {
  if (isSabr.value) {
    return sabrManifestMimeType.value
  }

  return activeFormat.value === 'audio' ? source.value.audio.mimeType : (source.value.manifestMimeType ?? '')
})

const canSaveWatchProgress = computed(() => {
  return !isLoading.value && video.value !== null && !isLive.value && !video.value.isUpcoming
})

/**
 * @param {Format} format
 * @returns {boolean}
 */
function canUseFormat(format) {
  const playbackSource = source.value

  if (playbackSource === null) {
    return false
  }

  switch (format) {
    case 'dash':
      return !!playbackSource.manifestUrl
    case 'legacy':
      // As Watch.js: neither a live nor a post-live DVR recording plays from them
      return !playbackSource.isLive && !playbackSource.isPostLiveDvr && playbackSource.legacyFormats.length > 0
    case 'audio':
      return !!playbackSource.audio
    default:
      return false
  }
}

/**
 * The format a video starts in: for YouTube, the default format setting where
 * the video has it, as Watch.js starts from it, else the first of the ring it
 * has. A PeerTube video starts on the ring, as it always has.
 *
 * @returns {Format}
 */
function initialFormat() {
  const preferred = store.getters.getDefaultVideoFormat

  if (isYouTube.value && FORMAT_RING.includes(preferred) && canUseFormat(preferred)) {
    return preferred
  }

  return FORMAT_RING.find(canUseFormat) ?? 'dash'
}

/**
 * What to show instead of the player, or `null` to show the player.
 *
 * @type {import('vue').ComputedRef<Message | null>}
 */
const message = computed(() => {
  if (loadError.value !== null) {
    return loadErrorMessage(loadError.value)
  }

  const details = video.value

  if (details === null) {
    return null
  }

  // A waiting live with a trailer plays it, and an ended one served as a
  // recording (YouTube's post-live DVR) plays that, as the old view does;
  // PeerTube answers neither with a source. A waiting YouTube video says when
  // it premieres instead (`premiere`)
  if (details.liveStatus === 'waiting' && source.value === null) {
    if (isYouTube.value) {
      return null
    }

    return {
      icon: ['fas', 'satellite-dish'],
      text: t('PeerTube.Watch.Live waiting'),
      detail: details.premiereDate
        ? t('PeerTube.Watch.Live starts', { time: formatScheduledTime(new Date(details.premiereDate).getTime()) })
        : '',
    }
  }

  if (details.liveStatus === 'ended' && source.value === null) {
    return { icon: ['fas', 'tower-broadcast'], text: t('PeerTube.Watch.Live ended') }
  }

  if (playbackFailure.value !== null) {
    return playbackFailure.value
  }

  if (!canUseFormat(activeFormat.value)) {
    return cannotPlay()
  }

  return null
})

/** @returns {Message} */
function cannotPlay() {
  return { icon: ['fas', 'exclamation-circle'], text: t('PeerTube.Watch.Cannot play'), retryable: true }
}

const showPlayer = computed(() => message.value === null && source.value !== null)

/**
 * When a waiting YouTube video premieres, in Watch.js's words for an upcoming
 * one: how long until then (minutes up to two hours, then hours up to a day,
 * then days, rounded down, and less than a minute below one) and the date, its
 * year only where it is not this year's; `{}` without a scheduled time, `null`
 * for any other video. Worked out once per video, as there. A PeerTube live
 * says when it starts in its own message.
 *
 * @type {import('vue').ComputedRef<{ timeLeft?: string, timestamp?: string } | null>}
 */
const premiere = computed(() => {
  const details = video.value

  if (!isYouTube.value || details.liveStatus !== 'waiting' || loadError.value !== null) {
    return null
  }

  if (!details.premiereDate) {
    return {}
  }

  const start = new Date(details.premiereDate)
  const now = new Date()
  const locales = getLocalesWithFallback(locale.value)

  const timestampOptions = { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }

  if (now.getFullYear() < start.getFullYear()) {
    timestampOptions.year = 'numeric'
  }

  let timeLeft = (start.getTime() - now.getTime()) / 1000 / 60
  let timeUnit = 'minute'

  // YouTube switches to minutes at 120 minutes left
  if (timeLeft > 120) {
    timeLeft /= 60
    timeUnit = 'hour'
  }

  if (timeUnit === 'hour' && timeLeft > 24) {
    timeLeft /= 24
    timeUnit = 'day'
  }

  timeLeft = Math.floor(timeLeft)

  return {
    timeLeft: timeLeft < 1
      ? t('Video.Published.In less than a minute').toLowerCase()
      : new Intl.RelativeTimeFormat(locales).format(timeLeft, timeUnit),
    timestamp: new Intl.DateTimeFormat(locales, timestampOptions).format(start),
  }
})

/**
 * The premiere's text is shown over the thumbnail, or below the trailer while
 * one plays, as Watch.vue shows it; a failure to play the trailer says so
 * instead
 */
const premiereShown = computed(() => premiere.value !== null && (showPlayer.value || message.value === null))

/**
 * @param {{ kind?: string, reason?: string | null, host?: string | null }} error
 */
function loadErrorMessage(error) {
  // A YouTube video's messages name YouTube where a PeerTube one names its
  // instance; the old view has words of its own for its refusals only
  const host = error.host ?? route.params.host ?? 'YouTube'

  switch (error.kind) {
    case 'refused':
      if (route.params.id !== undefined) {
        return youtubeRefusalMessage(error)
      }

      return { icon: ['fas', 'lock'], text: refusalText(error.reason, host) }
    case 'notFound':
      return { icon: ['fas', 'exclamation-circle'], text: t('PeerTube.Watch.Not found', { host }) }
    case 'unavailable':
      return { icon: ['fas', 'exclamation-circle'], text: t('PeerTube.Watch.Unavailable', { host }), retryable: true }
    case 'rateLimited':
      return { icon: ['fas', 'clock'], text: t('PeerTube.Watch.Rate limited', { host }), retryable: true }
    default:
      return { icon: ['fas', 'exclamation-circle'], text: t('PeerTube.Watch.Could not load'), retryable: true }
  }
}

/**
 * @param {string | null | undefined} reason
 * @param {string} host
 */
function refusalText(reason, host) {
  switch (reason) {
    case 'private':
      return t('PeerTube.Watch.Refused.Private', { host })
    case 'internal':
      return t('PeerTube.Watch.Refused.Internal', { host })
    case 'password':
      return t('PeerTube.Watch.Refused.Password')
    case 'blocked':
      return t('PeerTube.Watch.Refused.Blocked', { host })
    default:
      return t('PeerTube.Watch.Refused.Other', { host })
  }
}

/**
 * A refused YouTube video, in Watch.js's words for each reason, with its icon
 * for members only. None of them offers to try again, as there. Without a
 * reason, YouTube's own (`[STATUS] reason: explanation`, which the layer
 * keeps as the message), as Watch.js shows it.
 *
 * @param {{ reason?: string | null, message?: string }} error
 * @returns {Message}
 */
function youtubeRefusalMessage(error) {
  const icon = ['fas', 'exclamation-circle']

  switch (error.reason) {
    case 'private':
      return { icon, text: t('Video.Private') }
    case 'membersOnly':
      return { icon: ['fas', 'money-check-dollar'], text: t('Video.MembersOnly') }
    case 'ageRestricted':
      return { icon, text: t('Video.AgeRestricted') }
    case 'drm':
      return { icon, text: t('Video.DRMProtected') }
    case 'ipBlock':
      return { icon, text: t('Video.IP block') }
    case 'unexplained':
      return { icon, text: t('Video.Unexplained playback refusal') }
    default:
      return { icon, text: error.message || t('PeerTube.Watch.Refused.Other', { host: 'YouTube' }) }
  }
}

/**
 * The video the route names: on a `/watch/:id` route, as upstream's watch
 * route is, a YouTube id; on the PeerTube route, its host and uuid. `null`
 * for a name that is neither.
 *
 * @returns {import('../../platform/shapes').VideoRef | null}
 */
function routeVideoRef() {
  if (route.params.id !== undefined) {
    return isYouTubeVideoRef(route.params.id) ? route.params.id : null
  }

  return peerTubeVideoRef(route.params.host, route.params.uuid)
}

function readTimestamp() {
  const value = parseInt(route.query.timestamp)
  return isNaN(value) || value < 0 ? null : value
}

function historyEntry() {
  return video.value ? store.getters.getHistoryCacheById[video.value.videoId] : undefined
}

/**
 * Where to start, as Watch.js's `startTimeSeconds`: where the ladder's page
 * reload left off, else the timestamp asked for, else the stored position if
 * progress is being saved at all and the video was not watched to its end,
 * else the beginning. Never for a live.
 *
 * @param {number | null} resumePosition
 */
function initialStartTime(resumePosition) {
  if (isLive.value) {
    return null
  }

  const lengthSeconds = video.value.lengthSeconds ?? 0

  if (resumePosition !== null && resumePosition < lengthSeconds) {
    return resumePosition
  }

  if (timestamp !== null && timestamp < lengthSeconds) {
    return timestamp
  }

  const entry = historyEntry()

  // No reading of progress while writing it is switched off, as for YouTube
  if (watchedProgressSavingEnabled.value && entry !== undefined) {
    const { watchProgress } = entry

    if (watchProgress > 0 && watchProgress < lengthSeconds - 2) {
      return watchProgress
    }
  }

  return null
}

/**
 * As Watch.js: `setViewingModeOnFirstLoad` for the first video this view
 * shows, then `setViewingModeOnRouteChange` for every later one, a reload and
 * a retry included, which applies only the `_always_on` modes. Otherwise the
 * player's own state carries over from the video before (`destroyPlayer`).
 */
function applyViewingMode() {
  const mode = store.getters.getDefaultViewingMode

  if (viewingModeApplied) {
    if (mode === 'fullscreen_always_on') {
      startInFullscreen.value = true
    } else if (mode === 'fullwindow_always_on') {
      startInFullwindow.value = true
    }

    return
  }

  viewingModeApplied = true

  switch (mode) {
    case 'theatre':
      useTheatreMode.value = theatrePossible.value
      break
    case 'fullscreen':
    case 'fullscreen_always_on':
      startInFullscreen.value = true
      break
    case 'fullwindow':
    case 'fullwindow_always_on':
      startInFullwindow.value = true
      break
    case 'pip':
      startInPip.value = true
  }
}

async function load() {
  const thisLoad = ++loadsStarted
  // Once only, as Watch.js's `oneTimeTimestamp`
  const resumePosition = resumeAt
  resumeAt = null
  retryAt = null

  isLoading.value = true
  video.value = null
  recommendedVideos.value = []
  loadError.value = null
  playbackFailure.value = null
  failedFormats.clear()
  narrowWindow.value = window.innerWidth < 500
  historyWritten = false
  savedOnLeave = false
  leavingVideo = false
  startTime.value = null
  currentChapterIndex.value = 0
  timestamp = readTimestamp()

  const ref = routeVideoRef()

  try {
    if (ref === null) {
      loadError.value = { kind: 'notFound', host: route.params.host ?? null }
      return
    }

    const details = await layer.getVideo(ref)

    if (thisLoad !== loadsStarted) {
      return
    }

    video.value = details
    recommendedVideos.value = sortWatchedVideosLast(details.related ?? [])

    // YouTube's AI label, read from the /next the details came from: kept,
    // so that this video's tile is never asked about (helpers/aiMarker)
    if (details.aiVerdict === 'ai' || details.aiVerdict === 'not-ai') {
      store.dispatch('recordAiVerdict', { videoId: details.videoId, verdict: details.aiVerdict })
    }

    // As Watch.js: shown as age restricted, and moved on from as if it had
    // ended, without a title or the subscription's details
    if (hiddenAsNotFamilyFriendly.value) {
      isLoading.value = false
      handleVideoEnded()
      return
    }

    activeFormat.value = initialFormat()
    startTime.value = initialStartTime(resumePosition)
    // Theatre mode is only possible once the page knows what the sidebar holds
    isLoading.value = false
    applyViewingMode()
    store.commit('setAppTitle', details.title)
    updateSubscriptionDetails(details)
  } catch (error) {
    if (thisLoad !== loadsStarted) {
      return
    }

    if (!error?.kind) {
      console.error(error)
    }

    loadError.value = error ?? {}
  } finally {
    if (thisLoad === loadsStarted) {
      isLoading.value = false
    }
  }
}

/** Where playback is, or `null` when the player has not loaded */
function currentPosition() {
  return player.value?.hasLoaded ? player.value.getCurrentTime() : null
}

/** As Watch.js `pausePlayer`: before the video goes to the external player */
function pausePlayer() {
  if (player.value && !player.value.isPaused()) {
    player.value.pause()
  }
}

/**
 * Plays the video in another format, from where it was.
 *
 * @param {Format} format
 */
function switchFormat(format) {
  startTime.value = currentPosition() ?? startTime.value
  activeFormat.value = format
}

/**
 * The player could not play the active format: walk the ring to the next
 * format the video has and has not failed in, or say it cannot be played.
 *
 * @param {shaka.util.Error} error
 */
async function handlePlayerError(error) {
  // As Watch.js: the connection was lost, and the player keeps trying and
  // resumes by itself when it returns, so the format is not at fault
  if (error?.code === shaka.util.Error.Code.HTTP_ERROR &&
    error.data?.[1]?.message === 'Failed to fetch' &&
    !navigator.onLine) {
    return
  }

  // What a YouTube stream's failure says of itself, which no other format
  // would mend, as Watch.js reads it
  const said = isYouTube.value ? youtubeStreamFailure(error) : null

  if (said !== null) {
    await stopPlaying(said)
    return
  }

  failedFormats.add(activeFormat.value)

  // As Watch.js: a failed SABR transport is not a failed format. Adaptive and
  // audio are the same session, which the regulator has already spent what
  // it has on, so only the legacy formats remain worth trying
  if (isSabr.value && isTransportFailure(error)) {
    failedFormats.add('dash')
    failedFormats.add('audio')
  }

  const next = FORMAT_RING.find(format => !failedFormats.has(format) && canUseFormat(format))

  if (next) {
    switchFormat(next)
    return
  }

  await stopPlaying(cannotPlay())
}

/**
 * Whether the streaming URLs have expired: only where the layer said when.
 * (Watch.js, comparing the time with an unknown expiry, takes it as expired.)
 */
function streamExpired() {
  return expiresAt.value !== null && Date.now() > expiresAt.value.getTime()
}

/**
 * Watch.js's `handlePlayerError` for a YouTube video, before its format ring:
 * the end of the SABR ladder (ADR-0011), which no other format escapes, its
 * retry starting the ladder afresh; a 429, the rate limit, to try again; a
 * 403, which reads as an expired session
 * once the streaming URLs have expired and otherwise as the address refused,
 * a music video's possibly by country; a legacy format failing after the
 * expiry. Its words, hard-coded in English there, are kept as they are.
 * `null` for anything else, which the ring takes.
 *
 * @param {any} error a player error
 * @returns {Message | null}
 */
function youtubeStreamFailure(error) {
  const { Code } = shaka.util.Error
  const clock = ['fas', 'clock']

  if (isEndOfLadder(error)) {
    return {
      icon: ['fas', 'shield'],
      text: 'YouTube is not serving this video to the current session (PO token rejected). Trying again sometimes works, otherwise wait a while or switch networks.',
      retryable: true,
    }
  }

  if (error?.code === Code.BAD_HTTP_STATUS && error.data?.[1] === 429) {
    return { icon: ['fas', 'exclamation-circle'], text: '[BAD_HTTP_STATUS: 429] Ratelimited', retryable: true }
  }

  if (error?.code === Code.BAD_HTTP_STATUS && error.data?.[1] === 403) {
    if (streamExpired()) {
      return { icon: clock, text: '[BAD_HTTP_STATUS: 403] YouTube watch session expired.', retryable: true }
    }

    return {
      icon: ['fas', 'exclamation-circle'],
      text: video.value.category === 'Music'
        ? '[BAD_HTTP_STATUS: 403] Potential causes: IP block, streaming URL deciphering failed or music video geo-block'
        : '[BAD_HTTP_STATUS: 403] Potential causes: IP block or streaming URL deciphering failed',
    }
  }

  if (error?.code === Code.VIDEO_ERROR && activeFormat.value === 'legacy' && streamExpired()) {
    return { icon: clock, text: '[VIDEO_ERROR] YouTube watch session expired.', retryable: true }
  }

  return null
}

/**
 * Nothing more is tried: the message replaces the player. The player goes
 * away with it, so its position is taken now, saved and kept for a retry, as
 * Watch.js's `showRetryableError` keeps it. It is destroyed before that too:
 * unmounted by the message, it would be left running, as a live that goes on
 * refreshing its playlist.
 *
 * @param {Message} failure
 */
async function stopPlaying(failure) {
  const position = player.value === destroyedPlayer ? null : currentPosition()

  handleWatchProgressAutoSaveWhenProgressEnabled(position)

  // Where the player was told to start, where it never loaded: a format the
  // ring switched to from a position, which failed before playing
  const resumePosition = position ?? startTime.value
  retryAt = resumePosition === null ? null : Math.floor(resumePosition)

  const thisLoad = loadsStarted

  try {
    await destroyPlayer()
  } catch (destroyError) {
    console.error(destroyError)
  }

  // Unless another video has started loading meanwhile
  if (thisLoad === loadsStarted) {
    playbackFailure.value = failure
  }
}

/**
 * The ladder's page reload (useSabrHosting.js), as Watch.js's `reloadView`:
 * the position saved and the player destroyed, then the video asked of the
 * layer afresh and started at `position`. Not if, during the destruction,
 * another video has started loading or a navigation has left this one: the
 * position is this video's, and the navigation brings its own load.
 *
 * @param {number | null} position
 */
async function reloadKeepingPosition(position) {
  handleWatchProgressAutoSave()

  const thisLoad = loadsStarted

  await destroyPlayerLogged()

  // A navigation the route guard has let through, whose load is still to come
  if (thisLoad !== loadsStarted || leavingVideo) {
    return
  }

  resumeAt = position
  await load()
}

/**
 * The message's Try Again, as Watch.js's `retryVideo`: the video asked of the
 * layer afresh, starting where playback stopped, where it had got past the
 * beginning (`oneTimeTimestamp`). A new load resets the regulator
 * (useSabrHosting.js), as `retryVideo` does.
 */
function retry() {
  resumeAt = retryAt !== null && retryAt > 0 ? retryAt : null
  load()
}

function toggleAudioOnly() {
  if (activeFormat.value === 'audio') {
    const videoFormat = FORMAT_RING.find(format => format !== 'audio' && canUseFormat(format))

    if (videoFormat) {
      switchFormat(videoFormat)
    }
  } else {
    switchFormat('audio')
  }
}

/**
 * As Watch.js's `updateCurrentChapter`
 *
 * @param {number} currentSeconds
 */
function updateCurrentChapter(currentSeconds) {
  const list = chapters.value

  if (!chaptersShown.value) {
    return
  }

  const currentChapterStart = list[currentChapterIndex.value].startSeconds

  if (currentSeconds !== currentChapterStart) {
    let i = currentSeconds < currentChapterStart ? 0 : currentChapterIndex.value

    for (; i < list.length; i++) {
      if (currentSeconds < list[i].endSeconds) {
        currentChapterIndex.value = i
        break
      }
    }
  }
}

/**
 * @param {number} seconds
 */
function changeTimestamp(seconds) {
  if (!isLoading.value && player.value?.hasLoaded) {
    player.value.setCurrentTime(seconds)
  }
}

/**
 * The history entry, as Watch.js's `addToHistory` writes it, with exactly its
 * fields and names. A YouTube video carries its `category` where it has one,
 * as there: the YouTube category the profile suggestions read. A video of
 * another platform adds what its record needs to render and route (spec,
 * "Refs and stored shapes") and never `category`: a PeerTube video's own
 * category label goes to `peertubeCategory` instead, where it has one, so
 * that the two vocabularies never meet (docs/CONTEXT.md, "Watched
 * category"). Nothing reads it yet.
 *
 * @param {number} watchProgress
 */
function historyRecord(watchProgress) {
  const details = video.value

  const record = {
    videoId: details.videoId,
    title: details.title,
    author: details.author,
    authorId: details.authorId,
    published: details.published,
    // Plain text: the old list card renders it as HTML
    description: toStoredPlainText(details.description),
    viewCount: details.viewCount,
    // A number, as the old view keeps it: 0 for a live, or where unknown
    lengthSeconds: typeof details.lengthSeconds === 'number' ? details.lengthSeconds : 0,
    watchProgress,
    timeWatched: Date.now(),
    isLive: false,
    type: 'video',
  }

  if (platformOf(details) === PLATFORM_YOUTUBE) {
    // The layer trims it, and answers `null` for none, as Watch.js leaves it out
    if (typeof details.category === 'string' && details.category !== '') {
      record.category = details.category
    }
  } else {
    record.platform = details.platform
    record.host = details.host
    record.thumbnail = details.thumbnail
    record.authorThumbnail = details.authorThumbnail

    if (typeof details.category === 'string' && details.category !== '') {
      record.peertubeCategory = details.category
    }
  }

  return record
}

/**
 * As Watch.js's `handleVideoLoaded`: once per video, not for an upcoming one,
 * the history entry, then the playlist it was watched in; and a user
 * playlist's last played time, history or not
 */
function handleVideoLoaded() {
  if (historyWritten || video.value === null || video.value.isUpcoming) {
    return
  }

  historyWritten = true

  if (rememberHistory.value) {
    const entry = historyEntry()

    if (timestamp) {
      store.dispatch('updateHistory', historyRecord(timestamp))
    } else if (entry !== undefined) {
      store.dispatch('updateHistory', historyRecord(entry.watchProgress))
    } else {
      store.dispatch('updateHistory', historyRecord(0))
    }

    // After the entry, which it is written into
    persistLastViewedPlaylist()
  }

  if (playlist.value?.userPlaylistId) {
    store.dispatch('updatePlaylistLastPlayedAt', { _id: playlist.value.userPlaylistId })
  }
}

/**
 * As Watch.js's `handlePlaylistPersisting`: the playlist the video was last
 * watched in, kept in its history entry, or none, for every video but a live
 */
function persistLastViewedPlaylist() {
  if (!saveVideoHistoryWithLastViewedPlaylist.value || isLive.value) {
    return
  }

  store.dispatch('updateLastViewedPlaylist', {
    videoId: video.value.videoId,
    lastViewedPlaylistId: playlist.value?.id ?? '',
    lastViewedPlaylistType: playlist.value?.type ?? '',
    lastViewedPlaylistItemId: playlist.value?.itemId ?? null,
  })
}

/**
 * As WatchVideoInfo's `handleExternalPlayer` after it hands the video over:
 * the video is marked watched from its start, with a toast the first time.
 * YouTube only: a PeerTube video is not marked, as before.
 */
function markWatchedInExternalPlayer() {
  if (!isYouTube.value || !rememberHistory.value) {
    return
  }

  const isNew = historyEntry() === undefined

  store.dispatch('updateHistory', historyRecord(0))

  if (isNew) {
    showToast(t('Video.Video has been marked as watched'))
  }
}

/**
 * As Watch.js on every load of a YouTube video: a subscription to its channel
 * takes the channel's current name and avatar. The store's action finds the
 * stub by id, and turns an avatar on an Invidious instance back into
 * YouTube's. Not for PeerTube, whose stub keeps the avatar it was stored with.
 *
 * @param {import('../../platform/shapes').VideoDetails} details
 */
function updateSubscriptionDetails(details) {
  if (platformOf(details) !== PLATFORM_YOUTUBE || !details.authorId) {
    return
  }

  store.dispatch('updateSubscriptionDetails', {
    channelThumbnailUrl: details.authorThumbnail === '' ? null : details.authorThumbnail,
    channelName: details.author,
    channelId: details.authorId,
  })
}

/**
 * @param {number | null} [position] where playback is, where already read
 */
function saveWatchProgress(position = null) {
  // A player being destroyed, or destroyed and not yet unmounted, has had its
  // video unloaded, so its position reads about 0 and would overwrite the one
  // saved before the destruction began
  if (!canSaveWatchProgress.value || !player.value?.hasLoaded || player.value === destroyedPlayer) {
    return
  }

  store.dispatch('updateWatchProgress', {
    videoId: video.value.videoId,
    watchProgress: position ?? player.value.getCurrentTime(),
  })
}

/** On leaving the video, closing the window: only when saving is automatic */
function handleWatchProgressAutoSave() {
  if (!rememberHistory.value || !autosaveWatchedProgress.value) {
    return
  }

  saveWatchProgress()
}

/**
 * At the end of the video, or when it stops playing: whenever saving is on
 *
 * @param {number | null} [position] where playback is, where already read
 */
function handleWatchProgressAutoSaveWhenProgressEnabled(position = null) {
  if (!rememberHistory.value || !watchedProgressSavingEnabled.value) {
    return
  }

  saveWatchProgress(position)
}

function handleWatchProgressManualSave() {
  saveWatchProgress()
  showToast(t('Video.Watched Progress Saved'))
}

/**
 * As Watch.js's `sortWatchedVideosLast`: watched recommendations after the
 * rest, each group in YouTube's order
 *
 * @param {import('../../platform/shapes').VideoSummary[]} videos
 */
function sortWatchedVideosLast(videos) {
  const history = store.getters.getHistoryCacheById
  const watched = videos.filter(summary => Object.hasOwn(history, summary.videoId))

  return [...videos.filter(summary => !Object.hasOwn(history, summary.videoId)), ...watched]
}

/**
 * What the end of this video moves on to, or `null` for nothing: in a
 * playlist, the playlist's next video, of either platform, else the next
 * recommendation
 *
 * @returns {{ play: () => void } | null}
 */
function nextToPlay() {
  if (playlist.value !== null) {
    const panel = playlistPanel.value

    return panel ? { play: () => panel.playNextVideo() } : null
  }

  const next = nextRecommendedVideo.value

  if (next === null) {
    return null
  }

  return {
    play: () => {
      router.push({ path: `/watch/${next.videoId}` })
      showToast(t('Playing Next Video'))
    },
  }
}

// The Later list, for the video shown: its buttons, and its leaving the list
// when played to its end
const isInLater = computed(() => video.value !== null && store.getters.getIsInLater(video.value.videoId))
const isArmed = computed(() => video.value !== null && store.getters.getIsArmed(video.value.videoId))

/** The stated start of an upcoming video whose time is still ahead, else null */
const armableAt = computed(() => {
  if (video.value === null || !subscriptionEntryIsUpcoming(video.value)) { return null }

  return subscriptionEntryScheduledAt(video.value)
})

function laterVideoData() {
  const details = video.value

  return {
    videoId: details.videoId,
    title: details.title,
    author: details.author,
    authorId: details.authorId,
    lengthSeconds: typeof details.lengthSeconds === 'number' ? details.lengthSeconds : undefined,
    published: details.published,
    isUpcoming: details.isUpcoming === true,
    premiereDate: details.premiereDate,
  }
}

function toggleLater() {
  if (isInLater.value) {
    store.dispatch('removeFromLater', video.value.videoId)
  } else {
    store.dispatch('addToLater', laterVideoData())
  }
}

function toggleArmed() {
  if (isArmed.value) {
    store.dispatch('disarm', video.value.videoId)
  } else if (armableAt.value !== null) {
    store.dispatch('arm', { video: laterVideoData(), at: armableAt.value })
  }
}

/**
 * The player's end: a queued Later item played to its end has been watched,
 * and leaves the list before autoplay moves on. An armed one stays: it is
 * waiting for its event, not this playing.
 */
function handlePlayerEnded() {
  if (video.value !== null && isInLater.value && !isArmed.value) {
    store.dispatch('removeFromLater', video.value.videoId)
  }

  handleVideoEnded()
}

/**
 * As Watch.js's `handleVideoEnded`: the position saved, then, with autoplay
 * on, the next video after the countdown (`defaultInterval` seconds, its
 * toast a click away from cancelling it), unless nothing has been touched for
 * the interruption interval. The countdown moves on only if the video is
 * still stopped when it ends; a video hidden as not family friendly has no
 * player to be playing, and moves on.
 */
function handleVideoEnded() {
  handleWatchProgressAutoSaveWhenProgressEnabled()

  if (!autoplayEnabled.value) {
    return
  }

  if (blockVideoAutoplay) {
    const hours = store.getters.getDefaultAutoplayInterruptionIntervalHours
    showToast(t('Autoplay Interruption Timer', { autoplayInterruptionIntervalHours: hours }), 3_600_000)
    resetAutoplayInterruptionTimeout()
    return
  }

  // As Watch.js: at the playlist's end the panel says so (or loops), with no countdown
  if (playlist.value !== null && playlistPanel.value?.shouldStopDueToPlaylistEnd) {
    playlistPanel.value.playNextVideo()
    return
  }

  const next = nextToPlay()

  if (next === null) {
    return
  }

  abortAutoplayCountdown(true)

  const interval = store.getters.getDefaultInterval
  const toast = new AbortController()
  playNextToast = toast

  playNextTimeout = setTimeout(() => {
    playNextTimeout = null
    playNextToast = null

    if (player.value?.isPaused() ?? true) {
      next.play()
    }
  }, interval * 1000)

  // No countdown for an interval of 0
  if (interval > 0) {
    showToast(
      ({ remainingMs }) => {
        const seconds = remainingMs / 1000
        return t('Playing Next Video Interval', { nextVideoInterval: seconds }, seconds)
      },
      // So that the countdown's last text is not 0 seconds
      interval * 1000,
      () => abortAutoplayCountdown(),
      toast.signal
    )
  }
}

/**
 * As Watch.js's `handleSkipToNext` from the player: the playlist's next
 * video, or the next recommendation, at once
 */
function handleSkipToNext() {
  nextToPlay()?.play()
}

/** As Watch.js's `handleSkipToPrev` from the player: the playlist's previous video */
function handleSkipToPrev() {
  playlistPanel.value?.playPreviousVideo()
}

/**
 * Stops the countdown to the next video, with a toast saying so unless
 * `quietly`, and closes the countdown's toast
 *
 * @param {boolean} [quietly]
 */
function abortAutoplayCountdown(quietly = false) {
  const wasRunning = playNextTimeout !== null

  clearTimeout(playNextTimeout)
  playNextTimeout = null
  playNextToast?.abort()
  playNextToast = null

  if (wasRunning && !quietly) {
    showToast(t('Canceled next video autoplay'))
  }
}

/**
 * As Watch.js's `toggleAutoplay`: switching it off stops a countdown; in a
 * playlist the playlist's is switched
 */
function toggleAutoplay() {
  if (autoplayEnabled.value && playNextTimeout !== null) {
    abortAutoplayCountdown()
  }

  if (playlist.value !== null) {
    autoplayNextPlaylistVideo.value = !autoplayNextPlaylistVideo.value
  } else {
    autoplayNextRecommendedVideo.value = !autoplayNextRecommendedVideo.value
  }
}

/**
 * As Watch.js's: every click and key press starts the interruption interval
 * (`defaultAutoplayInterruptionIntervalHours`) afresh; once it passes
 * untouched, the end of a video does not move on.
 */
function resetAutoplayInterruptionTimeout() {
  clearTimeout(autoplayInterruptionTimeout)
  autoplayInterruptionTimeout = setTimeout(() => {
    blockVideoAutoplay = true
  }, store.getters.getDefaultAutoplayInterruptionIntervalHours * 3_600_000)
  blockVideoAutoplay = false
}

function stopAutoplayInterruptionTimer() {
  document.removeEventListener('keydown', resetAutoplayInterruptionTimeout)
  document.removeEventListener('click', resetAutoplayInterruptionTimeout)
  clearTimeout(autoplayInterruptionTimeout)
}

/**
 * The player's destruction is asynchronous, so it is destroyed before it is
 * unmounted, keeping the full screen, full window and picture in picture
 * state for the next video (as Watch.js's `destroyPlayer`).
 *
 * Once per player: leaving while a failed player is still being destroyed
 * waits for that destruction instead of starting a second one, which would
 * call `ui.destroy()` again on a player already on its way out.
 */
function destroyPlayer() {
  const instance = player.value

  if (!instance) {
    return Promise.resolve()
  }

  if (instance !== destroyedPlayer) {
    destroyedPlayer = instance
    destruction = (async () => {
      const uiState = await instance.destroyPlayer()
      startInFullscreen.value = uiState.startNextVideoInFullscreen
      startInFullwindow.value = uiState.startNextVideoInFullwindow
      startInPip.value = uiState.startNextVideoInPip
    })()
  }

  return destruction
}

/**
 * `destroyPlayer`, a failure logged rather than thrown: whatever comes next
 * (the next video, a message, leaving the view) goes ahead without the player
 */
async function destroyPlayerLogged() {
  try {
    await destroyPlayer()
  } catch (destroyError) {
    console.error(destroyError)
  }
}

/**
 * Whether this view renders the route: either watch route, between which the
 * router keeps it, as a playlist crosses from one platform to the other. Both
 * render the surface switch (platform/routes.js `WatchSurface`), so the view
 * is the one the switch picks for the route: this one on the PeerTube route,
 * and on `/watch/:id` while the switch is on
 *
 * @param {import('vue-router').RouteLocationNormalized} location
 */
function rendersThisView(location) {
  return routeView(location) === thisView
}

/** Whether a navigation from one of this view's routes to another stays on the video, the playlist item included */
function sameVideo(to, from) {
  return to.params.id === from.params.id && to.params.host === from.params.host && to.params.uuid === from.params.uuid &&
    to.query.timestamp === from.query.timestamp && to.query.playlistItemId === from.query.playlistItemId
}

// A guard on the router rather than on the route record: the record's guards
// stay with the record this view was first mounted on, and the router keeps
// the view when a playlist crosses to the other watch route. For another
// video, the one left is saved and its player destroyed before the watcher
// below loads the next; leaving the view, the same and the listeners removed.
// Before resolving rather than before each: after the target route's own
// `beforeEnter`, so that a navigation it refuses (a PeerTube route while
// PeerTube is off) leaves the video playing
const removeRouteGuard = router.beforeResolve(async (to, from) => {
  if (!rendersThisView(from)) {
    return
  }

  if (rendersThisView(to)) {
    if (sameVideo(to, from)) {
      return
    }

    leavingVideo = true
    // As Watch.js's `handleRouteChange`: the countdown is for the video left
    abortAutoplayCountdown(true)
    handleWatchProgressAutoSave()
    await destroyPlayerLogged()
    return
  }

  leavingVideo = true
  abortAutoplayCountdown(true)
  handleWatchProgressAutoSave()
  savedOnLeave = true
  window.removeEventListener('beforeunload', handleWatchProgressAutoSave)
  stopAutoplayInterruptionTimer()
  await destroyPlayerLogged()
})

watch(
  () => [route.matched.at(-1)?.path, route.params.id, route.params.host, route.params.uuid, route.query.timestamp, route.query.playlistItemId],
  () => {
    // The watcher can fire for the navigation away, before this view
    // unmounts. Told apart by the view the route renders rather than its
    // name: upstream's `/watch/:id` and the routes it leads to have none
    if (rendersThisView(route)) {
      load()
    }
  }
)

// An armed Later item gone live while its own page is open: the page
// reloads into the stream, as if newly opened. Told through the store, so
// that the scheduler does not reach into the view
watch(() => store.getters.getLaterFiredVideoId, (videoId) => {
  if (videoId == null || videoId !== route.params.id || !rendersThisView(route)) {
    return
  }

  store.commit('setLaterFiredVideoId', null)
  load()
})

onMounted(() => {
  window.addEventListener('beforeunload', handleWatchProgressAutoSave)
  document.addEventListener('keydown', resetAutoplayInterruptionTimeout)
  document.addEventListener('click', resetAutoplayInterruptionTimeout)
  resetAutoplayInterruptionTimeout()
  load()
})

onBeforeUnmount(() => {
  removeRouteGuard()
  window.removeEventListener('beforeunload', handleWatchProgressAutoSave)
  abortAutoplayCountdown(true)
  stopAutoplayInterruptionTimer()

  // Unmounted without leaving the route, as when the app goes away
  if (!savedOnLeave) {
    handleWatchProgressAutoSave()
  }
})
</script>

<style scoped src="./LayerWatch.scss" lang="scss" />
