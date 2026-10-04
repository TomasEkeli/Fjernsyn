import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DBLaterHandlers } from '../../../datastores/handlers/index'
import { showToast } from '../../helpers/utils'
import later from './later'

// What the store reads and writes, answered and recorded instead
vi.mock('../../../datastores/handlers/index', () => ({
  DBLaterHandlers: {
    find: vi.fn(async () => []),
    upsert: vi.fn(async () => {}),
    updatePosition: vi.fn(async () => {}),
    updateAlarm: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    deleteAll: vi.fn(async () => {}),
  },
}))

vi.mock('../../helpers/utils', () => ({ showToast: vi.fn() }))
vi.mock('../../i18n/index', () => ({ default: { global: { t: key => key } } }))

const NOW = Date.parse('2026-10-04T12:00:00Z')

function freshState() {
  return { laterItems: {}, laterReady: false }
}

function contextFor(state) {
  return { state, commit: (type, payload) => later.mutations[type](state, payload) }
}

function video(videoId, extra = {}) {
  return { videoId, title: `Title ${videoId}`, author: 'Author', authorId: 'UC1', lengthSeconds: 60, ...extra }
}

const queuedIds = state => later.getters.getLaterQueued(state).map(i => i._id)
const armedIds = state => later.getters.getLaterArmed(state).map(i => i._id)

describe('the Later store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
  })

  it('adds at the top, and writes the one record', async () => {
    const state = freshState()
    const context = contextFor(state)

    await later.actions.addToLater(context, video('a'))
    await later.actions.addToLater(context, video('b'))

    expect(queuedIds(state)).toEqual(['b', 'a'])
    expect(later.getters.getIsInLater(state)('a')).toBe(true)
    expect(DBLaterHandlers.upsert).toHaveBeenCalledTimes(2)
    expect(DBLaterHandlers.upsert.mock.calls[0][0]).toMatchObject({
      _id: 'a', videoId: 'a', title: 'Title a', addedAt: NOW, position: 0, alarm: null,
    })
  })

  it('says a video is there already and changes nothing', async () => {
    const state = freshState()
    const context = contextFor(state)

    await later.actions.addToLater(context, video('a'))
    const before = structuredClone(state.laterItems)
    const added = await later.actions.addToLater(context, video('a'))

    expect(added).toBe(false)
    expect(state.laterItems).toEqual(before)
    expect(showToast).toHaveBeenCalledWith('Later.Already in Later')
    expect(DBLaterHandlers.upsert).toHaveBeenCalledTimes(1)
  })

  it('removes', async () => {
    const state = freshState()
    const context = contextFor(state)

    await later.actions.addToLater(context, video('a'))
    await later.actions.removeFromLater(context, 'a')

    expect(later.getters.getIsInLater(state)('a')).toBe(false)
    expect(DBLaterHandlers.delete).toHaveBeenCalledWith('a')
  })

  it('moves an item by writing its one position', async () => {
    const state = freshState()
    const context = contextFor(state)
    for (const id of ['c', 'b', 'a']) { await later.actions.addToLater(context, video(id)) }

    await later.actions.moveLaterItem(context, { id: 'a', toIndex: 2 })

    expect(queuedIds(state)).toEqual(['b', 'c', 'a'])
    expect(DBLaterHandlers.updatePosition).toHaveBeenCalledTimes(1)
  })

  it('renumbers every queued item once when the gaps close', async () => {
    const state = freshState()
    state.laterItems = {
      a: { _id: 'a', videoId: 'a', addedAt: 0, position: 0, alarm: null },
      b: { _id: 'b', videoId: 'b', addedAt: 0, position: 1e-7, alarm: null },
      c: { _id: 'c', videoId: 'c', addedAt: 0, position: 1, alarm: null },
    }

    await later.actions.moveLaterItem(contextFor(state), { id: 'c', toIndex: 0 })

    expect(queuedIds(state)).toEqual(['c', 'a', 'b'])
    expect(Object.values(state.laterItems).map(i => i.position).sort()).toEqual([0, 1, 2])
    expect(DBLaterHandlers.updatePosition).toHaveBeenCalledTimes(4)
  })

  it('arms a video not in the list, adding it with its alarm', async () => {
    const state = freshState()

    await later.actions.arm(contextFor(state), { video: video('live', { isUpcoming: true }), at: NOW + 1000 })

    expect(armedIds(state)).toEqual(['live'])
    expect(DBLaterHandlers.upsert.mock.calls[0][0].alarm).toEqual({ at: NOW + 1000, armedAt: NOW })
  })

  it('arms an item already queued, writing only its alarm', async () => {
    const state = freshState()
    const context = contextFor(state)
    await later.actions.addToLater(context, video('a'))

    await later.actions.arm(context, { video: video('a'), at: NOW + 1000 })

    expect(queuedIds(state)).toEqual([])
    expect(armedIds(state)).toEqual(['a'])
    expect(DBLaterHandlers.upsert).toHaveBeenCalledTimes(1)
    expect(DBLaterHandlers.updateAlarm).toHaveBeenCalledWith('a', { at: NOW + 1000, armedAt: NOW })
  })

  it('disarms to the top of the queued items', async () => {
    const state = freshState()
    const context = contextFor(state)
    await later.actions.arm(context, { video: video('armed'), at: NOW + 1000 })
    await later.actions.addToLater(context, video('a'))
    await later.actions.addToLater(context, video('b'))

    await later.actions.disarm(context, 'armed')

    expect(armedIds(state)).toEqual([])
    expect(queuedIds(state)).toEqual(['armed', 'b', 'a'])
    expect(DBLaterHandlers.updateAlarm).toHaveBeenLastCalledWith('armed', null)
  })

  it('follows a moved time', async () => {
    const state = freshState()
    const context = contextFor(state)
    await later.actions.arm(context, { video: video('a'), at: NOW + 1000 })

    await later.actions.updateAlarmTime(context, { id: 'a', at: NOW + 5000 })

    expect(state.laterItems.a.alarm).toEqual({ at: NOW + 5000, armedAt: NOW })
  })

  it('adds many as one block on top, in order, skipping what is there', async () => {
    const state = freshState()
    const context = contextFor(state)
    await later.actions.addToLater(context, video('there'))

    const result = await later.actions.addManyToLater(context, [
      { videoId: 'x', title: 'x' },
      { videoId: 'there', title: 'there' },
      { videoId: 'y', title: 'y' },
      { videoId: 'x', title: 'again' },
    ])

    expect(result).toEqual({ added: 2, failed: 0 })
    expect(queuedIds(state)).toEqual(['x', 'y', 'there'])
  })
})
