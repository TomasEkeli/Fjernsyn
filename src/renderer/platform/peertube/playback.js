// A PeerTube video's playback source: what the player needs, built from the
// details response and the captions, chapters and storyboards responses.
// Pure: videos.js fetches, this shapes. What the player needs, and why, is in
// thoughts/2026-09-27-platform-layer-spike.md and design.md's amendments:
//
// - `manifestUrl`: the HLS master playlist, `streamingPlaylists[0].playlistUrl`.
// - `legacyFormats`: the Web Video MP4s that carry audio and video both, in
//   the Local and Invidious legacy shape, highest first (the player's legacy
//   quality pick takes the first).
// - `audio`: the HLS manifest only when its audio is a separate rendition
//   (split audio: a video-only HLS file exists); on a muxed HLS, audio-only
//   mode fails in shaka (4032), even with an extra audio-only HLS file.
//   Otherwise the audio-only Web Video file as `video/mp4` (`audio/mp4`
//   fails in the player's response filter). Otherwise none.
// - `storyboard`: the sprite as a WebVTT thumbnails track in a `data:` URI.
// - `chaptersSrc`: the chapters as a WebVTT track in a `data:` URI, exactly as
//   the Watch view's `chaptersSrc` computes it, for the player's prop of the
//   same name; `chapters` for the chapter list.

import { absoluteUrl } from './normalise'

const HLS_MIME_TYPE = 'application/x-mpegurl'
const MP4_MIME_TYPE = 'video/mp4'
const VTT_MIME_TYPE = 'text/vtt'

/**
 * @typedef {object} PlaybackExtras
 * @property {any} [captions] the captions response, `{ data: [...] }`
 * @property {any} [chapters] the chapters response, `{ chapters: [...] }`
 * @property {any} [storyboards] the storyboards response, `{ storyboards: [...] }`
 * @property {string} [locale] the display language, for ordering captions
 */

/**
 * @param {any} file
 * @returns {number}
 */
function resolutionOf(file) {
  const resolution = Number(file?.resolution?.id)
  return Number.isFinite(resolution) ? resolution : -1
}

/**
 * What a file carries. From 6.3, files say so (`hasAudio`, `hasVideo`); before
 * that, resolution 0 is the audio-only file and every other file is muxed.
 *
 * @param {any} file
 * @returns {'muxed' | 'audio' | 'video'}
 */
export function fileKind(file) {
  if (typeof file?.hasAudio === 'boolean' || typeof file?.hasVideo === 'boolean') {
    if (file.hasVideo === false) {
      return 'audio'
    }

    return file.hasAudio === false ? 'video' : 'muxed'
  }

  return resolutionOf(file) === 0 ? 'audio' : 'muxed'
}

/**
 * Width and height: the file's, else from its resolution, which PeerTube
 * gives as the shorter side, and the video's aspect ratio (16:9 when unknown).
 *
 * @param {any} file
 * @param {number | null | undefined} aspectRatio
 * @returns {{ width: number, height: number }}
 */
export function dimensionsOf(file, aspectRatio) {
  if (file?.width > 0 && file?.height > 0) {
    return { width: file.width, height: file.height }
  }

  const resolution = resolutionOf(file)
  const ratio = aspectRatio > 0 ? aspectRatio : 16 / 9

  return ratio >= 1
    ? { width: Math.round(resolution * ratio), height: resolution }
    : { width: resolution, height: Math.round(resolution / ratio) }
}

/**
 * @param {any} file
 * @param {number} duration
 * @param {number | null | undefined} aspectRatio
 * @param {string} host
 * @returns {import('../shapes').LegacyFormat | null}
 */
function toLegacyFormat(file, duration, aspectRatio, host) {
  const url = absoluteUrl(host, file?.fileUrl)

  if (!url) {
    return null
  }

  const resolution = resolutionOf(file)
  const { width, height } = dimensionsOf(file, aspectRatio)

  return {
    itag: resolution,
    qualityLabel: typeof file.resolution?.label === 'string' ? file.resolution.label : `${resolution}p`,
    fps: Number(file.fps) || 0,
    bitrate: duration > 0 && file.size > 0 ? Math.round((file.size * 8) / duration) : 0,
    mimeType: MP4_MIME_TYPE,
    height,
    width,
    url,
  }
}

/**
 * The muxed Web Video files as legacy formats, highest first.
 *
 * @param {any} video
 * @param {string} host
 * @returns {import('../shapes').LegacyFormat[]}
 */
function legacyFormatsOf(video, host) {
  const files = Array.isArray(video.files) ? video.files : []
  const duration = Number(video.duration) || 0

  return files
    .filter(file => resolutionOf(file) > 0 && fileKind(file) === 'muxed')
    .map(file => toLegacyFormat(file, duration, video.aspectRatio, host))
    .filter(format => format !== null)
    .sort((a, b) => b.itag - a.itag)
}

/**
 * @param {any} video
 * @param {string | null} manifestUrl
 * @param {string} host
 * @returns {{ manifestUrl: string, mimeType: string } | null}
 */
function audioOf(video, manifestUrl, host) {
  const hlsFiles = Array.isArray(video.streamingPlaylists?.[0]?.files) ? video.streamingPlaylists[0].files : []
  // Split only when a video-only HLS file exists (4d2). A muxed HLS with an
  // extra audio-only file (blurt, 6.3) is not: audio-only mode on it is unconfirmed
  const splitAudio = hlsFiles.some(file => fileKind(file) === 'video')

  if (manifestUrl && splitAudio) {
    return { manifestUrl, mimeType: HLS_MIME_TYPE }
  }

  const files = Array.isArray(video.files) ? video.files : []
  const audioFile = files.find(file => fileKind(file) === 'audio' && absoluteUrl(host, file.fileUrl))

  return audioFile ? { manifestUrl: absoluteUrl(host, audioFile.fileUrl), mimeType: MP4_MIME_TYPE } : null
}

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

/**
 * Orders captions as the Watch view's `sortCaptions`
 * (src/renderer/helpers/player/utils.js) does for YouTube, reimplemented here
 * because that module imports i18n: the display language first, written
 * before generated, then an exact country match, then no country, then the
 * rest; everything else alphabetically by label. PeerTube says which are
 * generated (`automaticallyGenerated`), so the flag is read instead of
 * looking for "auto" in the label.
 *
 * @param {import('../shapes').CaptionTrack[]} captions
 * @param {string} locale
 * @returns {import('../shapes').CaptionTrack[]}
 */
export function sortCaptions(captions, locale) {
  const [userLanguage, userCountry] = String(locale || 'en').toLowerCase().split('-')
  const collator = new Intl.Collator([locale || 'en', 'en'])

  /**
   * @param {import('../shapes').CaptionTrack} caption
   * @returns {number[]}
   */
  function rank(caption) {
    const [language, country] = caption.language.toLowerCase().split('-')

    if (language !== userLanguage) {
      return [1, 0, 0]
    }

    let countryRank = 2
    if (country === userCountry) {
      countryRank = 0
    } else if (country === undefined) {
      countryRank = 1
    }

    return [0, caption.isAutomatic ? 1 : 0, countryRank]
  }

  return captions
    .map(caption => ({ caption, rank: rank(caption) }))
    .sort((a, b) => {
      for (let i = 0; i < a.rank.length; i++) {
        if (a.rank[i] !== b.rank[i]) {
          return a.rank[i] - b.rank[i]
        }
      }

      return collator.compare(a.caption.label, b.caption.label)
    })
    .map(({ caption }) => caption)
}

/**
 * Captions as WebVTT tracks: `fileUrl` (absolute, 7.1 and later, possibly on
 * object storage) or `captionPath` on the host.
 *
 * @param {any} response
 * @param {string} host
 * @param {string} locale
 * @returns {import('../shapes').CaptionTrack[]}
 */
function captionsOf(response, host, locale) {
  const data = Array.isArray(response?.data) ? response.data : []

  const captions = data
    .map((caption) => {
      const url = absoluteUrl(host, caption?.fileUrl) ?? absoluteUrl(host, caption?.captionPath)
      const language = caption?.language?.id

      if (!url || typeof language !== 'string' || language === '') {
        return null
      }

      return {
        url,
        label: typeof caption.language.label === 'string' ? caption.language.label : language,
        language,
        mimeType: VTT_MIME_TYPE,
        isAutomatic: caption.automaticallyGenerated === true,
      }
    })
    .filter(caption => caption !== null)

  return sortCaptions(captions, locale)
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

/**
 * `formatDurationAsTimestamp` of src/renderer/helpers/utils.js, reimplemented
 * because that module imports the router: `m:ss`, or `h:mm:ss` from an hour.
 *
 * @param {number} lengthSeconds
 * @returns {string}
 */
export function formatTimestamp(lengthSeconds) {
  const hours = Math.floor(lengthSeconds / 3600)
  const minutes = Math.floor((lengthSeconds % 3600) / 60)
  const seconds = lengthSeconds % 60

  const paddedSeconds = String(seconds).padStart(2, '0')

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`
    : `${minutes}:${paddedSeconds}`
}

/**
 * `00:00:00.000`, as `secondsToVttTimestamp` in src/renderer/helpers/utils.js.
 *
 * @param {number} totalSeconds
 * @returns {string}
 */
function vttTimestamp(totalSeconds) {
  const hours = Math.trunc(totalSeconds / 3600)
  const minutes = Math.trunc((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${seconds.toFixed(3).padStart(6, '0')}`
}

/**
 * Chapters with their ends: each ends where the next starts, the last at the
 * end of the video, as the Watch view's `addChaptersEndSeconds`.
 *
 * @param {any} response
 * @param {number} duration
 * @returns {import('../shapes').Chapter[]}
 */
function chaptersOf(response, duration) {
  const raw = Array.isArray(response?.chapters) ? response.chapters : []

  const chapters = raw
    .filter(chapter => Number.isFinite(chapter?.timecode) && typeof chapter.title === 'string')
    // A chapter starting at or after the end of the video is not in it
    .filter(chapter => !(duration > 0) || chapter.timecode < duration)
    .sort((a, b) => a.timecode - b.timecode)
    .map(chapter => ({
      title: chapter.title,
      timestamp: formatTimestamp(chapter.timecode),
      startSeconds: chapter.timecode,
      endSeconds: 0,
    }))

  for (let i = 0; i < chapters.length; i++) {
    const end = i + 1 < chapters.length ? chapters[i + 1].startSeconds : duration
    chapters[i].endSeconds = Math.max(end, chapters[i].startSeconds)
  }

  return chapters
}

/**
 * The chapters as the player's `chaptersSrc`, built as `buildChaptersVttFile`
 * in src/renderer/helpers/utils.js and wrapped as the Watch view's
 * `chaptersSrc` wraps it.
 *
 * @param {import('../shapes').Chapter[]} chapters
 * @returns {string | null}
 */
export function chaptersSrcOf(chapters) {
  if (chapters.length === 0) {
    return null
  }

  const blocks = ['WEBVTT']

  for (const chapter of chapters) {
    // One line per cue: a line break in a title would end the cue, a blank
    // line start a new one
    const title = chapter.title.replaceAll(/\s+/g, ' ').trim()
    blocks.push(`${vttTimestamp(chapter.startSeconds)} --> ${vttTimestamp(chapter.endSeconds)}\n${title}`)
  }

  return `data:text/vtt,${encodeURIComponent(blocks.join('\n\n') + '\n')}`
}

// ---------------------------------------------------------------------------
// Storyboard
// ---------------------------------------------------------------------------

/**
 * The storyboard sprite as a WebVTT thumbnails track: one cue per
 * `spriteDuration`, left to right and top to bottom through the sprite,
 * `url#xywh=x,y,w,h`, until the video or the sprite ends.
 *
 * @param {any} response
 * @param {number} duration
 * @param {string} host
 * @returns {string | null}
 */
export function storyboardOf(response, duration, host) {
  const storyboard = Array.isArray(response?.storyboards) ? response.storyboards[0] : null
  const url = absoluteUrl(host, storyboard?.fileUrl) ?? absoluteUrl(host, storyboard?.storyboardPath)

  if (!url || !(duration > 0)) {
    return null
  }

  const { spriteWidth, spriteHeight, totalWidth, totalHeight, spriteDuration } = storyboard

  if (![spriteWidth, spriteHeight, totalWidth, totalHeight, spriteDuration].every(value => value > 0)) {
    return null
  }

  const columns = Math.floor(totalWidth / spriteWidth)
  const rows = Math.floor(totalHeight / spriteHeight)
  const sprites = columns * rows

  if (sprites === 0) {
    return null
  }

  const blocks = ['WEBVTT']

  for (let index = 0; index < sprites && index * spriteDuration < duration; index++) {
    const start = index * spriteDuration
    const end = Math.min(start + spriteDuration, duration)
    const x = (index % columns) * spriteWidth
    const y = Math.floor(index / columns) * spriteHeight

    blocks.push(`${vttTimestamp(start)} --> ${vttTimestamp(end)}\n${url}#xywh=${x},${y},${spriteWidth},${spriteHeight}`)
  }

  return `data:text/vtt;charset=utf-8,${encodeURIComponent(blocks.join('\n\n') + '\n')}`
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

/**
 * The playback source of a video, or `null` when there is nothing to play:
 * a live that is waiting or has ended, or a video with neither a manifest,
 * nor a muxed file, nor an audio file.
 *
 * A live that is live now plays from its manifest alone.
 *
 * @param {any} video the details response
 * @param {string} host the instance that answered (the origin)
 * @param {'live' | 'waiting' | 'ended' | null} liveStatus
 * @param {PlaybackExtras} [extras]
 * @returns {import('../shapes').ManifestPlaybackSource | null}
 */
export function playbackSourceFor(video, host, liveStatus, { captions, chapters, storyboards, locale = 'en-US' } = {}) {
  if (liveStatus === 'waiting' || liveStatus === 'ended') {
    return null
  }

  const manifestUrl = absoluteUrl(host, video.streamingPlaylists?.[0]?.playlistUrl)
  const isLive = liveStatus === 'live'

  if (isLive) {
    return manifestUrl ? manifestSource({ manifestUrl, isLive }) : null
  }

  const legacyFormats = legacyFormatsOf(video, host)
  const audio = audioOf(video, manifestUrl, host)

  if (!manifestUrl && legacyFormats.length === 0 && !audio) {
    return null
  }

  const duration = Number(video.duration) || 0
  const chapterList = chaptersOf(chapters, duration)

  return manifestSource({
    manifestUrl,
    legacyFormats,
    audio,
    captions: captionsOf(captions, host, locale),
    chapters: chapterList,
    chaptersSrc: chaptersSrcOf(chapterList),
    storyboard: storyboardOf(storyboards, duration, host),
    isLive,
  })
}

/**
 * @param {Partial<import('../shapes').ManifestPlaybackSource>} fields
 * @returns {import('../shapes').ManifestPlaybackSource}
 */
function manifestSource({ manifestUrl = null, legacyFormats = [], audio = null, captions = [], chapters = [], chaptersSrc = null, storyboard = null, isLive = false }) {
  return {
    transport: 'manifest',
    manifestUrl,
    manifestMimeType: manifestUrl ? HLS_MIME_TYPE : null,
    legacyFormats,
    audio,
    captions,
    chapters,
    chaptersSrc,
    storyboard,
    isLive,
  }
}
