import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import Datastore from '@seald-io/nedb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isBaseFileName, SYNC_FILE_NAME } from '../../renderer/helpers/keptBackup'
import { createKeeper, LOCK_FILE_NAME, STATE_FILE_NAME, TEMP_PREFIX, watchDatastores } from './keeper'
import { runKeeperJob } from './keeperWorker'

// Several keepers on one folder, and crashes (spec, "Testing decisions").
// Each keeper has its own data folder, datastores, state file and clock, and
// a file system that can hold one of its operations at a chosen step: released,
// another keeper acts in between; never released, it is a crash, and a fresh
// keeper on the same data folder is the restart. Nothing waits on real time:
// ages are set on the files' modified times, against clocks near the real one.

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** Older than the two minutes after which a lock is stale */
const STALE = 2 * MINUTE + 10_000

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

const OLD = ['h1']
const NEW = ['h1', 'h2']

let root
let keepers

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'fjernsyn-keepers-'))
  keepers = []
})

afterEach(async () => {
  // A crashed keeper's log is not held, so every log can be let finish
  await Promise.all(keepers.map(keeper => keeper.flushLog()))
  rmSync(root, { recursive: true, force: true })
})

// #region the harness

function historyEntry(videoId) {
  return { videoId, title: `Video ${videoId}`, author: 'Synthetic Channel', authorId: 'UCsynthetic', published: 1700000000000, description: 'A synthetic description', viewCount: 10, lengthSeconds: 60, watchProgress: 30, timeWatched: 1, isLive: false, type: 'video' }
}

/**
 * node:fs/promises, where an operation matching a hold stops before or after
 * it runs until the hold is released
 */
function heldFileSystem() {
  const holds = []

  async function gate(when, op, args) {
    const index = holds.findIndex(hold => hold.when === when && hold.match(op, args))
    if (index === -1) { return }

    const [hold] = holds.splice(index, 1)
    hold.arrive()
    await hold.released
  }

  const fileSystem = {}
  for (const [op, original] of Object.entries(fsp)) {
    fileSystem[op] = typeof original !== 'function'
      ? original
      : async (...args) => {
        await gate('before', op, args)
        const result = await original(...args)
        await gate('after', op, args)
        return result
      }
  }

  /**
   * @param {'before' | 'after'} when
   * @param {(op: string, args: any[]) => boolean} match
   */
  function hold(when, match) {
    const entry = { when, match }
    const reached = new Promise((resolve) => { entry.arrive = resolve })
    let release
    entry.released = new Promise((resolve) => { release = resolve })
    holds.push(entry)
    return { reached, release }
  }

  return { fileSystem, hold }
}

const named = (file, test) => typeof file === 'string' && test(path.basename(file))
const inBackupFolder = file => path.basename(path.dirname(file)) !== 'backups'

/** The steps a write can be held at, by operation and path */
const at = {
  lockMade: (op, [file, , options]) => op === 'writeFile' && named(file, name => name === LOCK_FILE_NAME) && options?.flag === 'wx',
  lockOverwritten: (op, [file, , options]) => op === 'writeFile' && named(file, name => name === LOCK_FILE_NAME) && options?.flag !== 'wx',
  lockRemoved: (op, [file]) => op === 'rm' && named(file, name => name === LOCK_FILE_NAME),
  /** @param {'base' | 'sync'} kind the base's is gzipped bytes, the sync file's text */
  tempWritten: kind => (op, [file, data]) => op === 'writeFile' && named(file, name => name.startsWith(TEMP_PREFIX)) && inBackupFolder(file) && (typeof data === 'string') === (kind === 'sync'),
  baseRenamed: (op, [, to]) => op === 'rename' && named(to, isBaseFileName),
  baseRemoved: (op, [file]) => op === 'rm' && named(file, isBaseFileName),
  syncRead: (op, [file]) => op === 'readFile' && named(file, name => name === SYNC_FILE_NAME),
  syncRenamed: (op, [, to]) => op === 'rename' && named(to, name => name === SYNC_FILE_NAME),
  /** After the state file is renamed into place, with what it says */
  stateSaved: test => (op, [, to]) => op === 'rename' && named(to, name => name === STATE_FILE_NAME) && test(JSON.parse(readFileSync(to, 'utf8'))),
}

/**
 * A machine: its data folder, made the first time and opened again after, as
 * a restart does, with a keeper of its own on the backup folder
 * @param {string} name
 * @param {{ folder?: string, history?: string[], clockOffset?: number }} [options]
 */
async function machine(name, { folder = 'kept', history = [], clockOffset = 0 } = {}) {
  const dataFolder = path.join(root, name)
  const fresh = !existsSync(dataFolder)
  const datastores = {}

  for (const [section, file] of Object.entries(DATASTORE_FILES)) {
    datastores[section] = new Datastore({ filename: path.join(dataFolder, `${file}.db`) })
    await datastores[section].loadDatabaseAsync()
  }

  if (fresh) {
    mkdirSync(path.join(root, folder), { recursive: true })
    await datastores.profiles.insertAsync(MAIN_PROFILE)
    await datastores.settings.insertAsync({ _id: 'backupFolder', value: path.join(root, folder) })
    await datastores.history.insertAsync(history.map(historyEntry))
  }

  const { fileSystem, hold } = heldFileSystem()

  const m = { name, dataFolder, datastores, hold, rebase: false }
  m.keeper = createKeeper({
    datastores,
    dataFolder,
    appVersion: '0.1.0',
    installationId: `installation-${name}`,
    machineName: `MACHINE-${name}`,
    // A rebase on request, as the worker does once the sync file is too large
    runJob: async job => runKeeperJob(m.rebase && job.type === 'build' ? { ...job, forceRebase: true } : job),
    relaunch: () => {},
    fileSystem,
    now: () => Date.now() + clockOffset,
    sleep: async () => {},
  })

  watchDatastores(datastores, () => m.keeper.markChanged())
  keepers.push(m.keeper)

  return m
}

/** A machine that has written its history to the folder */
async function written(name = 'a', history = OLD) {
  const m = await machine(name, { history })
  await m.keeper.start()
  await m.keeper.tick()
  return m
}

/** a has written, b has taken it in, and both have a change of their own */
async function both() {
  const a = await written()
  const b = await machine('b')
  await b.keeper.start()
  await a.datastores.history.insertAsync(historyEntry('a2'))
  await b.datastores.history.insertAsync(historyEntry('b2'))
  return { a, b }
}

async function watched(m) {
  return (await m.datastores.history.findAsync({})).map(entry => entry.videoId).sort()
}

async function logOf(m) {
  await m.keeper.flushLog()
  return readFileSync(path.join(m.dataFolder, 'backups', 'keeper.log'), 'utf8')
}

let readers = 0

/** What a keeper starting now takes in from the folder */
async function readerSees() {
  const reader = await machine(`reader-${++readers}`)
  await reader.keeper.start()
  expect(reader.keeper.status()).toMatchObject({ ready: true, arriving: null, pause: null })
  return watched(reader)
}

const folderPath = (folder = 'kept') => path.join(root, folder)
const files = (folder = 'kept') => readdirSync(folderPath(folder)).sort()
const syncText = (folder = 'kept') => readFileSync(path.join(folderPath(folder), SYNC_FILE_NAME), 'utf8')
const lockFile = () => path.join(folderPath(), LOCK_FILE_NAME)

function kindOf(name) {
  if (name === LOCK_FILE_NAME) { return 'lock' }
  if (name.startsWith(TEMP_PREFIX)) { return 'temp' }
  return isBaseFileName(name) ? 'base' : name
}

/** @param {string} file @param {number} ms how old its modified time makes it */
function age(file, ms) {
  const time = (Date.now() - ms) / 1000
  utimesSync(file, time, time)
}

/** As a sync tool carries a folder: every file copied over, times kept */
function syncTool(from, to) {
  cpSync(folderPath(from), folderPath(to), { recursive: true, preserveTimestamps: true })
}

// #endregion the harness

describe('reading while another keeper writes', () => {
  it.each([
    ['after the lock is made', 'after', at.lockMade, OLD],
    ['after the new base\'s temporary file', 'after', at.tempWritten('base'), OLD],
    ['after the new base is renamed into place', 'after', at.baseRenamed, OLD],
    ['after the pending hash is recorded', 'after', at.stateSaved(state => state.pending !== null), OLD],
    ['after the sync file\'s temporary file', 'after', at.tempWritten('sync'), OLD],
    ['after the sync file is renamed into place', 'after', at.syncRenamed, NEW],
    ['after last seen is saved', 'after', at.stateSaved(state => state.pending === null), NEW],
    ['before the lock is removed', 'before', at.lockRemoved, NEW],
    ['before the old base is removed', 'before', at.baseRemoved, NEW],
  ])('a keeper starting %s takes in one whole state', async (_, when, match, sees) => {
    const a = await written()
    await a.datastores.history.insertAsync(historyEntry('h2'))
    a.rebase = true

    const held = a.hold(when, match)
    const writing = a.keeper.tick()
    await held.reached

    expect(await readerSees()).toEqual(sees)

    held.release()
    await writing

    expect(a.keeper.status()).toMatchObject({ pause: null, failure: null })
    expect(await readerSees()).toEqual(NEW)
  })

  it('the old base removed between reading the sync file and its base: reads the sync file again and takes in the new pair, without waiting', async () => {
    const a = await written()
    const [oldBase] = files().filter(isBaseFileName)
    await a.datastores.history.insertAsync(historyEntry('h2'))
    a.rebase = true

    const reader = await machine('reader')
    const held = reader.hold('after', at.syncRead)
    const starting = reader.keeper.start()
    await held.reached

    await a.keeper.tick()
    expect(files()).not.toContain(oldBase)

    held.release()
    await starting

    expect(reader.keeper.status()).toMatchObject({ ready: true, arriving: null, pause: null, tookIn: { machineName: 'MACHINE-a' } })
    expect(await watched(reader)).toEqual(NEW)
    expect(await logOf(reader)).not.toMatch(/not in the folder/)
  })
})

describe('writers at once', () => {
  it.each([
    ['b ticks while a holds the lock', /lock held by MACHINE-a; skipping this tick/, async (a, b) => {
      const held = a.hold('after', at.lockMade)
      const writing = a.keeper.tick()
      await held.reached
      await b.keeper.tick()
      held.release()
      await writing
    }],
    ['b reaches the lock while a holds it', /lock held by MACHINE-a; not writing/, async (a, b) => {
      const bHeld = b.hold('before', at.lockMade)
      const bTick = b.keeper.tick()
      await bHeld.reached
      const aHeld = a.hold('after', at.lockMade)
      const aTick = a.keeper.tick()
      await aHeld.reached
      bHeld.release()
      await bTick
      aHeld.release()
      await aTick
    }],
    ['a writes between b reading the sync file and b taking the lock', /sync file changed while building/, async (a, b) => {
      const bHeld = b.hold('before', at.lockMade)
      const bTick = b.keeper.tick()
      await bHeld.reached
      await a.keeper.tick()
      bHeld.release()
      await bTick
    }],
  ])('two keepers ticking together, %s: one writes, the other does not, and pauses on its next tick', async (_, logged, play) => {
    const { a, b } = await both()

    await play(a, b)

    expect(JSON.parse(syncText()).machineName).toBe('MACHINE-a')
    expect(b.keeper.status().pause).toBeNull()
    expect(await logOf(b)).toMatch(logged)

    await b.keeper.tick()
    await a.keeper.tick()

    expect(b.keeper.status().pause).toMatchObject({ reason: 'otherMachine', machineName: 'MACHINE-a' })
    expect(a.keeper.status().pause).toBeNull()
    expect(await watched(b)).toEqual(['b2', 'h1'])
  })

  it.each(['a', 'b'])('two keepers taking over one stale lock at once: only the last to overwrite it goes on (%s reads it back first)', async (first) => {
    const { a, b } = await both()
    writeFileSync(lockFile(), JSON.stringify({ token: 'gone', installationId: 'installation-gone', machineName: 'MACHINE-gone', time: new Date().toISOString() }))
    age(lockFile(), 3 * MINUTE)

    const holds = {}
    const ticks = {}
    for (const m of [a, b]) {
      holds[m.name] = { before: m.hold('before', at.lockOverwritten), after: m.hold('after', at.lockOverwritten) }
      ticks[m.name] = m.keeper.tick()
      await holds[m.name].before.reached
    }

    // Both have found the lock stale; both overwrite it, b last, before either reads it back
    for (const m of [a, b]) {
      holds[m.name].before.release()
      await holds[m.name].after.reached
    }

    for (const name of first === 'a' ? ['a', 'b'] : ['b', 'a']) {
      holds[name].after.release()
      await ticks[name]
    }

    expect(JSON.parse(syncText()).machineName).toBe('MACHINE-b')
    expect(existsSync(lockFile())).toBe(false)

    const [aLog, bLog] = [await logOf(a), await logOf(b)]
    expect(aLog).toMatch(/stale lock of MACHINE-gone taken over/)
    expect(aLog).toMatch(/lock lost to another keeper; not writing/)
    // Only its first write, before the stale lock
    expect(aLog.match(/wrote sync file/g)).toHaveLength(1)
    expect(bLog).toMatch(/stale lock of MACHINE-gone taken over/)
    expect(bLog).not.toMatch(/lock lost/)

    await a.keeper.tick()
    await b.keeper.tick()
    expect(a.keeper.status().pause).toMatchObject({ reason: 'otherMachine', machineName: 'MACHINE-b' })
    expect(b.keeper.status().pause).toBeNull()
  })

  it('a stale lock taken over after the other keeper has read it back: both write, the last rename wins, and the other pauses on its next tick', async () => {
    // The read back cannot catch this order; the pause on a lost write does
    const { a, b } = await both()
    writeFileSync(lockFile(), JSON.stringify({ token: 'gone', installationId: 'installation-gone', machineName: 'MACHINE-gone', time: new Date().toISOString() }))
    age(lockFile(), 3 * MINUTE)

    const aStale = a.hold('before', at.lockOverwritten)
    const bStale = b.hold('before', at.lockOverwritten)
    const aTick = a.keeper.tick()
    await aStale.reached
    const bTick = b.keeper.tick()
    await bStale.reached

    const aRename = a.hold('before', at.syncRenamed)
    aStale.release()
    await aRename.reached

    const bUnlock = b.hold('before', at.lockRemoved)
    bStale.release()
    await bUnlock.reached

    aRename.release()
    await aTick
    bUnlock.release()
    await bTick

    expect(JSON.parse(syncText()).machineName).toBe('MACHINE-a')
    expect(existsSync(lockFile())).toBe(false)
    expect(await logOf(a)).toMatch(/lock now held by MACHINE-b; left in place/)

    await a.keeper.tick()
    await b.keeper.tick()
    expect(a.keeper.status().pause).toBeNull()
    expect(b.keeper.status().pause).toMatchObject({ reason: 'otherMachine', machineName: 'MACHINE-a' })
  })

  it.each([2, 3])('one keeper\'s files copied over the others\', as a sync tool would, with %i keepers: each lost write pauses, the winning one carries on', async (count) => {
    const a = await machine('a', { folder: 'kept-a', history: OLD })
    await a.keeper.start()
    await a.keeper.tick()

    const others = []
    for (const name of ['b', 'c'].slice(0, count - 1)) {
      syncTool('kept-a', `kept-${name}`)
      const m = await machine(name, { folder: `kept-${name}` })
      await m.keeper.start()
      expect(await watched(m)).toEqual(OLD)
      others.push(m)
    }

    for (const m of [a, ...others]) {
      await m.datastores.history.insertAsync(historyEntry(`${m.name}2`))
      await m.keeper.tick()
      expect(m.keeper.status()).toMatchObject({ pause: null, failure: null })
    }

    for (const m of others) {
      syncTool('kept-a', `kept-${m.name}`)
      await m.keeper.tick()
      expect(m.keeper.status().pause).toMatchObject({ reason: 'otherMachine', machineName: 'MACHINE-a' })
      expect(await watched(m)).toEqual([`${m.name}2`, 'h1'])
    }

    const before = syncText('kept-a')
    await a.datastores.history.insertAsync(historyEntry('a3'))
    await a.keeper.tick()
    expect(a.keeper.status()).toMatchObject({ pause: null, failure: null })
    expect(syncText('kept-a')).not.toBe(before)
  })
})

describe('crashed writes', () => {
  /**
   * a writes h1, then crashes at a step of writing h2
   * @returns {Promise<string[]>} the folder's files before the crash
   */
  async function crashedWrite(when, match, { rebase = false } = {}) {
    const a = await written()
    await a.datastores.history.insertAsync(historyEntry('h2'))
    a.rebase = rebase

    const before = files()
    const held = a.hold(when, match)
    a.keeper.tick()
    await held.reached
    return before
  }

  for (const { after, when, match, rebase, left, takenIn, restart } of [
    { after: 'taking the lock', when: 'after', match: at.lockMade, left: ['lock'], takenIn: OLD, restart: /is last seen/ },
    { after: 'writing a temporary file', when: 'after', match: at.tempWritten('sync'), left: ['lock', 'temp'], takenIn: OLD, restart: /removed leftover temporary file \.fjernsyn-tmp-installation-a-/ },
    { after: 'writing a new base, before the sync file', when: 'after', match: at.baseRenamed, rebase: true, left: ['base', 'lock'], takenIn: OLD, restart: /is last seen/ },
    { after: 'recording the pending hash, before the rename', when: 'after', match: at.stateSaved(state => state.pending !== null), left: ['lock'], takenIn: OLD, restart: /is last seen/ },
    { after: 'the rename, before last seen is saved', when: 'after', match: at.syncRenamed, left: ['lock'], takenIn: NEW, restart: /is the pending one: now last seen/ },
    { after: 'the rename, before the lock is removed', when: 'before', match: at.lockRemoved, left: ['lock'], takenIn: NEW, restart: /is last seen/ },
  ]) {
    it(`crashed after ${after}: another keeper's start takes in the ${takenIn === OLD ? 'old' : 'new'} state, the lock holds off both ticks for two minutes, then neither pauses`, async () => {
      const before = await crashedWrite(when, match, { rebase })
      expect(files().filter(name => !before.includes(name)).map(kindOf).sort()).toEqual(left)
      const afterCrash = syncText()

      // Another keeper's start, within the two minutes
      const b = await machine('b')
      await b.keeper.start()
      expect(b.keeper.status()).toMatchObject({ ready: true, arriving: null, pause: null })
      expect(await watched(b)).toEqual(takenIn)

      // The same keeper's restart
      const a = await machine('a')
      await a.keeper.start()
      expect(a.keeper.status()).toMatchObject({ ready: true, arriving: null, pause: null })
      expect(await watched(a)).toEqual(NEW)
      expect(files().map(kindOf)).not.toContain('temp')

      for (const m of [b, a]) {
        await m.keeper.tick()
      }
      expect(syncText()).toBe(afterCrash)

      age(lockFile(), STALE)

      for (const m of [b, a]) {
        await m.keeper.tick()
        expect(m.keeper.status()).toMatchObject({ pause: null, failure: null })
      }

      expect(await readerSees()).toEqual(NEW)

      const [aLog, bLog] = [await logOf(a), await logOf(b)]
      expect(bLog).toMatch(/startup: a fresh lock by MACHINE-a/)
      expect(bLog).toMatch(/lock held by MACHINE-a; skipping this tick/)
      expect(aLog).toMatch(restart)
      expect(aLog).toMatch(/lock held by MACHINE-a; skipping this tick/)
    })
  }

  it('crashed after taking the lock: the next write after two minutes takes the stale lock over', async () => {
    await crashedWrite('after', at.lockMade)
    age(lockFile(), STALE)

    const a = await machine('a')
    await a.keeper.start()
    await a.keeper.tick()

    expect(await logOf(a)).toMatch(/stale lock of MACHINE-a taken over/)
    expect(existsSync(lockFile())).toBe(false)
    expect(await readerSees()).toEqual(NEW)
  })

  it('a start within two minutes of a crash, the folder not reading cleanly: no take in, and ready without asking', async () => {
    await crashedWrite('after', at.lockMade)

    // The sync tool carries in another machine's sync file ahead of its base
    const c = await machine('c', { folder: 'kept-c', history: ['c1'] })
    await c.keeper.start()
    await c.keeper.tick()
    cpSync(path.join(folderPath('kept-c'), SYNC_FILE_NAME), path.join(folderPath(), SYNC_FILE_NAME))

    const b = await machine('b')
    await b.keeper.start()

    expect(b.keeper.status()).toMatchObject({ ready: true, arriving: null, pause: null, tookIn: null })
    expect(await watched(b)).toEqual([])
    expect(await logOf(b)).toMatch(/a fresh lock, and the folder does not read cleanly \(baseMissing\): no take in/)
  })

  it('crashed after writing a temporary file: another keeper leaves it until it is a day old, then removes it at its start', async () => {
    await crashedWrite('after', at.tempWritten('sync'))
    const [temp] = files().filter(name => name.startsWith(TEMP_PREFIX))

    const b = await machine('b')
    await b.keeper.start()
    expect(files()).toContain(temp)

    age(path.join(folderPath(), temp), DAY + MINUTE)

    const restarted = await machine('b')
    await restarted.keeper.start()
    expect(files()).not.toContain(temp)
    expect(await logOf(restarted)).toMatch(`removed leftover temporary file ${temp}`)
  })

  it('crashed after writing a new base: the orphaned base is kept for seven days, then removed by a rebase', async () => {
    const before = await crashedWrite('after', at.baseRenamed, { rebase: true })
    const [oldBase] = before.filter(isBaseFileName)
    const [orphan] = files().filter(name => isBaseFileName(name) && name !== oldBase)
    age(lockFile(), STALE)

    const a = await machine('a')
    a.rebase = true
    await a.keeper.start()
    await a.datastores.history.insertAsync(historyEntry('h3'))
    await a.keeper.tick()

    // The base the sync file pointed to goes at once; the orphan, too young, stays
    expect(files()).not.toContain(oldBase)
    expect(files()).toContain(orphan)
    expect(files().filter(isBaseFileName)).toHaveLength(2)

    age(path.join(folderPath(), orphan), 7 * DAY + MINUTE)
    await a.datastores.history.insertAsync(historyEntry('h4'))
    await a.keeper.tick()

    expect(files().filter(isBaseFileName)).toHaveLength(1)
    expect(files()).not.toContain(orphan)
    expect(await readerSees()).toEqual(['h1', 'h2', 'h3', 'h4'])
  })

  it('crashed while a take in replaces the sections: the next start takes in again, and the first safety copy stays', async () => {
    const a = await written()
    const b = await machine('b', { history: ['b1'] })

    // The history's insert never returns: profiles are replaced, history emptied
    let crashed
    const reached = new Promise((resolve) => { crashed = resolve })
    b.datastores.history.insertAsync = () => {
      crashed()
      return new Promise(() => {})
    }
    b.keeper.start()
    await reached
    // The removal queued before it is on disk
    await b.datastores.history.countAsync({})

    const backups = path.join(b.dataFolder, 'backups')
    const copies = () => readdirSync(backups).filter(name => name.startsWith('before-restore-')).sort()
    const [first] = copies()
    const firstText = readFileSync(path.join(backups, first), 'utf8')
    expect(JSON.parse(firstText).sections.history.map(entry => entry.videoId)).toEqual(['b1'])

    // A second later, as a safety copy is named by the second
    const restarted = await machine('b', { clockOffset: 2000 })
    expect(await watched(restarted)).toEqual([])
    await restarted.keeper.start()

    expect(restarted.keeper.status()).toMatchObject({ ready: true, pause: null, tookIn: { machineName: 'MACHINE-a' } })
    expect(await watched(restarted)).toEqual(OLD)
    expect(copies()).toHaveLength(2)
    expect(copies()[0]).toBe(first)
    expect(readFileSync(path.join(backups, first), 'utf8')).toBe(firstText)

    const other = await machine('a')
    await other.keeper.start()
    for (const m of [restarted, other]) {
      await m.keeper.tick()
      expect(m.keeper.status()).toMatchObject({ pause: null, failure: null })
    }
    expect(a.keeper.status().pause).toBeNull()
  })
})
