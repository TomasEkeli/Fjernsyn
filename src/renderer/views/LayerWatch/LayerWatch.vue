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
            :platform="video.platform"
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
          class="watchVideo"
          @save-watched-progress="handleWatchProgressManualSave"
        >
          <template #actions>
            <FtIconButton
              v-if="canUseFormat('audio')"
              :title="activeFormat === 'audio' ? t('PeerTube.Watch.Play video') : t('PeerTube.Watch.Audio only')"
              :icon="activeFormat === 'audio' ? ['fas', 'film'] : ['fas', 'volume-high']"
              theme="secondary"
              @click="toggleAudioOnly"
            />
          </template>
        </LayerVideoInfo>
        <LayerVideoDescription
          v-if="!hideVideoDescription"
          :description="video.description"
          :kind="video.descriptionKind"
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
// The platform layer's watch view. Platform-neutral: it talks only to the
// injected layer and reads only the common shapes (platform/shapes.js). The
// one PeerTube fact here is the route, which names a video by host and uuid.
// Upstream's Watch view (views/Watch) is the model for everything a viewer
// sees and for when history and progress are written; it is not edited.

import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import shaka from 'shaka-player'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute } from 'vue-router'

import FtButton from '../../components/FtButton/FtButton.vue'
import FtIconButton from '../../components/FtIconButton/FtIconButton.vue'
import FtLoader from '../../components/FtLoader/FtLoader.vue'
import FtShakaVideoPlayer from '../../components/ft-shaka-video-player/ft-shaka-video-player.vue'
import LayerVideoDescription from '../../components/LayerVideoDescription/LayerVideoDescription.vue'
import LayerVideoInfo from '../../components/LayerVideoInfo/LayerVideoInfo.vue'
import WatchVideoChapters from '../../components/WatchVideoChapters/WatchVideoChapters.vue'
import { toStoredPlainText } from '../../components/LayerMarkdown/plainText'

import store from '../../store/index'
import { formatScheduledTime, showToast } from '../../helpers/utils'
import { PLATFORM_YOUTUBE, peerTubeVideoRef, platformOf } from '../../platform/refs'
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

/**
 * What the player plays from. A `sabr` source (YouTube Local, phase 3) is
 * not played here yet, and reads as nothing to play.
 */
const source = computed(() => {
  const playbackSource = video.value?.playbackSource
  return playbackSource?.transport === 'manifest' ? playbackSource : null
})

const isLive = computed(() => video.value?.liveStatus === 'live' || source.value?.isLive === true)

const chapters = computed(() => source.value?.chapters ?? [])
// Hidden chapters are hidden from the player's progress bar too, as Watch.js
// does by not reading them at all
const chaptersShown = computed(() => !hideChapters.value && chapters.value.length > 0)

// The sidebar holds the chapters; without it there is nothing for theatre
// mode to move out of the way
const theatrePossible = computed(() => !isLoading.value && chaptersShown.value)

const manifestSrc = computed(() => activeFormat.value === 'audio'
  ? source.value.audio.manifestUrl
  : source.value.manifestUrl)

const manifestMimeType = computed(() => activeFormat.value === 'audio'
  ? source.value.audio.mimeType
  : (source.value.manifestMimeType ?? ''))

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
      return !playbackSource.isLive && playbackSource.legacyFormats.length > 0
    case 'audio':
      return !!playbackSource.audio
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

  if (details.liveStatus === 'waiting') {
    return {
      icon: ['fas', 'satellite-dish'],
      text: t('PeerTube.Watch.Live waiting'),
      detail: details.premiereDate
        ? t('PeerTube.Watch.Live starts', { time: formatScheduledTime(new Date(details.premiereDate).getTime()) })
        : '',
    }
  }

  if (details.liveStatus === 'ended') {
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
  const host = error.host ?? route.params.host

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

  const ref = peerTubeVideoRef(route.params.host, route.params.uuid)

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
function handlePlayerError(error) {
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
  } else {
    // The player goes away with the message, so its position is taken now
    handleWatchProgressAutoSaveWhenProgressEnabled()
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
 * fields and names. A video of another platform than YouTube adds what its
 * record needs to render and route (spec, "Refs and stored shapes"), and a
 * YouTube record written here would have nothing added. `category` is left
 * out: it is the YouTube category the profile suggestions read.
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
    lengthSeconds: details.lengthSeconds ?? 0,
    watchProgress,
    timeWatched: Date.now(),
    isLive: false,
    type: 'video',
  }

  if (platformOf(details) !== PLATFORM_YOUTUBE) {
    record.platform = details.platform
    record.host = details.host
    record.thumbnail = details.thumbnail
    record.authorThumbnail = details.authorThumbnail
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

function saveWatchProgress() {
  if (!canSaveWatchProgress.value || !player.value?.hasLoaded) {
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
 */
async function destroyPlayer() {
  if (!player.value) {
    return
  }

  const uiState = await player.value.destroyPlayer()
  startInFullscreen.value = uiState.startNextVideoInFullscreen
  startInFullwindow.value = uiState.startNextVideoInFullwindow
  startInPip.value = uiState.startNextVideoInPip
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
  if (to.params.host === from.params.host && to.params.uuid === from.params.uuid && to.query.timestamp === from.query.timestamp) {
    return
  }

  handleWatchProgressAutoSave()
  await destroyPlayer()
})

watch(
  () => [route.name, route.params.host, route.params.uuid, route.query.timestamp],
  ([name], [previousName]) => {
    // The watcher can fire for the navigation away, before this view unmounts
    if (name === previousName) {
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
