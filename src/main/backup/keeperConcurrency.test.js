import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Datastore from '@seald-io/nedb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseSegmentName, readSegment, segmentName } from '../../renderer/helpers/intentLog'
import { isBaseFileName } from '../../renderer/helpers/keptBackup'
import { createKeeper, TEMP_PREFIX, watchDatastores } from './keeper'
import { runKeeperJob } from './keeperWorker'

// Two and three keepers on one folder, each with its own data folder,
// datastores, state file and segments, and a sync tool that takes as long as
// it takes (spec, "Delivery is slow and out of order").
//
// Each machine sees the folder as a copy of its own, which is what two
// machines behind Syncthing have: a carry takes each machine's own files to
// the others, a file held back waits the carries it was given, and a file
// carried half way is the tail of a segment that is still being appended to.
// Nothing waits on real time. A test drives every tick itself.

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

/** Each test opens several machines of eleven datastores, and gzips archives */
const SLOW = { timeout: 60_000 }

const T = 1764160000000

let root
let keepers

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'fjernsyn-delivery-'))
  keepers = []
})

afterEach(async () => {
  await Promise.all(keepers.map(keeper => keeper.flushLog()))
  rmSync(root, { recursive: true, force: true })
})

// #region the harness

const idOf = name => `installation-${name}`
const folderOf = (home, name) => path.join(home, `kept-${name}`)
const backupsOf = m => path.join(m.dataFolder, 'backups')
const stateOf = m => JSON.parse(readFileSync(path.join(backupsOf(m), 'keeper-state.json'), 'utf8'))
const indexOf = m => JSON.parse(readFileSync(path.join(backupsOf(m), 'intent-index.json'), 'utf8'))
const archivesIn = m => readdirSync(m.folder).filter(isBaseFileName).sort()
const segmentIn = (m, who, index) => path.join(m.folder, segmentName(idOf(who), index))

/** Every wait never ends: a test drives the ticks itself */
function untimed() {
  return new Promise(() => {})
}

function historyEntry(videoId, extra = {}) {
  return {
    _id: videoId,
    videoId,
    title: `Video ${videoId}`,
    author: 'Synthetic Channel',
    authorId: 'UCsynthetic',
    published: 1700000000000,
    description: 'A synthetic description',
    viewCount: 10,
    lengthSeconds: 60,
    watchProgress: 30,
    timeWatched: 1,
    isLive: false,
    type: 'video',
    ...extra,
  }
}

/**
 * A machine: its own data folder, its own datastores, and its own copy of the
 * backup folder, which the sync tool fills
 * @param {string} name
 * @param {object} [options]
 * @param {string} [options.home] the world this machine lives in, for a test that runs several
 */
async function machine(name, { home = root, ...options } = {}) {
  const dataFolder = path.join(home, name)
  const folder = folderOf(home, name)
  const datastores = {}

  mkdirSync(folder, { recursive: true })

  for (const [section, file] of Object.entries(DATASTORE_FILES)) {
    datastores[section] = new Datastore({ filename: path.join(dataFolder, `${file}.db`) })
    await datastores[section].loadDatabaseAsync()
  }

  await datastores.profiles.insertAsync(MAIN_PROFILE)
  await datastores.settings.insertAsync({ _id: 'backupFolder', value: folder })

  const m = { datastores, dataFolder, folder, id: idOf(name), keeper: null }

  /** A new keeper on the same data, as after a restart of the app */
  m.restart = ({ sleep = untimed } = {}) => {
    m.keeper = createKeeper({
      datastores,
      dataFolder,
      appVersion: '0.1.0',
      installationId: idOf(name),
      machineName: `MACHINE-${name}`,
      runJob: async job => runKeeperJob(job),
      sleep,
    })
    keepers.push(m.keeper)
    return m.keeper
  }

  m.restart(options)
  watchDatastores(datastores, () => m.keeper.markChanged())

  return m
}

/**
 * The sync tool. A carry takes each machine's own files to the other
 * machines, so a machine reads only what has reached it. A file held back
 * waits the carries it was given, which is how a newer file arrives before an
 * older one, and a file given a length is carried that far, which is a
 * segment copied while its owner was still appending to it.
 * @param {...object} machines
 */
function sync(...machines) {
  const held = new Map()
  const halfway = new Map()

  function carried(name, owner) {
    if (name.startsWith(TEMP_PREFIX)) { return false }

    return isBaseFileName(name) || parseSegmentName(name)?.installationId === owner || name === `state-${owner}.json`
  }

  return {
    /**
     * @param {string} name
     * @param {number} carries how many carries this file waits
     */
    hold(name, carries) {
      held.set(name, carries)
    },

    /**
     * @param {string} name
     * @param {number} chars how much of it the next carry takes
     */
    half(name, chars) {
      halfway.set(name, chars)
    },

    carry() {
      for (const from of machines) {
        for (const name of readdirSync(from.folder)) {
          if (!carried(name, from.id)) { continue }

          const waiting = held.get(name) ?? 0
          if (waiting > 0) {
            held.set(name, waiting - 1)
            continue
          }

          const chars = halfway.get(name)
          halfway.delete(name)

          for (const to of machines) {
            if (to === from) { continue }

            if (chars === undefined) {
              copyFileSync(path.join(from.folder, name), path.join(to.folder, name))
            } else {
              writeFileSync(path.join(to.folder, name), readFileSync(path.join(from.folder, name), 'utf8').slice(0, chars))
            }
          }
        }
      }
    },
  }
}

/**
 * @param {object[]} machines
 * @param {{ carry: () => void }} carrier
 * @param {number} count
 */
async function ticks(machines, carrier, count) {
  for (let round = 0; round < count; round++) {
    for (const m of machines) {
      await m.keeper.tick()
    }
    carrier.carry()
  }
}

/**
 * A video put in Later, at the front as the app does: the record on this
 * machine, and the intent that travels
 * @param {object} m
 * @param {string} videoId
 * @param {number} at
 */
async function addLater(m, videoId, at) {
  const positions = (await m.datastores.later.findAsync({})).map(record => record.position)
  const position = positions.length === 0 ? 0 : Math.min(...positions) - 1

  await m.datastores.later.insertAsync({ _id: videoId, videoId, position, title: `Video ${videoId}` })
  m.keeper.recordEvent({ at, type: 'later.added', key: `later/${videoId}`, data: { after: null } })
}

/**
 * @param {object} m
 * @param {string} videoId
 * @param {number} at
 */
async function removeLater(m, videoId, at) {
  await m.datastores.later.removeAsync({ _id: videoId }, {})
  m.keeper.recordEvent({ at, type: 'later.removed', key: `later/${videoId}`, data: {} })
}

/**
 * This machine's Later list, in the order it is in
 * @param {object} m
 * @returns {Promise<string[]>}
 */
async function laterOrder(m) {
  const records = await m.datastores.later.findAsync({})

  return records
    .sort((one, other) => (one.position - other.position) || (one._id < other._id ? -1 : 1))
    .map(record => record._id)
}

/**
 * Both machines running on a folder each has an archive of, which is where
 * every test but the first meeting starts: the archive a machine writes at
 * its first tick is its own, so the one that arrives next is never merged in
 * as a first meeting.
 * @param {object[]} machines
 * @param {{ carry: () => void }} carrier
 */
async function settled(machines, carrier) {
  for (const m of machines) {
    await m.keeper.start()
  }

  await ticks(machines, carrier, 2)
}

/**
 * Past the archiving threshold and over it: the first tick writes a state
 * file too big to leave alone, the second writes the archive and starts a new
 * segment. Three long records, as a 2 MB one would not fit a datastore line.
 * @param {object} m
 * @param {string} mark what to call them, so two rounds of this do not collide
 */
async function archiveNow(m, mark) {
  const long = 'x'.repeat(800_000)

  for (const videoId of [`${mark}1`, `${mark}2`, `${mark}3`]) {
    await m.datastores.history.insertAsync(historyEntry(videoId, { description: long }))
  }

  await m.keeper.tick()

  await m.datastores.searchHistory.insertAsync({ _id: `search-${mark}`, name: mark })
  await m.keeper.tick()
}

// #endregion the harness

describe('several machines on one folder', () => {
  describe('delivery', () => {
    /**
     * The same intents on both machines, made one at a time with each
     * machine's state carried over, under a delivery of the test's choosing
     * @param {string} home
     * @param {Record<string, number>} delays
     */
    async function bothMachines(home, delays) {
      const a = await machine('a', { home })
      const b = await machine('b', { home })
      const carrier = sync(a, b)

      for (const [name, carries] of Object.entries(delays)) {
        carrier.hold(name, carries)
      }

      await a.keeper.start()
      await b.keeper.start()

      await addLater(a, 'aaaaaaaaaaa', T)
      await ticks([a, b], carrier, 1)

      await addLater(b, 'bbbbbbbbbbb', T + 1000)
      await ticks([a, b], carrier, 1)

      await addLater(a, 'ccccccccccc', T + 2000)
      await ticks([a, b], carrier, 1)

      await removeLater(b, 'bbbbbbbbbbb', T + 3000)
      await ticks([a, b], carrier, 8)

      return { a: await laterOrder(a), b: await laterOrder(b) }
    }

    it('reaches the same records on both machines however long each file is held back', SLOW, async () => {
      const segments = { a: segmentName(idOf('a'), 0), b: segmentName(idOf('b'), 0) }
      const states = { a: `state-${idOf('a')}.json`, b: `state-${idOf('b')}.json` }

      const deliveries = {
        prompt: {},
        aLast: { [segments.a]: 5, [states.a]: 4, [segments.b]: 1, [states.b]: 0 },
        bLast: { [segments.b]: 5, [states.b]: 3, [segments.a]: 2, [states.a]: 1 },
      }

      const outcomes = {}

      for (const [name, delays] of Object.entries(deliveries)) {
        outcomes[name] = await bothMachines(path.join(root, name), delays)
      }

      expect(outcomes.prompt).toEqual({ a: ['ccccccccccc', 'aaaaaaaaaaa'], b: ['ccccccccccc', 'aaaaaaaaaaa'] })
      expect(outcomes.aLast).toEqual(outcomes.prompt)
      expect(outcomes.bLast).toEqual(outcomes.prompt)
    })

    it('reaches the same records when a newer file arrives before an older one', SLOW, async () => {
      const a = await machine('a')
      const b = await machine('b')
      const carrier = sync(a, b)

      await settled([a, b], carrier)

      await addLater(a, 'aaaaaaaaaaa', T)
      await addLater(a, 'ccccccccccc', T + 1000)
      await a.keeper.tick()

      await archiveNow(a, 'roll')

      await addLater(a, 'ddddddddddd', T + 2000)
      await a.keeper.tick()

      expect(readSegment(readFileSync(segmentIn(a, 'a', 2), 'utf8')).events.map(event => event.key)).toEqual(['later/ddddddddddd'])

      // The sync tool gets to the second segment first, and the first one is
      // still on its way
      carrier.hold(segmentName(idOf('a'), 1), 3)
      carrier.carry()
      await b.keeper.tick()

      expect(existsSync(segmentIn(b, 'a', 2))).toBe(true)
      expect(existsSync(segmentIn(b, 'a', 1))).toBe(false)
      expect(await laterOrder(b)).toEqual([])

      await ticks([a, b], carrier, 5)

      expect(await laterOrder(b)).toEqual(['ddddddddddd', 'ccccccccccc', 'aaaaaaaaaaa'])
      expect(await laterOrder(b)).toEqual(await laterOrder(a))
    })

    it('matches a machine on today\'s archive from a machine on last week\'s', SLOW, async () => {
      const a = await machine('a')
      const b = await machine('b')
      const carrier = sync(a, b)

      await a.keeper.start()
      await addLater(a, 'aaaaaaaaaaa', T)
      await archiveNow(a, 'week1')

      const lastWeek = stateOf(a).archive

      // b meets the folder on the only archive there is, and never receives
      // the one a writes next
      carrier.carry()
      await b.keeper.start()
      await b.keeper.tick()

      await addLater(a, 'ccccccccccc', T + 1000)
      await archiveNow(a, 'week2')
      await addLater(a, 'ddddddddddd', T + 2000)

      const today = stateOf(a).archive
      expect(today).not.toBe(lastWeek)

      carrier.hold(`base-${today.slice(0, 16)}.json.gz`, 99)
      await ticks([a, b], carrier, 4)

      expect(stateOf(b).archive).toBe(lastWeek)
      expect(stateOf(a).archive).toBe(today)
      expect(await laterOrder(b)).toEqual(['ddddddddddd', 'ccccccccccc', 'aaaaaaaaaaa'])
      expect(await laterOrder(b)).toEqual(await laterOrder(a))
    })

    // The keeper cannot do this yet, and the test stays as it is. A machine
    // reads another machine's archive once, when it first meets the folder.
    // A state field folded into an archive while this machine's delivery was
    // down reaches it no other way, so it keeps last week's value for good.
    // Mending it wants either a change time on state records that survives
    // being applied elsewhere, or a take in of an archive that folded more
    // than this machine's. Neither is decided. Recorded in
    // `.scratch/evented-sync/run/decision-later-ordering.md`.
    it.skip('turns staleness into the current value when an archive arrives after the state file naming it', SLOW, async () => {
      const a = await machine('a')
      const b = await machine('b')
      const carrier = sync(a, b)

      await settled([a, b], carrier)

      await a.datastores.history.insertAsync(historyEntry('aaaaaaaaaaa', { watchProgress: 30 }))
      await ticks([a, b], carrier, 2)

      expect((await b.datastores.history.findOneAsync({ _id: 'aaaaaaaaaaa' })).watchProgress).toBe(30)

      // b hears nothing while a watches on and folds what it watched into an
      // archive, so the value b has is last week's
      await a.datastores.history.updateAsync({ _id: 'aaaaaaaaaaa' }, { $set: { watchProgress: 90 } }, {})
      await a.keeper.tick()
      await archiveNow(a, 'fold')

      const today = `base-${stateOf(a).archive.slice(0, 16)}.json.gz`

      carrier.hold(today, 2)
      await ticks([a, b], carrier, 2)

      expect(existsSync(path.join(b.folder, today))).toBe(false)
      expect((await b.datastores.history.findOneAsync({ _id: 'aaaaaaaaaaa' })).watchProgress).toBe(30)

      await ticks([a, b], carrier, 3)

      expect(existsSync(path.join(b.folder, today))).toBe(true)
      expect((await b.datastores.history.findOneAsync({ _id: 'aaaaaaaaaaa' })).watchProgress).toBe(90)
    })

    it('lets the machine that changed a state field win over one that writes the same value again', SLOW, async () => {
      const a = await machine('a')
      const b = await machine('b')
      const carrier = sync(a, b)

      await settled([a, b], carrier)

      await a.datastores.history.insertAsync(historyEntry('aaaaaaaaaaa', { watchProgress: 30 }))
      await ticks([a, b], carrier, 2)

      expect((await b.datastores.history.findOneAsync({ _id: 'aaaaaaaaaaa' })).watchProgress).toBe(30)

      // The video is watched further on b. a knows nothing of it yet and
      // writes its own state file again for a reason of its own. It still has
      // 30, and saying so now must not beat the 90 b wrote a moment ago
      await b.datastores.history.updateAsync({ _id: 'aaaaaaaaaaa' }, { $set: { watchProgress: 90 } }, {})
      await b.keeper.tick()

      // Restarted, so the times it published come back from its own state
      // file and not from a memory that would have gone with the app
      a.restart()
      await a.keeper.start()

      await addLater(a, 'ccccccccccc', T)
      await a.keeper.tick()

      await ticks([a, b], carrier, 3)

      expect((await a.datastores.history.findOneAsync({ _id: 'aaaaaaaaaaa' })).watchProgress).toBe(90)
      expect((await b.datastores.history.findOneAsync({ _id: 'aaaaaaaaaaa' })).watchProgress).toBe(90)
    })

    it('loses nothing when one machine\'s delivery stops for a day and then resumes', SLOW, async () => {
      const a = await machine('a')
      const b = await machine('b')
      const carrier = sync(a, b)

      await a.keeper.start()
      await b.keeper.start()

      await addLater(a, 'aaaaaaaaaaa', T)
      await addLater(b, 'bbbbbbbbbbb', T + 1000)
      await ticks([a, b], carrier, 2)

      expect(await laterOrder(b)).toEqual(['bbbbbbbbbbb', 'aaaaaaaaaaa'])

      // A day of a's, with an archive in it, that nothing carries
      await addLater(a, 'ccccccccccc', T + 2000)
      await a.keeper.tick()
      await archiveNow(a, 'day')
      await addLater(a, 'ddddddddddd', T + 3000)
      await removeLater(a, 'aaaaaaaaaaa', T + 4000)
      await a.keeper.tick()

      expect(await laterOrder(b)).toEqual(['bbbbbbbbbbb', 'aaaaaaaaaaa'])

      await ticks([a, b], carrier, 4)

      expect(await laterOrder(b)).toEqual(['ddddddddddd', 'ccccccccccc', 'bbbbbbbbbbb'])
      expect(await laterOrder(b)).toEqual(await laterOrder(a))
    })

    it('takes a segment whose last line is half written on the tick after it is finished', SLOW, async () => {
      const a = await machine('a')
      const b = await machine('b')
      const carrier = sync(a, b)

      await settled([a, b], carrier)

      await addLater(a, 'aaaaaaaaaaa', T)
      await addLater(a, 'ccccccccccc', T + 1000)
      await a.keeper.tick()

      const whole = readFileSync(segmentIn(a, 'a', 1), 'utf8')

      // The sync tool copies the segment while a is still appending to it
      carrier.half(segmentName(idOf('a'), 1), whole.length - 20)
      carrier.carry()
      await b.keeper.tick()

      expect(readFileSync(segmentIn(b, 'a', 1), 'utf8')).not.toBe(whole)
      expect(await laterOrder(b)).toEqual(['aaaaaaaaaaa'])

      carrier.carry()
      await b.keeper.tick()

      expect(readFileSync(segmentIn(b, 'a', 1), 'utf8')).toBe(whole)
      expect(await laterOrder(b)).toEqual(['ccccccccccc', 'aaaaaaaaaaa'])
    })
  })

  describe('machines writing at once', () => {
    it('lets two machines archive in the same tick, and keeps both archives', SLOW, async () => {
      const a = await machine('a')
      const b = await machine('b')
      const carrier = sync(a, b)

      await a.keeper.start()
      await b.keeper.start()

      await addLater(a, 'aaaaaaaaaaa', T)
      await addLater(b, 'bbbbbbbbbbb', T + 1000)

      // Each sees a folder of its own, so each writes an archive of its own
      await archiveNow(a, 'both')
      await archiveNow(b, 'both')

      const theirs = { a: archivesIn(a), b: archivesIn(b) }
      expect(theirs.a).toHaveLength(1)
      expect(theirs.b).toHaveLength(1)
      expect(theirs.a).not.toEqual(theirs.b)

      await ticks([a, b], carrier, 3)

      for (const m of [a, b]) {
        expect(archivesIn(m)).toEqual(expect.arrayContaining([...theirs.a, ...theirs.b]))
      }

      expect(await laterOrder(a)).toEqual(['bbbbbbbbbbb', 'aaaaaaaaaaa'])
      expect(await laterOrder(b)).toEqual(['bbbbbbbbbbb', 'aaaaaaaaaaa'])
    })

    it('reaches one list with three machines adding to it at once', SLOW, async () => {
      const a = await machine('a')
      const b = await machine('b')
      const c = await machine('c')
      const carrier = sync(a, b, c)

      for (const m of [a, b, c]) {
        await m.keeper.start()
      }

      await addLater(a, 'aaaaaaaaaaa', T)
      await addLater(b, 'bbbbbbbbbbb', T + 1000)
      await addLater(c, 'ccccccccccc', T + 2000)

      carrier.hold(segmentName(idOf('a'), 0), 2)
      carrier.hold(segmentName(idOf('c'), 0), 4)

      await ticks([a, b, c], carrier, 8)

      const wanted = ['ccccccccccc', 'bbbbbbbbbbb', 'aaaaaaaaaaa']
      expect(await laterOrder(a)).toEqual(wanted)
      expect(await laterOrder(b)).toEqual(wanted)
      expect(await laterOrder(c)).toEqual(wanted)
    })
  })

  describe('losing the keeper\'s state', () => {
    it('rebuilds the index from an archive and the segments when the keeper\'s state is lost, with the data folder untouched', SLOW, async () => {
      const a = await machine('a')
      const b = await machine('b')
      const carrier = sync(a, b)

      // The archives are written before any of this, so neither has the
      // record, and what b works out again has to come from the segments
      await settled([a, b], carrier)

      await addLater(a, 'aaaaaaaaaaa', T)
      await ticks([a, b], carrier, 2)

      expect(await laterOrder(b)).toEqual(['aaaaaaaaaaa'])

      // It comes out again on b, which is the newer intent on that key
      await removeLater(b, 'aaaaaaaaaaa', T + 1000)
      await addLater(b, 'bbbbbbbbbbb', T + 2000)
      await ticks([a, b], carrier, 2)

      expect(await laterOrder(a)).toEqual(['bbbbbbbbbbb'])
      expect(await laterOrder(b)).toEqual(['bbbbbbbbbbb'])

      const before = await laterOrder(b)
      rmSync(path.join(backupsOf(b), 'keeper-state.json'))
      rmSync(path.join(backupsOf(b), 'intent-index.json'))

      b.restart()
      await b.keeper.start()
      await ticks([a, b], carrier, 2)

      expect(await laterOrder(b)).toEqual(before)
      expect(indexOf(b)['later/aaaaaaaaaaa']).toMatchObject({ at: T + 1000, by: idOf('b') })
      expect(await laterOrder(a)).toEqual(['bbbbbbbbbbb'])
    })
  })
})
