import os from 'node:os'
// Without the node: prefix, as webpack recognises `new Worker(new URL(...))`
// only from 'worker_threads' by that name. Taken for the global Worker
// instead, it swaps in a constructor of its own that main's bundle never
// defines.
import { Worker } from 'worker_threads'

import { app, BrowserWindow, ipcMain } from 'electron'

import packageDetails from '../../../package.json'
import { IpcChannels, SyncEvents } from '../../constants'
import * as handlers from '../../datastores/handlers/base'
import * as datastores from '../../datastores/index'
import { isFreeTubeUrl } from '../utils'
import { watchIntents } from './intents'
import { createKeeper, TICK_MS, watchDatastores } from './keeper'
import { runKeeperJob } from './keeperWorker'

/**
 * The keeper wired into main: the datastores watched for writes, the handler
 * classes watched for intents, the startup check begun before the first
 * window opens, a tick every minute on a timer no window affects, and the IPC
 * the Backup group and the notices use.
 */

/**
 * The keeper's jobs in a worker thread, started on the first job and again
 * after one that died. A worker that cannot start at all (its script not
 * found, or not loadable from a packaged build) is not tried again: the jobs
 * run on main's thread instead, slower to the touch but kept.
 * @returns {(job: object) => Promise<any>}
 */
function createWorkerRunner() {
  /** @type {Worker | null} */
  let worker = null
  let broken = false
  let answered = false
  let nextId = 0
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
  const waiting = new Map()

  function failAll(error) {
    for (const { reject } of waiting.values()) {
      reject(error)
    }
    waiting.clear()
    worker = null
  }

  function start() {
    worker = new Worker(new URL('./keeperWorker.js', import.meta.url), { workerData: { fjernsynKeeper: true } })

    worker.on('message', ({ id, result, error }) => {
      answered = true
      const job = waiting.get(id)
      if (job === undefined) { return }

      waiting.delete(id)
      if (error === undefined) {
        job.resolve(result)
      } else {
        job.reject(new Error(error))
      }
    })

    worker.on('error', (error) => {
      if (!answered) {
        broken = true
        console.error('The keeper\'s worker could not start; its jobs run on the main thread', error)
      }
      failAll(error)
    })
    worker.on('exit', code => failAll(new Error(`The keeper's worker stopped (${code})`)))

    // The worker must never keep the app from quitting
    worker.unref()
  }

  const inWorker = job => new Promise((resolve, reject) => {
    if (worker === null) { start() }

    const id = nextId++
    waiting.set(id, { resolve, reject })
    worker.postMessage({ id, job })
  })

  return async (job) => {
    if (!broken) {
      try {
        return await inWorker(job)
      } catch (error) {
        if (!broken) { throw error }
      }
    }

    return runKeeperJob(job)
  }
}

/**
 * @param {string} channel
 * @param {any} payload
 */
function sendToAllWindows(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (isFreeTubeUrl(window.webContents.getURL())) {
      window.webContents.send(channel, payload)
    }
  }
}

/**
 * @param {object} deps
 * @param {Promise<string>} deps.installationId
 * @param {(webContents: import('electron').WebContents, currentPath: string | undefined, options: object) => Promise<string | undefined>} deps.chooseDefaultFolder main's folder dialog, which writes the setting it is given
 * @returns {{ quit: () => Promise<void> }} the last write, for the quit path
 */
export function registerKeeper({ installationId, chooseDefaultFolder }) {
  const keeper = createKeeper({
    datastores,
    dataFolder: app.getPath('userData'),
    appVersion: packageDetails.version,
    installationId: () => installationId,
    machineName: os.hostname(),
    hostName: os.hostname(),
    runJob: createWorkerRunner(),
    onStatus: status => sendToAllWindows(IpcChannels.KEEPER_STATUS_CHANGED, status),
    // Every window loads the merged sections again, as it loads them at startup
    onDataChanged: changes => sendToAllWindows(IpcChannels.KEEPER_DATA_CHANGED, changes),
    // A take in of Later in turn with the Later handler's writes, so that a
    // local write made while it runs is not written over by it
    inLaterQueue: handlers.inLaterQueue,
  })

  watchDatastores(datastores, () => keeper.markChanged())

  let firstLoadFinished = false

  // The first load seeds the default profile and the default playlists and
  // makes the `favorites` id fixup (`store/modules/playlists.js:310-333`).
  // None of them is an intent, so the seam records nothing until that load is
  // over, which the window says itself once it has loaded every section
  // (`App.vue`). There is no window to act in before then, so no real intent
  // falls inside the gate.
  ipcMain.on(IpcChannels.KEEPER_FIRST_LOAD_DONE, (event) => {
    if (isFreeTubeUrl(event.senderFrame.url)) {
      firstLoadFinished = true
    }
  })

  watchIntents(handlers, {
    read: (section, id) => id === undefined
      ? datastores[section].findAsync({})
      : datastores[section].findOneAsync({ _id: id }),
    onIntent: (intent) => {
      if (!firstLoadFinished) { return }

      keeper.recordEvent({ at: Date.now(), ...intent })
    },
  })

  keeper.start()

  const timer = setInterval(() => {
    keeper.tick().catch((error) => {
      console.error('The keeper tick failed', error)
    })
  }, TICK_MS)
  timer.unref()

  ipcMain.handle(IpcChannels.KEEPER_READY, async (event) => {
    if (!isFreeTubeUrl(event.senderFrame.url)) {
      return null
    }

    await keeper.whenReady()
    return true
  })

  ipcMain.handle(IpcChannels.KEEPER_STATUS, (event) => {
    if (!isFreeTubeUrl(event.senderFrame.url)) {
      return null
    }

    return keeper.status()
  })

  ipcMain.handle(IpcChannels.KEEPER_CHOOSE_FOLDER, async (event) => {
    if (!isFreeTubeUrl(event.senderFrame.url)) {
      return null
    }

    const current = (await datastores.settings.findOneAsync({ _id: 'backupFolder' }))?.value

    const chosen = await chooseDefaultFolder(event.sender, current, {
      settingId: 'backupFolder',
      defaultPathName: 'documents',
    })

    if (chosen === undefined) {
      return keeper.status()
    }

    return await keeper.folderChosen()
  })

  ipcMain.handle(IpcChannels.KEEPER_STOP, async (event) => {
    if (!isFreeTubeUrl(event.senderFrame.url)) {
      return null
    }

    const status = await keeper.stop()

    sendToAllWindows(IpcChannels.SYNC_SETTINGS, {
      event: SyncEvents.GENERAL.UPSERT,
      data: { _id: 'backupFolder', value: '' },
    })

    return status
  })

  return {
    quit: () => keeper.quit(),
  }
}
