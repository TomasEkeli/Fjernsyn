<!-- eslint-disable @intlify/vue-i18n/no-raw-text -->
<!--
  THROWAWAY: the platform layer spike (ticket 03). Plays one PeerTube video in
  the existing player to learn what the player lacks. Removed by ticket 07,
  together with its route. Plain English on purpose: it is never shipped.
-->
<template>
  <div class="peerTubeSpike">
    <FtLoader v-if="isLoading" />
    <FtShakaVideoPlayer
      v-else-if="source"
      :key="playerKey"
      class="spikePlayer"
      :format="source.format"
      :manifest-src="source.manifestSrc"
      :manifest-mime-type="source.manifestMimeType"
      :legacy-formats="source.legacyFormats"
      :start-time="source.startTime"
      :captions="source.captions"
      :chapters="source.chapters"
      :chapters-src="source.chaptersSrc"
      :storyboard-src="source.storyboardSrc"
      :video-id="source.videoId"
      :channel-id="source.channelId"
      :title="source.title"
      :thumbnail="source.thumbnail"
      v-bind="platformProp"
      @error="handlePlayerError"
      @loaded="handleLoaded"
    />
    <pre class="spikeDiagnostics">{{ diagnostics }}</pre>
    <pre
      v-if="errorMessage"
      class="spikeError"
    >{{ errorMessage }}</pre>
  </div>
</template>

<script setup>
/* eslint-disable no-console -- the spike reports through console.log, which the dev runner forwards to its log */
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import shaka from 'shaka-player'

import FtLoader from '../../components/FtLoader/FtLoader.vue'
import FtShakaVideoPlayer from '../../components/ft-shaka-video-player/ft-shaka-video-player.vue'

import { buildChaptersVttFile, formatDurationAsTimestamp } from '../../helpers/utils'

const LOG_PREFIX = '[peertube-spike]'
const USER_AGENT = 'Fjernsyn/0.0.1 (+https://github.com/TomasEkeli/Fjernsyn)'
const DEFAULT_HOST = 'video.blender.org'
const DEFAULT_UUID = 'b29290cc-dc51-4a12-bcb2-2aa5fece7605'

const route = useRoute()

const isLoading = ref(true)
const source = shallowRef(null)
const diagnostics = ref('')
const errorMessage = ref('')
const playerKey = ref(0)

const baseline = computed(() => route.query.baseline === '1')

// With baseline=1 the prop is left out entirely, so the player takes its
// default and behaves exactly as it does for YouTube today.
const platformProp = computed(() => baseline.value ? {} : { platform: 'peertube' })

/**
 * Fetches JSON with the prescribed User-Agent. A header outside the CORS
 * safelist makes the request preflighted, so if that is refused the request is
 * repeated without it, and the refusal is logged as a finding.
 * @param {string} url
 */
async function fetchJson(url) {
  let response
  try {
    response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  } catch (error) {
    console.log(LOG_PREFIX, 'fetch with User-Agent failed, retrying without it', url, String(error))
    response = await fetch(url)
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`)
  }

  return response.json()
}

/**
 * @param {string} url
 */
async function fetchOptionalJson(url) {
  try {
    return await fetchJson(url)
  } catch (error) {
    console.log(LOG_PREFIX, 'optional request failed', url, String(error))
    return null
  }
}

/**
 * @param {string} host
 * @param {string|null|undefined} path
 */
function absolute(host, path) {
  if (!path) { return '' }
  if (/^https?:\/\//.test(path)) { return path }
  return `https://${host}${path}`
}

/**
 * @param {number} seconds
 */
function vttTimestamp(seconds) {
  const hours = Math.trunc(seconds / 3600)
  const minutes = Math.trunc((seconds % 3600) / 60)
  const rest = seconds % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}`
}

/**
 * Turns a PeerTube storyboard sprite into a WebVTT thumbnails track.
 * Spike only; the adapter gets its own tested version.
 * @param {string} host
 * @param {any} storyboard
 * @param {number} duration
 * @returns {{ src: string, cues: number }}
 */
function buildStoryboardVtt(host, storyboard, duration) {
  const spriteUrl = absolute(host, storyboard.fileUrl ?? storyboard.storyboardPath)
  const { spriteWidth, spriteHeight, totalWidth, totalHeight, spriteDuration } = storyboard

  const columns = Math.floor(totalWidth / spriteWidth)
  const rows = Math.floor(totalHeight / spriteHeight)
  const maxCues = columns * rows

  const blocks = ['WEBVTT']
  let cues = 0

  for (let start = 0; start < duration && cues < maxCues; start += spriteDuration) {
    const end = Math.min(start + spriteDuration, duration)
    const x = (cues % columns) * spriteWidth
    const y = Math.floor(cues / columns) * spriteHeight

    blocks.push(`${vttTimestamp(start)} --> ${vttTimestamp(end)}\n${spriteUrl}#xywh=${x},${y},${spriteWidth},${spriteHeight}`)
    cues++
  }

  return {
    src: `data:text/vtt;charset=utf-8,${encodeURIComponent(blocks.join('\n\n') + '\n')}`,
    cues
  }
}

/**
 * The shape the player's legacy path reads, as produced by
 * `mapLocalLegacyFormat` and `mapInvidiousLegacyFormat`.
 * @param {any} file
 * @param {number} duration
 * @param {number|null|undefined} aspectRatio
 */
function toLegacyFormat(file, duration, aspectRatio) {
  const resolution = file.resolution.id

  let width = file.width
  let height = file.height

  if (!width || !height) {
    // PeerTube's resolution is the shorter side
    const ratio = aspectRatio || 16 / 9
    if (ratio >= 1) {
      height = resolution
      width = Math.round(resolution * ratio)
    } else {
      width = resolution
      height = Math.round(resolution / ratio)
    }
  }

  return {
    itag: resolution,
    qualityLabel: file.resolution.label,
    fps: file.fps,
    bitrate: duration > 0 ? Math.round((file.size * 8) / duration) : 0,
    mimeType: 'video/mp4',
    height,
    width,
    url: file.fileUrl
  }
}

/**
 * Audio only (resolution 0) and video only files cannot be played on their own
 * by the legacy path.
 * @param {any} file
 */
function isMuxedFile(file) {
  return file.resolution?.id > 0 && file.hasAudio !== false && file.hasVideo !== false
}

/**
 * @param {any} video
 * @param {string} host
 */
function pickThumbnail(video, host) {
  if (Array.isArray(video.thumbnails) && video.thumbnails.length > 0) {
    const largest = [...video.thumbnails].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]
    return absolute(host, largest.fileUrl ?? largest.path)
  }

  return absolute(host, video.previewPath ?? video.thumbnailPath)
}

async function runUserAgentTest() {
  try {
    const response = await fetch('http://127.0.0.1:9311/ua', { headers: { 'User-Agent': USER_AGENT } })
    const { headers } = await response.json()
    console.log(LOG_PREFIX, 'ua-test', JSON.stringify({ sent: USER_AGENT, received: headers['user-agent'] ?? null, headers }))
  } catch (error) {
    console.log(LOG_PREFIX, 'ua-test', 'failed', String(error))
  }
}

async function load() {
  isLoading.value = true
  errorMessage.value = ''
  source.value = null

  const host = route.params.host || DEFAULT_HOST
  const uuid = route.params.uuid || DEFAULT_UUID
  const requestedFormat = ['dash', 'legacy', 'audio'].includes(route.query.format) ? route.query.format : 'dash'
  const includeHlsFiles = route.query.hlsFiles === '1'

  runUserAgentTest()

  try {
    const base = `https://${host}/api/v1`

    const [video, config, captionsResponse, chaptersResponse, storyboardsResponse] = await Promise.all([
      fetchJson(`${base}/videos/${uuid}`),
      fetchOptionalJson(`${base}/config`),
      fetchOptionalJson(`${base}/videos/${uuid}/captions`),
      fetchOptionalJson(`${base}/videos/${uuid}/chapters`),
      fetchOptionalJson(`${base}/videos/${uuid}/storyboards`)
    ])

    const duration = video.duration ?? 0
    const playlist = video.streamingPlaylists?.[0] ?? null

    const legacyFiles = [
      ...(video.files ?? []),
      ...(includeHlsFiles ? (playlist?.files ?? []) : [])
    ]
    const legacyFormats = legacyFiles
      .filter(isMuxedFile)
      .map(file => toLegacyFormat(file, duration, video.aspectRatio))
      .sort((a, b) => b.height - a.height)

    let format = requestedFormat
    if (!playlist) {
      format = 'legacy'
    }

    const captions = (captionsResponse?.data ?? []).map(caption => ({
      url: absolute(host, caption.fileUrl ?? caption.captionPath),
      label: caption.language.label,
      language: caption.language.id,
      mimeType: 'text/vtt'
    }))

    const chapters = (chaptersResponse?.chapters ?? []).map(chapter => ({
      title: chapter.title,
      timestamp: formatDurationAsTimestamp(chapter.timecode),
      startSeconds: chapter.timecode,
      endSeconds: 0
    }))

    // Copied from Watch.js's addChaptersEndSeconds, which is a component method
    if (chapters.length > 0) {
      for (let i = 0; i < chapters.length - 1; i++) {
        chapters[i].endSeconds = chapters[i + 1].startSeconds
      }
      chapters.at(-1).endSeconds = duration
    }

    const chaptersSrc = chapters.length > 0
      ? `data:text/vtt,${encodeURIComponent(buildChaptersVttFile(chapters))}`
      : ''

    const storyboard = storyboardsResponse?.storyboards?.[0]
    const { src: storyboardSrc, cues: storyboardCues } = storyboard
      ? buildStoryboardVtt(host, storyboard, duration)
      : { src: '', cues: 0 }

    source.value = {
      format,
      manifestSrc: playlist ? playlist.playlistUrl : null,
      manifestMimeType: 'application/x-mpegurl',
      legacyFormats,
      startTime: null,
      captions,
      chapters,
      chaptersSrc,
      storyboardSrc,
      videoId: uuid,
      channelId: `${video.channel?.name}@${video.channel?.host}`,
      title: video.name,
      thumbnail: pickThumbnail(video, host)
    }

    const summary = {
      host,
      uuid,
      serverVersion: config?.serverVersion ?? 'unknown',
      platformProp: baseline.value ? '(none, baseline)' : 'peertube',
      requestedFormat,
      format,
      manifestSrc: source.value.manifestSrc,
      manifestMimeType: source.value.manifestMimeType,
      isLive: video.isLive,
      duration,
      aspectRatio: video.aspectRatio,
      streamingPlaylists: video.streamingPlaylists?.length ?? 0,
      hlsFiles: (playlist?.files ?? []).map(f => `${f.resolution?.id} a:${f.hasAudio} v:${f.hasVideo}`),
      webVideoFiles: (video.files ?? []).map(f => `${f.resolution?.id} a:${f.hasAudio} v:${f.hasVideo}`),
      includeHlsFilesInLegacy: includeHlsFiles,
      legacyFormats: legacyFormats.map(f => `${f.qualityLabel} ${f.width}x${f.height} ${f.url}`),
      captionLanguages: captions.map(c => c.language),
      chapterCount: chapters.length,
      storyboardCues,
      thumbnail: source.value.thumbnail,
      channelId: source.value.channelId
    }

    diagnostics.value = JSON.stringify(summary, null, 2)
    console.log(LOG_PREFIX, 'source', JSON.stringify(summary))
  } catch (error) {
    errorMessage.value = String(error)
    console.log(LOG_PREFIX, 'load error', String(error))
  } finally {
    isLoading.value = false
    playerKey.value++
  }
}

/**
 * @param {shaka.util.Error} error
 */
function handlePlayerError(error) {
  const { Category, Code } = shaka.util.Error
  const categoryText = Object.keys(Category).find(key => Category[key] === error.category)
  const codeText = Object.keys(Code).find(key => Code[key] === error.code)

  let data
  try {
    data = JSON.stringify(error.data)
  } catch {
    data = String(error.data)
  }

  const message = `player error: ${codeText} (${error.code}), category ${categoryText} (${error.category}), severity ${error.severity}, data ${data}`
  errorMessage.value = message
  console.log(LOG_PREFIX, 'player error', message)
}

function handleLoaded() {
  console.log(LOG_PREFIX, 'player loaded')
}

onMounted(load)

watch(() => route.fullPath, () => {
  // the watcher can fire for the navigation away, before this view unmounts
  if (route.name === 'peertubeSpike') {
    load()
  }
})
</script>

<style scoped>
.peerTubeSpike {
  padding: 16px;
}

.spikePlayer {
  inline-size: 100%;
  max-block-size: 70vh;
}

.spikeDiagnostics,
.spikeError {
  font-size: 12px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.spikeError {
  color: var(--accent-color);
}
</style>
