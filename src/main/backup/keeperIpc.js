import os from 'node:os'
// Without the node: prefix, as webpack recognises `new Worker(new URL(...))`
// only from 'worker_threads' by that name. Taken for the global Worker
// instead, it swaps in a constructor of its own that main's bundle never
// defines.
import { Worker } from 'worker_threads'

import { app, BrowserWindow, ipcMain } from 'electron'

import packageDetails from '../../../package.json'
import { IpcChannels, SyncEvents } from '../../constants'
import * as datastores from '../../datastores/index'
import { isFreeTubeUrl } from '../utils'
import { createKeeper, TICK_MS, watchDatastores } from './keeper'
import { runKeeperJob } from './keeperWorker'

/**
 * The keeper wired into main: the datastores watched for writes, the startup
 * check begun before the first window opens, a tick every minute on a timer
 * no window affects, and the IPC the Backup group and the notices use.
 */

/** @type {ReadonlySet<import('./keeper').KeeperAnswer>} */
const ANSWERS = new Set(['restore', 'overwrite', 'notNow', 'wait', 'continue', 'stopWaiting'])

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
 * @param {() => void} deps.relaunch
 * @param {Promise<string>} deps.installationId
 * @param {(webContents: import('electron').WebContents, currentPath: string | undefined, options: object) => Promise<string | undefined>} deps.chooseDefaultFolder main's folder dialog, which writes the setting it is given
 * @returns {{ quit: () => Promise<void> }} the last write, for the quit path
 */
export function registerKeeper({ relaunch, installationId, chooseDefaultFolder }) {
  const keeper = createKeeper({
    datastores,
    dataFolder: app.getPath('userData'),
    appVersion: packageDetails.version,
    installationId: () => installationId,
    machineName: os.hostname(),
    runJob: createWorkerRunner(),
    relaunch,
    onStatus: status => sendToAllWindows(IpcChannels.KEEPER_STATUS_CHANGED, status),
  })

  watchDatastores(datastores, () => keeper.markChanged())

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

  ipcMain.handle(IpcChannels.KEEPER_ANSWER, async (event, answer) => {
    if (!isFreeTubeUrl(event.senderFrame.url) || !ANSWERS.has(answer)) {
      return null
    }

    return await keeper.answer(answer)
  })

  return {
    quit: () => keeper.quit(),
  }
}
