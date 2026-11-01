import Datastore from '@seald-io/nedb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as db from '../index'
import { communities } from './base'

// The datastores as main opens them, in memory: only the communities ones are used here
vi.mock('../index', async () => {
  const { default: Datastore } = await import('@seald-io/nedb')
  return {
    communitySources: new Datastore({ inMemoryOnly: true }),
    communityShares: new Datastore({ inMemoryOnly: true }),
    communityVideos: new Datastore({ inMemoryOnly: true }),
    communitySourceData: new Datastore({ inMemoryOnly: true }),
  }
})

/**
 * @param {string} videoId
 * @param {object} [extra]
 */
function share(videoId, extra = {}) {
  return { _id: `hackertube|${videoId}`, sourceId: 'hackertube', videoId, votes: 1, seenAt: 1, ...extra }
}

const kept = async () => (await db.communityShares.findAsync({})).sort((a, b) => a._id.localeCompare(b._id))

describe('putting community shares', () => {
  beforeEach(async () => {
    await db.communityShares.removeAsync({}, { multi: true })
    await db.communitySources.removeAsync({}, { multi: true })
    await communities.upsertSource({ _id: 'hackertube', kind: 'hackertube' })
    expect(db.communityShares).toBeInstanceOf(Datastore)
  })

  it('adds the new ones, updates those kept, and drops none', async () => {
    await communities.putShares([share('aaaaaaaaaaa'), share('bbbbbbbbbbb')])

    const counts = await communities.putShares([share('bbbbbbbbbbb', { votes: 9 }), share('ccccccccccc')])

    expect(counts).toEqual({ added: 1, updated: 1, dropped: [] })
    expect((await kept()).map(({ _id, votes }) => [_id, votes])).toEqual([
      ['hackertube|aaaaaaaaaaa', 1],
      ['hackertube|bbbbbbbbbbb', 9],
      ['hackertube|ccccccccccc', 1],
    ])
  })

  it('keeps the fields an update does not name', async () => {
    await communities.putShares([share('aaaaaaaaaaa', { why: 'kept' })])

    await communities.putShares([{ _id: 'hackertube|aaaaaaaaaaa', votes: 4 }])

    expect(await kept()).toEqual([share('aaaaaaaaaaa', { why: 'kept', votes: 4 })])
  })

  it('keeps the last of a share given twice in one batch', async () => {
    const counts = await communities.putShares([share('aaaaaaaaaaa', { votes: 2 }), share('aaaaaaaaaaa', { votes: 3 })])

    expect(counts).toEqual({ added: 1, updated: 0, dropped: [] })
    expect((await kept()).map(({ votes }) => votes)).toEqual([3])
  })

  it('writes the same shares put twice at once only once, without refusing either', async () => {
    const batch = [share('aaaaaaaaaaa'), share('bbbbbbbbbbb')]

    const results = await Promise.allSettled([communities.putShares(batch), communities.putShares(batch)])

    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(results.map(result => result.value)).toEqual([{ added: 2, updated: 0, dropped: [] }, { added: 0, updated: 2, dropped: [] }])
    expect((await kept()).map(({ _id }) => _id)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|bbbbbbbbbbb'])
  })

  it('goes on after a put that failed', async () => {
    await expect(communities.putShares([{ _id: 'hackertube|bad', sourceId: 'hackertube', $bad: 1 }])).rejects.toThrow()

    await communities.putShares([share('aaaaaaaaaaa')])

    expect((await kept()).map(({ _id }) => _id)).toEqual(['hackertube|aaaaaaaaaaa'])
  })

  it('does nothing for no shares', async () => {
    expect(await communities.putShares([])).toEqual({ added: 0, updated: 0, dropped: [] })
  })

  it('drops the shares of a source that is not followed, new or kept, and says which', async () => {
    await communities.putShares([share('aaaaaaaaaaa')])
    // As left behind by a removal cut short
    await db.communityShares.insertAsync({ _id: 'lemmy:gone@b.example|aaaaaaaaaaa', sourceId: 'lemmy:gone@b.example', videoId: 'aaaaaaaaaaa', votes: 1 })

    const counts = await communities.putShares([
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

describe('the order of community writes', () => {
  beforeEach(async () => {
    for (const store of [db.communitySources, db.communityShares, db.communitySourceData]) {
      await store.removeAsync({}, { multi: true })
    }
  })

  it('creates a source when it is followed, and replaces it when followed over itself', async () => {
    await communities.upsertSource({ _id: 'hackertube', name: 'A' })
    await communities.upsertSource({ _id: 'hackertube', name: 'B' })

    expect(await communities.findSources()).toEqual([{ _id: 'hackertube', name: 'B' }])
  })

  it('updates a followed source, and never creates one that is not', async () => {
    await communities.upsertSource({ _id: 'hackertube', name: 'A' })

    expect(await communities.updateSource({ _id: 'hackertube', name: 'A', checkedAt: 5 })).toEqual({ updated: 1 })
    expect(await communities.updateSource({ _id: 'lemmy:gone@b.example', name: 'gone', checkedAt: 5 })).toEqual({ updated: 0 })

    expect(await communities.findSources()).toEqual([{ _id: 'hackertube', name: 'A', checkedAt: 5 }])
  })

  it('keeps a source\'s own data only while it is followed', async () => {
    await communities.upsertSource({ _id: 'hackertube' })

    expect(await communities.putSourceData({ _id: 'hackertube', generated: 'g' })).toEqual({ kept: true })
    expect(await communities.putSourceData({ _id: 'lemmy:gone@b.example', generated: 'g' })).toEqual({ kept: false })

    expect(await communities.findSourceData()).toEqual([{ _id: 'hackertube', generated: 'g' }])
  })

  it('lets nothing a refresh writes after an unfollow bring the source or its shares back', async () => {
    await communities.upsertSource({ _id: 'lemmy:a@b.example', name: 'a' })
    const share = { _id: 'lemmy:a@b.example|aaaaaaaaaaa', sourceId: 'lemmy:a@b.example', videoId: 'aaaaaaaaaaa', votes: 1 }

    // A refresh's writes, asked for one after another, with the unfollow asked between them
    const writes = Promise.all([
      communities.putShares([share]),
      communities.removeSource('lemmy:a@b.example'),
      communities.putShares([{ ...share, votes: 2 }]),
      communities.putSourceData({ _id: 'lemmy:a@b.example', generated: 'g' }),
      communities.updateSource({ _id: 'lemmy:a@b.example', name: 'a', checkedAt: 9 }),
    ])

    const [first, removed, second, data, update] = await writes

    expect(first.dropped).toEqual([])
    expect(removed).toEqual({ shares: 1 })
    expect(second.dropped).toEqual([share._id])
    expect(data).toEqual({ kept: false })
    expect(update).toEqual({ updated: 0 })
    expect(await communities.findSources()).toEqual([])
    expect(await communities.findShares()).toEqual([])
    expect(await communities.findSourceData()).toEqual([])
  })

  it('goes on after a write that failed', async () => {
    await expect(communities.upsertSource({ _id: 'x', $bad: 1 })).rejects.toThrow()

    await communities.upsertSource({ _id: 'hackertube' })

    expect(await communities.findSources()).toEqual([{ _id: 'hackertube' }])
  })
})

describe('putting community videos\' details', () => {
  beforeEach(async () => {
    await db.communityVideos.removeAsync({}, { multi: true })
  })

  const details = (videoId, extra = {}) => ({ _id: videoId, videoId, fetchedAt: 1, lengthSeconds: 60, ...extra })

  it('keeps each video\'s details by its ref, and finds them all', async () => {
    await communities.putVideos([details('aaaaaaaaaaa'), details('bbbbbbbbbbb', { unavailable: 'gone' })])

    expect((await communities.findVideos()).sort((a, b) => a._id.localeCompare(b._id))).toEqual([
      details('aaaaaaaaaaa'),
      details('bbbbbbbbbbb', { unavailable: 'gone' }),
    ])
  })

  it('replaces what was kept for a video, once', async () => {
    await communities.putVideos([details('aaaaaaaaaaa', { viewCount: 5 })])
    await communities.putVideos([details('aaaaaaaaaaa', { fetchedAt: 2 })])

    expect(await communities.findVideos()).toEqual([details('aaaaaaaaaaa', { fetchedAt: 2 })])
  })
})

describe('unfollowing a community source', () => {
  beforeEach(async () => {
    for (const store of [db.communitySources, db.communityShares, db.communityVideos, db.communitySourceData]) {
      await store.removeAsync({}, { multi: true })
    }

    await communities.upsertSource({ _id: 'hackertube', kind: 'hackertube', name: 'HackerTube' })
    await communities.upsertSource({ _id: 'lemmy:a@b.example', kind: 'lemmy', name: 'a@b.example' })
    await communities.putShares([
      share('aaaaaaaaaaa'),
      share('bbbbbbbbbbb'),
      { _id: 'lemmy:a@b.example|aaaaaaaaaaa', sourceId: 'lemmy:a@b.example', videoId: 'aaaaaaaaaaa', votes: 4, seenAt: 1 },
    ])
    await communities.putSourceData({ _id: 'hackertube', generated: '2026-10-31', taxonomy: { areas: [] } })
    await communities.putVideos([{ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 1 }])
  })

  it('removes the source, its shares and its own data, and nothing of another source\'s', async () => {
    const removed = await communities.removeSource('hackertube')

    expect(removed).toEqual({ shares: 2 })
    expect((await communities.findSources()).map(({ _id }) => _id)).toEqual(['lemmy:a@b.example'])
    expect((await kept()).map(({ _id }) => _id)).toEqual(['lemmy:a@b.example|aaaaaaaaaaa'])
    expect(await communities.findSourceData()).toEqual([])
  })

  it('leaves the videos\' details, which belong to the video and not to a source', async () => {
    await communities.removeSource('hackertube')

    expect((await communities.findVideos()).map(({ _id }) => _id)).toEqual(['aaaaaaaaaaa'])
  })

  it('does nothing for a source not followed', async () => {
    expect(await communities.removeSource('lemmy:nothing@b.example')).toEqual({ shares: 0 })
    expect(await communities.findSources()).toHaveLength(2)
    expect(await kept()).toHaveLength(3)
  })

  it('waits for a put under way, so that no share of the source is left behind it', async () => {
    const put = communities.putShares([share('ccccccccccc')])
    const removal = communities.removeSource('hackertube')

    await Promise.all([put, removal])

    expect((await kept()).map(({ _id }) => _id)).toEqual(['lemmy:a@b.example|aaaaaaaaaaa'])
  })
})

describe('putting a community source\'s own data', () => {
  beforeEach(async () => {
    await db.communitySourceData.removeAsync({}, { multi: true })
    await communities.upsertSource({ _id: 'hackertube', kind: 'hackertube' })
  })

  it('keeps one record per source, each put replacing the last, and finds them all', async () => {
    await communities.putSourceData({ _id: 'hackertube', generated: '2026-10-31', taxonomy: { version: 'a', areas: [] } })
    await communities.putSourceData({ _id: 'hackertube', generated: '2026-11-07', taxonomy: { version: 'b', areas: [] } })

    expect(await communities.findSourceData()).toEqual([{ _id: 'hackertube', generated: '2026-11-07', taxonomy: { version: 'b', areas: [] } }])
  })
})
