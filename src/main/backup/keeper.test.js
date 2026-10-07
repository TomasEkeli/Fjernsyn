import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

import Datastore from '@seald-io/nedb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeBackup } from '../../renderer/helpers/backup'
import { baseFileName, isBaseFileName, SYNC_FILE_NAME, writeSyncFile } from '../../renderer/helpers/keptBackup'
import { createKeeper, LOG_CAP_BYTES, LOOK_AGAIN_MS, RETRY_MS, watchDatastores } from './keeper'
import { runKeeperJob } from './keeperWorker'

// Keepers on temporary folders, with real datastores and files, and the
// worker's jobs run inline. The clock is the real one, as file ages are
// measured against the files' modified times.

const DATASTORE_FILES = {
  settings: 'settings',
  profiles: 'profiles',
  playlists: 'playlists',
  history: 'history',
  searchHistory: 'search-history',
  channels: 'channels',
  aiVerdicts: 'ai-verdicts',
  later: 'later',
}

const MAIN_PROFILE = { _id: 'allChannels', name: 'All Channels', bgColor: '#000000', textColor: '#FFFFFF', subscriptions: [] }

const DAY_MS = 24 * 60 * 60_000

let root

/** Every keeper made in a test, so that its log is written before the folder goes */
let keepers

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'fjernsyn-keeper-'))
  keepers = []
})

afterEach(async () => {
  await Promise.all(keepers.map(keeper => keeper.flushLog()))
  rmSync(root, { recursive: true, force: true })
})

function historyEntry(videoId, timeWatched) {
  return {
    videoId,
    title: `Video ${videoId}`,
    author: 'Synthetic Channel',
    authorId: 'UCsynthetic',
    published: 1700000000000,
    description: 'A synthetic description',
    viewCount: 10,
    lengthSeconds: 60,
    watchProgress: 30,
    timeWatched,
    isLive: false,
    type: 'video',
  }
}

/** The second's wait between reads of an unreadable file passes at once; every other wait never ends */
function untimed(ms) {
  return ms === RETRY_MS ? Promise.resolve() : new Promise(() => {})
}

/**
 * A machine: its own data folder and datastores, on the shared backup folder
 * @param {string} name
 * @param {object} [options]
 * @param {string | null} [options.folder] the backup folder setting; null for none
 * @param {object[]} [options.settings] more settings in its datastore
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {object} [options.fileSystem]
 */
async function machine(name, { folder = keptFolder(), settings = [], ...options } = {}) {
  const dataFolder = path.join(root, name)
  const datastores = {}

  for (const [section, file] of Object.entries(DATASTORE_FILES)) {
    datastores[section] = new Datastore({ filename: path.join(dataFolder, `${file}.db`) })
    await datastores[section].loadDatabaseAsync()
  }

  await datastores.profiles.insertAsync(MAIN_PROFILE)
  if (folder !== null) {
    await datastores.settings.insertAsync({ _id: 'backupFolder', value: folder })
  }
  if (settings.length > 0) {
    await datastores.settings.insertAsync(settings)
  }

  const m = { datastores, dataFolder, jobs: [], relaunch: vi.fn(), keeper: null }

  /** A new keeper on the same data, as after a restart of the app */
  m.restart = ({ sleep = untimed, fileSystem } = {}) => {
    m.keeper = createKeeper({
      datastores,
      dataFolder,
      appVersion: '0.1.0',
      installationId: `installation-${name}`,
      machineName: `MACHINE-${name}`,
      runJob: async (job) => {
        m.jobs.push(job.type)
        return runKeeperJob(job)
      },
      relaunch: m.relaunch,
      sleep,
      ...(fileSystem ? { fileSystem } : {}),
    })
    keepers.push(m.keeper)
    return m.keeper
  }

  m.restart(options)
  watchDatastores(datastores, () => m.keeper.markChanged())

  return m
}

const keptFolder = () => path.join(root, 'kept')
const kept = name => path.join(keptFolder(), name)
const readSyncText = () => readFileSync(kept(SYNC_FILE_NAME), 'utf8')
const syncDoc = () => JSON.parse(readSyncText())
const bases = () => readdirSync(keptFolder()).filter(isBaseFileName).sort()
const hashOf = text => createHash('sha256').update(text).digest('hex')
const stateOf = m => JSON.parse(readFileSync(path.join(m.dataFolder, 'backups', 'keeper-state.json'), 'utf8'))
const safetyCopies = m => readdirSync(path.join(m.dataFolder, 'backups')).filter(name => name.startsWith('before-restore-'))

async function logOf(m) {
  await m.keeper.flushLog()
  return readFileSync(path.join(m.dataFolder, 'backups', 'keeper.log'), 'utf8')
}

async function videoIds(m) {
  return (await m.datastores.history.findAsync({})).map(entry => entry.videoId).sort()
}

async function settingsOf(m) {
  return Object.fromEntries((await m.datastores.settings.findAsync({})).map(({ _id, value }) => [_id, value]))
}

/** Whether a promise has settled once the queue has run */
async function isSettled(promise) {
  let settled = false
  promise.then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  return settled
}

function ageFile(file, ms) {
  const time = (Date.now() - ms) / 1000
  utimesSync(file, time, time)
}

// #region another machine's files, written by hand

const HEADER_Z = { appVersion: '0.1.0', installationId: 'installation-z', machineName: 'MACHINE-z' }

const Z_SECTIONS = {
  profiles: [MAIN_PROFILE],
  history: [{ _id: 'h1', ...historyEntry('zzzzzzzzzz1', 1) }],
}

const Z_CHANGE = { history: { put: [{ _id: 'h2', ...historyEntry('zzzzzzzzzz2', 2) }], remove: [] } }

/** A base, gzipped, in a folder; the backup folder unless said */
function writeBase(sections, folder = keptFolder()) {
  const text = writeBackup({ ...HEADER_Z, sections })
  const sha256 = hashOf(text)
  const file = baseFileName(sha256)
  writeFileSync(path.join(folder, file), gzipSync(text))
  return { file, sha256 }
}

/** @returns {string} the sync file's hash */
function writeSync(base, changes = {}) {
  const text = writeSyncFile({ ...HEADER_Z, base, changes })
  writeFileSync(kept(SYNC_FILE_NAME), text)
  return hashOf(text)
}

// #endregion another machine's files

describe('the keeper', () => {
  it('writes a base and a sync file, and another machine takes them in at startup', async () => {
    mkdirSync(keptFolder())

    const a = await machine('a')
    await a.datastores.history.insertAsync(historyEntry('aaaaaaaaaaa', 1))
    await a.keeper.start()
    await a.keeper.tick()

    const names = readdirSync(keptFolder()).sort()
    expect(names).toHaveLength(2)
    expect(names[0]).toMatch(/^base-[\da-f]{16}\.json\.gz$/)
    expect(names[1]).toBe('fjernsyn-sync.json')
    expect(a.keeper.status().writtenAt).not.toBeNull()

    const b = await machine('b')
    await b.keeper.start()
    await b.keeper.whenReady()

    expect(await videoIds(b)).toEqual(['aaaaaaaaaaa'])
    expect(b.keeper.status().tookIn).toMatchObject({ machineName: 'MACHINE-a' })
    expect(safetyCopies(b)).toHaveLength(1)

    // b's change is written against a's base, and a, still running, pauses
    await b.datastores.history.insertAsync(historyEntry('bbbbbbbbbbb', 2))
    await b.keeper.tick()

    const sync = syncDoc()
    expect(sync.machineName).toBe('MACHINE-b')
    expect(sync.changes.history.put.map(entry => entry.videoId)).toEqual(['bbbbbbbbbbb'])

    await a.datastores.history.insertAsync(historyEntry('ccccccccccc', 3))
    await a.keeper.tick()

    expect(a.keeper.status().pause).toMatchObject({ reason: 'otherMachine', machineName: 'MACHINE-b' })
    expect(await logOf(a)).toMatch(/paused: otherMachine/)
  })

  describe('at startup', () => {
    it('does nothing and is ready at once when no folder is set', async () => {
      const a = await machine('a', { folder: null })
      await a.keeper.start()

      expect(a.keeper.status()).toMatchObject({ ready: true, folder: null, pause: null })
      expect(await isSettled(a.keeper.whenReady())).toBe(true)
      expect(a.jobs).toEqual([])
    })

    it('is ready with no sync file, and the first tick writes a base and a sync file pointing to it', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()

      expect(a.keeper.status()).toMatchObject({ ready: true, folder: keptFolder() })
      expect(readdirSync(keptFolder())).toEqual([])

      await a.keeper.tick()

      expect(bases()).toHaveLength(1)
      expect(syncDoc()).toMatchObject({ machineName: 'MACHINE-a', base: { file: bases()[0] }, changes: {} })
    })

    it('takes nothing in when the sync file is last seen', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()
      await a.keeper.tick()

      a.restart()
      await a.keeper.start()

      expect(a.keeper.status()).toMatchObject({ ready: true, pause: null, tookIn: null, writtenAt: expect.any(Number) })
      expect(a.jobs).not.toContain('prepareTakeIn')
      expect(safetyCopies(a)).toEqual([])
    })

    it('makes a pending sync file last seen, without pausing', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()
      await a.keeper.tick()

      // A crash between the rename and saving last seen
      const hash = hashOf(readSyncText())
      const statePath = path.join(a.dataFolder, 'backups', 'keeper-state.json')
      writeFileSync(statePath, JSON.stringify({ ...stateOf(a), lastSeen: null, pending: hash }))

      a.restart()
      await a.keeper.start()

      expect(a.keeper.status()).toMatchObject({ ready: true, pause: null })
      expect(stateOf(a)).toMatchObject({ lastSeen: hash, pending: null })

      await a.datastores.history.insertAsync(historyEntry('aaaaaaaaaaa', 1))
      await a.keeper.tick()

      expect(a.keeper.status().pause).toBeNull()
      expect(hashOf(readSyncText())).not.toBe(hash)
    })

    it('takes nothing in from another machine whose content is the same, and makes its sync file last seen', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()
      await a.keeper.tick()
      const text = readSyncText()

      const b = await machine('b')
      await b.keeper.start()

      expect(b.keeper.status()).toMatchObject({ ready: true, pause: null, tookIn: null })
      expect(stateOf(b).lastSeen).toBe(hashOf(text))
      expect(safetyCopies(b)).toEqual([])

      // and has nothing to write either
      await b.keeper.tick()
      expect(readSyncText()).toBe(text)
    })

    it('takes in another machine\'s different content with a safety copy, keeping unknown settings and never writing machine-bound ones', async () => {
      mkdirSync(keptFolder())
      const base = writeBase({
        ...Z_SECTIONS,
        settings: [
          { _id: 'maxVolume', value: 500 },
          { _id: 'aSettingFromTheFuture', value: 42 },
          { _id: 'proxyHostname', value: '10.9.9.9' },
          { _id: 'proxyPort', value: '9999' },
          { _id: 'backupFolder', value: '/somewhere/else' },
          { _id: 'bounds', value: { x: 0, y: 0, width: 1, height: 1 } },
        ],
      })
      const syncHash = writeSync(base, Z_CHANGE)

      const bounds = { x: 1, y: 2, width: 800, height: 600 }
      const b = await machine('b', { settings: [{ _id: 'proxyHostname', value: '10.0.0.1' }, { _id: 'bounds', value: bounds }] })
      await b.datastores.history.insertAsync(historyEntry('bbbbbbbbbbb', 3))
      await b.keeper.start()

      expect(b.keeper.status()).toMatchObject({
        ready: true,
        pause: null,
        tookIn: { key: syncHash, machineName: 'MACHINE-z', writtenAt: expect.any(Number) },
      })
      expect(await videoIds(b)).toEqual(['zzzzzzzzzz1', 'zzzzzzzzzz2'])

      const settings = await settingsOf(b)
      expect(settings).toMatchObject({ maxVolume: 500, aSettingFromTheFuture: 42, proxyHostname: '10.0.0.1', backupFolder: keptFolder(), bounds })
      expect(settings).not.toHaveProperty('proxyPort')

      const copies = safetyCopies(b)
      expect(copies).toHaveLength(1)
      expect(readFileSync(path.join(b.dataFolder, 'backups', copies[0]), 'utf8')).toContain('bbbbbbbbbbb')

      expect(stateOf(b).lastSeen).toBe(syncHash)
      expect(b.relaunch).not.toHaveBeenCalled()
    })

    it('refuses a sync file that is not JSON after reading it twice more, a second apart, and is ready, paused', async () => {
      mkdirSync(keptFolder())
      writeFileSync(kept(SYNC_FILE_NAME), '{ "format": "fjernsyn-sync", ')

      const sleeps = []
      const b = await machine('b', { sleep: async (ms) => { sleeps.push(ms) } })
      await b.keeper.start()

      expect(b.keeper.status()).toMatchObject({ ready: true, pause: { reason: 'refused', detail: 'notJson' } })
      expect(sleeps).toEqual([RETRY_MS, RETRY_MS])
      expect(await videoIds(b)).toEqual([])
    })

    it('refuses a base that does not match the hash its sync file gives', async () => {
      mkdirSync(keptFolder())
      const text = writeBackup({ ...HEADER_Z, sections: Z_SECTIONS })
      const sha256 = hashOf(text)
      const file = baseFileName(sha256)
      writeFileSync(kept(file), gzipSync(text.replace('zzzzzzzzzz1', 'tampered000')))
      writeSync({ file, sha256 })

      const b = await machine('b')
      await b.keeper.start()

      expect(b.keeper.status()).toMatchObject({ ready: true, pause: { reason: 'refused', detail: 'baseMismatch', machineName: 'MACHINE-z' } })
      expect(await videoIds(b)).toEqual([])
    })

    it('leaves a sync file of a newer format version alone, and is ready, paused', async () => {
      mkdirSync(keptFolder())
      writeFileSync(kept(SYNC_FILE_NAME), JSON.stringify({ format: 'fjernsyn-sync', formatVersion: 2 }))

      const b = await machine('b')
      await b.keeper.start()

      expect(b.keeper.status()).toMatchObject({ ready: true, pause: { reason: 'newer', formatVersion: 2 } })
    })

    it('says another machine\'s sync file is still arriving when its base is not here, and is not ready', async () => {
      const { b } = await baseOnItsWay()

      expect(b.keeper.status()).toMatchObject({
        ready: false,
        pause: null,
        arriving: { machineName: 'MACHINE-z', writtenAt: expect.any(Number), waitingSince: null },
      })
      expect(await isSettled(b.keeper.whenReady())).toBe(false)
    })
  })

  describe('waiting for the base', () => {
    it('looks again while waiting, and takes in once the base arrives, then is ready', async () => {
      const { b, looks, arrive } = await baseOnItsWay()

      const status = await b.keeper.answer('wait')
      expect(status.arriving.waitingSince).toEqual(expect.any(Number))

      await looks.wake()
      await looks.asleep()
      expect(b.keeper.status().ready).toBe(false)

      arrive()
      await looks.wake()
      await b.keeper.whenReady()

      expect(b.keeper.status()).toMatchObject({ ready: true, arriving: null, pause: null, tookIn: { machineName: 'MACHINE-z' } })
      expect(await videoIds(b)).toEqual(['zzzzzzzzzz1'])
    })

    it('is ready and paused when Tomas stops waiting', async () => {
      const { b, looks } = await baseOnItsWay()
      await b.keeper.answer('wait')

      const status = await b.keeper.answer('stopWaiting')

      expect(status).toMatchObject({ ready: true, arriving: null, pause: { reason: 'baseMissing', machineName: 'MACHINE-z' } })
      expect(await isSettled(b.keeper.whenReady())).toBe(true)

      await looks.wake()
      await b.keeper.tick()
      expect(await videoIds(b)).toEqual([])
    })

    it('after Continue, turns the pause into the question of another machine once the base arrives, writing nothing', async () => {
      const { b, arrive } = await baseOnItsWay()
      const before = readSyncText()

      const status = await b.keeper.answer('continue')
      expect(status).toMatchObject({ ready: true, arriving: null, pause: { reason: 'baseMissing' } })

      await b.keeper.tick()
      expect(b.keeper.status().pause.reason).toBe('baseMissing')

      arrive()
      await b.keeper.tick()

      expect(b.keeper.status().pause).toMatchObject({ reason: 'otherMachine', machineName: 'MACHINE-z' })
      expect(readSyncText()).toBe(before)
      expect(await videoIds(b)).toEqual([])
    })

    it('reads a newer sync file that arrives while waiting afresh, and takes that one in', async () => {
      const { b, base, looks, arrive } = await baseOnItsWay()
      await b.keeper.answer('wait')

      const newer = writeSync(base, Z_CHANGE)
      await looks.wake()
      await looks.asleep()
      expect(await logOf(b)).toContain(`a newer sync file ${newer.slice(0, 12)} arrived while waiting`)

      arrive()
      await looks.wake()
      await b.keeper.whenReady()

      expect(b.keeper.status().tookIn.key).toBe(newer)
      expect(await videoIds(b)).toEqual(['zzzzzzzzzz1', 'zzzzzzzzzz2'])
    })
  })

  describe('the tick', () => {
    it('builds nothing while the flag is down, which writes to the datastores raise and reads do not', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.datastores.history.insertAsync({ _id: 'h1', ...historyEntry('aaaaaaaaaaa', 1) })
      await a.keeper.start()
      await a.keeper.tick()
      expect(a.keeper.hasChanged()).toBe(false)

      await a.datastores.history.findAsync({})
      await a.datastores.settings.findOneAsync({ _id: 'maxVolume' })
      await a.datastores.later.countAsync({})
      expect(a.keeper.hasChanged()).toBe(false)

      const jobs = a.jobs.length
      const text = readSyncText()
      await a.keeper.tick()
      expect(a.jobs).toHaveLength(jobs)
      expect(readSyncText()).toBe(text)

      for (const write of [
        () => a.datastores.history.insertAsync(historyEntry('bbbbbbbbbbb', 2)),
        () => a.datastores.history.updateAsync({ _id: 'h1' }, { $set: { watchProgress: 45 } }),
        () => a.datastores.history.removeAsync({ _id: 'h1' }, {}),
      ]) {
        await write()
        expect(a.keeper.hasChanged()).toBe(true)
        await a.keeper.tick()
        expect(a.keeper.hasChanged()).toBe(false)
      }

      expect(syncDoc().changes.history).toEqual({ put: [expect.objectContaining({ videoId: 'bbbbbbbbbbb' })], remove: ['h1'] })
    })

    it('writes nothing when the content is the same as last written', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()
      await a.keeper.tick()
      const text = readSyncText()

      const added = await a.datastores.history.insertAsync(historyEntry('aaaaaaaaaaa', 1))
      await a.datastores.history.removeAsync({ _id: added._id }, {})
      await a.keeper.tick()

      expect(a.jobs.at(-1)).toBe('build')
      expect(readSyncText()).toBe(text)
      expect(a.keeper.hasChanged()).toBe(false)
      expect(await logOf(a)).toMatch(/content unchanged/)
    })

    it('rebases past the threshold: the new base before the sync file, the old base removed only after', async () => {
      const calls = []
      const fileSystem = {
        ...fs,
        rename: async (from, to) => {
          calls.push(`rename ${path.basename(to)}`)
          return fs.rename(from, to)
        },
        rm: async (target, options) => {
          calls.push(`rm ${path.basename(target)}`)
          return fs.rm(target, options)
        },
      }

      mkdirSync(keptFolder())
      const a = await machine('a', { fileSystem })
      await a.keeper.start()
      await a.keeper.tick()
      const [oldBase] = bases()
      calls.length = 0

      const long = 'x'.repeat(800_000)
      for (const videoId of ['long0000001', 'long0000002', 'long0000003']) {
        await a.datastores.history.insertAsync({ ...historyEntry(videoId, 1), description: long })
      }
      await a.keeper.tick()

      const sync = syncDoc()
      const newBase = sync.base.file
      expect(newBase).not.toBe(oldBase)
      expect(sync.changes).toEqual({})
      expect(bases()).toEqual([newBase])

      const steps = [`rename ${newBase}`, `rename ${SYNC_FILE_NAME}`, `rm ${oldBase}`]
      expect(calls.filter(call => steps.includes(call))).toEqual(steps)

      const baseText = gunzipSync(readFileSync(kept(newBase))).toString('utf8')
      expect(hashOf(baseText)).toBe(sync.base.sha256)
      expect(JSON.parse(baseText).sections.history).toHaveLength(3)
    })

    it('removes a base nothing points to only when it is more than seven days old', async () => {
      mkdirSync(keptFolder())
      const young = 'base-1111111111111111.json.gz'
      const old = 'base-2222222222222222.json.gz'
      writeFileSync(kept(young), 'synthetic')
      writeFileSync(kept(old), 'synthetic')
      ageFile(kept(young), 6 * DAY_MS)
      ageFile(kept(old), 8 * DAY_MS)

      const a = await machine('a')
      await a.keeper.start()
      await a.keeper.tick()

      expect(bases()).toEqual([syncDoc().base.file, young].sort())
    })

    it('removes its own leftover temporary files at start, and another\'s only once they are a day old', async () => {
      mkdirSync(keptFolder())
      const own = '.fjernsyn-tmp-installation-a-0000000000000000'
      const fresh = '.fjernsyn-tmp-installation-z-1111111111111111'
      const stale = '.fjernsyn-tmp-installation-z-2222222222222222'
      for (const name of [own, fresh, stale]) {
        writeFileSync(kept(name), 'synthetic')
      }
      ageFile(kept(stale), DAY_MS + 60_000)

      const a = await machine('a')
      await a.keeper.start()

      expect(readdirSync(keptFolder())).toEqual([fresh])
    })

    it('says why it could not write and since when, tries again each tick, and clears it once it writes', async () => {
      // The folder is not there
      const a = await machine('a')
      await a.keeper.start()
      expect(a.keeper.status().ready).toBe(true)

      await a.keeper.tick()
      const { failure } = a.keeper.status()
      expect(failure).toEqual({ message: expect.stringContaining('ENOENT'), since: expect.any(Number) })

      await a.keeper.tick()
      expect(a.keeper.status().failure).toEqual(failure)

      mkdirSync(keptFolder())
      await a.keeper.tick()

      expect(a.keeper.status()).toMatchObject({ failure: null, writtenAt: expect.any(Number) })
      expect(existsSync(kept(SYNC_FILE_NAME))).toBe(true)
      expect(await logOf(a)).toMatch(/couldn't write: ENOENT/)
    })
  })

  describe('leaving a pause', () => {
    /** a and b on one folder: b took in a's backup and wrote since, and a, changed, has paused */
    async function pausedPair() {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.datastores.history.insertAsync(historyEntry('aaaaaaaaaaa', 1))
      await a.keeper.start()
      await a.keeper.tick()

      const b = await machine('b')
      await b.keeper.start()
      await b.datastores.history.insertAsync(historyEntry('bbbbbbbbbbb', 2))
      await b.keeper.tick()

      await a.datastores.history.insertAsync(historyEntry('ccccccccccc', 3))
      await a.keeper.tick()
      expect(a.keeper.status().pause).toMatchObject({ reason: 'otherMachine', machineName: 'MACHINE-b' })

      return { a, b }
    }

    it('Overwrite writes this machine\'s state at once and resumes', async () => {
      const { a } = await pausedPair()

      const status = await a.keeper.answer('overwrite')

      expect(status).toMatchObject({ pause: null, writtenAt: expect.any(Number) })
      const sync = syncDoc()
      expect(sync.machineName).toBe('MACHINE-a')
      expect(sync.changes.history.put.map(entry => entry.videoId)).toEqual(['ccccccccccc'])

      await a.datastores.history.insertAsync(historyEntry('ddddddddddd', 4))
      await a.keeper.tick()
      expect(a.keeper.status().pause).toBeNull()
      expect(syncDoc().changes.history.put).toHaveLength(2)
    })

    it('Overwrite rebases when the base is not in the folder', async () => {
      const { a } = await pausedPair()
      const [base] = bases()
      rmSync(kept(base))

      await a.keeper.answer('overwrite')

      const sync = syncDoc()
      expect(sync.base.file).not.toBe(base)
      expect(sync.changes).toEqual({})
      expect(bases()).toEqual([sync.base.file])
    })

    it('Restore takes in what is there and relaunches once, writing nothing after', async () => {
      const { a } = await pausedPair()
      const text = readSyncText()

      await a.keeper.answer('restore')

      expect(a.relaunch).toHaveBeenCalledTimes(1)
      expect(await videoIds(a)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb'])
      expect(safetyCopies(a)).toHaveLength(1)

      await a.datastores.history.insertAsync(historyEntry('eeeeeeeeeee', 5))
      await a.keeper.tick()
      await a.keeper.quit()

      expect(readSyncText()).toBe(text)
      expect(a.relaunch).toHaveBeenCalledTimes(1)
    })

    it('Not now stays paused, and while paused neither the tick nor the quit writes', async () => {
      const { a } = await pausedPair()
      const text = readSyncText()

      const status = await a.keeper.answer('notNow')
      expect(status.pause.reason).toBe('otherMachine')

      await a.datastores.history.insertAsync(historyEntry('eeeeeeeeeee', 5))
      await a.keeper.tick()
      await a.keeper.quit()

      expect(readSyncText()).toBe(text)
      expect(a.keeper.status().pause.reason).toBe('otherMachine')
      expect(await logOf(a)).toMatch(/quit: no write \(paused\)/)
    })
  })

  describe('choosing a folder', () => {
    async function choose(m, folder) {
      await m.datastores.settings.updateAsync({ _id: 'backupFolder' }, { _id: 'backupFolder', value: folder }, { upsert: true })
      return m.keeper.folderChosen()
    }

    it('writes at once to an empty folder', async () => {
      const c = await machine('c', { folder: null })
      await c.keeper.start()
      mkdirSync(keptFolder())

      const status = await choose(c, keptFolder())

      expect(status).toMatchObject({ folder: keptFolder(), pause: null, writtenAt: expect.any(Number) })
      expect(bases()).toHaveLength(1)
      expect(syncDoc().machineName).toBe('MACHINE-c')
    })

    it('asks when the folder holds another machine\'s kept backup, writing and taking in nothing', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.datastores.history.insertAsync(historyEntry('aaaaaaaaaaa', 1))
      await a.keeper.start()
      await a.keeper.tick()
      const text = readSyncText()

      const c = await machine('c', { folder: null })
      await c.keeper.start()
      const status = await choose(c, keptFolder())

      expect(status.pause).toMatchObject({ reason: 'otherMachine', machineName: 'MACHINE-a' })
      expect(readSyncText()).toBe(text)
      expect(await videoIds(c)).toEqual([])
    })

    it('Stop keeping clears the setting and leaves the files; choosing the folder again writes over its own backup', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()
      await a.keeper.tick()
      const files = readdirSync(keptFolder()).sort()

      const stopped = await a.keeper.stop()

      expect(stopped).toMatchObject({ folder: null, pause: null, writtenAt: null })
      expect((await settingsOf(a)).backupFolder).toBe('')
      expect(stateOf(a)).toMatchObject({ folder: null, lastSeen: null })
      expect(readdirSync(keptFolder()).sort()).toEqual(files)

      const chosen = await choose(a, keptFolder())

      expect(chosen).toMatchObject({ folder: keptFolder(), pause: null, writtenAt: expect.any(Number) })
      expect(stateOf(a).lastSeen).toBe(hashOf(readSyncText()))
    })
  })

  describe('the quit write', () => {
    it('writes when something changed, and not when nothing did', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()
      await a.keeper.tick()
      const text = readSyncText()

      await a.keeper.quit()
      expect(readSyncText()).toBe(text)

      await a.datastores.history.insertAsync(historyEntry('aaaaaaaaaaa', 1))
      await a.keeper.quit()
      expect(syncDoc().changes.history.put.map(entry => entry.videoId)).toEqual(['aaaaaaaaaaa'])

      const log = await logOf(a)
      expect(log).toMatch(/quit: no write \(nothing changed\)/)
      expect(log).toMatch(/quit: writing/)
    })

    it('gives up waiting at its limit, so that a hung folder cannot hold the quit', async () => {
      let hang = false
      const fileSystem = { ...fs, writeFile: (...args) => hang ? new Promise(() => {}) : fs.writeFile(...args) }

      mkdirSync(keptFolder())
      const a = await machine('a', { fileSystem, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) })
      await a.keeper.start()

      hang = true
      await a.keeper.quit(50)

      expect(existsSync(kept(SYNC_FILE_NAME))).toBe(false)
      expect(await logOf(a)).toMatch(/quit: the write did not finish in time/)
    })
  })

  describe('its memory and its log', () => {
    it('records the sync file\'s hash as pending before renaming it into place, and as last seen after', async () => {
      let atRename = null
      const statePath = path.join(root, 'a', 'backups', 'keeper-state.json')
      const fileSystem = {
        ...fs,
        rename: async (from, to) => {
          if (path.basename(to) === SYNC_FILE_NAME) {
            atRename = { state: JSON.parse(readFileSync(statePath, 'utf8')), text: readFileSync(from, 'utf8') }
          }
          return fs.rename(from, to)
        },
      }

      mkdirSync(keptFolder())
      const a = await machine('a', { fileSystem })
      await a.keeper.start()
      await a.keeper.tick()

      expect(atRename.state).toMatchObject({ lastSeen: null, pending: hashOf(atRename.text) })
      expect(stateOf(a)).toEqual({
        folder: keptFolder(),
        lastSeen: hashOf(readSyncText()),
        contentHash: expect.stringMatching(/^[\da-f]{64}$/),
        pending: null,
      })
    })

    it('logs each decision, with no record\'s contents', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.datastores.history.insertAsync(historyEntry('aaaaaaaaaaa', 1))
      await a.keeper.start()
      await a.keeper.tick()

      const b = await machine('b')
      await b.keeper.start()
      await b.datastores.history.insertAsync(historyEntry('bbbbbbbbbbb', 2))
      await b.keeper.tick()

      await a.datastores.history.insertAsync(historyEntry('ccccccccccc', 3))
      await a.keeper.tick()
      await a.keeper.answer('notNow')

      const logA = await logOf(a)
      const logB = await logOf(b)

      expect(logA).toMatch(/^\S+Z startup: folder /m)
      expect(logA).toMatch(/no sync file: the first tick writes one/)
      expect(logA).toMatch(/wrote sync file [\da-f]{12} .*new base base-/)
      expect(logA).toMatch(/paused: otherMachine, sync file [\da-f]{12} by MACHINE-b/)
      expect(logA).toMatch(/answer: notNow/)
      expect(logB).toMatch(/took in sync file [\da-f]{12} by MACHINE-a .*safety copy before-restore-/)

      for (const log of [logA, logB]) {
        expect(log).not.toMatch(/Video |Synthetic|aaaaaaaaaaa|bbbbbbbbbbb|ccccccccccc/)
      }
    })

    it('starts a new log past 1 MB, keeping the previous one as keeper.log.1', async () => {
      const backups = path.join(root, 'a', 'backups')
      mkdirSync(backups, { recursive: true })
      const filler = 'x'.repeat(LOG_CAP_BYTES - 11) + '\n'
      writeFileSync(path.join(backups, 'keeper.log'), filler)

      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()

      const log = await logOf(a)
      expect(readFileSync(path.join(backups, 'keeper.log.1'), 'utf8')).toBe(filler)
      expect(log).toMatch(/^\S+Z /)
      expect(statSync(path.join(backups, 'keeper.log')).size).toBeLessThan(LOG_CAP_BYTES)
    })
  })
})

/**
 * Waits the keeper's ten seconds between looks for a base on command
 */
function lookAgain() {
  const sleepers = []

  const asleep = () => vi.waitFor(() => expect(sleepers.length).toBeGreaterThan(0))

  return {
    sleep: ms => ms === LOOK_AGAIN_MS ? new Promise(resolve => sleepers.push(resolve)) : Promise.resolve(),
    /** Until the keeper waits to look again */
    asleep,
    /** Ends the keeper's wait, once it waits */
    async wake() {
      await asleep()
      sleepers.shift()()
    },
  }
}

/** Another machine's sync file in the folder, its base held back until `arrive()`; b started on it */
async function baseOnItsWay() {
  mkdirSync(keptFolder())
  const stash = path.join(root, 'on-its-way')
  mkdirSync(stash)

  const base = writeBase(Z_SECTIONS, stash)
  writeSync(base)

  const looks = lookAgain()
  const b = await machine('b', { sleep: looks.sleep })
  await b.keeper.start()

  return { b, base, looks, arrive: () => renameSync(path.join(stash, base.file), kept(base.file)) }
}
