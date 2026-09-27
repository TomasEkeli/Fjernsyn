/**
 * The downloads panel's actions, sent to whichever service in main owns the
 * download: PeerTube downloads have keys `peertube:<host>:<uuid>`, anything
 * else is a YouTube video id and belongs to yt-dlp. Electron only.
 *
 * No store or i18n here, so that the dispatch can be tested on its own.
 */

const PEERTUBE_KEY_PREFIX = 'peertube:'

/**
 * @param {string} key
 */
export function isPeerTubeDownloadKey(key) {
  return typeof key === 'string' && key.startsWith(PEERTUBE_KEY_PREFIX)
}

/**
 * @param {string} key
 */
export function cancelDownload(key) {
  if (isPeerTubeDownloadKey(key)) {
    window.ftElectron.peerTubeCancel(key)
  } else {
    window.ftElectron.ytDlpCancel(key)
  }
}

/**
 * @param {string} key
 */
export function revealDownload(key) {
  if (isPeerTubeDownloadKey(key)) {
    window.ftElectron.peerTubeReveal(key)
  } else {
    window.ftElectron.ytDlpReveal(key)
  }
}

/**
 * Tells main the viewer has dismissed it; the store is the caller's.
 *
 * @param {string} key
 */
export function dismissDownloadInMain(key) {
  if (isPeerTubeDownloadKey(key)) {
    window.ftElectron.peerTubeDismiss(key)
  } else {
    window.ftElectron.ytDlpDismiss(key)
  }
}

/**
 * What both services in main know, for a window opened after downloads
 * started. A PeerTube list that cannot be had leaves the yt-dlp one.
 *
 * @returns {Promise<{ downloads: import('../../main/ytdlp/downloadService').DownloadSnapshot[], finished: Record<string, string | null> }>}
 */
export async function listAllDownloads() {
  const [ytDlp, peerTube] = await Promise.all([
    window.ftElectron.ytDlpListDownloads(),
    Promise.resolve()
      .then(() => window.ftElectron.peerTubeListDownloads())
      .catch((error) => {
        console.error('Could not load the PeerTube downloads', error)
        return null
      }),
  ])

  return {
    downloads: [...ytDlp.downloads, ...(peerTube?.downloads ?? [])],
    finished: { ...ytDlp.finished, ...(peerTube?.finished ?? {}) },
  }
}

/**
 * Asks main to download a file a PeerTube instance offers. Main checks the
 * request, names the file and reports through the downloads panel and
 * toasts, like a yt-dlp download.
 *
 * @param {object} request
 * @param {string} request.key `peertube:<host>:<uuid>`, plus `:<suffix>` for more than one file per video
 * @param {string} request.url the download option's URL
 * @param {string} request.title
 * @param {string} request.label e.g. `1080p`
 * @param {number | null} [request.resolution] the height, 0 for audio only
 * @param {boolean} [request.audioOnly]
 * @param {string | null} [request.videoUrl] the video's page on its instance
 */
export function downloadFromPeerTube(request) {
  if (process.env.IS_ELECTRON) {
    window.ftElectron.peerTubeDownload(request)
  }
}
