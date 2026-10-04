import { ipcRenderer, webFrame } from 'electron/renderer'
import { IpcChannels } from '../constants.js'

/**
 * Linux fix for dynamically updating theme preference, this works on
 * all systems running the electron app.
 */
ipcRenderer.on(IpcChannels.NATIVE_THEME_UPDATE, (_, shouldUseDarkColors) => {
  document.body.dataset.systemTheme = shouldUseDarkColors ? 'dark' : 'light'
})

// Force update the window title whenever the page title changes
// as Electron doesn't do it when the back button is pressed, probably a bug.
// It doesn't even fire the `page-title-updated` in the main process.

const titleMutationObserver = new MutationObserver((mutations) => {
  ipcRenderer.send(IpcChannels.SET_WINDOW_TITLE, mutations[0].addedNodes[0].textContent)
})
document.addEventListener('DOMContentLoaded', () => {
  titleMutationObserver.observe(document.querySelector('title'), { childList: true })
}, { once: true })

let currentUpdateSearchInputTextListener

export default {
  /**
   * @returns {Promise<string>}
   */
  getSystemLocale: () => {
    return ipcRenderer.invoke(IpcChannels.GET_SYSTEM_LOCALE)
  },

  /**
   * @returns {Promise<boolean>}
   */
  isWaylandPlatform: () => {
    return ipcRenderer.invoke(IpcChannels.IS_WAYLAND_PLATFORM)
  },

  /**
   * @param {string} path
   * @param {Record<string, string> | null | undefined} query
   * @param {string | null | undefined} searchQueryText
   */
  openInNewWindow: (path, query, searchQueryText) => {
    ipcRenderer.send(IpcChannels.CREATE_NEW_WINDOW, path, query, searchQueryText)
  },

  /**
   * @param {string} url
   */
  enableProxy: (url) => {
    ipcRenderer.send(IpcChannels.ENABLE_PROXY, url)
  },

  disableProxy: () => {
    ipcRenderer.send(IpcChannels.DISABLE_PROXY)
  },

  /**
   * @param {string} authorization
   * @param {string} url
   */
  setInvidiousAuthorization: (authorization, url) => {
    ipcRenderer.send(IpcChannels.SET_INVIDIOUS_AUTHORIZATION, authorization, url)
  },

  clearInvidiousAuthorization: () => {
    ipcRenderer.send(IpcChannels.SET_INVIDIOUS_AUTHORIZATION, null)
  },

  startPowerSaveBlocker: () => {
    ipcRenderer.send(IpcChannels.START_POWER_SAVE_BLOCKER)
  },

  stopPowerSaveBlocker: () => {
    ipcRenderer.send(IpcChannels.STOP_POWER_SAVE_BLOCKER)
  },

  /**
   * @returns {Promise<boolean>}
   */
  getReplaceHttpCache: () => {
    return ipcRenderer.invoke(IpcChannels.GET_REPLACE_HTTP_CACHE)
  },

  /**
   * @returns {Promise<boolean>}
   */
  getDisableHardwareAcceleration: () => {
    return ipcRenderer.invoke(IpcChannels.GET_DISABLE_HARDWARE_ACCELERATION)
  },

  toggleReplaceHttpCache: () => {
    ipcRenderer.send(IpcChannels.TOGGLE_REPLACE_HTTP_CACHE)
  },

  toggleDisableHardwareAcceleration: () => {
    ipcRenderer.send(IpcChannels.TOGGLE_DISABLE_HARDWARE_ACCELERATION)
  },

  // Allows programmatic toggling of picture-in-picture mode without accompanying user interaction.
  // See: https://developer.mozilla.org/en-US/docs/Web/Security/User_activation#transient_activation
  requestPiP: () => {
    webFrame.executeJavaScript('document.querySelector("video.player")?.ui.getControls().togglePiP()', true).catch()
  },

  // Allows programmatic toggling of fullscreen without accompanying user interaction.
  // See: https://developer.mozilla.org/en-US/docs/Web/Security/User_activation#transient_activation
  requestFullscreen: () => {
    webFrame.executeJavaScript('document.querySelector("video.player")?.ui.getControls().toggleFullScreen()', true).catch()
  },

  /**
   * @param {string} key
   * @returns {Promise<ArrayBuffer>}
   */
  playerCacheGet: (key) => {
    return ipcRenderer.invoke(IpcChannels.PLAYER_CACHE_GET, key)
  },

  /**
   * @param {string} key
   * @param {ArrayBuffer} value
   */
  playerCacheSet: async (key, value) => {
    await ipcRenderer.invoke(IpcChannels.PLAYER_CACHE_SET, key, value)
  },

  /**
   * @param {string} videoId
   * @param {string} context
   * @param {string} initialAttestationData
   * @param {string} ytConfig
   * @returns {Promise<string>}
   */
  generatePoToken: (videoId, context, initialAttestationData, ytConfig) => {
    return ipcRenderer.invoke(IpcChannels.GENERATE_PO_TOKEN, videoId, context, initialAttestationData, ytConfig)
  },

  chooseDefaultFolder: () => {
    ipcRenderer.send(IpcChannels.CHOOSE_DEFAULT_FOLDER)
  },

  /**
   * @param {string} filename
   * @param {ArrayBuffer} contents
   * @returns {Promise<boolean>}
   */
  writeToDefaultFolder: async (filename, contents) => {
    return await ipcRenderer.invoke(IpcChannels.WRITE_TO_DEFAULT_FOLDER, filename, contents)
  },

  relaunch: () => {
    ipcRenderer.send(IpcChannels.RELAUNCH_REQUEST)
  },

  // The window follows the cursor between these two; main tracks the cursor itself
  startWindowMove: () => {
    ipcRenderer.send(IpcChannels.WINDOW_MOVE_START)
  },

  endWindowMove: () => {
    ipcRenderer.send(IpcChannels.WINDOW_MOVE_END)
  },

  /**
   * Reshapes the window to the video's ratio until {@linkcode releaseWindowFit}
   * @param {number} videoWidth
   * @param {number} videoHeight
   */
  fitWindowToVideo: (videoWidth, videoHeight) => {
    ipcRenderer.send(IpcChannels.WINDOW_FIT_TO_VIDEO, videoWidth, videoHeight)
  },

  // Returns the window to its size from before the fit; a no-op if it is not fitted
  releaseWindowFit: () => {
    ipcRenderer.send(IpcChannels.WINDOW_RELEASE_FIT)
  },

  /**
   * @param {import('../main/externalPlayer').ExternalPlayerPayload} payload
   */
  openInExternalPlayer: (payload) => {
    // require the user to have interacted with the page recently
    if (navigator.userActivation.isActive) {
      ipcRenderer.send(IpcChannels.OPEN_IN_EXTERNAL_PLAYER, payload)
    }
  },

  /**
   * @param {(
   *   externalPlayer: string,
   *   unsuportedActions: (import('../constants').UnsupportedPlayerAction)[],
   *   isPlaylist: boolean
   * ) => void} handler
   */
  handleOpenInExternalPlayerResult: (handler) => {
    ipcRenderer.on(IpcChannels.OPEN_IN_EXTERNAL_PLAYER_RESULT,
      (event, externalPlayer, unsupportedActions, isPlaylist) => {
        handler(externalPlayer, unsupportedActions, isPlaylist)
      })
  },

  /**
   * @param {{ videoId: string, title: string, quality?: import('../main/ytdlp/downloadService').Quality, fresh?: boolean }} request
   */
  ytDlpDownload: (request) => {
    // require the user to have interacted with the page recently
    if (navigator.userActivation.isActive) {
      ipcRenderer.send(IpcChannels.YTDLP_DOWNLOAD, request)
    }
  },

  /**
   * @param {(outcome: import('../main/ytdlp/downloadService').DownloadOutcome & { toast: boolean }) => void} handler
   */
  handleYtDlpDownloadOutcome: (handler) => {
    ipcRenderer.on(IpcChannels.YTDLP_DOWNLOAD_OUTCOME, (_, outcome) => {
      handler(outcome)
    })
  },

  /**
   * @param {string} videoId
   */
  ytDlpReveal: (videoId) => {
    ipcRenderer.send(IpcChannels.YTDLP_REVEAL, videoId)
  },

  /**
   * @param {string} videoId
   */
  ytDlpCancel: (videoId) => {
    // require the user to have interacted with the page recently
    if (navigator.userActivation.isActive) {
      ipcRenderer.send(IpcChannels.YTDLP_CANCEL, videoId)
    }
  },

  /**
   * @returns {Promise<{ downloads: import('../main/ytdlp/downloadService').DownloadSnapshot[], finished: Record<string, string | null> }>}
   */
  ytDlpListDownloads: () => {
    return ipcRenderer.invoke(IpcChannels.YTDLP_LIST_DOWNLOADS)
  },

  /**
   * @param {string} videoId
   */
  ytDlpDismiss: (videoId) => {
    ipcRenderer.send(IpcChannels.YTDLP_DISMISS, videoId)
  },

  /**
   * Main saves the choice to the setting itself, the renderer may not
   * @returns {Promise<string | undefined>}
   */
  ytDlpChooseFolder: () => {
    return ipcRenderer.invoke(IpcChannels.YTDLP_CHOOSE_FOLDER)
  },

  /**
   * Main saves the choice to the setting itself, the renderer may not
   * @returns {Promise<string | undefined>}
   */
  ytDlpChooseExecutable: () => {
    return ipcRenderer.invoke(IpcChannels.YTDLP_CHOOSE_EXECUTABLE)
  },

  /**
   * @returns {Promise<{
   *   tools: import('../main/ytdlp/toolDetection').ToolStatuses,
   *   coverage: Record<import('../main/ytdlp/toolDetection').Tool, boolean>,
   *   installing: boolean,
   *   downloading: boolean
   * }>}
   */
  ytDlpDetectTools: () => {
    return ipcRenderer.invoke(IpcChannels.YTDLP_DETECT_TOOLS)
  },

  /**
   * @param {{ videoId: string, title: string, quality?: import('../main/ytdlp/downloadService').Quality, fresh?: boolean }} [thenDownload] what to download once the install succeeds
   * @returns {Promise<import('../main/ytdlp/toolInstaller').InstallResult | undefined>}
   */
  ytDlpInstallTools: (thenDownload) => {
    // require the user to have interacted with the page recently
    if (navigator.userActivation.isActive) {
      return ipcRenderer.invoke(IpcChannels.YTDLP_INSTALL_TOOLS, thenDownload ? { thenDownload } : {})
    }
    return Promise.resolve(undefined)
  },

  /**
   * @returns {Promise<import('../main/ytdlp/toolInstaller').UpdateResult | undefined>}
   */
  ytDlpUpdate: () => {
    // require the user to have interacted with the page recently
    if (navigator.userActivation.isActive) {
      return ipcRenderer.invoke(IpcChannels.YTDLP_UPDATE)
    }
    return Promise.resolve(undefined)
  },

  /**
   * @param {(progress: import('../main/ytdlp/toolInstaller').InstallProgress) => void} handler
   */
  handleYtDlpInstallProgress: (handler) => {
    ipcRenderer.on(IpcChannels.YTDLP_INSTALL_PROGRESS, (_, progress) => {
      handler(progress)
    })
  },

  /**
   * The fork's PeerTube downloads. Outcomes arrive through
   * handleYtDlpDownloadOutcome, keyed `peertube:<host>:<uuid>`.
   *
   * @param {{ key: string, url: string, title: string, label: string, resolution?: number | null, audioOnly?: boolean, videoUrl?: string | null }} request
   */
  peerTubeDownload: (request) => {
    // require the user to have interacted with the page recently
    if (navigator.userActivation.isActive) {
      ipcRenderer.send(IpcChannels.PEERTUBE_DOWNLOAD, request)
    }
  },

  /**
   * @param {string} key
   */
  peerTubeCancel: (key) => {
    // require the user to have interacted with the page recently
    if (navigator.userActivation.isActive) {
      ipcRenderer.send(IpcChannels.PEERTUBE_CANCEL, key)
    }
  },

  /**
   * @param {string} key
   */
  peerTubeReveal: (key) => {
    ipcRenderer.send(IpcChannels.PEERTUBE_REVEAL, key)
  },

  /**
   * @param {string} key
   */
  peerTubeDismiss: (key) => {
    ipcRenderer.send(IpcChannels.PEERTUBE_DISMISS, key)
  },

  /**
   * @returns {Promise<{ downloads: import('../main/ytdlp/downloadService').DownloadSnapshot[], finished: Record<string, string> }>}
   */
  peerTubeListDownloads: () => {
    return ipcRenderer.invoke(IpcChannels.PEERTUBE_LIST_DOWNLOADS)
  },

  /**
   * @param {number} factor
   */
  setZoomFactor: (factor) => {
    if (typeof factor === 'number' && factor > 0) {
      webFrame.setZoomFactor(factor)
    }
  },

  /**
   * @returns {Promise<{ label: string, value: number, active: boolean }[]>}
   */
  getNavigationHistory: () => {
    return ipcRenderer.invoke(IpcChannels.GET_NAVIGATION_HISTORY)
  },

  /**
   * @param {number} action
   * @param {any} [data]
   */
  dbSettings: (action, data) => {
    return ipcRenderer.invoke(IpcChannels.DB_SETTINGS, data ? { action, data } : { action })
  },

  /**
   * @param {number} action
   * @param {any} [data]
   */
  dbHistory: (action, data) => {
    return ipcRenderer.invoke(IpcChannels.DB_HISTORY, data ? { action, data } : { action })
  },

  /**
   * @param {number} action
   * @param {any} [data]
   */
  dbProfiles: (action, data) => {
    return ipcRenderer.invoke(IpcChannels.DB_PROFILES, data ? { action, data } : { action })
  },

  /**
   * @param {number} action
   * @param {any} [data]
   */
  dbPlaylists: (action, data) => {
    return ipcRenderer.invoke(IpcChannels.DB_PLAYLISTS, data ? { action, data } : { action })
  },

  /**
   * @param {number} action
   * @param {any} [data]
   */
  dbSearchHistory: (action, data) => {
    return ipcRenderer.invoke(IpcChannels.DB_SEARCH_HISTORY, data ? { action, data } : { action })
  },

  /**
   * @param {number} action
   * @param {any} [data]
   */
  dbSubscriptionCache: (action, data) => {
    return ipcRenderer.invoke(IpcChannels.DB_SUBSCRIPTION_CACHE, data ? { action, data } : { action })
  },

  /**
   * @param {number} action
   * @param {any} [data]
   */
  dbChannels: (action, data) => {
    return ipcRenderer.invoke(IpcChannels.DB_CHANNELS, data ? { action, data } : { action })
  },

  /**
   * @param {number} action
   * @param {any} [data]
   */
  dbAiVerdicts: (action, data) => {
    return ipcRenderer.invoke(IpcChannels.DB_AI_VERDICTS, data ? { action, data } : { action })
  },

  /**
   * @param {number} action
   * @param {any} [data]
   */
  dbLater: (action, data) => {
    return ipcRenderer.invoke(IpcChannels.DB_LATER, data ? { action, data } : { action })
  },

  /**
   * @param {(route: string) => void} handler
   */
  handleChangeView: (handler) => {
    ipcRenderer.on(IpcChannels.CHANGE_VIEW, (_, route) => {
      handler(route)
    })
  },

  /**
   * @param {(url: string) => void} handler
   */
  handleOpenUrl: (handler) => {
    ipcRenderer.on(IpcChannels.OPEN_URL, (_, url) => {
      handler(url)
    })
    ipcRenderer.send(IpcChannels.APP_READY)
  },

  /**
   * Pass `null` to clear the handler
   * @param {(text: string) => void | null} handler
   */
  handleUpdateSearchInputText: (handler) => {
    if (currentUpdateSearchInputTextListener) {
      ipcRenderer.off(IpcChannels.UPDATE_SEARCH_INPUT_TEXT, currentUpdateSearchInputTextListener)
      currentUpdateSearchInputTextListener = undefined
    }

    if (handler) {
      currentUpdateSearchInputTextListener = (_, text) => {
        handler(text)
      }

      ipcRenderer.on(IpcChannels.UPDATE_SEARCH_INPUT_TEXT, currentUpdateSearchInputTextListener)
      ipcRenderer.send(IpcChannels.SEARCH_INPUT_HANDLING_READY)
    }
  },

  /**
   * @param {(event: number, data: any) => void} handler
   */
  handleSyncSettings: (handler) => {
    ipcRenderer.on(IpcChannels.SYNC_SETTINGS, (_, { event, data }) => {
      handler(event, data)
    })
  },

  /**
   * @param {(event: number, data: any) => void} handler
   */
  handleSyncHistory: (handler) => {
    ipcRenderer.on(IpcChannels.SYNC_HISTORY, (_, { event, data }) => {
      handler(event, data)
    })
  },

  /**
   * @param {(event: number, data: any) => void} handler
   */
  handleSyncSearchHistory: (handler) => {
    ipcRenderer.on(IpcChannels.SYNC_SEARCH_HISTORY, (_, { event, data }) => {
      handler(event, data)
    })
  },

  /**
   * @param {(event: number, data: any) => void} handler
   */
  handleSyncProfiles: (handler) => {
    ipcRenderer.on(IpcChannels.SYNC_PROFILES, (_, { event, data }) => {
      handler(event, data)
    })
  },

  /**
   * @param {(event: number, data: any) => void} handler
   */
  handleSyncPlaylists: (handler) => {
    ipcRenderer.on(IpcChannels.SYNC_PLAYLISTS, (_, { event, data }) => {
      handler(event, data)
    })
  },

  /**
   * @param {(event: number, data: any) => void} handler
   */
  handleSyncSubscriptionCache: (handler) => {
    ipcRenderer.on(IpcChannels.SYNC_SUBSCRIPTION_CACHE, (_, { event, data }) => {
      handler(event, data)
    })
  },

  /**
   * @param {(event: number, data: any) => void} handler
   */
  handleSyncChannels: (handler) => {
    ipcRenderer.on(IpcChannels.SYNC_CHANNELS, (_, { event, data }) => {
      handler(event, data)
    })
  },

  /**
   * @param {(event: number, data: any) => void} handler
   */
  handleSyncLater: (handler) => {
    ipcRenderer.on(IpcChannels.SYNC_LATER, (_, { event, data }) => {
      handler(event, data)
    })
  },
}
