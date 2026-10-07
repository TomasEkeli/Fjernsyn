import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Datastore from '@seald-io/nedb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createKeeper, watchDatastores } from './keeper'
import { runKeeperJob } from './keeperWorker'

// Two machines on one folder, both running: each follows the other's writes
// by merging them, and asks nothing

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
  root = mkdtempSync(path.join(os.tmpdir(), 'fjernsyn-merge-'))
  mkdirSync(path.join(root, 'kept'))
})

afterEach(async () => {
  rmSync(root, { recursive: true, force: true })
})

function historyEntry(videoId, timeWatched, watchProgress = 30) {
  return {
    videoId,
    title: `Video ${videoId}`,
    author: 'Synthetic Channel',
    authorId: 'UCsynthetic',
    published: 1700000000000,
    description: 'A synthetic description',
    viewCount: 10,
    lengthSeconds: 600,
    watchProgress,
    timeWatched,
    isLive: false,
    type: 'video',
  }
}

async function machine(name) {
  const dataFolder = path.join(root, name)
  const datastores = {}

  for (const [section, file] of Object.entries(DATASTORE_FILES)) {
    datastores[section] = new Datastore({ filename: path.join(dataFolder, `${file}.db`) })
    await datastores[section].loadDatabaseAsync()
  }

  await datastores.profiles.insertAsync(MAIN_PROFILE)
  await datastores.settings.insertAsync({ _id: 'backupFolder', value: path.join(root, 'kept') })

  const m = { datastores, dataFolder, dataChanged: [] }
  m.keeper = createKeeper({
    datastores,
    dataFolder,
    appVersion: '0.1.0',
    installationId: `installation-${name}`,
    machineName: name,
    runJob: async job => runKeeperJob(job),
    onDataChanged: sections => m.dataChanged.push(sections),
    sleep: async () => {},
  })
  watchDatastores(datastores, () => m.keeper.markChanged())

  return m
}

async function history(m) {
  return (await m.datastores.history.findAsync({})).map(({ videoId, watchProgress }) => `${videoId}@${watchProgress}`).sort()
}

describe('two machines running at once', () => {
  it('Desktop follows what Laptop watched, without asking, and the windows load it again', async () => {
    const desktop = await machine('Desktop')
    await desktop.datastores.history.insertAsync(historyEntry('desktop0001', 1))
    await desktop.keeper.start()
    await desktop.keeper.tick()

    const laptop = await machine('Laptop')
    await laptop.keeper.start()
    expect(await history(laptop)).toEqual(['desktop0001@30'])

    await laptop.datastores.history.insertAsync(historyEntry('laptop00001', 2))
    await laptop.keeper.tick()

    await desktop.keeper.tick()

    expect(desktop.keeper.status()).toMatchObject({ pause: null, mergedFrom: { machineName: 'Laptop' } })
    expect(await history(desktop)).toEqual(['desktop0001@30', 'laptop00001@30'])
    expect(desktop.dataChanged).toEqual([['history']])
  })

  it('keeps both sides when both changed, and the two converge', async () => {
    const desktop = await machine('Desktop')
    await desktop.datastores.history.insertAsync(historyEntry('shared00001', 1))
    await desktop.keeper.start()
    await desktop.keeper.tick()

    const laptop = await machine('Laptop')
    await laptop.keeper.start()

    // Each watches something, and both go on with the shared video
    await laptop.datastores.history.insertAsync(historyEntry('laptop00001', 2))
    await laptop.datastores.history.updateAsync({ videoId: 'shared00001' }, { $set: { watchProgress: 200, timeWatched: 3 } })
    await laptop.keeper.tick()

    await desktop.datastores.history.insertAsync(historyEntry('desktop0001', 4))
    await desktop.datastores.history.updateAsync({ videoId: 'shared00001' }, { $set: { watchProgress: 100, timeWatched: 5 } })
    await desktop.keeper.tick()

    // Desktop merged Laptop's and wrote the union; Laptop follows it
    await laptop.keeper.tick()

    const expected = ['desktop0001@30', 'laptop00001@30', 'shared00001@100']
    expect(await history(desktop)).toEqual(expected)
    expect(await history(laptop)).toEqual(expected)

    // Nothing left to write on either side
    const before = desktop.keeper.status().writtenAt
    await desktop.keeper.tick()
    await laptop.keeper.tick()
    expect(desktop.keeper.status().writtenAt).toBe(before)
  })

  it('carries a removal from one machine to the other', async () => {
    const desktop = await machine('Desktop')
    await desktop.datastores.history.insertAsync([historyEntry('keep0000001', 1), historyEntry('remove00001', 2)])
    await desktop.keeper.start()
    await desktop.keeper.tick()

    const laptop = await machine('Laptop')
    await laptop.keeper.start()
    await laptop.datastores.history.removeAsync({ videoId: 'remove00001' }, {})
    await laptop.keeper.tick()

    await desktop.keeper.tick()

    expect(await history(desktop)).toEqual(['keep0000001@30'])
  })

  it('a machine joining with data of its own keeps it, and gives it to the other', async () => {
    const desktop = await machine('Desktop')
    await desktop.datastores.history.insertAsync(historyEntry('desktop0001', 1))
    await desktop.keeper.start()
    await desktop.keeper.tick()

    const laptop = await machine('Laptop')
    await laptop.datastores.history.insertAsync(historyEntry('laptop00001', 2))
    await laptop.keeper.start()
    await laptop.keeper.tick()
    await desktop.keeper.tick()

    expect(await history(laptop)).toEqual(['desktop0001@30', 'laptop00001@30'])
    expect(await history(desktop)).toEqual(['desktop0001@30', 'laptop00001@30'])
  })
})
