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
  communitySources: 'community-sources',
  communityShares: 'community-shares',
  communitySourceData: 'community-source-data',
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

async function machine(name, deps = {}) {
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
    onDataChanged: (changes) => {
      m.dataChanged.push(changes.sections)
      m.historyChanges = [...(m.historyChanges ?? []), changes.history]
    },
    sleep: async () => {},
    ...deps,
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
    // The entry itself goes to the windows, not word to load the whole history
    expect(desktop.historyChanges).toEqual([{ put: [expect.objectContaining({ videoId: 'laptop00001' })], removed: [] }])
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
    expect(desktop.historyChanges).toEqual([{ put: [], removed: ['remove00001'] }])
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

describe('two machines running at once, following sources', () => {
  const HACKERTUBE = { _id: 'hackertube', kind: 'hackertube', url: 'https://hackertube.org', name: 'HackerTube', followedAt: 1 }
  const LEMMY = { _id: 'lemmy:videos@lemmy.example', kind: 'lemmy', url: 'https://lemmy.example/c/videos', name: 'videos@lemmy.example', followedAt: 2 }

  function share(sourceId, videoId, votes = 1, seenAt = 10) {
    return { _id: `${sourceId}|${videoId}`, sourceId, videoId, title: `Video ${videoId}`, author: '', votes, why: null, sharedAt: 1, discussionUrl: null, seenAt }
  }

  /** A machine that follows HackerTube and the community, refreshed as this machine refreshes */
  async function following(m, refreshedAt) {
    await m.datastores.communitySources.insertAsync([
      { ...HACKERTUBE, dataGenerated: '2026-10-31', checkedAt: refreshedAt, attemptedAt: refreshedAt, failedAt: null },
      { ...LEMMY, checkedAt: refreshedAt, attemptedAt: refreshedAt, failedAt: null },
    ])
    await m.datastores.communityShares.insertAsync([share('hackertube', 'hackertube1'), share(LEMMY._id, 'lemmyvideo1')])
    await m.datastores.communitySourceData.insertAsync({ _id: 'hackertube', generated: '2026-10-31', taxonomy: { areas: [] } })
    await m.datastores.settings.insertAsync({ _id: 'communitiesStarterSetDone', value: true })
  }

  const ids = async datastore => (await datastore.findAsync({})).map(record => record._id).sort()

  it('Desktop follows what Laptop followed, without HackerTube\'s shares or Laptop\'s refresh times, and marks the starter set done', async () => {
    const desktop = await machine('Desktop')
    await desktop.keeper.start()
    await desktop.keeper.tick()

    const laptop = await machine('Laptop')
    await laptop.keeper.start()
    await following(laptop, 500)
    await laptop.keeper.tick()

    await desktop.keeper.tick()

    expect(await desktop.datastores.communitySources.findAsync({}).sort({ _id: 1 })).toEqual([HACKERTUBE, LEMMY])
    expect(await ids(desktop.datastores.communityShares)).toEqual([`${LEMMY._id}|lemmyvideo1`])
    expect(await desktop.datastores.settings.findOneAsync({ _id: 'communitiesStarterSetDone' })).toMatchObject({ value: true })
    expect(desktop.dataChanged.map(sections => [...sections].sort())).toEqual([['communityShares', 'communitySources', 'settings']])
  })

  it('a refresh, which only moves this machine\'s refresh times, writes nothing', async () => {
    const laptop = await machine('Laptop')
    await following(laptop, 500)
    await laptop.keeper.start()
    await laptop.keeper.tick()
    const writtenAt = laptop.keeper.status().writtenAt

    await laptop.datastores.communitySources.updateAsync({ _id: LEMMY._id }, { $set: { checkedAt: 900, attemptedAt: 900 } })
    await laptop.keeper.tick()

    expect(laptop.keeper.status().writtenAt).toBe(writtenAt)
  })

  it('carries an unfollow to the other machine, with every share of that source and its own data, HackerTube\'s too', async () => {
    const desktop = await machine('Desktop')
    await following(desktop, 100)
    await desktop.keeper.start()
    await desktop.keeper.tick()

    const laptop = await machine('Laptop')
    await laptop.keeper.start()
    await laptop.datastores.communityShares.insertAsync(share('hackertube', 'hackertube1'))
    await laptop.datastores.communitySources.removeAsync({ _id: 'hackertube' }, {})
    await laptop.datastores.communityShares.removeAsync({ sourceId: 'hackertube' }, { multi: true })
    await laptop.keeper.tick()

    await desktop.keeper.tick()

    expect(await ids(desktop.datastores.communitySources)).toEqual([LEMMY._id])
    expect(await ids(desktop.datastores.communityShares)).toEqual([`${LEMMY._id}|lemmyvideo1`])
    expect(await ids(desktop.datastores.communitySourceData)).toEqual([])
    expect(desktop.dataChanged).toEqual([['communitySources']])
  })

  it('carries a vote update to the other machine, which keeps its own refresh times', async () => {
    const desktop = await machine('Desktop')
    await following(desktop, 100)
    await desktop.keeper.start()
    await desktop.keeper.tick()

    const laptop = await machine('Laptop')
    await laptop.keeper.start()
    await laptop.datastores.communityShares.updateAsync({ _id: `${LEMMY._id}|lemmyvideo1` }, { $set: { votes: 40, seenAt: 20 } })
    await laptop.datastores.communitySources.updateAsync({ _id: LEMMY._id }, { $set: { name: 'Videos' } })
    await laptop.keeper.tick()

    await desktop.keeper.tick()

    expect(await desktop.datastores.communityShares.findOneAsync({ _id: `${LEMMY._id}|lemmyvideo1` })).toMatchObject({ votes: 40, seenAt: 20 })
    expect(await desktop.datastores.communitySources.findOneAsync({ _id: LEMMY._id })).toEqual({ ...LEMMY, name: 'Videos', checkedAt: 100, attemptedAt: 100, failedAt: null })
  })

  it('leaves no share behind of a source one machine unfollowed while the other updated the share', async () => {
    const desktop = await machine('Desktop')
    await following(desktop, 100)
    await desktop.keeper.start()
    await desktop.keeper.tick()

    const laptop = await machine('Laptop')
    await laptop.keeper.start()

    // Desktop's vote update reaches the folder first; Laptop unfollowed meanwhile
    await desktop.datastores.communityShares.updateAsync({ _id: `${LEMMY._id}|lemmyvideo1` }, { $set: { votes: 40, seenAt: 20 } })
    await desktop.keeper.tick()
    await laptop.datastores.communitySources.removeAsync({ _id: LEMMY._id }, {})
    await laptop.datastores.communityShares.removeAsync({ sourceId: LEMMY._id }, { multi: true })
    await laptop.keeper.tick()

    expect(await ids(laptop.datastores.communitySources)).toEqual(['hackertube'])
    expect(await ids(laptop.datastores.communityShares)).toEqual([])

    await desktop.keeper.tick()
    expect(await ids(desktop.datastores.communitySources)).toEqual(['hackertube'])
    expect(await ids(desktop.datastores.communityShares)).toEqual(['hackertube|hackertube1'])
  })

  it('writes the sources it merges in turn with the app\'s own communities writes', async () => {
    const desktop = await machine('Desktop')
    await following(desktop, 100)
    await desktop.keeper.start()
    await desktop.keeper.tick()

    let inQueue = false
    const writes = []
    const inCommunitiesQueue = async (write) => {
      inQueue = true
      try {
        return await write()
      } finally {
        inQueue = false
      }
    }
    const laptop = await machine('Laptop', { inCommunitiesQueue })
    for (const name of ['communitySources', 'communityShares', 'communitySourceData']) {
      for (const method of ['updateAsync', 'removeAsync']) {
        const original = laptop.datastores[name][method]
        laptop.datastores[name][method] = function (...args) {
          writes.push(`${name}.${method} ${inQueue ? 'in turn' : 'outside'}`)
          return original.apply(this, args)
        }
      }
    }
    await laptop.keeper.start()

    await desktop.datastores.communitySources.removeAsync({ _id: 'hackertube' }, {})
    await desktop.datastores.communityShares.removeAsync({ sourceId: 'hackertube' }, { multi: true })
    await desktop.keeper.tick()
    await laptop.keeper.tick()

    const sourceWrites = writes.filter(write => !write.startsWith('communityShares.updateAsync'))
    expect(sourceWrites.length).toBeGreaterThan(0)
    expect(sourceWrites.filter(write => write.endsWith('outside'))).toEqual([])
    expect(await ids(laptop.datastores.communitySources)).toEqual([LEMMY._id])
  })
})
