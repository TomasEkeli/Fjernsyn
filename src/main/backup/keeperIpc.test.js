import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IpcChannels } from '../../constants'
import { readSegment, segmentName, writeEventLine } from '../../renderer/helpers/intentLog'
import { TICK_MS } from './keeper'

// The keeper as main wires it, with Electron, the worker thread and the
// sender check stood in for: in-memory datastores, a temporary data folder, a
// temporary backup folder, and the minute timer fired by hand. The writes go
// through the handler classes, as a window's do.

const electron = vi.hoisted(() => ({
  dataFolder: '',
  handlers: new Map(),
  listeners: new Map(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => electron.dataFolder },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel, handler) => electron.handlers.set(channel, handler),
    on: (channel, listener) => electron.listeners.set(channel, listener),
  },
}))

// A worker that cannot start, so the keeper's jobs run on this thread
vi.mock('worker_threads', () => ({
  parentPort: null,
  workerData: null,
  Worker: class {
    on(event, handler) {
      if (event === 'error') {
        setImmediate(() => handler(new Error('no worker thread in a test')))
      }
    }

    postMessage() {}
    unref() {}
  },
}))

vi.mock('../../datastores/index', async () => {
  const { default: Datastore } = await import('@seald-io/nedb')
  const names = ['settings', 'profiles', 'playlists', 'history', 'searchHistory', 'subscriptionCache', 'channels', 'aiVerdicts', 'later', 'communitySources', 'communityShares', 'communitySourceData']
  return Object.fromEntries(names.map(name => [name, new Datastore({ inMemoryOnly: true })]))
})

vi.mock('../utils', () => ({
  isFreeTubeUrl: url => url.startsWith('app://bundle/'),
}))

// Every tick the timer starts, so that a test waits for the work itself. The
// timer throws the promise away, and waiting for the file instead is a race a
// loaded machine loses.
const ticks = vi.hoisted(() => [])

vi.mock('./keeper', async (importOriginal) => {
  const actual = await importOriginal()

  return {
    ...actual,
    createKeeper: (deps) => {
      const keeper = actual.createKeeper(deps)

      return {
        ...keeper,
        tick: () => {
          const run = keeper.tick()
          ticks.push(run)
          return run
        },
      }
    },
  }
})

const APP = { senderFrame: { url: 'app://bundle/index.html' } }
const ELSEWHERE = { senderFrame: { url: 'https://example.com/' } }

const INSTALLATION_ID = 'installation-test'

let root
let datastores
let handlers
let registered

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['setInterval'] })
  ticks.length = 0
  electron.handlers.clear()
  electron.listeners.clear()
  root = mkdtempSync(path.join(os.tmpdir(), 'fjernsyn-keeper-ipc-'))
  electron.dataFolder = path.join(root, 'data')
  mkdirSync(electron.dataFolder)
  mkdirSync(keptFolder())
  datastores = await import('../../datastores/index')
  handlers = await import('../../datastores/handlers/base')
  registered = null

  // The datastores are made once for the file, so each test empties them
  for (const datastore of Object.values(datastores)) {
    await datastore.removeAsync({}, { multi: true })
  }
})

afterEach(async () => {
  await registered?.quit()
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

const keptFolder = () => path.join(root, 'kept')
const ownSegment = index => path.join(keptFolder(), segmentName(INSTALLATION_ID, index))

/** A Later record as the renderer makes one */
function laterItem(videoId, position) {
  return {
    _id: videoId,
    videoId,
    title: `Video ${videoId}`,
    author: 'Synthetic Channel',
    authorId: 'UCsynthetic',
    lengthSeconds: 60,
    viewCount: 10,
    published: 1700000000000,
    addedAt: 1764160000000,
    position,
    alarm: null,
  }
}

/** Main's own wiring, with the startup check done */
async function register() {
  await datastores.settings.insertAsync({ _id: 'backupFolder', value: keptFolder() })

  const { registerKeeper } = await import('./keeperIpc')

  registered = registerKeeper({
    installationId: Promise.resolve(INSTALLATION_ID),
    chooseDefaultFolder: vi.fn(),
  })

  await electron.handlers.get(IpcChannels.KEEPER_READY)(APP)
}

/** The window saying it has loaded every section */
function firstLoadDone(event = APP) {
  electron.listeners.get(IpcChannels.KEEPER_FIRST_LOAD_DONE)(event)
}

/** The minute timer, and the write it starts, waited for to its end */
async function tick() {
  await vi.advanceTimersByTimeAsync(TICK_MS)
  await Promise.all(ticks.splice(0))
}

function ownEvents() {
  if (!existsSync(ownSegment(0))) { return [] }

  return readSegment(readFileSync(ownSegment(0), 'utf8')).events
}

/** Another machine's intents, in its own segment in the folder */
function writeForeignEvents(events) {
  appendFileSync(path.join(keptFolder(), segmentName('installation-z', 0)), events.map(writeEventLine).join(''), 'utf8')
}

describe('the keeper in main', () => {
  it('carries a video put in Later to this machine\'s own segment', async () => {
    await register()
    firstLoadDone()

    const before = Date.now()
    await handlers.later.upsert(laterItem('aaaaaaaaaaa', 1000))
    await tick()

    expect(ownEvents()).toMatchObject([{
      seq: 1,
      by: INSTALLATION_ID,
      type: 'later.added',
      key: 'later/aaaaaaaaaaa',
      data: { after: null },
    }])
    // The time of the intent, which is what settles it against the other
    // machine's
    expect(ownEvents()[0].at).toBeGreaterThanOrEqual(before)
  })

  it('records nothing until the first load has finished', async () => {
    // The defaults seeding and the `favorites` id fixup write inside that
    // load, and neither is an intent. Later is the only evented section in
    // this part, so it is what the gate is shown on.
    await register()

    await handlers.later.upsert(laterItem('bbbbbbbbbbb', 1000))
    firstLoadDone()
    await handlers.later.upsert(laterItem('ccccccccccc', 2000))

    await tick()

    expect(ownEvents().map(event => event.key)).toEqual(['later/ccccccccccc'])
  })

  it('takes another machine\'s Later intents in without writing over a local write', async () => {
    await register()
    firstLoadDone()
    await handlers.later.upsert(laterItem('aaaaaaaaaaa', 1))
    await handlers.later.upsert(laterItem('bbbbbbbbbbb', 2))

    // A local write arms an alarm on the record the take in is moving, from
    // inside its first write. The apply holds the Later handler's queue, so
    // that write lands after it and is not written over by the copy the fold
    // read
    const alarm = { at: 1764170000000, armedAt: 1764160002000 }
    const updateAsync = datastores.later.updateAsync.bind(datastores.later)
    let armed = null
    datastores.later.updateAsync = async (...args) => {
      if (armed === null) {
        armed = handlers.later.updateAlarm('aaaaaaaaaaa', alarm)
        await new Promise(resolve => setImmediate(resolve))
      }

      return updateAsync(...args)
    }

    writeForeignEvents([
      { seq: 1, at: 1764160000000, by: 'installation-z', type: 'later.added', key: 'later/zzzzzzzzzzz', data: { after: 'later/bbbbbbbbbbb' } },
      { seq: 2, at: 1764160001000, by: 'installation-z', type: 'later.moved', key: 'later/aaaaaaaaaaa', data: { after: 'later/zzzzzzzzzzz' } },
    ])
    await tick()
    await armed

    const records = await datastores.later.findAsync({})
    const moved = records.find(record => record._id === 'aaaaaaaaaaa')

    expect(moved.alarm).toEqual(alarm)
    expect(moved.position).toBe(4)
    expect(records.map(record => record._id).sort()).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'zzzzzzzzzzz'])
  })

  it('lets no other frame say the first load has finished', async () => {
    await register()

    firstLoadDone(ELSEWHERE)
    await handlers.later.upsert(laterItem('ddddddddddd', 1000))

    firstLoadDone()
    await handlers.later.upsert(laterItem('eeeeeeeeeee', 2000))

    await tick()

    expect(ownEvents().map(event => event.key)).toEqual(['later/eeeeeeeeeee'])
  })
})
