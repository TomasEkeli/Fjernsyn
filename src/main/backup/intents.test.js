import { beforeEach, describe, expect, it, vi } from 'vitest'

import { topPosition } from '../../renderer/helpers/later'
import { laterIntents, watchIntents } from './intents'

/**
 * The Later handler class over records held in memory, with the signatures
 * and the write-through of `datastores/handlers/base.js`: `upsert` replaces
 * the record whole, as NeDB's upsert does, and the rest set fields.
 *
 * `read` goes to the records themselves, as the keeper's does to the
 * datastore, so that reading never goes back through what is wrapped.
 *
 * @param {Record<string, any>[]} initial
 */
function laterStore(initial) {
  const records = new Map(initial.map(record => [record._id, { ...record }]))

  function set(_id, fields) {
    const record = records.get(_id)

    if (record === undefined) { return 0 }

    records.set(_id, { ...record, ...fields })

    return 1
  }

  const all = () => [...records.values()].map(record => ({ ...record }))

  const later = {
    find: async () => all(),
    upsert: async (item) => { records.set(item._id, { ...item }); return 1 },
    updatePosition: async (_id, position) => set(_id, { position }),
    updatePositions: async (positions) => positions.reduce((written, { _id, position }) => written + set(_id, { position }), 0),
    updateAlarm: async (_id, alarm, premiereDate) => set(_id, typeof premiereDate === 'number' ? { alarm, premiereDate } : { alarm }),
    updateViewCount: async (_id, viewCount) => set(_id, { viewCount }),
    delete: async (_id) => { records.delete(_id); return 1 },
    deleteAll: async () => { const gone = records.size; records.clear(); return gone },
  }

  return {
    handlers: { later },
    read: async (section, id) => {
      if (section !== 'later') { throw new Error(`No such section here: ${section}`) }

      return id === undefined ? all() : all().find(record => record._id === id) ?? null
    },
  }
}

const QUEUED = [
  { _id: 'a', videoId: 'a', position: 0, title: 'The first', viewCount: 10, addedAt: 1 },
  { _id: 'b', videoId: 'b', position: 1, title: 'The second', viewCount: 20, addedAt: 2 },
]

/** @param {Record<string, any>[]} initial */
function watching(initial = QUEUED) {
  const onIntent = vi.fn()
  const { handlers, read } = laterStore(initial)

  watchIntents(handlers, { read, onIntent })

  return { later: handlers.later, read, onIntent }
}

describe('watching the Later handlers', () => {
  let later
  let read
  let onIntent

  beforeEach(() => {
    ({ later, read, onIntent } = watching())
  })

  it('records nothing for a write that moves only state fields', async () => {
    await later.updateViewCount('a', 900)

    expect(onIntent).not.toHaveBeenCalled()
    expect((await read('later', 'a')).viewCount).toBe(900)
  })

  it('records nothing for a write that only brings a field the partition does not know', async () => {
    await later.upsert({ ...QUEUED[0], authorThumbnail: 'https://example.invalid/author.jpg' })

    expect(onIntent).not.toHaveBeenCalled()
  })

  it('records an addition with the key it follows', async () => {
    await later.upsert({ _id: 'c', videoId: 'c', position: 2.5 })

    expect(onIntent).toHaveBeenCalledWith({ type: 'later.added', key: 'later/c', data: { after: 'later/b' } })
  })

  it('records an addition at the front as following nothing', async () => {
    await later.upsert({ _id: 'c', videoId: 'c', position: -1 })

    expect(onIntent).toHaveBeenCalledWith({ type: 'later.added', key: 'later/c', data: { after: null } })
  })

  it('records a removal', async () => {
    await later.delete('a')

    expect(onIntent).toHaveBeenCalledTimes(1)
    expect(onIntent).toHaveBeenCalledWith({ type: 'later.removed', key: 'later/a', data: {} })
  })

  it('records a move with its new neighbour, and not as a removal and an addition', async () => {
    await later.updatePosition('a', 1.5)

    expect(onIntent).toHaveBeenCalledTimes(1)
    expect(onIntent).toHaveBeenCalledWith({ type: 'later.moved', key: 'later/a', data: { after: 'later/b' } })
  })

  it('records an alarm armed, with the premiere date when the write carries one', async () => {
    await later.updateAlarm('b', { at: 5000, armedAt: 4000 }, 5000)

    expect(onIntent).toHaveBeenCalledWith({
      type: 'later.alarmArmed',
      key: 'later/b',
      data: { alarm: { at: 5000, armedAt: 4000 }, premiereDate: 5000 },
    })
  })

  it('records an alarm armed without a premiere date the record has not got', async () => {
    await later.updateAlarm('b', { at: 5000, armedAt: 4000 })

    expect(onIntent).toHaveBeenCalledWith({
      type: 'later.alarmArmed',
      key: 'later/b',
      data: { alarm: { at: 5000, armedAt: 4000 } },
    })
  })

  it('records an alarm cleared', async () => {
    const armed = watching([QUEUED[0], { ...QUEUED[1], alarm: { at: 5000, armedAt: 4000 } }])

    await armed.later.updateAlarm('b', null)

    expect(armed.onIntent).toHaveBeenCalledTimes(1)
    expect(armed.onIntent).toHaveBeenCalledWith({ type: 'later.alarmCleared', key: 'later/b', data: {} })
  })

  it('records a clear of the whole list once, with the key later/*', async () => {
    await later.deleteAll()

    expect(onIntent).toHaveBeenCalledTimes(1)
    expect(onIntent).toHaveBeenCalledWith({ type: 'later.cleared', key: 'later/*', data: {} })
  })

  it('records nothing for a read of the whole list, or for clearing one already empty', async () => {
    const empty = watching([])

    await later.find()
    await empty.later.deleteAll()

    expect(onIntent).not.toHaveBeenCalled()
    expect(empty.onIntent).not.toHaveBeenCalled()
  })

  it('records once for a write that moves an intent field and a state field together', async () => {
    await later.upsert({ _id: 'a', videoId: 'a', position: 9, viewCount: 12 })

    expect(onIntent).toHaveBeenCalledTimes(1)
    expect(onIntent).toHaveBeenCalledWith({ type: 'later.moved', key: 'later/a', data: { after: 'later/b' } })
  })

  it('records the placement and then the alarm for an armed video added in the middle of the list', async () => {
    await later.upsert({ _id: 'c', videoId: 'c', position: 0.5, alarm: { at: 5000, armedAt: 4000 } })

    expect(onIntent.mock.calls.map(([intent]) => intent)).toEqual([
      { type: 'later.added', key: 'later/c', data: { after: 'later/a' } },
      { type: 'later.alarmArmed', key: 'later/c', data: { alarm: { at: 5000, armedAt: 4000 } } },
    ])
  })

  it('records the move and then the alarm for a write that places and arms the same record', async () => {
    await later.upsert({ _id: 'a', videoId: 'a', position: 1.5, alarm: { at: 5000, armedAt: 4000 } })

    expect(onIntent.mock.calls.map(([intent]) => intent)).toEqual([
      { type: 'later.moved', key: 'later/a', data: { after: 'later/b' } },
      { type: 'later.alarmArmed', key: 'later/a', data: { alarm: { at: 5000, armedAt: 4000 } } },
    ])
  })

  it('breaks a tie on position by the key, so a move onto a neighbour position is a move', async () => {
    const tied = watching([
      { _id: 'c', videoId: 'c', position: 0 },
      { _id: 'a', videoId: 'a', position: 1 },
      { _id: 'b', videoId: 'b', position: 2 },
    ])

    await tied.later.updatePosition('c', 1)

    expect(tied.onIntent).toHaveBeenCalledWith({ type: 'later.moved', key: 'later/c', data: { after: 'later/a' } })
  })

  it('breaks the same tie in the order the write found, so a move off a shared position is a move', async () => {
    const tied = watching([
      { _id: 'a', videoId: 'a', position: 1 },
      { _id: 'c', videoId: 'c', position: 1 },
      { _id: 'b', videoId: 'b', position: 2 },
    ])

    await tied.later.updatePosition('c', 0.5)

    expect(tied.onIntent).toHaveBeenCalledWith({ type: 'later.moved', key: 'later/c', data: { after: null } })
  })

  // Positions drift below zero, since a new item goes above the top one. A
  // renumber of these written one at a time, ascending, puts `a` below the
  // other two on the first write: the order really does change, and the seam
  // reads that as a move. So a renumber is one write or it is not safe.
  const DRIFTED = [
    { _id: 'a', videoId: 'a', position: -5 },
    { _id: 'b', videoId: 'b', position: -4 },
    { _id: 'c', videoId: 'c', position: 0.1 },
  ]

  const WHOLE = [{ _id: 'a', position: 0 }, { _id: 'b', position: 1 }, { _id: 'c', position: 2 }]

  it('records nothing for a renumber, where every position moves and the order does not', async () => {
    const drifted = watching(DRIFTED)

    await drifted.later.updatePositions(WHOLE)

    expect(drifted.onIntent).not.toHaveBeenCalled()
    expect((await drifted.read('later')).map(record => record.position)).toEqual([0, 1, 2])
  })

  it('records moves of its own for the same renumber written one position at a time', async () => {
    const drifted = watching(DRIFTED)

    for (const { _id, position } of WHOLE) {
      await drifted.later.updatePosition(_id, position)
    }

    expect(drifted.onIntent.mock.calls.map(([intent]) => intent)).toEqual([
      { type: 'later.moved', key: 'later/a', data: { after: 'later/b' } },
      { type: 'later.moved', key: 'later/b', data: { after: 'later/c' } },
      { type: 'later.moved', key: 'later/c', data: { after: 'later/b' } },
    ])
  })

  it('records nothing for a renumber with an armed record among the positions it leaves alone', async () => {
    const drifted = watching([
      { _id: 'a', videoId: 'a', position: -5 },
      { _id: 'b', videoId: 'b', position: -4 },
      { _id: 'c', videoId: 'c', position: -4 + 1e-7 },
      { _id: 'z', videoId: 'z', position: 0.5, alarm: { at: 5000, armedAt: 4000 } },
    ])

    await drifted.later.updatePositions(WHOLE)

    expect(drifted.onIntent).not.toHaveBeenCalled()
  })

  it('records a move for each record a write of every position leaves following another', async () => {
    const three = watching([...QUEUED, { _id: 'c', videoId: 'c', position: 2 }])

    await three.later.updatePositions([{ _id: 'a', position: 3 }])

    expect(three.onIntent.mock.calls.map(([intent]) => intent)).toEqual([
      { type: 'later.moved', key: 'later/b', data: { after: null } },
      { type: 'later.moved', key: 'later/a', data: { after: 'later/c' } },
    ])
  })

  it('records nothing when the scheduler follows a stated time that moved', async () => {
    const armed = watching([QUEUED[0], { ...QUEUED[1], alarm: { at: 5000, armedAt: 4000 }, premiereDate: 5000 }])

    await armed.later.updateAlarm('b', { at: 6000, armedAt: 4000 }, 6000)

    expect(armed.onIntent).not.toHaveBeenCalled()
    expect((await armed.read('later', 'b')).alarm).toEqual({ at: 6000, armedAt: 4000 })
  })

  it('records an alarm cleared and then a move for disarming, which is two writes', async () => {
    const armed = watching([QUEUED[0], { ...QUEUED[1], alarm: { at: 5000, armedAt: 4000 } }])

    // `store/modules/later.js`'s `disarm`: the alarm off, then the item to the
    // top of the queued ones. The second is what leaves the two machines with
    // the list in one order, as the first carries no position.
    const position = topPosition((await armed.read('later')).filter(record => record._id !== 'b'))
    await armed.later.updateAlarm('b', null)
    await armed.later.updatePosition('b', position)

    expect(armed.onIntent.mock.calls.map(([intent]) => intent)).toEqual([
      { type: 'later.alarmCleared', key: 'later/b', data: {} },
      { type: 'later.moved', key: 'later/b', data: { after: null } },
    ])
  })

  it('lets the write through, and returns what it returned', async () => {
    await expect(later.upsert({ _id: 'c', videoId: 'c', position: 2.5 })).resolves.toBe(1)
    await expect(later.deleteAll()).resolves.toBe(3)
    expect(await read('later')).toEqual([])
  })
})

describe('the intent one change to a Later record is', () => {
  const order = [
    { key: 'later/a', record: { _id: 'a', position: 0 } },
    { key: 'later/b', record: { _id: 'b', position: 1 } },
  ]

  it('is nothing for a record that was not there and still is not', () => {
    expect(laterIntents(null, null, order)).toEqual([])
  })

  it('is nothing for a position written again that leaves the order as it was', () => {
    expect(laterIntents({ _id: 'b', position: 0.5 }, { _id: 'b', position: 1 }, order)).toEqual([])
  })
})
