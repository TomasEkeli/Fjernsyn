import { reactive } from 'vue'

import i18n from '../i18n/index'
import { showToast } from './utils'
import { isPeerTubeDownloadKey, revealDownload } from './downloads'
import { applyOutcome, loadYtDlpDownloads, qualityText } from './ytdlpDownloads'

/**
 * The renderer's half of download with yt-dlp: asking main to download, and
 * turning what main reports back into toasts. Electron only.
 */

// Long enough to read a yt-dlp error line, and to get to the finished toast
// before it goes
const LONG_TOAST_MS = 10_000

// Product names, the same in every language
export const TOOL_NAMES = {
  'yt-dlp': 'yt-dlp',
  ffmpeg: 'ffmpeg',
  deno: 'Deno',
}

/**
 * @param {string} videoId
 * @param {string} title
 * @param {import('../../main/ytdlp/downloadService').Quality} [quality]
 * @param {boolean} [fresh] chosen from the quality menu: start over, replacing a file of the same name
 */
export function downloadWithYtDlp(videoId, title, quality = 'best', fresh = false) {
  if (process.env.IS_ELECTRON) {
    window.ftElectron.ytDlpDownload({ videoId, title, quality, fresh })
  }
}

/**
 * The install as this window knows it, for the settings section to show.
 * Progress arrives for installs started from any window.
 */
export const ytDlpInstallState = reactive({
  /** @type {import('../../main/ytdlp/toolInstaller').InstallProgress | null} */
  progress: null,
  installing: false,
})

/**
 * Registered once, at startup.
 */
export function setupYtDlpOutcomeToasts() {
  if (!process.env.IS_ELECTRON) {
    return
  }

  window.ftElectron.handleYtDlpDownloadOutcome((outcome) => {
    // Every window's panel follows every download; one window tells of it
    applyOutcome(outcome)

    if (outcome.toast) {
      showOutcome(outcome)
    }
  })

  loadYtDlpDownloads().catch((error) => {
    console.error('Could not load the yt-dlp downloads', error)
  })

  window.ftElectron.handleYtDlpInstallProgress((progress) => {
    ytDlpInstallState.progress = progress
  })
}

/**
 * Installs whatever is missing. Joins an install already running, here or in
 * main.
 *
 * @param {{ videoId: string, title: string, quality?: import('../../main/ytdlp/downloadService').Quality, fresh?: boolean }} [thenDownload] for main to download once installed
 * @returns {Promise<import('../../main/ytdlp/toolInstaller').InstallResult | undefined>}
 */
export async function installYtDlpTools(thenDownload) {
  ytDlpInstallState.installing = true
  try {
    return await window.ftElectron.ytDlpInstallTools(thenDownload)
  } finally {
    ytDlpInstallState.installing = false
    ytDlpInstallState.progress = null
  }
}

// Long enough for any install; the toast is closed when the install ends
const INSTALL_TOAST_MS = 60 * 60 * 1000

/**
 * The install offered by the tools missing toast: progress in a toast that
 * follows it, then either the download that was asked for, which main starts
 * and reports as usual, or the reason the install failed.
 *
 * @param {string} videoId
 * @param {string} title
 * @param {import('../../main/ytdlp/downloadService').Quality} quality
 * @param {boolean} fresh
 */
async function installThenDownload(videoId, title, quality, fresh) {
  const t = i18n.global.t
  const progressToast = new AbortController()

  showToast(
    () => ytDlpInstallState.progress
      ? formatInstallProgress(ytDlpInstallState.progress)
      : t('Settings.yt-dlp Settings.Install Progress.Starting'),
    INSTALL_TOAST_MS,
    null,
    progressToast.signal
  )

  let result
  try {
    result = await installYtDlpTools({ videoId, title, quality, fresh })
  } finally {
    progressToast.abort()
  }

  if (result && !result.ok) {
    showToast(formatInstallResult(result), LONG_TOAST_MS)
  }
}

/**
 * @param {import('../../main/ytdlp/toolInstaller').InstallProgress} progress
 */
export function formatInstallProgress(progress) {
  const t = i18n.global.t
  const tool = TOOL_NAMES[progress.tool]

  switch (progress.stage) {
    case 'downloading':
      if (progress.total) {
        return t('Settings.yt-dlp Settings.Install Progress.Downloading with size', {
          tool,
          percent: Math.floor((progress.received / progress.total) * 100),
          received: toMegabytes(progress.received),
          total: toMegabytes(progress.total),
        })
      }
      return t('Settings.yt-dlp Settings.Install Progress.Downloading', { tool })
    case 'verifying':
      return t('Settings.yt-dlp Settings.Install Progress.Verifying', { tool })
    case 'extracting':
      return t('Settings.yt-dlp Settings.Install Progress.Extracting', { tool })
    case 'done':
      return t('Settings.yt-dlp Settings.Install Progress.Done', { tool })
  }
  return ''
}

/**
 * @param {import('../../main/ytdlp/toolInstaller').InstallResult} result
 */
export function formatInstallResult(result) {
  const t = i18n.global.t

  if (result.ok) {
    return result.installed.length > 0
      ? t('Settings.yt-dlp Settings.Install Result.Installed', { tools: formatToolList(result.installed) })
      : t('Settings.yt-dlp Settings.Install Result.Nothing to install')
  }

  if (result.error === 'unsupported') {
    return t('Settings.yt-dlp Settings.Install Result.Unsupported', { tools: formatToolList(result.notCovered) })
  }

  return result.tool
    ? t('Settings.yt-dlp Settings.Install Result.Failed', { tool: TOOL_NAMES[result.tool], reason: result.reason })
    : t('Settings.yt-dlp Settings.Install Result.Failed without tool', { reason: result.reason })
}

/**
 * @param {import('../../main/ytdlp/toolInstaller').UpdateResult} result
 */
export function formatUpdateResult(result) {
  const t = i18n.global.t

  switch (result.status) {
    case 'updated':
      return t('Settings.yt-dlp Settings.Update Result.Updated', { version: result.version })
    case 'current':
      return t('Settings.yt-dlp Settings.Update Result.Current', { version: result.version })
    case 'package-manager':
      return t('Settings.yt-dlp Settings.Update Result.Package Manager')
    case 'busy':
      return t('Settings.yt-dlp Settings.Update Unavailable While Downloading')
    case 'missing':
      return t('Settings.yt-dlp Settings.yt-dlp Missing Warning')
    default:
      return t('Settings.yt-dlp Settings.Update Result.Failed', { reason: result.reason })
  }
}

/**
 * @param {number} bytes
 */
function toMegabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(0)
}

/**
 * @param {import('../../main/ytdlp/downloadService').DownloadOutcome} outcome
 */
function showOutcome(outcome) {
  const t = i18n.global.t
  const title = outcome.title

  switch (outcome.type) {
    case 'started': {
      // Where it is going, as soon as yt-dlp has said; the folder until then
      const path = outcome.download.destination ?? outcome.download.folder
      showToast(
        outcome.download.resuming
          ? t('Video.yt-dlp.Resuming download', { title, path })
          : t('Video.yt-dlp.Download started', { title, path }),
        LONG_TOAST_MS
      )
      break
    }

    case 'cancelled':
      // A PeerTube download keeps nothing to resume from
      showToast(isPeerTubeDownloadKey(outcome.videoId)
        ? t('PeerTube.Downloads.Download cancelled', { title })
        : t('Video.yt-dlp.Download cancelled', { title }))
      break

    case 'already-running':
      showToast(t('Video.yt-dlp.Already downloading', { title }))
      break

    case 'finished': {
      // Say what came down, so that a lower quality than hoped for is seen
      const quality = qualityText(outcome.download)
      showToast(
        quality
          ? t('Video.yt-dlp.Download finished with quality', { title, quality })
          : t('Video.yt-dlp.Download finished', { title }),
        LONG_TOAST_MS,
        // yt-dlp's or PeerTube's, by the key
        () => revealDownload(outcome.videoId)
      )
      break
    }

    case 'failed':
      showToast(
        outcome.reason
          ? t('Video.yt-dlp.Download failed', { title, reason: outcome.reason })
          : t('Video.yt-dlp.Download failed with exit code', { title, exitCode: outcome.exitCode ?? '?' }),
        LONG_TOAST_MS
      )
      break

    case 'not-found':
      showToast(t('Video.yt-dlp.yt-dlp could not be started'), LONG_TOAST_MS)
      break

    case 'tools-missing':
      if (outcome.installable) {
        // Letting it pass, or not clicking, leaves everything as it was
        showToast(
          t('Video.yt-dlp.Tools missing, click to install', { tools: formatToolList(outcome.missing) }),
          LONG_TOAST_MS,
          () => installThenDownload(outcome.videoId, outcome.title, outcome.quality, outcome.fresh)
        )
      } else {
        showToast(
          t('Video.yt-dlp.Tools missing', { tools: formatToolList(outcome.missing) }),
          LONG_TOAST_MS
        )
      }
      break

    case 'waiting-for-install':
      showToast(t('Video.yt-dlp.Waiting for install', { title }))
      break
  }
}

/**
 * @param {import('../../main/ytdlp/toolDetection').Tool[]} tools
 */
export function formatToolList(tools) {
  const names = tools.map(tool => TOOL_NAMES[tool])

  try {
    return new Intl.ListFormat(i18n.global.locale.value, { type: 'conjunction' }).format(names)
  } catch {
    return names.join(', ')
  }
}
