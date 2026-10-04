import { app, ipcMain } from 'electron'

import { IpcChannels } from '../../constants'
import * as datastores from '../../datastores/index'
import { isFreeTubeUrl } from '../utils'
import { backupsFolder, ensureInstallationId, restoreBackup } from './restore'

/**
 * The IPC surface of the backup: where the safety copies go, for the
 * confirmation to say, and the restore itself. Also makes this data folder's
 * installation id, if it has none yet, for the backups' header.
 *
 * @param {object} deps
 * @param {() => void} deps.relaunch main's relaunch, the one the experimental settings use
 */
export function registerBackupHandlers({ relaunch }) {
  const dataFolder = app.getPath('userData')

  ensureInstallationId(datastores.settings).catch((error) => {
    console.error('Could not make the installation id', error)
  })

  ipcMain.handle(IpcChannels.BACKUP_FOLDER, (event) => {
    if (!isFreeTubeUrl(event.senderFrame.url)) {
      return null
    }

    return backupsFolder(dataFolder)
  })

  // Once a restore has started, another is refused until it fails or the
  // app relaunches
  let restoring = false

  ipcMain.handle(IpcChannels.BACKUP_RESTORE, async (event, request) => {
    if (!isFreeTubeUrl(event.senderFrame.url)) {
      return null
    }

    if (restoring) {
      return { ok: false, error: 'A restore is already running', safetyCopyPath: null }
    }

    restoring = true

    let result
    try {
      result = await restoreBackup({ datastores, dataFolder, relaunch }, request)
    } catch (error) {
      // restoreBackup answers every failure it knows of; this is one it does not
      result = { ok: false, error: String(error), safetyCopyPath: null }
    }

    if (!result.ok) {
      console.error('The restore failed', result.error)
      restoring = false
    }

    return result
  })
}
