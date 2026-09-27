import { app, ipcMain, net, shell } from 'electron'
import { rmSync } from 'node:fs'

import { IpcChannels } from '../../constants'
import { settings } from '../../datastores/handlers/base'
import { isFreeTubeUrl } from '../utils'
import { sendToAllFreeTube } from '../ytdlp/ipc'
import { nodeFileSystem } from '../ytdlp/nodeFileSystem'
import { createSettingsReader } from '../ytdlp/settings'
import { createPeerTubeDownloadService } from './downloadService'
import { createNetFetch } from './netFetch'
import { isValidDownloadKey, validateDownloadRequest } from './request'

export { isValidDownloadKey, validateDownloadRequest } from './request'

/**
 * The IPC surface of PeerTube downloads. The handlers are thin, like the
 * yt-dlp ones: check the sender, check the payload (`request.js`), call the
 * service, forward what it says.
 *
 * Outcomes go out on the yt-dlp outcome channel, since they have the same
 * shapes: every window's downloads panel and store follow them, and the
 * window that asked shows the toasts, with no second listener in the
 * renderer. Their keys (`peertube:…`) cannot be taken for a YouTube id.
 *
 * @param {object} deps
 * @param {string} deps.userAgent the prescribed PeerTube User-Agent
 * @param {ReturnType<typeof createPeerTubeDownloadService>} [deps.downloadService] for tests; made here when not given
 */
export function registerPeerTubeDownloadHandlers({ userAgent, downloadService: givenService }) {
  const readSetting = createSettingsReader(id => settings._findOne(id))

  const downloadService = givenService ?? createPeerTubeDownloadService({
    // On Electron's `net`, so that the file comes through FreeTube's proxy
    // on the default session. Not `net.fetch`, which cancels a redirect it
    // is asked not to follow instead of handing it back: see `netFetch.js`
    fetch: createNetFetch(net),
    fileSystem: nodeFileSystem,
    readSetting,
    defaultDownloadFolder: () => app.getPath('downloads'),
    userAgent,
  })

  ipcMain.on(IpcChannels.PEERTUBE_DOWNLOAD, async (event, payload) => {
    // Only from FreeTube, and only from the window the viewer is using: the
    // preload has already required a recent click
    if (!isFreeTubeUrl(event.senderFrame.url) || !event.sender.isFocused()) {
      return
    }

    const request = validateDownloadRequest(payload)
    if (request === null) {
      return
    }

    // The button is not there while PeerTube is off, so neither is this
    if ((await settings._findOne('enablePeerTube'))?.value !== true) {
      return
    }

    const sender = event.sender
    downloadService.start(request, (outcome) => {
      sendToAllFreeTube(sender, IpcChannels.YTDLP_DOWNLOAD_OUTCOME, outcome)
    }).catch((error) => {
      console.error('PeerTube download could not start', error)
    })
  })

  ipcMain.on(IpcChannels.PEERTUBE_CANCEL, (event, key) => {
    // The preload has required a recent click
    if (!isFreeTubeUrl(event.senderFrame.url) || !event.sender.isFocused() || !isValidDownloadKey(key)) {
      return
    }

    downloadService.cancel(key)
  })

  ipcMain.handle(IpcChannels.PEERTUBE_LIST_DOWNLOADS, (event) => {
    if (!isFreeTubeUrl(event.senderFrame.url)) {
      return
    }

    return downloadService.list()
  })

  ipcMain.on(IpcChannels.PEERTUBE_DISMISS, (event, key) => {
    if (!isFreeTubeUrl(event.senderFrame.url) || !isValidDownloadKey(key)) {
      return
    }

    downloadService.dismiss(key)
  })

  ipcMain.on(IpcChannels.PEERTUBE_REVEAL, async (event, key) => {
    if (!isFreeTubeUrl(event.senderFrame.url) || !isValidDownloadKey(key)) {
      return
    }

    const target = await downloadService.revealPath(key)

    if (target === null) {
      return
    }

    if ('file' in target) {
      shell.showItemInFolder(target.file)
    } else {
      // Moved or deleted since
      await shell.openPath(target.folder)
    }
  })

  app.on('will-quit', () => {
    // The service removes the partial files as the downloads stop, but the
    // app may be gone by then. On Windows a file still open cannot be
    // removed, so one may be left behind there.
    for (const partPath of downloadService.quit()) {
      try {
        rmSync(partPath, { force: true })
      } catch {}
    }
  })

  return { downloadService }
}
