import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseSegmentName, readSegment, segmentName, writeEventLine } from '../../renderer/helpers/intentLog'
import { writeBackup } from '../../renderer/helpers/backup'
import { baseFileName, isBaseFileName, readArchiveHeader, SYNC_FILE_NAME, writeArchive, writeSyncFile } from '../../renderer/helpers/keptBackup'
import { writeStateFile } from '../../renderer/helpers/stateFile'
import { createKeeper, LOG_CAP_BYTES, watchDatastores, writeSafetyCopy } from './keeper'
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
  communitySources: 'community-sources',
  communityShares: 'community-shares',
  communitySourceData: 'community-source-data',
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

/** Every wait never ends: a test drives the ticks itself */
function untimed() {
  return new Promise(() => {})
}

/**
 * A machine: its own data folder and datastores, on the shared backup folder
 * @param {string} name
 * @param {object} [options]
 * @param {string | null} [options.folder] the backup folder setting, null for none
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

  const m = { datastores, dataFolder, jobs: [], keeper: null }

  /** A new keeper on the same data, as after a restart of the app */
  m.restart = ({ sleep = untimed, fileSystem, onDataChanged, inLaterQueue, now, hostName = null, installationId = `installation-${name}` } = {}) => {
    m.keeper = createKeeper({
      datastores,
      dataFolder,
      appVersion: '0.1.0',
      installationId,
      machineName: `MACHINE-${name}`,
      hostName,
      runJob: async (job) => {
        m.jobs.push(job.type)
        return runKeeperJob(job)
      },
      sleep,
      ...(fileSystem ? { fileSystem } : {}),
      ...(onDataChanged ? { onDataChanged } : {}),
      ...(inLaterQueue ? { inLaterQueue } : {}),
      ...(now ? { now } : {}),
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
const archives = () => readdirSync(keptFolder()).filter(isBaseFileName).sort()
const hashOf = text => createHash('sha256').update(text).digest('hex')
const backupsOf = m => path.join(m.dataFolder, 'backups')
const stateOf = m => JSON.parse(readFileSync(path.join(backupsOf(m), 'keeper-state.json'), 'utf8'))
const indexOf = m => JSON.parse(readFileSync(path.join(backupsOf(m), 'intent-index.json'), 'utf8'))

const ownSegment = (name, index) => kept(segmentName(`installation-${name}`, index))
const segmentsOf = id => readdirSync(keptFolder()).filter(file => parseSegmentName(file)?.installationId === id).sort()
const eventsUnder = id => segmentsOf(id).flatMap(file => readSegment(readFileSync(kept(file), 'utf8')).events)
const ownState = name => kept(`state-installation-${name}.json`)
const eventsIn = (name, index) => readSegment(readFileSync(ownSegment(name, index), 'utf8')).events
const stateInFolder = name => JSON.parse(readFileSync(ownState(name), 'utf8'))
const archiveText = file => gunzipSync(readFileSync(kept(file))).toString('utf8')

/** One intent, as the intents module will record it */
function intent(type, key, at, data = {}) {
  return { at, type, key, data }
}

/** A line of this machine's own, as an earlier run of it appended */
function ownLine(seq, key) {
  return writeEventLine({ seq, at: 1764160000000 + seq, by: 'installation-a', type: 'later.added', key, data: {} })
}

/** The keeper's memory as an earlier run left it */
function saveKeeperState(m, patch) {
  mkdirSync(backupsOf(m), { recursive: true })
  const state = { folder: keptFolder(), archive: null, segment: 0, seq: 0, applied: {}, contentHash: null, stateBytes: 0, ...patch }
  writeFileSync(path.join(backupsOf(m), 'keeper-state.json'), JSON.stringify(state))
}

async function logOf(m) {
  await m.keeper.flushLog()
  return readFileSync(path.join(backupsOf(m), 'keeper.log'), 'utf8')
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

/**
 * Enough state fields to carry the state file past the archiving threshold on
 * the tick after the one that writes it
 */
async function growPastTheThreshold(m) {
  const long = 'x'.repeat(800_000)
  for (const videoId of ['long0000001', 'long0000002', 'long0000003']) {
    await m.datastores.history.insertAsync({ ...historyEntry(videoId, 1), description: long })
  }
  await m.keeper.tick()
}

// #region another machine's files, written by hand

const HEADER_Z = { appVersion: '0.1.0', installationId: 'installation-z', machineName: 'MACHINE-z' }

/** An archive of another machine's, gzipped, in the backup folder */
function writeForeignArchive(sections = { profiles: [MAIN_PROFILE] }, cut = { 'installation-z': 4 }) {
  const text = writeArchive({ ...HEADER_Z, cut, sections })
  const file = baseFileName(hashOf(text))
  writeFileSync(kept(file), gzipSync(text))
  return file
}

/** The folder as the version before this one left it: a base with no cut, and the sync file's changes since it */
function writeOldLayout(base, changes) {
  const text = writeBackup({ ...HEADER_Z, sections: base })
  const hash = hashOf(text)
  writeFileSync(kept(baseFileName(hash)), gzipSync(text))
  writeFileSync(kept(SYNC_FILE_NAME), writeSyncFile({ ...HEADER_Z, base: { file: baseFileName(hash), sha256: hash }, changes }))
}

/** One of machine z's events */
function foreign(seq, type, key, at, data = {}) {
  return { seq, at, by: 'installation-z', type, key, data }
}

/** Machine z's events, appended to one of its segments */
function writeForeignEvents(events, index = 0) {
  appendFileSync(kept(segmentName('installation-z', index)), events.map(writeEventLine).join(''), 'utf8')
}

/** What machine z has to say about each key's state fields */
function writeForeignState(records, archive = '0'.repeat(64)) {
  writeFileSync(kept('state-installation-z.json'), writeStateFile({ archive, records }))
}

// #endregion another machine's files

describe('the keeper', () => {
  describe('at startup', () => {
    it('does nothing and is ready at once when no folder is set', async () => {
      const a = await machine('a', { folder: null })
      await a.keeper.start()

      expect(a.keeper.status()).toMatchObject({ ready: true, folder: null })
      expect(await isSettled(a.keeper.whenReady())).toBe(true)
      expect(a.jobs).toEqual([])
    })

    it('is ready with an empty folder, and the first tick writes an archive and this machine\'s segment and state file', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()

      expect(a.keeper.status()).toMatchObject({ ready: true, folder: keptFolder() })
      expect(readdirSync(keptFolder())).toEqual([])

      a.keeper.recordEvent(intent('later.added', 'later/aaaaaaaaaaa', 1764160000000))
      await a.keeper.tick()

      expect(archives()).toHaveLength(1)
      expect(eventsIn('a', 0)).toEqual([{ seq: 1, at: 1764160000000, by: 'installation-a', type: 'later.added', key: 'later/aaaaaaaaaaa', data: {} }])
      expect(stateInFolder('a')).toEqual({ archive: hashOf(archiveText(archives()[0])), records: {} })
      expect(stateOf(a)).toMatchObject({ segment: 1, seq: 1, applied: { 'installation-a': [[1, 1]] } })
      expect(indexOf(a)).toEqual({ 'later/aaaaaaaaaaa': { at: 1764160000000, by: 'installation-a', seq: 1 } })
    })

    it('writes a fresh archive when the one it last wrote no longer matches the hash in its name', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()
      await a.keeper.tick()

      const [file] = archives()
      writeFileSync(kept(file), gzipSync(writeArchive({ ...HEADER_Z, sections: { profiles: [MAIN_PROFILE] } })))

      // A restart empties the archive it keeps in memory, so it reads the folder
      a.restart()
      await a.keeper.start()
      await a.datastores.history.insertAsync(historyEntry('aaaaaaaaaaa', 1))
      await a.keeper.tick()

      expect(archives()).toHaveLength(2)
      expect(baseFileName(stateOf(a).archive)).not.toBe(file)
      expect(archives()).toContain(baseFileName(stateOf(a).archive))
      expect(await logOf(a)).toMatch(/archive base-[\da-f]{16}\.json\.gz does not match its name: writing a fresh one/)
    })

    it('gives up a take in when the folder does not answer in time, applies nothing of it, and takes it in on the next tick', async () => {
      mkdirSync(keptFolder())

      // The folder answers the read of another machine's segment only when
      // the test lets it, as a network mount that has gone away answers none
      let holding = true
      let release = null
      const fileSystem = {
        ...fs,
        readFile: (file, ...rest) => {
          if (!holding || parseSegmentName(path.basename(file))?.installationId !== 'installation-z') {
            return fs.readFile(file, ...rest)
          }

          holding = false
          return new Promise((resolve) => { release = () => resolve(fs.readFile(file, ...rest)) })
        },
      }

      const a = await machine('a', { fileSystem, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) })
      writeForeignEvents([foreign(1, 'later.added', 'later/zzzzzzzzzzz', 1764160000000, { after: null })])

      await a.keeper.start(50)

      expect(a.keeper.status().ready).toBe(true)
      expect(await a.datastores.later.countAsync({})).toBe(0)

      // The folder answers at last. What the read given up on found never
      // reaches the datastores, so no second take in is applying beside the
      // one the next tick makes
      release()
      await new Promise(resolve => setImmediate(resolve))
      expect(await a.datastores.later.countAsync({})).toBe(0)

      await a.keeper.tick()

      expect((await a.datastores.later.findAsync({})).map(record => record._id)).toEqual(['zzzzzzzzzzz'])
      expect(stateOf(a).applied['installation-z']).toEqual([[1, 1]])
      expect(await logOf(a)).toMatch(/the folder did not answer in 0\.05 s: nothing taken in/)
    })
  })

  describe('the folder', () => {
    it('writes this machine\'s segment and state file, and no file another machine owns', async () => {
      mkdirSync(keptFolder())
      const foreign = {
        [segmentName('installation-z', 0)]: '{"seq":1,"at":1,"by":"installation-z","type":"later.added","key":"later/z1","data":{}}\n',
        'state-installation-z.json': '{"archive":"0123456789abcdef","records":{}}',
      }
      for (const [name, text] of Object.entries(foreign)) {
        writeFileSync(kept(name), text)
      }
      const foreignArchive = writeForeignArchive()

      const a = await machine('a')
      await a.keeper.start()
      a.keeper.recordEvent(intent('later.added', 'later/a1', 1764160000000))
      await a.keeper.tick()

      expect(existsSync(ownSegment('a', 0))).toBe(true)
      expect(existsSync(ownState('a'))).toBe(true)

      for (const [name, text] of Object.entries(foreign)) {
        expect(readFileSync(kept(name), 'utf8')).toBe(text)
      }
      expect(existsSync(kept(foreignArchive))).toBe(true)
    })

    it('starts a new segment when it archives, and leaves the one it closed alone', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()

      a.keeper.recordEvent(intent('later.added', 'later/v1', 1764160000000))
      await a.keeper.tick()
      const first = archives()
      expect(first).toHaveLength(1)
      expect(stateOf(a)).toMatchObject({ segment: 1 })

      // The state file written this tick is measured on the next
      await growPastTheThreshold(a)
      expect(archives()).toEqual(first)

      a.keeper.recordEvent(intent('later.added', 'later/v2', 1764160001000))
      await a.keeper.tick()

      expect(archives()).toHaveLength(2)
      expect(stateOf(a)).toMatchObject({ segment: 2 })
      const closed = readFileSync(ownSegment('a', 1), 'utf8')
      expect(eventsIn('a', 1).map(event => event.key)).toEqual(['later/v2'])
      expect(existsSync(ownSegment('a', 2))).toBe(false)

      a.keeper.recordEvent(intent('later.added', 'later/v3', 1764160002000))
      await a.keeper.tick()

      expect(eventsIn('a', 2).map(event => event.key)).toEqual(['later/v3'])
      expect(readFileSync(ownSegment('a', 1), 'utf8')).toBe(closed)
    })

    it('never rewrites a line of a segment', async () => {
      const touched = []
      const note = (how, file) => {
        if (parseSegmentName(path.basename(file)) !== null) { touched.push(`${how} ${path.basename(file)}`) }
      }
      const fileSystem = {
        ...fs,
        appendFile: (file, ...rest) => { note('append', file); return fs.appendFile(file, ...rest) },
        writeFile: (file, ...rest) => { note('write', file); return fs.writeFile(file, ...rest) },
        rename: (from, to) => { note('rename', to); return fs.rename(from, to) },
        rm: (file, ...rest) => { note('rm', file); return fs.rm(file, ...rest) },
      }

      mkdirSync(keptFolder())
      const a = await machine('a', { fileSystem })
      await a.keeper.start()

      const before = new Map()
      for (const videoId of ['v1', 'v2', 'v3']) {
        a.keeper.recordEvent(intent('later.added', `later/${videoId}`, 1764160000000))
        await a.keeper.tick()

        for (const name of readdirSync(keptFolder()).filter(name => parseSegmentName(name) !== null)) {
          const after = readFileSync(kept(name), 'utf8')
          expect(after.startsWith(before.get(name) ?? '')).toBe(true)
          before.set(name, after)
        }
      }

      expect([...before.keys()].length).toBeGreaterThan(1)
      expect(touched.every(step => step.startsWith('append'))).toBe(true)
      expect(touched).toHaveLength(3)
    })

    it('does not divide one write\'s intents between two segments', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()
      await a.keeper.tick()
      await growPastTheThreshold(a)

      // One write: a video put in Later with an alarm already on it, which is
      // only right applied in this order
      a.keeper.recordEvent(intent('later.added', 'later/v1', 1764160000000))
      a.keeper.recordEvent(intent('later.alarmArmed', 'later/v1', 1764160000000, { alarm: 1764170000000 }))
      await a.keeper.tick()

      expect(archives()).toHaveLength(2)
      expect(eventsIn('a', 1).map(event => event.type)).toEqual(['later.added', 'later.alarmArmed'])
      expect(existsSync(ownSegment('a', 2))).toBe(false)
    })

    it('keeps a closed segment and a superseded archive until they are seven days old, and the current ones however old', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')

      // The archive this machine's state file is a delta against, old enough
      // to go were it not the current one
      const text = writeArchive({ ...HEADER_Z, cut: { 'installation-z': 4 }, sections: { profiles: [MAIN_PROFILE] } })
      const current = baseFileName(hashOf(text))
      writeFileSync(kept(current), gzipSync(text))

      mkdirSync(backupsOf(a), { recursive: true })
      writeFileSync(path.join(backupsOf(a), 'keeper-state.json'), JSON.stringify({
        folder: keptFolder(), archive: hashOf(text), segment: 3, seq: 5, applied: {}, contentHash: null, stateBytes: 0,
      }))

      const old = {
        [current]: 8 * DAY_MS,
        [segmentName('installation-a', 0)]: 8 * DAY_MS,
        [segmentName('installation-a', 1)]: 6 * DAY_MS,
        [segmentName('installation-a', 3)]: 8 * DAY_MS,
        [segmentName('installation-z', 0)]: 8 * DAY_MS,
        'base-1111111111111111.json.gz': 8 * DAY_MS,
        'base-2222222222222222.json.gz': 6 * DAY_MS,
      }
      for (const [name, age] of Object.entries(old)) {
        if (name !== current) { writeFileSync(kept(name), 'synthetic\n') }
        ageFile(kept(name), age)
      }

      await a.keeper.start()
      await a.keeper.tick()

      expect(readdirSync(keptFolder()).sort()).toEqual([
        current,
        'base-2222222222222222.json.gz',
        segmentName('installation-a', 1),
        segmentName('installation-a', 3),
        segmentName('installation-z', 0),
        'state-installation-a.json',
      ].sort())
    })

    it('names in the archive\'s cut what it has folded in, of every machine', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')

      mkdirSync(backupsOf(a), { recursive: true })
      writeFileSync(path.join(backupsOf(a), 'keeper-state.json'), JSON.stringify({
        folder: keptFolder(), archive: null, segment: 0, seq: 0, applied: { 'installation-z': [[1, 4]] }, contentHash: null, stateBytes: 0,
      }))

      await a.keeper.start()
      a.keeper.recordEvent(intent('later.added', 'later/v1', 1764160000000))
      a.keeper.recordEvent(intent('later.added', 'later/v2', 1764160001000))
      await a.keeper.tick()

      expect(readArchiveHeader(archiveText(archives()[0]))).toMatchObject({
        ok: true,
        cut: { 'installation-a': 2, 'installation-z': 4 },
      })
    })

    it('closes a segment that ends in half a line, so the next intent is a whole line of its own', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      saveKeeperState(a, { segment: 0, seq: 1, applied: { 'installation-a': [[1, 1]] } })

      // A crash in the middle of an append, which left the second line torn
      writeFileSync(ownSegment('a', 0), ownLine(1, 'later/v1') + ownLine(2, 'later/v2').slice(0, 30))

      await a.keeper.start()
      a.keeper.recordEvent(intent('later.added', 'later/v3', 1764160003000))
      await a.keeper.tick()

      expect(readSegment(readFileSync(ownSegment('a', 0), 'utf8'))).toMatchObject({ partial: false })
      expect(eventsIn('a', 0).map(event => event.key)).toEqual(['later/v1', 'later/v3'])
    })

    it('takes its sequence number from the highest of its own segments, and goes on in the last of them', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')

      // The state file is behind the folder: a crash in the window after a roll
      saveKeeperState(a, { segment: 0, seq: 5, applied: { 'installation-a': [[1, 5]] } })
      writeFileSync(ownSegment('a', 0), ownLine(5, 'later/v5'))
      writeFileSync(ownSegment('a', 1), ownLine(6, 'later/v6') + ownLine(7, 'later/v7'))

      await a.keeper.start()

      expect(stateOf(a)).toMatchObject({ segment: 1, seq: 7, applied: { 'installation-a': [[1, 7]] } })

      a.keeper.recordEvent(intent('later.added', 'later/v8', 1764160008000))
      await a.keeper.tick()

      expect([...eventsIn('a', 0), ...eventsIn('a', 1)].map(event => event.seq)).toEqual([5, 6, 7, 8])
      expect(eventsIn('a', 1).map(event => event.key)).toEqual(['later/v6', 'later/v7', 'later/v8'])
    })

    it('takes its own sequence number from its segment, which an append that was never saved has moved', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()
      a.keeper.recordEvent(intent('later.added', 'later/v1', 1764160000000))
      await a.keeper.tick()

      // An append that landed, with the save that would have counted it lost
      appendFileSync(ownSegment('a', 1), writeEventLine({ seq: 2, at: 1764160001000, by: 'installation-a', type: 'later.added', key: 'later/v2', data: {} }))

      a.restart()
      await a.keeper.start()
      a.keeper.recordEvent(intent('later.added', 'later/v3', 1764160002000))
      await a.keeper.tick()

      expect(eventsIn('a', 1).map(event => [event.seq, event.key])).toEqual([[2, 'later/v2'], [3, 'later/v3']])
      expect(stateOf(a)).toMatchObject({ seq: 3, applied: { 'installation-a': [[1, 3]] } })
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
      const text = readFileSync(ownState('a'), 'utf8')
      await a.keeper.tick()
      expect(a.jobs).toHaveLength(jobs)
      expect(readFileSync(ownState('a'), 'utf8')).toBe(text)

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

      const { records } = stateInFolder('a')
      const keys = Object.keys(records)
      expect(keys).toHaveLength(1)
      expect(records[keys[0]].fields.videoId).toBe('bbbbbbbbbbb')
    })

    it('writes nothing when the content is the same as last written', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()
      await a.keeper.tick()
      const text = readFileSync(ownState('a'), 'utf8')

      const added = await a.datastores.history.insertAsync(historyEntry('aaaaaaaaaaa', 1))
      await a.datastores.history.removeAsync({ _id: added._id }, {})
      await a.keeper.tick()

      expect(a.jobs.at(-1)).toBe('build')
      expect(readFileSync(ownState('a'), 'utf8')).toBe(text)
      expect(a.keeper.hasChanged()).toBe(false)
      expect(await logOf(a)).toMatch(/content unchanged/)
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
      expect(a.keeper.status().failure).toMatchObject({ message: expect.stringContaining('ENOENT'), since: failure.since })

      mkdirSync(keptFolder())
      await a.keeper.tick()

      expect(a.keeper.status()).toMatchObject({ failure: null, writtenAt: expect.any(Number) })
      expect(existsSync(ownState('a'))).toBe(true)
      expect(await logOf(a)).toMatch(/couldn't write: ENOENT/)
    })

    it('keeps an intent recorded while it was appending, and the quit write puts it down', async () => {
      mkdirSync(keptFolder())
      let second = null
      const fileSystem = {
        ...fs,
        appendFile: async (file, ...rest) => {
          const done = await fs.appendFile(file, ...rest)
          // A second intent arrives while the tick is writing, so the flag it
          // is about to lower is that one's and not the one it took
          second?.()
          return done
        },
      }

      const a = await machine('a', { fileSystem })
      await a.keeper.start()
      await a.keeper.tick()

      a.keeper.recordEvent(intent('later.added', 'later/v1', 1764160000000))
      second = () => {
        second = null
        a.keeper.recordEvent(intent('later.added', 'later/v2', 1764160001000))
      }
      await a.keeper.tick()
      await a.keeper.quit()

      expect(eventsIn('a', 1).map(event => event.key)).toEqual(['later/v1', 'later/v2'])
    })

    it('appends the intents a failed tick could not, before the next tick\'s own', async () => {
      const a = await machine('a')
      await a.keeper.start()

      a.keeper.recordEvent(intent('later.added', 'later/v1', 1764160000000))
      await a.keeper.tick()
      expect(a.keeper.status().failure).not.toBeNull()

      mkdirSync(keptFolder())
      a.keeper.recordEvent(intent('later.added', 'later/v2', 1764160001000))
      await a.keeper.tick()

      expect(eventsIn('a', 0).map(event => [event.seq, event.key])).toEqual([[1, 'later/v1'], [2, 'later/v2']])
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

      expect(status).toMatchObject({ folder: keptFolder(), writtenAt: expect.any(Number) })
      expect(archives()).toHaveLength(1)
      expect(existsSync(ownState('c'))).toBe(true)
    })

    it('Stop keeping clears the setting and leaves the files', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()
      await a.keeper.tick()
      const files = readdirSync(keptFolder()).sort()

      const stopped = await a.keeper.stop()

      expect(stopped).toMatchObject({ folder: null, writtenAt: null })
      expect((await settingsOf(a)).backupFolder).toBe('')
      expect(stateOf(a)).toMatchObject({ folder: null, archive: null, contentHash: null })
      expect(readdirSync(keptFolder()).sort()).toEqual(files)
    })

    it('forgets another machine\'s applied ranges when the folder changes, and keeps its own', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()

      writeForeignEvents([foreign(1, 'later.added', 'later/aaaaaaaaaaa', 1764160000000, { after: null })])
      a.keeper.recordEvent(intent('later.added', 'later/bbbbbbbbbbb', 1764160001000, { after: null }))
      await a.keeper.tick()
      expect(stateOf(a).applied).toMatchObject({ 'installation-z': [[1, 1]], 'installation-a': [[1, 1]] })

      const elsewhere = path.join(root, 'elsewhere')
      mkdirSync(elsewhere)
      await a.datastores.settings.updateAsync({ _id: 'backupFolder' }, { _id: 'backupFolder', value: elsewhere }, { upsert: true })
      await a.keeper.folderChosen()

      expect(stateOf(a).applied).toEqual({ 'installation-a': [[1, 1]] })
    })
  })

  describe('the intents made before a folder was chosen', () => {
    const pendingOf = m => path.join(backupsOf(m), 'pending-events.jsonl')

    async function chooseAfter(m, record) {
      const c = m ?? await machine('c', { folder: null })
      await c.keeper.start()
      await record(c)
      await c.keeper.tick()

      mkdirSync(keptFolder(), { recursive: true })
      await c.datastores.settings.updateAsync({ _id: 'backupFolder' }, { _id: 'backupFolder', value: keptFolder() }, { upsert: true })
      await c.keeper.folderChosen()

      return c
    }

    it('keeps them in the data folder while no folder is set, and makes them this machine\'s first segment when one is chosen', async () => {
      const c = await machine('c', { folder: null })
      await c.keeper.start()
      c.keeper.recordEvent(intent('later.added', 'later/aaaaaaaaaaa', Date.now(), { after: null }))
      await c.keeper.tick()

      expect(readSegment(readFileSync(pendingOf(c), 'utf8')).events.map(event => event.key)).toEqual(['later/aaaaaaaaaaa'])

      mkdirSync(keptFolder(), { recursive: true })
      await c.datastores.settings.updateAsync({ _id: 'backupFolder' }, { _id: 'backupFolder', value: keptFolder() }, { upsert: true })
      await c.keeper.folderChosen()

      expect(eventsIn('c', 0).map(event => [event.seq, event.key])).toEqual([[1, 'later/aaaaaaaaaaa']])
      expect(existsSync(pendingOf(c))).toBe(false)
    })

    it('drops the oldest past the cap, so those keys enrol as a union and nothing else does', async () => {
      const c = await chooseAfter(null, async (m) => {
        m.keeper.recordEvent(intent('later.added', 'later/oldoldoldo', Date.now() - 31 * DAY_MS, { after: null }))
        m.keeper.recordEvent(intent('later.added', 'later/freshfresh', Date.now(), { after: null }))
      })

      expect(eventsIn('c', 0).map(event => event.key)).toEqual(['later/freshfresh'])
      expect(await logOf(c)).toContain('past its cap')
    })

    it('loses to the other machine\'s later intent on the same key, and beats its earlier one', async () => {
      mkdirSync(keptFolder())
      writeForeignEvents([foreign(1, 'later.removed', 'later/aaaaaaaaaaa', 2000)])

      const late = await chooseAfter(null, async (m) => {
        await m.datastores.later.insertAsync({ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', position: 1 })
        m.keeper.recordEvent(intent('later.added', 'later/aaaaaaaaaaa', 1000, { after: null }))
      })

      expect(await late.datastores.later.countAsync({})).toBe(0)

      const early = await chooseAfter(await machine('d', { folder: null }), async (m) => {
        await m.datastores.later.insertAsync({ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', position: 1 })
        m.keeper.recordEvent(intent('later.added', 'later/aaaaaaaaaaa', 3000, { after: null }))
      })

      expect((await early.datastores.later.findAsync({})).map(record => record._id)).toEqual(['aaaaaaaaaaa'])
    })
  })

  describe('meeting a folder for the first time', () => {
    it('takes an event whose predecessors the folder no longer has, from the ranges the archive\'s cut seeds', async () => {
      mkdirSync(keptFolder())
      writeForeignArchive({ later: [] }, { 'installation-z': 2 })
      writeForeignEvents([foreign(3, 'later.added', 'later/ccccccccccc', 1764160002000, { after: null })], 1)

      const a = await machine('a')
      await a.keeper.start()

      expect((await a.datastores.later.findAsync({})).map(record => record._id)).toEqual(['ccccccccccc'])
      expect(stateOf(a).applied['installation-z']).toEqual([[1, 3]])
    })

    it('merges the folder\'s archive in, removes nothing local, and keeps a safety copy first', async () => {
      mkdirSync(keptFolder())
      writeForeignArchive({ later: [{ _id: 'zzzzzzzzzzz', videoId: 'zzzzzzzzzzz', position: 1 }] }, {})

      const a = await machine('a')
      await a.datastores.later.insertAsync({ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', title: 'A', position: 1 })
      await a.keeper.start()

      const copies = readdirSync(backupsOf(a)).filter(name => name.startsWith('before-restore-'))
      expect(copies).toHaveLength(1)
      expect(readFileSync(path.join(backupsOf(a), copies[0]), 'utf8')).not.toContain('zzzzzzzzzzz')
      expect((await a.datastores.later.findAsync({})).map(record => record._id).sort()).toEqual(['aaaaaaaaaaa', 'zzzzzzzzzzz'])
    })

    it('takes a folder still in the old layout in once, writes the new layout, and leaves the old file alone', async () => {
      mkdirSync(keptFolder())
      writeOldLayout(
        { later: [{ _id: 'inthebase0', videoId: 'inthebase0', position: 1 }] },
        { later: { put: [{ _id: 'sincethebas', videoId: 'sincethebas', position: 2 }], remove: [] } }
      )

      const a = await machine('a')
      await a.keeper.start()
      await a.keeper.tick()

      expect((await a.datastores.later.findAsync({})).map(record => record._id).sort()).toEqual(['inthebase0', 'sincethebas'])
      expect(existsSync(ownState('a'))).toBe(true)
      expect(archives()).toHaveLength(1)
      expect(existsSync(kept(SYNC_FILE_NAME))).toBe(true)

      const before = readFileSync(kept(SYNC_FILE_NAME), 'utf8')
      a.restart()
      await a.keeper.start()

      expect(await a.datastores.later.countAsync({})).toBe(2)
      expect(readFileSync(kept(SYNC_FILE_NAME), 'utf8')).toBe(before)
    })

    it('meets the folder once: a second start merges nothing and reads no archive again', async () => {
      mkdirSync(keptFolder())
      writeForeignArchive({ later: [{ _id: 'zzzzzzzzzzz', videoId: 'zzzzzzzzzzz', position: 1 }] }, {})

      const a = await machine('a')
      await a.keeper.start()
      await a.datastores.later.removeAsync({ _id: 'zzzzzzzzzzz' }, {})

      a.restart()
      await a.keeper.start()

      expect(await a.datastores.later.countAsync({})).toBe(0)
    })
  })

  describe('this machine\'s own identity', () => {
    const itsOwn = ownLine(1, 'later/v1') + ownLine(2, 'later/v2')

    /** The data folder as the run before this one left it: the keeper's memory and this machine's own segment */
    function theRunBefore(m, { lastHostName, lines }) {
      saveKeeperState(m, { lastHostName, segment: 3, seq: 2, applied: { 'installation-a': [[1, 2]] } })
      writeFileSync(ownSegment('a', 3), lines)
    }

    it('mints a new installation id when the host name has changed, and leaves the old id\'s segment where it is', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a', { hostName: 'LAPTOP' })
      theRunBefore(a, { lastHostName: 'DESKTOP', lines: itsOwn })

      await a.keeper.start()
      a.keeper.recordEvent(intent('later.added', 'later/v3', 1764160003000))
      await a.keeper.tick()

      const minted = (await settingsOf(a)).installationId

      expect(minted).toMatch(/^[\da-f-]{36}$/)
      expect(segmentsOf('installation-a')).toEqual([segmentName('installation-a', 3)])
      expect(readFileSync(ownSegment('a', 3), 'utf8')).toBe(itsOwn)
      expect(segmentsOf(minted)).toContain(segmentName(minted, 0))
      expect(eventsUnder(minted).map(event => [event.seq, event.key])).toEqual([[1, 'later/v3']])
    })

    it('mints a new installation id when its own segments give one sequence number to two events, which is what two machines on one id do', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a', { hostName: 'DESKTOP' })
      theRunBefore(a, { lastHostName: 'DESKTOP', lines: itsOwn })

      // The machine this folder was copied to rolled a segment of its own and
      // gave sequence number 2 away a second time
      writeFileSync(ownSegment('a', 4), ownLine(2, 'later/v2again'))

      await a.keeper.start()
      a.keeper.recordEvent(intent('later.added', 'later/v3', 1764160003000))
      await a.keeper.tick()

      const minted = (await settingsOf(a)).installationId

      expect(minted).toMatch(/^[\da-f-]{36}$/)
      expect(segmentsOf('installation-a')).toEqual([segmentName('installation-a', 3), segmentName('installation-a', 4)])
      expect(eventsUnder(minted).map(event => [event.seq, event.key])).toEqual([[1, 'later/v3']])
    })

    it('keeps the id it has across a restart when the host name is the same and every sequence number in its segment is its own', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a', { hostName: 'DESKTOP' })
      theRunBefore(a, { lastHostName: 'DESKTOP', lines: itsOwn })

      await a.keeper.start()
      a.keeper.recordEvent(intent('later.added', 'later/v3', 1764160003000))
      await a.keeper.tick()

      a.restart({ hostName: 'DESKTOP' })
      await a.keeper.start()
      a.keeper.recordEvent(intent('later.added', 'later/v4', 1764160004000))
      await a.keeper.tick()

      expect((await settingsOf(a)).installationId).toBeUndefined()
      expect(eventsUnder('installation-a').map(event => [event.seq, event.key]))
        .toEqual([[1, 'later/v1'], [2, 'later/v2'], [3, 'later/v3'], [4, 'later/v4']])
    })

    it('records the host name it minted under, so the start after a rename does not mint a second time', async () => {
      const a = await machine('a', { folder: null, hostName: 'LAPTOP' })
      saveKeeperState(a, { folder: null, lastHostName: 'DESKTOP' })

      await a.keeper.start()
      const minted = (await settingsOf(a)).installationId

      // The id comes back from the settings datastore, as `ensureInstallationId` hands it to the keeper
      a.restart({ hostName: 'LAPTOP', installationId: minted })
      await a.keeper.start()

      expect(minted).toMatch(/^[\da-f-]{36}$/)
      expect((await settingsOf(a)).installationId).toBe(minted)
    })

    it('knows the host name has changed when the backup folder has changed as well', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a', { hostName: 'LAPTOP' })
      saveKeeperState(a, { folder: path.join(root, 'elsewhere'), lastHostName: 'DESKTOP' })

      await a.keeper.start()

      expect((await settingsOf(a)).installationId).toMatch(/^[\da-f-]{36}$/)
    })

    it('mints before a folder is chosen, so the intents kept pending are this machine\'s own', async () => {
      const a = await machine('a', { folder: null, hostName: 'LAPTOP' })
      saveKeeperState(a, { folder: null, lastHostName: 'DESKTOP' })

      await a.keeper.start()
      a.keeper.recordEvent(intent('later.added', 'later/v3', Date.now()))
      await a.keeper.tick()

      const minted = (await settingsOf(a)).installationId
      const pending = readSegment(readFileSync(path.join(backupsOf(a), 'pending-events.jsonl'), 'utf8')).events

      expect(minted).toMatch(/^[\da-f-]{36}$/)
      expect(pending.map(event => event.by)).toEqual([minted])
    })
  })

  describe('the quit write', () => {
    it('writes when something changed, and not when nothing did', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()
      await a.keeper.tick()
      const text = readFileSync(ownState('a'), 'utf8')

      await a.keeper.quit()
      expect(readFileSync(ownState('a'), 'utf8')).toBe(text)

      await a.datastores.history.insertAsync(historyEntry('aaaaaaaaaaa', 1))
      await a.keeper.quit()
      expect(Object.keys(stateInFolder('a').records)).toHaveLength(1)

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

      expect(existsSync(ownState('a'))).toBe(false)
      expect(await logOf(a)).toMatch(/quit: the write did not finish in time/)
    })
  })

  describe('taking another machine\'s intents in', () => {
    it('applies another machine\'s events to the datastores and tells the windows which sections changed', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a', { onDataChanged: changes => a.changes.push(changes) })
      a.changes = []
      await a.datastores.later.insertAsync({ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', title: 'A', position: 1 })
      await a.keeper.start()

      writeForeignEvents([
        foreign(1, 'later.added', 'later/zzzzzzzzzzz', 1764160000000, { after: null }),
        foreign(2, 'later.removed', 'later/aaaaaaaaaaa', 1764160001000),
      ])
      await a.keeper.tick()

      expect((await a.datastores.later.findAsync({})).map(record => record._id)).toEqual(['zzzzzzzzzzz'])
      expect(a.changes).toEqual([{ sections: ['later'], history: null }])
      expect(stateOf(a).applied['installation-z']).toEqual([[1, 2]])
    })

    it('keeps a safety copy of the data as it was before it applies anything', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.datastores.later.insertAsync({ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', title: 'A', position: 1 })
      await a.keeper.start()

      writeForeignEvents([foreign(1, 'later.removed', 'later/aaaaaaaaaaa', 1764160001000)])
      await a.keeper.tick()

      const copies = readdirSync(backupsOf(a)).filter(name => name.startsWith('before-restore-'))
      expect(copies).toHaveLength(1)
      expect(readFileSync(path.join(backupsOf(a), copies[0]), 'utf8')).toContain('aaaaaaaaaaa')
      expect(await a.datastores.later.countAsync({})).toBe(0)
    })

    it('holds back a segment that arrives before an earlier one, and takes it whole once the earlier one comes', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()

      writeForeignEvents([foreign(3, 'later.added', 'later/ccccccccccc', 1764160002000, { after: 'later/bbbbbbbbbbb' })], 1)
      await a.keeper.tick()

      expect(await a.datastores.later.countAsync({})).toBe(0)
      expect(stateOf(a).applied['installation-z']).toBeUndefined()

      writeForeignEvents([
        foreign(1, 'later.added', 'later/aaaaaaaaaaa', 1764160000000, { after: null }),
        foreign(2, 'later.added', 'later/bbbbbbbbbbb', 1764160001000, { after: 'later/aaaaaaaaaaa' }),
      ], 0)
      await a.keeper.tick()

      const order = (await a.datastores.later.findAsync({})).sort((one, other) => one.position - other.position)
      expect(order.map(record => record._id)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'])
      expect(stateOf(a).applied['installation-z']).toEqual([[1, 3]])
    })

    it('logs each applied intent with its type, its key and the machine it came from', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()

      writeForeignEvents([foreign(1, 'later.added', 'later/zzzzzzzzzzz', 1764160000000, { after: null })])
      await a.keeper.tick()

      expect(await logOf(a)).toMatch(/applied later\.added to later\/zzzzzzzzzzz from installatio/)
    })

    it('logs an event dated more than five minutes ahead of its own clock', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()

      writeForeignEvents([foreign(1, 'later.added', 'later/zzzzzzzzzzz', Date.now() + 20 * 60_000, { after: null })])
      await a.keeper.tick()

      expect(await logOf(a)).toMatch(/later\.added from installatio\S* is dated \d+ minutes ahead of this machine's clock/)
    })

    it('keeps an intent whose datastore write threw, and applies it on the next tick', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.datastores.later.insertAsync({ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', title: 'A', position: 1 })
      await a.keeper.start()

      const removeAsync = a.datastores.later.removeAsync.bind(a.datastores.later)
      let thrown = false
      a.datastores.later.removeAsync = async (...args) => {
        if (thrown) { return removeAsync(...args) }
        thrown = true
        throw new Error('the datastore is busy')
      }

      writeForeignEvents([foreign(1, 'later.removed', 'later/aaaaaaaaaaa', 1764160001000)])
      await a.keeper.tick()

      expect(await a.datastores.later.countAsync({})).toBe(1)

      await a.keeper.tick()

      expect(await a.datastores.later.countAsync({})).toBe(0)
    })

    it('leaves a key alone when an older intent from another machine arrives after it', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()

      writeForeignEvents([foreign(1, 'later.removed', 'later/aaaaaaaaaaa', 1764160002000)])
      await a.keeper.tick()

      appendFileSync(
        kept(segmentName('installation-y', 0)),
        writeEventLine({ seq: 1, at: 1764160001000, by: 'installation-y', type: 'later.added', key: 'later/aaaaaaaaaaa', data: { after: null } }),
        'utf8'
      )
      await a.keeper.tick()

      expect(await a.datastores.later.countAsync({})).toBe(0)
      expect(indexOf(a)['later/aaaaaaaaaaa']).toEqual({ at: 1764160002000, by: 'installation-z', seq: 1 })
    })

    it('applies nothing when the safety copy cannot be written', async () => {
      mkdirSync(keptFolder())
      const refusing = {
        ...fs,
        writeFile: async (file, ...rest) => {
          if (String(file).includes('before-restore')) { throw new Error('the disk is full') }
          return fs.writeFile(file, ...rest)
        },
      }
      const a = await machine('a', { fileSystem: refusing })
      await a.datastores.later.insertAsync({ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', title: 'A', position: 1 })
      await a.keeper.start()

      writeForeignEvents([foreign(1, 'later.removed', 'later/aaaaaaaaaaa', 1764160001000)])
      await a.keeper.tick()

      expect(await a.datastores.later.countAsync({})).toBe(1)
      expect(stateOf(a).applied['installation-z']).toBeUndefined()
    })

    it('keeps one safety copy an hour, however many take-ins there are', async () => {
      mkdirSync(keptFolder())
      const copies = []
      const counting = {
        ...fs,
        writeFile: async (file, ...rest) => {
          if (String(file).includes('before-restore')) { copies.push(String(file)) }
          return fs.writeFile(file, ...rest)
        },
      }
      const a = await machine('a', { fileSystem: counting })
      await a.keeper.start()

      writeForeignEvents([foreign(1, 'later.added', 'later/aaaaaaaaaaa', 1764160000000, { after: null })])
      await a.keeper.tick()

      expect(copies).toHaveLength(1)

      writeForeignEvents([foreign(2, 'later.added', 'later/zzzzzzzzzzz', 1764160001000, { after: null })])
      await a.keeper.tick()

      expect(copies).toHaveLength(1)
    })

    it('keeps a safety copy when the clock has gone back past the last one', async () => {
      mkdirSync(keptFolder())
      const copies = []
      const counting = {
        ...fs,
        writeFile: async (file, ...rest) => {
          if (String(file).includes('before-restore')) { copies.push(String(file)) }
          return fs.writeFile(file, ...rest)
        },
      }
      let clock = Date.now()
      const a = await machine('a', { fileSystem: counting, now: () => clock })
      await a.keeper.start()

      writeForeignEvents([foreign(1, 'later.added', 'later/aaaaaaaaaaa', 1764160000000, { after: null })])
      await a.keeper.tick()

      expect(copies).toHaveLength(1)

      clock -= 2 * 60 * 60_000
      writeForeignEvents([foreign(2, 'later.added', 'later/zzzzzzzzzzz', 1764160001000, { after: null })])
      await a.keeper.tick()

      expect(copies).toHaveLength(2)
    })

    it('writes nothing over a local Later write made while it applies, and brings its own records in', async () => {
      mkdirSync(keptFolder())

      // The Later handler's queue, as `datastores/handlers/base.js` keeps it
      let queue = Promise.resolve()
      const inLaterQueue = (write) => {
        const run = queue.then(write)
        queue = run.catch(() => {})
        return run
      }

      const a = await machine('a', { inLaterQueue })
      await a.datastores.later.insertAsync([
        { _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', title: 'A', position: 1, alarm: null },
        { _id: 'bbbbbbbbbbb', videoId: 'bbbbbbbbbbb', title: 'B', position: 2, alarm: null },
      ])
      await a.keeper.start()

      // A local write arms an alarm on the record the take in is moving, from
      // inside its first write, which is where each of the apply's awaits
      // lets one through
      const alarm = { at: 1764170000000, armedAt: 1764160002000 }
      const updateAsync = a.datastores.later.updateAsync.bind(a.datastores.later)
      let armed = null
      a.datastores.later.updateAsync = async (...args) => {
        if (armed === null) {
          armed = inLaterQueue(() => updateAsync({ _id: 'aaaaaaaaaaa' }, { $set: { alarm } }))
          await new Promise(resolve => setImmediate(resolve))
        }

        return updateAsync(...args)
      }

      writeForeignEvents([
        foreign(1, 'later.added', 'later/zzzzzzzzzzz', 1764160000000, { after: 'later/bbbbbbbbbbb' }),
        foreign(2, 'later.moved', 'later/aaaaaaaaaaa', 1764160001000, { after: 'later/zzzzzzzzzzz' }),
      ])
      await a.keeper.tick()
      await armed

      const records = await a.datastores.later.findAsync({})
      const moved = records.find(record => record._id === 'aaaaaaaaaaa')

      expect(moved.alarm).toEqual(alarm)
      expect(moved.position).toBe(4)
      expect(records.map(record => record._id).sort()).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'zzzzzzzzzzz'])
    })
  })

  describe('another machine\'s state fields', () => {
    it('writes a record created by an event together with its state from the state file, in one tick', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()

      writeForeignEvents([foreign(1, 'later.added', 'later/zzzzzzzzzzz', 1764160000000, { after: null })])
      writeForeignState({
        'later/zzzzzzzzzzz': { at: 1764160000000, fields: { title: 'A synthetic video', author: 'Synthetic Channel', viewCount: 12 } },
        'later/yyyyyyyyyyy': { at: 1764160000000, fields: { title: 'No event ever named this one' } },
      })
      await a.keeper.tick()

      const records = await a.datastores.later.findAsync({})

      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ _id: 'zzzzzzzzzzz', videoId: 'zzzzzzzzzzz', title: 'A synthetic video', viewCount: 12 })
    })

    it('writes nothing over a local Later write made while it merges state, and brings the state in', async () => {
      mkdirSync(keptFolder())

      // The Later handler's queue, as `datastores/handlers/base.js` keeps it
      let queue = Promise.resolve()
      const inLaterQueue = (write) => {
        const run = queue.then(write)
        queue = run.catch(() => {})
        return run
      }

      const a = await machine('a', { inLaterQueue })
      await a.datastores.later.insertAsync({ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', title: 'A', position: 1, viewCount: 10, alarm: null })
      await a.keeper.start()

      // A local write arms an alarm on the record the state merge is writing,
      // from inside its first write, which is where its awaits let one
      // through
      const alarm = { at: 1764170000000, armedAt: 1764160002000 }
      const updateAsync = a.datastores.later.updateAsync.bind(a.datastores.later)
      let armed = null
      a.datastores.later.updateAsync = async (...args) => {
        if (armed === null) {
          armed = inLaterQueue(() => updateAsync({ _id: 'aaaaaaaaaaa' }, { $set: { alarm } }))
          await new Promise(resolve => setImmediate(resolve))
        }

        return updateAsync(...args)
      }

      writeForeignState({ 'later/aaaaaaaaaaa': { at: 1764160000000, fields: { viewCount: 42 } } })
      await a.keeper.tick()
      await armed

      expect(await a.datastores.later.findOneAsync({ _id: 'aaaaaaaaaaa' })).toMatchObject({ viewCount: 42, alarm })
    })

    it('leaves a record no event names untouched, even when it differs from the archive', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.datastores.history.insertAsync({ _id: 'aaaaaaaaaaa', ...historyEntry('aaaaaaaaaaa', 1) })
      await a.keeper.start()
      await a.keeper.tick()

      await a.datastores.history.updateAsync({ _id: 'aaaaaaaaaaa' }, { $set: { watchProgress: 45 } })
      await a.keeper.tick()

      // Watched on after the state file naming 45 went into the folder
      await a.datastores.history.updateAsync({ _id: 'aaaaaaaaaaa' }, { $set: { watchProgress: 60 } })
      await a.keeper.tick()

      expect(await a.datastores.history.findOneAsync({ _id: 'aaaaaaaaaaa' })).toMatchObject({ watchProgress: 60 })
    })

    it('keeps the starter sources list as a union, and drops a share of a source nothing follows', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a', { settings: [{ _id: 'communitiesStarterSourcesOffered', value: ['starter-one'] }] })
      await a.datastores.communitySources.insertAsync({ _id: 'followed', name: 'A followed source' })
      await a.datastores.communityShares.insertAsync([
        { _id: 'share-of-followed', sourceId: 'followed', title: 'As it was here' },
        { _id: 'share-of-gone', sourceId: 'gone', title: 'As it was here' },
      ])
      await a.keeper.start()
      await a.keeper.tick()

      // An offer this machine alone has made, so only its own state file has it
      await a.datastores.settings.updateAsync({ _id: 'communitiesStarterSourcesOffered' }, { $set: { value: ['starter-one', 'starter-two'] } })
      await a.keeper.tick()

      const earlier = Date.now() - 60_000
      writeForeignState({
        'settings/communitiesStarterSourcesOffered': { at: earlier, fields: { _id: 'communitiesStarterSourcesOffered', value: ['starter-three'] } },
        'communityShares/share-of-followed': { at: earlier, fields: { _id: 'share-of-followed', sourceId: 'followed', title: 'From the other machine' } },
        'communityShares/share-of-gone': { at: earlier, fields: { _id: 'share-of-gone', sourceId: 'gone', title: 'From the other machine' } },
      })
      await a.keeper.tick()

      expect((await settingsOf(a)).communitiesStarterSourcesOffered).toEqual(['starter-one', 'starter-three', 'starter-two'])

      const shares = await a.datastores.communityShares.findAsync({})
      expect(Object.fromEntries(shares.map(({ _id, title }) => [_id, title]))).toEqual({
        'share-of-followed': 'From the other machine',
        'share-of-gone': 'As it was here',
      })
    })

    it('takes a video watched on the other machine into history, with its details', async () => {
      mkdirSync(keptFolder())
      const b = await machine('b')
      await b.keeper.start()
      await b.keeper.tick()

      const watched = await b.datastores.history.insertAsync({ _id: 'zzzzzzzzzzz', ...historyEntry('zzzzzzzzzzz', 1764160000000) })
      await b.keeper.tick()

      const a = await machine('a', { onDataChanged: changes => a.changes.push(changes) })
      a.changes = []
      await a.keeper.start()
      await a.keeper.tick()

      // Nothing but the state files says a history record is there, as no
      // intent of history's is named yet
      expect(await a.datastores.history.findAsync({})).toEqual([watched])
      expect(a.changes).toEqual([{ sections: ['history'], history: null }])
    })

    it('makes no record for a key of more parts than an id, which a later version writes', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.keeper.start()

      // A subscription's name and thumbnail, which part two keys inside the
      // profile record and this version cannot place
      writeForeignState({ 'profiles/allChannels/UCsynthetic': { at: Date.now(), fields: { name: 'Synthetic Channel' } } })
      await a.keeper.tick()

      expect((await a.datastores.profiles.findAsync({})).map(record => record._id)).toEqual(['allChannels'])
    })

    it('does not bring a Later record an event removed back, whatever a state file says of it', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.datastores.later.insertAsync({ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', title: 'A synthetic video', position: 1 })
      await a.keeper.start()

      writeForeignEvents([foreign(1, 'later.removed', 'later/aaaaaaaaaaa', 1764160001000)])
      // Newer than the removal, and still no say in whether the record is there
      writeForeignState({ 'later/aaaaaaaaaaa': { at: 1764160002000, fields: { title: 'A synthetic video', viewCount: 12 } } })
      await a.keeper.tick()

      expect(await a.datastores.later.findAsync({})).toEqual([])
    })

    it('writes its state file only when a state field changed', async () => {
      const written = []
      const fileSystem = {
        ...fs,
        rename: (from, to) => {
          if (path.basename(to) === 'state-installation-a.json') { written.push(to) }
          return fs.rename(from, to)
        },
      }

      mkdirSync(keptFolder())
      const a = await machine('a', { fileSystem })
      await a.datastores.later.insertAsync({ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', title: 'A synthetic video', position: 1 })
      await a.keeper.start()
      await a.keeper.tick()
      expect(written).toHaveLength(1)

      await a.datastores.later.updateAsync({ _id: 'aaaaaaaaaaa' }, { $set: { position: 2 } })
      await a.keeper.tick()
      expect(written).toHaveLength(1)

      await a.datastores.later.updateAsync({ _id: 'aaaaaaaaaaa' }, { $set: { viewCount: 12 } })
      await a.keeper.tick()
      expect(written).toHaveLength(2)

      expect(Object.keys(stateInFolder('a').records)).toEqual(['later/aaaaaaaaaaa'])
      expect(await logOf(a)).toMatch(/no state field changed: the state file stays as it is/)
    })
  })

  describe('the safety copy', () => {
    it('keeps the data as it was, and leaves alone one already written in the same second', async () => {
      const a = await machine('a')
      const at = Date.UTC(2026, 10, 27, 9, 37, 0)

      const name = await writeSafetyCopy({ dataFolder: a.dataFolder, fileSystem: fs, at, text: 'as it was' })
      const again = await writeSafetyCopy({ dataFolder: a.dataFolder, fileSystem: fs, at, text: 'later on' })

      expect(again).toBe(name)
      expect(readFileSync(path.join(backupsOf(a), name), 'utf8')).toBe('as it was')
    })
  })

  describe('its memory and its log', () => {
    it('logs each decision, with no record\'s contents', async () => {
      mkdirSync(keptFolder())
      const a = await machine('a')
      await a.datastores.history.insertAsync(historyEntry('aaaaaaaaaaa', 1))
      await a.keeper.start()
      a.keeper.recordEvent(intent('later.added', 'later/aaaaaaaaaaa', 1764160000000))
      await a.keeper.tick()

      const log = await logOf(a)

      expect(log).toMatch(/^\S+Z startup: folder /m)
      expect(log).toMatch(/appended 1 intent to events-installation-a-0\.jsonl/)
      expect(log).toMatch(/wrote archive base-[\da-f]{16}\.json\.gz/)
      expect(log).toMatch(/wrote state file: \d+ records, \d+ chars/)
      expect(log).not.toMatch(/Video |Synthetic|aaaaaaaaaaa/)
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
