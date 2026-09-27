<template>
  <span
    v-if="visible"
    class="layerDownloadButton"
  >
    <!-- Finished: the way to the file, with another download a right click or long press away -->
    <FtIconButton
      v-if="state === 'finished'"
      :title="finishedTitle"
      :icon="['fas', 'folder-open']"
      theme="secondary"
      :dropdown-options="finishedOptions"
      open-on-right-or-long-click
      @click="handleFinishedClick"
    />
    <template v-else>
      <!-- The best on a click; another resolution, or the audio alone, on a right click or long press -->
      <FtIconButton
        :title="buttonTitle"
        :icon="['fas', 'download']"
        theme="secondary"
        :dropdown-options="state === 'running' ? [] : choiceOptions"
        open-on-right-or-long-click
        @click="handleClick"
      />
      <FtProgressRing
        v-if="state === 'running'"
        class="ring"
        :fraction="fraction"
      />
    </template>
  </span>
</template>

<script setup>
// The PeerTube watch page's Download button: the instance's own files,
// downloaded in main (ticket 16), never through yt-dlp. It follows the
// download through the downloads store as FtYtDlpDownloadButton does, by the
// key `peertube:<host>:<uuid>`, one per video: a second resolution started
// while one runs is refused by main as already running.

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { faFolderOpen } from '@fortawesome/free-solid-svg-icons'

import FtIconButton from '../FtIconButton/FtIconButton.vue'
import FtProgressRing from '../FtProgressRing/FtProgressRing.vue'

import { library } from '../../fontawesome-minimal'
import { downloadFromPeerTube, revealDownload } from '../../helpers/downloads'
import {
  detailsText,
  formatBytes,
  isRunning,
  progressFraction,
  qualityText,
  statusText,
  whereText,
  ytDlpDownloads,
} from '../../helpers/ytdlpDownloads'
import { PLATFORM_PEERTUBE, platformOf } from '../../platform/refs'
import { isPeerTubeEnabled } from '../../platform/vue'

// Registered here rather than in main.js, to keep the fork out of upstream's list
library.add(faFolderOpen)

const props = defineProps({
  /**
   * The video's details, as the layer gives them
   * @type {import('vue').PropType<import('../../platform/shapes').VideoDetails>}
   */
  video: {
    type: Object,
    required: true
  },
})

const { t } = useI18n()

/** @type {import('vue').ComputedRef<import('../../platform/shapes').DownloadOption[]>} */
const options = computed(() => props.video.downloadOptions ?? [])

// The layer gives no options when the author has disabled downloads, nor for
// a live; a live is also checked here, since a live has no end to download to
const visible = computed(() => {
  return !!process.env.IS_ELECTRON &&
    platformOf(props.video) === PLATFORM_PEERTUBE &&
    isPeerTubeEnabled() &&
    options.value.length > 0 &&
    !props.video.liveNow &&
    props.video.liveStatus == null &&
    !props.video.isUpcoming
})

/**
 * What main accepts (`src/main/peertubeDownloads/request.js`): the host lower
 * case and without a port, as the layer already gives it, and the full uuid.
 */
const key = computed(() => `peertube:${props.video.host.toLowerCase()}:${props.video.videoId.toLowerCase()}`)

const download = computed(() => ytDlpDownloads.byId[key.value])

/**
 * Running while a download of this video is under way; finished once this
 * session has a file for it, until it is downloaded again; otherwise idle,
 * which covers a failed or cancelled attempt, since pressing again starts over.
 */
const state = computed(() => {
  if (isRunning(download.value)) {
    return 'running'
  }

  if (key.value in ytDlpDownloads.finished && download.value?.status !== 'failed' && download.value?.status !== 'cancelled') {
    return 'finished'
  }

  return 'idle'
})

const fraction = computed(() => (download.value ? progressFraction(download.value) : null))

/** The highest resolution, or the audio when that is all there is */
const bestOption = computed(() => options.value.find(option => option.kind !== 'audio') ?? options.value[0])

/**
 * @param {import('../../platform/shapes').DownloadOption} option
 */
function optionText(option) {
  const name = option.kind === 'audio' ? t('PeerTube.Downloads.Audio only') : option.label

  return option.sizeBytes != null
    ? t('PeerTube.Downloads.Option with size', { option: name, size: formatBytes(option.sizeBytes) })
    : name
}

const choiceOptions = computed(() => options.value.map(option => ({ label: optionText(option), value: option.id })))

const buttonTitle = computed(() => {
  if (state.value !== 'running') {
    return t('PeerTube.Downloads.Download')
  }

  // Stage, quality, progress and where it is going, one per line
  return [statusText(download.value), qualityText(download.value), detailsText(download.value), whereText(download.value)]
    .filter(line => line !== '')
    .join('\n')
})

const finishedPath = computed(() => ytDlpDownloads.finished[key.value] ?? download.value?.folder ?? '')

const finishedTitle = computed(() => {
  const quality = download.value?.status === 'finished' ? qualityText(download.value) : ''
  return [t('Video.yt-dlp.Show in folder', { path: finishedPath.value }), quality, t('PeerTube.Downloads.Download again tooltip')]
    .filter(line => line !== '')
    .join('\n')
})

const finishedOptions = computed(() => [
  { label: t('Video.yt-dlp.Downloads.Show in folder'), value: 'reveal' },
  { type: 'divider' },
  ...options.value.map(option => ({
    label: t('PeerTube.Downloads.Download again', { option: optionText(option) }),
    value: option.id,
  })),
])

/**
 * @param {import('../../platform/shapes').DownloadOption | undefined} option
 */
function start(option) {
  if (!option) {
    return
  }

  downloadFromPeerTube({
    key: key.value,
    url: option.url,
    title: props.video.title,
    label: option.label,
    resolution: option.resolution,
    audioOnly: option.kind === 'audio',
    videoUrl: props.video.url || null,
  })
}

/**
 * @param {string | undefined} optionId from the dropdown, or nothing for a plain click
 */
function handleClick(optionId) {
  if (state.value === 'running') {
    // Rather than being told it is already downloading: see how it is doing
    ytDlpDownloads.panelOpen = true
    return
  }

  start(optionId === undefined ? bestOption.value : options.value.find(option => option.id === optionId))
}

/**
 * @param {'reveal' | string | undefined} choice from the dropdown, or nothing for a plain click
 */
function handleFinishedClick(choice) {
  if (choice === undefined || choice === 'reveal') {
    revealDownload(key.value)
  } else {
    start(options.value.find(option => option.id === choice))
  }
}
</script>

<style scoped src="./LayerDownloadButton.css" />
