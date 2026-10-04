// Imported for its side effect, and first, by the main entry: everything
// imported after it may compute paths under the data folder as it is
// evaluated (the datastores module does), so the folder has to be settled,
// and the data copied in, before any of them runs.

import path from 'node:path'

import { app } from 'electron'

import packageDetails from '../../../package.json'
import { nodeFileSystem } from './nodeFileSystem'
import { migrateUserData } from './userDataMigration'

const isDevelopment = process.env.NODE_ENV === 'development'

if (isDevelopment) {
  // A development run is started as `electron dist/main.js`, which never
  // reads the package manifest, so Electron would name the app, and its data
  // folder, "Electron". Pin it to the real name, so development uses the same
  // folder and the same migration a user gets.
  app.setPath('userData', path.join(app.getPath('appData'), packageDetails.productName))

  // A development run on another data folder, such as a copy of the real
  // one to test something that changes it: `FT_USER_DATA=<folder> pnpm dev`
  if (process.env.FT_USER_DATA) {
    app.setPath('userData', path.resolve(process.env.FT_USER_DATA))
  }
}

// These print and exit, and a first launch's copy has no business happening
// behind them
const onlyPrinting = ['--version', '--help', '-h'].some(flag => process.argv.includes(flag))

if (!onlyPrinting) {
  migrate()
}

function migrate() {
  const userDataPath = app.getPath('userData')

  // Where this app kept its data before it was Fjernsyn: under FreeTube in a
  // packaged build, and under Electron in a development run
  const sources = isDevelopment ? ['Electron', 'FreeTube'] : ['FreeTube']

  // The migration runs before anything asynchronous can, so a launch that has
  // to wait for another one's migration waits by blocking
  const pause = new Int32Array(new SharedArrayBuffer(4))

  const result = migrateUserData({
    root: path.dirname(userDataPath),
    sources,
    target: path.basename(userDataPath),
    fs: nodeFileSystem,
    pid: process.pid,
    isAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        // EPERM: it runs, as someone else
        return error.code === 'EPERM'
      }
    },
    now: () => Date.now(),
    sleep: (ms) => {
      Atomics.wait(pause, 0, 0, ms)
    },
  })

  switch (result.outcome) {
    case 'copied':
      console.log(`Copied the data from ${result.from} into ${userDataPath}; the ${result.from} folder is untouched`) // eslint-disable-line no-console
      if (result.linksCopiedAsFiles.length > 0) {
        console.warn(`The system would not let these be copied as symlinks, so they are copies of what the links point at, and no longer shared with it: ${result.linksCopiedAsFiles.join(', ')}`)
      }
      break
    case 'failed':
      console.error(`Could not copy the data from ${result.from ?? 'the earlier folder'} into ${userDataPath}; that folder is untouched, and the next launch tries again`, result.error)
      break
    case 'skipped-no-source':
      console.log(`No earlier data to copy into ${userDataPath}`) // eslint-disable-line no-console
      break
    // 'skipped-target-has-data' is every launch after the first, and says nothing worth logging
  }
}
