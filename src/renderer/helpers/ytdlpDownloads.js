import { reactive } from 'vue'

import i18n from '../i18n/index'
import { dismissDownloadInMain, isPeerTubeDownloadKey, listAllDownloads } from './downloads'

/**
 * The downloads this window knows about, for the downloads panel and the
 * watch page button: every running download, those that ended in the last
 * few minutes, and the finished file of each video downloaded this session.
 * In memory only, like main's, so a restart forgets them.
 *
 * PeerTube downloads are here too, keyed `peertube:<host>:<uuid>` where a
 * yt-dlp one has its video id: main's PeerTube service reports in the same
 * shapes, on the same channel.
 */

/** @typedef {import('../../main/ytdlp/downloadService').DownloadSnapshot | (Omit<import('../../main/ytdlp/downloadService').DownloadSnapshot, 'status'> & { status: 'waiting' })} Download */

export const ytDlpDownloads = reactive({
  /** @type {Record<string, Download>} */
  byId: {},
  /** The finished file per video id, for Show in folder; null when yt-dlp did not say */
  /** @type {Record<string, string | null>} */
  finished: {},
  /** The panel in the top bar, opened from there or from the watch page button */
  panelOpen: false,
})

const RUNNING = new Set(['waiting', 'preparing', 'downloading', 'merging', 'processing'])

// An ended download stays in the panel this long unless dismissed
const ENDED_KEPT_MS = 5 * 60 * 1000

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const expiryTimers = new Map()

/**
 * @param {Download | undefined} download
 */
export function isRunning(download) {
  return download !== undefined && RUNNING.has(download.status)
}

/**
 * What main already knows, yt-dlp and PeerTube downloads both, for a window
 * opened after downloads started.
 */
export async function loadYtDlpDownloads() {
  const { downloads, finished } = await listAllDownloads()

  for (const download of downloads) {
    put(download)
  }

  Object.assign(ytDlpDownloads.finished, finished)
}

/**
 * @param {import('../../main/ytdlp/downloadService').DownloadOutcome | { type: 'waiting-for-install', videoId: string, title: string }} outcome
 */
export function applyOutcome(outcome) {
  switch (outcome.type) {
    case 'progress':
    case 'started':
      put(outcome.download)
      break

    case 'finished':
      put(outcome.download)
      ytDlpDownloads.finished[outcome.videoId] = outcome.path
      break

    case 'failed':
    case 'cancelled':
      if (outcome.download) {
        put(outcome.download)
      } else {
        remove(outcome.videoId)
      }
      break

    case 'waiting-for-install':
      put({
        videoId: outcome.videoId,
        title: outcome.title,
        status: 'waiting',
        folder: '',
        destination: null,
        resuming: false,
        part: null,
        parts: null,
        partKind: null,
        downloadedBytes: null,
        totalBytes: null,
        speed: null,
        eta: null,
        reason: null,
        exitCode: null,
        endedAt: null,
      })
      break

    case 'tools-missing':
    case 'not-found':
      remove(outcome.videoId)
      break
  }
}

/**
 * @param {Download} download
 */
function put(download) {
  ytDlpDownloads.byId[download.videoId] = download

  clearTimeout(expiryTimers.get(download.videoId))
  expiryTimers.delete(download.videoId)

  if (download.endedAt != null) {
    expiryTimers.set(download.videoId, setTimeout(() => remove(download.videoId), ENDED_KEPT_MS))
  }
}

/**
 * @param {string} videoId
 */
function remove(videoId) {
  clearTimeout(expiryTimers.get(videoId))
  expiryTimers.delete(videoId)
  delete ytDlpDownloads.byId[videoId]
}

/**
 * Takes an ended download off the panel, here and in main: yt-dlp's or
 * PeerTube's, by its key.
 *
 * @param {string} key
 */
export function dismissDownload(key) {
  remove(key)
  dismissDownloadInMain(key)
}

/**
 * @param {string} videoId
 */
export function revealYtDlpDownload(videoId) {
  window.ftElectron.ytDlpReveal(videoId)
}

/**
 * How far the current part has got, from 0 to 1, or null when there is no
 * telling (preparing, merging), for an indeterminate indicator.
 *
 * @param {Download} download
 * @returns {number | null}
 */
export function progressFraction(download) {
  if (download.status === 'finished') {
    return 1
  }

  if (download.status !== 'downloading' || !download.totalBytes || download.downloadedBytes == null) {
    return null
  }

  return Math.min(1, download.downloadedBytes / download.totalBytes)
}

/**
 * Where it is going, or went: the file once yt-dlp has said, the folder it
 * was told to use before that.
 *
 * @param {Download} download
 */
export function whereText(download) {
  const t = i18n.global.t

  // A PeerTube download that did not finish keeps nothing, anywhere
  if (isPeerTubeDownloadKey(download.videoId) && (download.status === 'failed' || download.status === 'cancelled')) {
    return ''
  }

  if (download.destination) {
    switch (download.status) {
      case 'finished':
        return t('Video.yt-dlp.Downloads.Saved to', { path: download.destination })
      case 'failed':
      case 'cancelled':
        // Its partial files are beside it, for the next attempt to carry on from
        return t('Video.yt-dlp.Downloads.Was saving to', { path: download.destination })
      default:
        return t('Video.yt-dlp.Downloads.Saving to', { path: download.destination })
    }
  }

  return download.folder ? t('Video.yt-dlp.Downloads.Saving into folder', { path: download.folder }) : ''
}

/**
 * The stage, in words.
 *
 * @param {Download} download
 */
export function statusText(download) {
  const t = i18n.global.t

  switch (download.status) {
    case 'waiting':
      return t('Video.yt-dlp.Downloads.Status.Waiting')
    case 'preparing':
      return download.resuming ? t('Video.yt-dlp.Downloads.Status.Resuming') : t('Video.yt-dlp.Downloads.Status.Preparing')
    case 'downloading': {
      const parts = { part: download.part, parts: download.parts }
      if (!download.part || !download.parts || download.parts < 2) {
        return download.resuming ? t('Video.yt-dlp.Downloads.Status.Resuming') : t('Video.yt-dlp.Downloads.Status.Downloading')
      }
      switch (download.partKind) {
        case 'video':
          return t('Video.yt-dlp.Downloads.Status.Downloading video', parts)
        case 'audio':
          return t('Video.yt-dlp.Downloads.Status.Downloading audio', parts)
        default:
          return t('Video.yt-dlp.Downloads.Status.Downloading part', parts)
      }
    }
    case 'merging':
      return t('Video.yt-dlp.Downloads.Status.Merging')
    case 'processing':
      return t('Video.yt-dlp.Downloads.Status.Processing')
    case 'finished':
      return t('Video.yt-dlp.Downloads.Status.Finished')
    case 'cancelled':
      // Nothing is kept of a PeerTube download to resume from
      return isPeerTubeDownloadKey(download.videoId)
        ? t('PeerTube.Downloads.Status.Cancelled')
        : t('Video.yt-dlp.Downloads.Status.Cancelled')
    case 'failed':
      return download.reason
        ? t('Video.yt-dlp.Downloads.Status.Failed', { reason: download.reason })
        : t('Video.yt-dlp.Downloads.Status.Failed with exit code', { exitCode: download.exitCode ?? '?' })
  }
  return ''
}

/**
 * Percent, size, speed and time left, as far as they are known.
 *
 * @param {Download} download
 */
export function detailsText(download) {
  if (download.status !== 'downloading') {
    return ''
  }

  const t = i18n.global.t
  const parts = []
  const fraction = progressFraction(download)

  if (fraction !== null) {
    parts.push(t('Video.yt-dlp.Downloads.Percent of size', {
      percent: Math.floor(fraction * 100),
      size: formatBytes(download.totalBytes),
    }))
  } else if (download.downloadedBytes) {
    parts.push(formatBytes(download.downloadedBytes))
  }

  if (download.speed) {
    parts.push(t('Video.yt-dlp.Downloads.Speed', { speed: formatBytes(download.speed) }))
  }

  if (download.eta != null && download.eta > 0) {
    parts.push(t('Video.yt-dlp.Downloads.Time left', { time: formatDuration(download.eta) }))
  }

  return parts.join(' · ')
}

/**
 * What was downloaded, as far as yt-dlp has said: its height, or audio only.
 * Empty until then.
 *
 * @param {Download | undefined} download
 */
export function qualityText(download) {
  if (!download) {
    return ''
  }

  if (download.audioOnly) {
    return i18n.global.t('Video.yt-dlp.Quality.Audio only')
  }

  return download.height ? i18n.global.t('Video.yt-dlp.Quality.Height', { height: download.height }) : ''
}

/**
 * The qualities the viewer can ask for, for a dropdown.
 *
 * @returns {{ label: string, value: import('../../main/ytdlp/downloadService').Quality }[]}
 */
export function qualityOptions() {
  const t = i18n.global.t

  return [
    { label: t('Video.yt-dlp.Quality.Download best'), value: 'best' },
    ...['2160', '1440', '1080', '720', '480', '360'].map(height => ({
      label: t('Video.yt-dlp.Quality.Download up to', { height }),
      value: /** @type {import('../../main/ytdlp/downloadService').Quality} */ (height),
    })),
    { label: t('Video.yt-dlp.Quality.Download audio only'), value: 'audio' },
  ]
}

/**
 * @param {number} bytes
 */
export function formatBytes(bytes) {
  const units = [['gigabyte', 1e9], ['megabyte', 1e6], ['kilobyte', 1e3]]
  const [unit, size] = units.find(([, size]) => bytes >= size) ?? ['byte', 1]

  return new Intl.NumberFormat(i18n.global.locale.value, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: bytes / size < 10 ? 1 : 0,
  }).format(bytes / size)
}

/**
 * @param {number} seconds
 */
export function formatDuration(seconds) {
  const locale = i18n.global.locale.value
  const format = (value, unit) => new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }).format(value)

  if (seconds < 60) {
    return format(Math.ceil(seconds), 'second')
  }
  if (seconds < 3600) {
    return format(Math.ceil(seconds / 60), 'minute')
  }
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.ceil((seconds % 3600) / 60)
  return minutes > 0 ? `${format(hours, 'hour')} ${format(minutes, 'minute')}` : format(hours, 'hour')
}
