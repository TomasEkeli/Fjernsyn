// A PeerTube video's download options, from its details response alone. The
// instance's own files, never yt-dlp (spec, "PeerTube downloads"):
//
// - None when the author has disabled downloads, and none for a live.
// - One option per resolution, from the Web Video files and the HLS files
//   both; for a resolution that has both, the Web Video file (a plain MP4
//   rather than a fragmented one).
// - A file with audio and video downloads from its own `fileDownloadUrl`.
// - A video-only file (split audio, 6.3 and later) downloads through
//   `/download/videos/generate/{uuid}`, which muxes it with an audio-only file
//   into one MP4. The ids in that URL are file ids, used for this URL and
//   never persisted or used as refs.
// - An audio-only option where an audio-only file exists, last.
//
// Labels are data (`1080p`, `Audio only`); the view translates them, and has
// `resolution` to format its own.

import { absoluteUrl } from './normalise'
import { dimensionsOf, fileKind } from './playback'
import { isUuid } from '../refs'

export const AUDIO_ONLY_LABEL = 'Audio only'

/**
 * @param {any} file
 * @returns {number}
 */
function resolutionOf(file) {
  const resolution = Number(file?.resolution?.id)
  return Number.isInteger(resolution) && resolution >= 0 ? resolution : -1
}

/**
 * @param {any} file
 * @returns {number | null}
 */
function sizeOf(file) {
  return typeof file?.size === 'number' && file.size >= 0 ? file.size : null
}

/**
 * @param {any} file
 * @returns {boolean}
 */
function hasFileId(file) {
  return Number.isSafeInteger(file?.id) && file.id > 0
}

/**
 * Every download option the instance offers for a video, highest resolution
 * first and audio only last. `[]` when downloads are disabled, for a live and
 * for anything that is not a video.
 *
 * @param {any} video a details response
 * @param {string} host the origin, which serves the downloads
 * @returns {import('../shapes').DownloadOption[]}
 */
export function downloadOptionsFor(video, host) {
  if (!video || video.downloadEnabled !== true || video.isLive === true || !isUuid(video.uuid)) {
    return []
  }

  const webFiles = Array.isArray(video.files) ? video.files : []
  const hlsFiles = Array.isArray(video.streamingPlaylists?.[0]?.files) ? video.streamingPlaylists[0].files : []

  // Web Video files first, so that they win a resolution over HLS files
  const sets = [webFiles, hlsFiles]

  /** @type {Map<number, import('../shapes').DownloadOption>} */
  const byResolution = new Map()
  /** @type {import('../shapes').DownloadOption | null} */
  let audioOption = null

  for (const files of sets) {
    // A video-only file muxes with an audio file of its own set where there is
    // one: the split HLS playlist's audio rendition
    const ownAudio = files.find(file => fileKind(file) === 'audio' && hasFileId(file))
    const anyAudio = ownAudio ?? [...webFiles, ...hlsFiles].find(file => fileKind(file) === 'audio' && hasFileId(file))

    for (const file of files) {
      const resolution = resolutionOf(file)
      const kind = fileKind(file)

      if (resolution < 0) {
        continue
      }

      if (kind === 'audio') {
        const url = absoluteUrl(host, file.fileDownloadUrl)
        if (!audioOption && url) {
          audioOption = {
            id: 'audio',
            label: AUDIO_ONLY_LABEL,
            resolution: 0,
            height: null,
            sizeBytes: sizeOf(file),
            url,
            kind: 'audio',
          }
        }
        continue
      }

      if (resolution === 0 || byResolution.has(resolution)) {
        continue
      }

      const option = kind === 'muxed'
        ? muxedOption(file, resolution, video, host)
        : generatedOption(file, anyAudio, resolution, video, host)

      if (option) {
        byResolution.set(resolution, option)
      }
    }
  }

  const options = [...byResolution.values()].sort((a, b) => b.resolution - a.resolution)

  return audioOption ? [...options, audioOption] : options
}

/**
 * @param {any} file
 * @param {number} resolution
 * @param {any} video
 * @param {string} host
 * @returns {import('../shapes').DownloadOption | null}
 */
function muxedOption(file, resolution, video, host) {
  const url = absoluteUrl(host, file.fileDownloadUrl)

  if (!url) {
    return null
  }

  return {
    id: String(resolution),
    label: `${resolution}p`,
    resolution,
    height: dimensionsOf(file, video.aspectRatio).height,
    sizeBytes: sizeOf(file),
    url,
    kind: 'muxed',
  }
}

/**
 * @param {any} file a video-only file
 * @param {any} audioFile
 * @param {number} resolution
 * @param {any} video
 * @param {string} host
 * @returns {import('../shapes').DownloadOption | null}
 */
function generatedOption(file, audioFile, resolution, video, host) {
  if (!audioFile || !hasFileId(file)) {
    return null
  }

  const query = new URLSearchParams()
  query.append('videoFileIds', String(file.id))
  query.append('videoFileIds', String(audioFile.id))

  const videoSize = sizeOf(file)
  const audioSize = sizeOf(audioFile)

  return {
    id: String(resolution),
    label: `${resolution}p`,
    resolution,
    height: dimensionsOf(file, video.aspectRatio).height,
    sizeBytes: videoSize !== null && audioSize !== null ? videoSize + audioSize : null,
    url: `https://${host}/download/videos/generate/${video.uuid.toLowerCase()}?${query}`,
    kind: 'generated',
  }
}
