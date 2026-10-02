<template>
  <div
    class="videoLayout"
    :class="{
      isLoading,
      useTheatreMode: useTheatreMode && !isLoading,
      noSidebar: !theatrePossible
    }"
  >
    <FtLoader
      v-if="isLoading"
      :fullscreen="true"
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
            :legacy-formats="source.legacyFormats"
            :start-time="startTime"
            :captions="source.captions"
            :chapters="chaptersShown ? chapters : []"
            :current-chapter-index="currentChapterIndex"
            :chapters-src="chaptersShown ? (source.chaptersSrc ?? '') : ''"
            :storyboard-src="source.storyboard ?? ''"
            :video-id="video.videoId"
            :channel-id="video.authorId"
            :title="video.title"
            :thumbnail="video.thumbnail"
            :platform="platformOf(video)"
            :loudness-db="null"
            :theatre-possible="theatrePossible"
            :use-theatre-mode="useTheatreMode"
            :start-in-fullscreen="startInFullscreen"
            :start-in-fullwindow="startInFullwindow"
            :start-in-pip="startInPip"
            :current-playback-rate="currentPlaybackRate"
            class="videoPlayer"
            @error="handlePlayerError"
            @loaded="handleVideoLoaded"
            @timeupdate="updateCurrentChapter"
            @ended="handleVideoEnded"
            @toggle-theatre-mode="useTheatreMode = !useTheatreMode"
            @playback-rate-updated="currentPlaybackRate = $event"
          />
          <div
            v-else-if="message"
            class="videoPlayer"
            :class="{ withoutThumbnail: !video?.thumbnail }"
          >
            <img
              v-if="video?.thumbnail"
              :src="video.thumbnail"
              class="videoThumbnail"
              alt=""
            >
            <div class="errorContainer">
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
                    @click="load"
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
          class="watchVideo"
        />
      </div>
      <div
        v-if="theatrePossible"
        class="sidebarArea"
      >
        <WatchVideoChapters
          :chapters="chapters"
          :current-chapter-index="currentChapterIndex"
          class="watchVideoSidebar"
          @timestamp-event="changeTimestamp"
        />
      </div>
    </template>
  </div>
</template>

<script setup>
// The platform layer's watch view. It talks only to the injected layer and
// reads only the common shapes (platform/shapes.js). The route names the
// video: `/watch/:id` a YouTube one by its id, as upstream's route does, and
// the PeerTube route one by host and uuid. Where the two platforms differ is
// in what is written beside the player, chosen by `platformOf(video)`: the
// history entry's extra fields, the subscription details refresh and the
// download button. Upstream's Watch view (views/Watch) is the model for
// everything a viewer sees and for when history and progress are written; it
// is not edited.

import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import shaka from 'shaka-player'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute } from 'vue-router'

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
import { toStoredPlainText } from '../../components/LayerMarkdown/plainText'

import store from '../../store/index'
import { formatScheduledTime, showToast } from '../../helpers/utils'
import { PLATFORM_YOUTUBE, isYouTubeVideoRef, peerTubeVideoRef, platformOf } from '../../platform/refs'
import { usePlatformLayer } from '../../platform/vue'

/** @typedef {'dash' | 'legacy' | 'audio'} Format */

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
const { t } = useI18n()

const player = useTemplateRef('player')

const rememberHistory = computed(() => store.getters.getRememberHistory)
const watchedProgressSavingEnabled = computed(() => store.getters.getWatchedProgressSavingMode !== 'never')
const autosaveWatchedProgress = computed(() => store.getters.getWatchedProgressSavingMode === 'auto')
const hideChapters = computed(() => store.getters.getHideChapters)
const hideVideoDescription = computed(() => store.getters.getHideVideoDescription)

const isLoading = ref(true)
/** @type {import('vue').ShallowRef<import('../../platform/shapes').VideoDetails | null>} */
const video = shallowRef(null)
/** @type {import('vue').ShallowRef<{ kind?: string, reason?: string | null, host?: string | null } | null>} */
const loadError = shallowRef(null)

/** @type {import('vue').Ref<Format>} */
const activeFormat = ref('dash')
/** The formats that have failed for this video */
const failedFormats = new Set()
const playbackFailed = ref(false)

/** @type {import('vue').Ref<number | null>} */
const startTime = ref(null)
const currentChapterIndex = ref(0)
const currentPlaybackRate = ref(store.getters.getDefaultPlayback)

const useTheatreMode = ref(false)
const startInFullscreen = ref(false)
const startInFullwindow = ref(false)
const startInPip = ref(false)

/** The `timestamp` query the video was opened with */
let timestamp = null
/** Whether the history entry has been written for this video */
let historyWritten = false
/** Whether leaving the page has already saved the position */
let savedOnLeave = false
/** Tells a load apart from the one that replaced it */
let loadsStarted = 0
/** The player whose destruction has begun, and that destruction */
let destroyedPlayer = null
/** @type {Promise<void>} */
let destruction = Promise.resolve()

/** What the player plays from, either transport */
const source = computed(() => video.value?.playbackSource ?? null)

/**
 * A `sabr` source (YouTube Local) needs the regulator this view does not host
 * yet, so its manifest is not played: only its legacy formats are, which are
 * plain files. Its `audio` is the same SABR manifest, so audio only goes too.
 */
const isSabr = computed(() => source.value?.transport === 'sabr')

const isYouTube = computed(() => video.value !== null && platformOf(video.value) === PLATFORM_YOUTUBE)

const isLive = computed(() => video.value?.liveStatus === 'live' || source.value?.isLive === true)

/** The video as the layer names it, for its comments */
const videoRef = computed(() => {
  if (video.value === null) {
    return null
  }

  return isYouTube.value ? video.value.videoId : peerTubeVideoRef(video.value.host, video.value.videoId)
})

const chapters = computed(() => source.value?.chapters ?? [])
// Hidden chapters are hidden from the player's progress bar too, as Watch.js
// does by not reading them at all
const chaptersShown = computed(() => !hideChapters.value && chapters.value.length > 0)

// The sidebar holds the chapters; without it there is nothing for theatre
// mode to move out of the way
const theatrePossible = computed(() => !isLoading.value && chaptersShown.value)

// A SABR manifest is not handed on: without its credentials it is nothing
// the player can load
const manifestSrc = computed(() => {
  if (isSabr.value) {
    return null
  }

  return activeFormat.value === 'audio' ? source.value.audio.manifestUrl : source.value.manifestUrl
})

const manifestMimeType = computed(() => {
  if (isSabr.value) {
    return ''
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
      return !isSabr.value && !!playbackSource.manifestUrl
    case 'legacy':
      return !playbackSource.isLive && playbackSource.legacyFormats.length > 0
    case 'audio':
      return !isSabr.value && !!playbackSource.audio
    default:
      return false
  }
}

/**
 * What to show instead of the player, or `null` to show the player.
 *
 * @type {import('vue').ComputedRef<{ icon: string[], text: string, detail?: string, retryable?: boolean } | null>}
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
  // PeerTube answers neither with a source
  if (details.liveStatus === 'waiting' && source.value === null) {
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

  if (playbackFailed.value || !canUseFormat(activeFormat.value)) {
    return { icon: ['fas', 'exclamation-circle'], text: t('PeerTube.Watch.Cannot play'), retryable: true }
  }

  return null
})

const showPlayer = computed(() => message.value === null && source.value !== null)

/**
 * @param {{ kind?: string, reason?: string | null, host?: string | null }} error
 */
function loadErrorMessage(error) {
  // A YouTube video's messages name YouTube where a PeerTube one names its
  // instance, until the old view's own YouTube messages are passed on
  const host = error.host ?? route.params.host ?? 'YouTube'

  switch (error.kind) {
    case 'refused':
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
 * Where to start, as Watch.js's `startTimeSeconds`: the timestamp asked for,
 * else the stored position if progress is being saved at all and the video
 * was not watched to its end, else the beginning. Never for a live.
 */
function initialStartTime() {
  if (isLive.value) {
    return null
  }

  const lengthSeconds = video.value.lengthSeconds ?? 0

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

/** As Watch.js's `setViewingModeOnFirstLoad` */
function applyViewingMode() {
  switch (store.getters.getDefaultViewingMode) {
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

  isLoading.value = true
  video.value = null
  loadError.value = null
  playbackFailed.value = false
  failedFormats.clear()
  historyWritten = false
  savedOnLeave = false
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
    activeFormat.value = FORMAT_RING.find(canUseFormat) ?? 'dash'
    startTime.value = initialStartTime()
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

  failedFormats.add(activeFormat.value)

  const next = FORMAT_RING.find(format => !failedFormats.has(format) && canUseFormat(format))

  if (next) {
    switchFormat(next)
    return
  }

  // The player goes away with the message, so its position is taken now. It
  // is destroyed before that too: unmounted by the message, it would be left
  // running, as a live that goes on refreshing its playlist
  handleWatchProgressAutoSaveWhenProgressEnabled()

  const thisLoad = loadsStarted

  try {
    await destroyPlayer()
  } catch (destroyError) {
    console.error(destroyError)
  }

  // Unless another video has started loading meanwhile
  if (thisLoad === loadsStarted) {
    playbackFailed.value = true
  }
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

/** As Watch.js's `handleVideoLoaded`: once per video, not for an upcoming one */
function handleVideoLoaded() {
  if (historyWritten || video.value === null || video.value.isUpcoming) {
    return
  }

  historyWritten = true

  if (!rememberHistory.value) {
    return
  }

  const entry = historyEntry()

  if (timestamp) {
    store.dispatch('updateHistory', historyRecord(timestamp))
  } else if (entry !== undefined) {
    store.dispatch('updateHistory', historyRecord(entry.watchProgress))
  } else {
    store.dispatch('updateHistory', historyRecord(0))
  }
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

function saveWatchProgress() {
  // A player being destroyed, or destroyed and not yet unmounted, has had its
  // video unloaded, so its position reads about 0 and would overwrite the one
  // saved before the destruction began
  if (!canSaveWatchProgress.value || !player.value?.hasLoaded || player.value === destroyedPlayer) {
    return
  }

  store.dispatch('updateWatchProgress', {
    videoId: video.value.videoId,
    watchProgress: player.value.getCurrentTime(),
  })
}

/** On leaving the video, closing the window: only when saving is automatic */
function handleWatchProgressAutoSave() {
  if (!rememberHistory.value || !autosaveWatchedProgress.value) {
    return
  }

  saveWatchProgress()
}

/** At the end of the video, or when it stops playing: whenever saving is on */
function handleWatchProgressAutoSaveWhenProgressEnabled() {
  if (!rememberHistory.value || !watchedProgressSavingEnabled.value) {
    return
  }

  saveWatchProgress()
}

function handleWatchProgressManualSave() {
  saveWatchProgress()
  showToast(t('Video.Watched Progress Saved'))
}

function handleVideoEnded() {
  handleWatchProgressAutoSaveWhenProgressEnabled()
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

onBeforeRouteLeave(async () => {
  handleWatchProgressAutoSave()
  savedOnLeave = true
  window.removeEventListener('beforeunload', handleWatchProgressAutoSave)
  await destroyPlayer()
})

// The router reuses this view for another video, so the one left is saved
// and its player destroyed before the watcher below loads the next
onBeforeRouteUpdate(async (to, from) => {
  if (to.params.id === from.params.id && to.params.host === from.params.host && to.params.uuid === from.params.uuid &&
    to.query.timestamp === from.query.timestamp) {
    return
  }

  handleWatchProgressAutoSave()
  await destroyPlayer()
})

watch(
  () => [route.matched.at(-1)?.path, route.params.id, route.params.host, route.params.uuid, route.query.timestamp],
  ([pattern], [previousPattern]) => {
    // The watcher can fire for the navigation away, before this view unmounts.
    // Told apart by the route's pattern rather than its name: upstream's
    // `/watch/:id` and the routes it leads to have none
    if (pattern === previousPattern) {
      load()
    }
  }
)

onMounted(() => {
  window.addEventListener('beforeunload', handleWatchProgressAutoSave)
  load()
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', handleWatchProgressAutoSave)

  // Unmounted without leaving the route, as when the app goes away
  if (!savedOnLeave) {
    handleWatchProgressAutoSave()
  }
})
</script>

<style scoped src="./LayerWatch.scss" lang="scss" />
