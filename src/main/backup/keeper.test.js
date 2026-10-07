import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Datastore from '@seald-io/nedb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createKeeper, watchDatastores } from './keeper'
import { runKeeperJob } from './keeperWorker'

// Keepers on temporary folders, with real datastores and files, and the
// worker's jobs run inline

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

let root

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'fjernsyn-keeper-'))
})

afterEach(() => {
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

/**
 * A machine: its own data folder and datastores, on the shared backup folder
 * @param {string} name
 */
async function machine(name, { relaunch = () => {} } = {}) {
  const dataFolder = path.join(root, name)
  const datastores = {}

  for (const [section, file] of Object.entries(DATASTORE_FILES)) {
    datastores[section] = new Datastore({ filename: path.join(dataFolder, `${file}.db`) })
    await datastores[section].loadDatabaseAsync()
  }

  await datastores.profiles.insertAsync(MAIN_PROFILE)
  await datastores.settings.insertAsync({ _id: 'backupFolder', value: path.join(root, 'kept') })

  const statuses = []
  const keeper = createKeeper({
    datastores,
    dataFolder,
    appVersion: '0.1.0',
    installationId: `installation-${name}`,
    machineName: `MACHINE-${name}`,
    runJob: async job => runKeeperJob(job),
    relaunch,
    onStatus: status => statuses.push(status),
    sleep: async () => {},
  })

  watchDatastores(datastores, () => keeper.markChanged())

  return { datastores, dataFolder, keeper, statuses }
}

const keptFolder = () => path.join(root, 'kept')

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

    expect((await b.datastores.history.findAsync({})).map(entry => entry.videoId)).toEqual(['aaaaaaaaaaa'])
    expect(b.keeper.status().tookIn).toMatchObject({ machineName: 'MACHINE-a' })
    expect(readdirSync(path.join(b.dataFolder, 'backups')).some(name => name.startsWith('before-restore-'))).toBe(true)

    // b's change is written against a's base, and a, still running, pauses
    await b.datastores.history.insertAsync(historyEntry('bbbbbbbbbbb', 2))
    await b.keeper.tick()

    const sync = JSON.parse(readFileSync(path.join(keptFolder(), 'fjernsyn-sync.json'), 'utf8'))
    expect(sync.machineName).toBe('MACHINE-b')
    expect(sync.changes.history.put.map(entry => entry.videoId)).toEqual(['bbbbbbbbbbb'])

    await a.datastores.history.insertAsync(historyEntry('ccccccccccc', 3))
    await a.keeper.tick()

    expect(a.keeper.status().pause).toMatchObject({ reason: 'otherMachine', machineName: 'MACHINE-b' })

    await a.keeper.flushLog()
    expect(readFileSync(path.join(a.dataFolder, 'backups', 'keeper.log'), 'utf8')).toMatch(/paused: otherMachine/)
  })
})
