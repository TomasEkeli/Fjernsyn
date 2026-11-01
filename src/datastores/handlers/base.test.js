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
    expect(db.collectionShares).toBeInstanceOf(Datastore)
  })

  it('adds the new ones, updates those kept, and drops none', async () => {
    await collections.putShares([share('aaaaaaaaaaa'), share('bbbbbbbbbbb')])

    const counts = await collections.putShares([share('bbbbbbbbbbb', { votes: 9 }), share('ccccccccccc')])

    expect(counts).toEqual({ added: 1, updated: 1 })
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

    expect(counts).toEqual({ added: 1, updated: 0 })
    expect((await kept()).map(({ votes }) => votes)).toEqual([3])
  })

  it('writes the same shares put twice at once only once, without refusing either', async () => {
    const batch = [share('aaaaaaaaaaa'), share('bbbbbbbbbbb')]

    const results = await Promise.allSettled([collections.putShares(batch), collections.putShares(batch)])

    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(results.map(result => result.value)).toEqual([{ added: 2, updated: 0 }, { added: 0, updated: 2 }])
    expect((await kept()).map(({ _id }) => _id)).toEqual(['hackertube|aaaaaaaaaaa', 'hackertube|bbbbbbbbbbb'])
  })

  it('goes on after a put that failed', async () => {
    await expect(collections.putShares([{ _id: 'hackertube|bad', $bad: 1 }])).rejects.toThrow()

    await collections.putShares([share('aaaaaaaaaaa')])

    expect((await kept()).map(({ _id }) => _id)).toEqual(['hackertube|aaaaaaaaaaa'])
  })

  it('does nothing for no shares', async () => {
    expect(await collections.putShares([])).toEqual({ added: 0, updated: 0 })
  })
})
