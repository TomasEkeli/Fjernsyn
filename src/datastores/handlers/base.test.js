import Datastore from '@seald-io/nedb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as db from '../index'
import { collections } from './base'

// The datastores as main opens them, in memory: only the collections ones are used here
vi.mock('../index', async () => {
  const { default: Datastore } = await import('@seald-io/nedb')
  return {
    collectionSources: new Datastore({ inMemoryOnly: true }),
    collectionShares: new Datastore({ inMemoryOnly: true }),
    collectionVideos: new Datastore({ inMemoryOnly: true }),
    collectionSourceData: new Datastore({ inMemoryOnly: true }),
  }
})

/**
 * @param {string} videoId
 * @param {object} [extra]
 */
function share(videoId, extra = {}) {
  return { _id: `hackertube|${videoId}`, sourceId: 'hackertube', videoId, votes: 1, seenAt: 1, ...extra }
}

const kept = async () => (await db.collectionShares.findAsync({})).sort((a, b) => a._id.localeCompare(b._id))

describe('putting collection shares', () => {
  beforeEach(async () => {
    await db.collectionShares.removeAsync({}, { multi: true })
    await db.collectionSources.removeAsync({}, { multi: true })
    await collections.upsertSource({ _id: 'hackertube', kind: 'hackertube' })
    expect(db.collectionShares).toBeInstanceOf(Datastore)
  })

  it('adds the new ones, updates those kept, and drops none', async () => {
    await collections.putShares([share('aaaaaaaaaaa'), share('bbbbbbbbbbb')])

    const counts = await collections.putShares([share('bbbbbbbbbbb', { votes: 9 }), share('ccccccccccc')])

    expect(counts).toEqual({ added: 1, updated: 1, dropped: [] })
    expect((await kept()).map(({ _id, votes }) => [_id, votes])).toEqual([
      ['hackertube|aaaaaaaaaaa', 1],
      ['hackertube|bbbbbbbbbbb', 9],
      ['hackertube|ccccccccccc', 1],
    ])
  })

  it('keeps the fields an update does not name', async () => {
    await collections.putShares([share('aaaaaaaaaaa', { why: 'kept' })])

    await collections.putShares([{ _id: 'hackertube|aaaaaaaaaaa', votes: 4 }])

    expect(await kept()).toEqual([share('aaaaaaaaaaa', { why: 'kept', votes: 4 })])
  })

  it('keeps the last of a share given twice in one batch', async () => {
    const counts = await collections.putShares([share('aaaaaaaaaaa', { votes: 2 }), share('aaaaaaaaaaa', { votes: 3 })])

    expect(counts).toEqual({ added: 1, updated: 0, dropped: [] })
    expect((await kept()).map(({ votes }) => votes)).toEqual([3])
  })

  it('writes the same shares put twice at once only once, without refusing either', async () => {
    const batch = [share('aaaaaaaaaaa'), share('bbbbbbbbbbb')]

    const results = await Promise.allSettled([collections.putShares(batch), collections.putShares(batch)])

    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(results.map(result => result.value)).toEqual([{ added: 2, updated: 0, dropped: [] }, { added: 0, updated: 2, dropped: [] }])
    expect((await kept()).map(({ _id }) => _id)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|bbbbbbbbbbb'])
  })

  it('goes on after a put that failed', async () => {
    await expect(collections.putShares([{ _id: 'hackertube|bad', sourceId: 'hackertube', $bad: 1 }])).rejects.toThrow()

    await collections.putShares([share('aaaaaaaaaaa')])

    expect((await kept()).map(({ _id }) => _id)).toEqual(['hackertube|aaaaaaaaaaa'])
  })

  it('does nothing for no shares', async () => {
    expect(await collections.putShares([])).toEqual({ added: 0, updated: 0, dropped: [] })
  })

  it('drops the shares of a source that is not followed, new or kept, and says which', async () => {
    await collections.putShares([share('aaaaaaaaaaa')])
    // As left behind by a removal cut short
    await db.collectionShares.insertAsync({ _id: 'lemmy:gone@b.example|aaaaaaaaaaa', sourceId: 'lemmy:gone@b.example', videoId: 'aaaaaaaaaaa', votes: 1 })

    const counts = await collections.putShares([
      share('bbbbbbbbbbb'),
      { _id: 'lemmy:gone@b.example|ccccccccccc', sourceId: 'lemmy:gone@b.example', videoId: 'ccccccccccc', votes: 2 },
      // Given without its source, as an update may be: the kept share names it
      { _id: 'lemmy:gone@b.example|aaaaaaaaaaa', votes: 9 },
    ])

    expect(counts).toEqual({ added: 1, updated: 0, dropped: ['lemmy:gone@b.example|ccccccccccc', 'lemmy:gone@b.example|aaaaaaaaaaa'] })
    expect((await kept()).map(({ _id, votes }) => [_id, votes])).toEqual([
      ['hackertube|aaaaaaaaaaa', 1],
      ['hackertube|bbbbbbbbbbb', 1],
      ['lemmy:gone@b.example|aaaaaaaaaaa', 1],
    ])
  })
})

describe('the order of collection writes', () => {
  beforeEach(async () => {
    for (const store of [db.collectionSources, db.collectionShares, db.collectionSourceData]) {
      await store.removeAsync({}, { multi: true })
    }
  })

  it('creates a source when it is followed, and replaces it when followed over itself', async () => {
    await collections.upsertSource({ _id: 'hackertube', name: 'A' })
    await collections.upsertSource({ _id: 'hackertube', name: 'B' })

    expect(await collections.findSources()).toEqual([{ _id: 'hackertube', name: 'B' }])
  })

  it('updates a followed source, and never creates one that is not', async () => {
    await collections.upsertSource({ _id: 'hackertube', name: 'A' })

    expect(await collections.updateSource({ _id: 'hackertube', name: 'A', checkedAt: 5 })).toEqual({ updated: 1 })
    expect(await collections.updateSource({ _id: 'lemmy:gone@b.example', name: 'gone', checkedAt: 5 })).toEqual({ updated: 0 })

    expect(await collections.findSources()).toEqual([{ _id: 'hackertube', name: 'A', checkedAt: 5 }])
  })

  it('keeps a source\'s own data only while it is followed', async () => {
    await collections.upsertSource({ _id: 'hackertube' })

    expect(await collections.putSourceData({ _id: 'hackertube', generated: 'g' })).toEqual({ kept: true })
    expect(await collections.putSourceData({ _id: 'lemmy:gone@b.example', generated: 'g' })).toEqual({ kept: false })

    expect(await collections.findSourceData()).toEqual([{ _id: 'hackertube', generated: 'g' }])
  })

  it('lets nothing a refresh writes after an unfollow bring the source or its shares back', async () => {
    await collections.upsertSource({ _id: 'lemmy:a@b.example', name: 'a' })
    const share = { _id: 'lemmy:a@b.example|aaaaaaaaaaa', sourceId: 'lemmy:a@b.example', videoId: 'aaaaaaaaaaa', votes: 1 }

    // A refresh's writes, asked for one after another, with the unfollow asked between them
    const writes = Promise.all([
      collections.putShares([share]),
      collections.removeSource('lemmy:a@b.example'),
      collections.putShares([{ ...share, votes: 2 }]),
      collections.putSourceData({ _id: 'lemmy:a@b.example', generated: 'g' }),
      collections.updateSource({ _id: 'lemmy:a@b.example', name: 'a', checkedAt: 9 }),
    ])

    const [first, removed, second, data, update] = await writes

    expect(first.dropped).toEqual([])
    expect(removed).toEqual({ shares: 1 })
    expect(second.dropped).toEqual([share._id])
    expect(data).toEqual({ kept: false })
    expect(update).toEqual({ updated: 0 })
    expect(await collections.findSources()).toEqual([])
    expect(await collections.findShares()).toEqual([])
    expect(await collections.findSourceData()).toEqual([])
  })

  it('goes on after a write that failed', async () => {
    await expect(collections.upsertSource({ _id: 'x', $bad: 1 })).rejects.toThrow()

    await collections.upsertSource({ _id: 'hackertube' })

    expect(await collections.findSources()).toEqual([{ _id: 'hackertube' }])
  })
})

describe('putting collection videos\' details', () => {
  beforeEach(async () => {
    await db.collectionVideos.removeAsync({}, { multi: true })
  })

  const details = (videoId, extra = {}) => ({ _id: videoId, videoId, fetchedAt: 1, lengthSeconds: 60, ...extra })

  it('keeps each video\'s details by its ref, and finds them all', async () => {
    await collections.putVideos([details('aaaaaaaaaaa'), details('bbbbbbbbbbb', { unavailable: 'gone' })])

    expect((await collections.findVideos()).sort((a, b) => a._id.localeCompare(b._id))).toEqual([
      details('aaaaaaaaaaa'),
      details('bbbbbbbbbbb', { unavailable: 'gone' }),
    ])
  })

  it('replaces what was kept for a video, once', async () => {
    await collections.putVideos([details('aaaaaaaaaaa', { viewCount: 5 })])
    await collections.putVideos([details('aaaaaaaaaaa', { fetchedAt: 2 })])

    expect(await collections.findVideos()).toEqual([details('aaaaaaaaaaa', { fetchedAt: 2 })])
  })
})

describe('unfollowing a collection source', () => {
  beforeEach(async () => {
    for (const store of [db.collectionSources, db.collectionShares, db.collectionVideos, db.collectionSourceData]) {
      await store.removeAsync({}, { multi: true })
    }

    await collections.upsertSource({ _id: 'hackertube', kind: 'hackertube', name: 'HackerTube' })
    await collections.upsertSource({ _id: 'lemmy:a@b.example', kind: 'lemmy', name: 'a@b.example' })
    await collections.putShares([
      share('aaaaaaaaaaa'),
      share('bbbbbbbbbbb'),
      { _id: 'lemmy:a@b.example|aaaaaaaaaaa', sourceId: 'lemmy:a@b.example', videoId: 'aaaaaaaaaaa', votes: 4, seenAt: 1 },
    ])
    await collections.putSourceData({ _id: 'hackertube', generated: '2026-10-31', taxonomy: { areas: [] } })
    await collections.putVideos([{ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 1 }])
  })

  it('removes the source, its shares and its own data, and nothing of another source\'s', async () => {
    const removed = await collections.removeSource('hackertube')

    expect(removed).toEqual({ shares: 2 })
    expect((await collections.findSources()).map(({ _id }) => _id)).toEqual(['lemmy:a@b.example'])
    expect((await kept()).map(({ _id }) => _id)).toEqual(['lemmy:a@b.example|aaaaaaaaaaa'])
    expect(await collections.findSourceData()).toEqual([])
  })

  it('leaves the videos\' details, which belong to the video and not to a source', async () => {
    await collections.removeSource('hackertube')

    expect((await collections.findVideos()).map(({ _id }) => _id)).toEqual(['aaaaaaaaaaa'])
  })

  it('does nothing for a source not followed', async () => {
    expect(await collections.removeSource('lemmy:nothing@b.example')).toEqual({ shares: 0 })
    expect(await collections.findSources()).toHaveLength(2)
    expect(await kept()).toHaveLength(3)
  })

  it('waits for a put under way, so that no share of the source is left behind it', async () => {
    const put = collections.putShares([share('ccccccccccc')])
    const removal = collections.removeSource('hackertube')

    await Promise.all([put, removal])

    expect((await kept()).map(({ _id }) => _id)).toEqual(['lemmy:a@b.example|aaaaaaaaaaa'])
  })
})

describe('putting a collection source\'s own data', () => {
  beforeEach(async () => {
    await db.collectionSourceData.removeAsync({}, { multi: true })
    await collections.upsertSource({ _id: 'hackertube', kind: 'hackertube' })
  })

  it('keeps one record per source, each put replacing the last, and finds them all', async () => {
    await collections.putSourceData({ _id: 'hackertube', generated: '2026-10-31', taxonomy: { version: 'a', areas: [] } })
    await collections.putSourceData({ _id: 'hackertube', generated: '2026-11-07', taxonomy: { version: 'b', areas: [] } })

    expect(await collections.findSourceData()).toEqual([{ _id: 'hackertube', generated: '2026-11-07', taxonomy: { version: 'b', areas: [] } }])
  })
})
