import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DBLaterHandlers } from '../../../datastores/handlers/index'
import { watchIntents } from '../../../main/backup/intents'
import { showToast } from '../../helpers/utils'
import later from './later'
import { laterFromExport, laterToExport } from '../../helpers/later'

// What the store reads and writes, answered and recorded instead. A test that
// needs the writes to land somewhere, as `underTheSeam` does, puts a handler
// in `wired` and they go through that as well.
let wired = null

vi.mock('../../../datastores/handlers/index', () => {
  const through = name => vi.fn(async (...args) => await wired?.[name](...args))

  return {
    DBLaterHandlers: {
      find: vi.fn(async () => wired == null ? [] : await wired.find()),
      upsert: through('upsert'),
      updatePosition: through('updatePosition'),
      updatePositions: through('updatePositions'),
      updateAlarm: through('updateAlarm'),
      updateViewCount: through('updateViewCount'),
      delete: through('delete'),
      deleteAll: through('deleteAll'),
    },
  }
})

vi.mock('../../helpers/utils', () => ({ showToast: vi.fn() }))
vi.mock('../../i18n/index', () => ({ default: { global: { t: key => key } } }))

const NOW = Date.parse('2026-10-04T12:00:00Z')

function freshState() {
  return { laterItems: {}, laterReady: false, laterPlayersMounted: 0, laterNotices: [], laterCountdown: null, laterFiredVideo: null, laterLiveQuiet: {} }
}

function contextFor(state) {
  const context = {
    state,
    commit: (type, payload) => later.mutations[type](state, payload),
    dispatch: (type, payload) => later.actions[type](context, payload),
  }
  return context
}

function video(videoId, extra = {}) {
  return { videoId, title: `Title ${videoId}`, author: 'Author', authorId: 'UC1', lengthSeconds: 60, ...extra }
}

const queuedIds = state => later.getters.getLaterQueued(state).map(i => i._id)
const armedIds = state => later.getters.getLaterArmed(state).map(i => i._id)

beforeEach(() => { wired = null })

/**
 * The Later handler over records in memory, with the signatures and the
 * write-through of `datastores/handlers/base.js`, watched by the main
 * process's seam: the intents the keeper would record of the store's writes.
 * @param {Record<string, any>[]} initial
 * @returns {import('vitest').Mock} the intents, in the order they were recorded
 */
function underTheSeam(initial) {
  const records = new Map(initial.map(record => [record._id, { ...record }]))
  const set = (_id, fields) => { if (records.has(_id)) { records.set(_id, { ...records.get(_id), ...fields }) } }
  const all = () => [...records.values()].map(record => ({ ...record }))

  const handler = {
    find: async () => all(),
    upsert: async (item) => { records.set(item._id, { ...item }) },
    updatePosition: async (_id, position) => set(_id, { position }),
    updatePositions: async (positions) => { for (const { _id, position } of positions) { set(_id, { position }) } },
    updateAlarm: async (_id, alarm, premiereDate) => set(_id, typeof premiereDate === 'number' ? { alarm, premiereDate } : { alarm }),
    updateViewCount: async (_id, viewCount) => set(_id, { viewCount }),
    delete: async (_id) => { records.delete(_id) },
    deleteAll: async () => records.clear(),
  }

  const onIntent = vi.fn()

  watchIntents({ later: handler }, {
    read: async (_section, id) => id === undefined ? all() : all().find(record => record._id === id) ?? null,
    onIntent,
  })

  wired = handler

  return onIntent
}

/** @param {Record<string, number>} positions a queued item's position, by its id */
function queuedAt(positions) {
  const items = {}

  for (const [id, position] of Object.entries(positions)) {
    items[id] = { _id: id, videoId: id, addedAt: 0, position, alarm: null }
  }

  return items
}

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

  it('renumbers every queued item in one write when the gaps close', async () => {
    const state = freshState()
    state.laterItems = queuedAt({ a: 0, b: 1e-7, c: 1 })

    await later.actions.moveLaterItem(contextFor(state), { id: 'c', toIndex: 0 })

    expect(queuedIds(state)).toEqual(['c', 'a', 'b'])
    expect(Object.values(state.laterItems).map(i => i.position).sort()).toEqual([0, 1, 2])
    expect(DBLaterHandlers.updatePosition).toHaveBeenCalledTimes(1)
    expect(DBLaterHandlers.updatePositions).toHaveBeenCalledTimes(1)
    expect(DBLaterHandlers.updatePositions).toHaveBeenCalledWith([
      { _id: 'c', position: 0 }, { _id: 'a', position: 1 }, { _id: 'b', position: 2 },
    ])
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
    expect(DBLaterHandlers.updateAlarm).toHaveBeenCalledWith('a', { at: NOW + 1000, armedAt: NOW }, NOW + 1000)
  })

  it('never arms a PeerTube video, which nothing can check', async () => {
    const state = freshState()
    const context = contextFor(state)
    const uuid = 'b29290cc-dc51-4a12-bcb2-2aa5fece7605'
    const peertube = video(uuid, { platform: 'peertube', host: 'video.blender.org', isUpcoming: true })

    await later.actions.arm(context, { video: peertube, at: NOW + 1000 })
    expect(state.laterItems).toEqual({})

    await later.actions.addToLater(context, peertube)
    await later.actions.arm(context, { video: peertube, at: NOW + 1000 })

    expect(queuedIds(state)).toEqual([uuid])
    expect(armedIds(state)).toEqual([])
    expect(DBLaterHandlers.updateAlarm).not.toHaveBeenCalled()
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
    // Kept through a disarm, to be armed again by
    await later.actions.disarm(context, 'a')
    expect(state.laterItems.a.premiereDate).toBe(NOW + 5000)
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

  describe('firing', () => {
    async function armed(context, id, at) {
      await later.actions.arm(context, { video: video(id), at })
      return context.state.laterItems[id]
    }

    it('stacks the notices on the player soonest first', async () => {
      const state = freshState()
      const context = contextFor(state)
      const late = await armed(context, 'late', NOW + 2000)
      const soon = await armed(context, 'soon', NOW + 1000)

      context.commit('addLaterNotice', late)
      context.commit('addLaterNotice', soon)
      context.commit('addLaterNotice', soon)

      expect(later.getters.getLaterNotices(state).map(i => i._id)).toEqual(['soon', 'late'])
    })

    it('takes an item gone to off the list, and its notice with it', async () => {
      const state = freshState()
      const context = contextFor(state)
      context.commit('addLaterNotice', await armed(context, 'a', NOW))

      await later.actions.laterWatchNow(context, 'a')

      expect(state.laterNotices).toEqual([])
      expect(later.getters.getIsInLater(state)('a')).toBe(false)
    })

    it('leaves a refused item at the top, disarmed, and ends its countdown', async () => {
      const state = freshState()
      const context = contextFor(state)
      await later.actions.addToLater(context, video('q'))
      context.commit('setLaterCountdown', await armed(context, 'a', NOW))

      await later.actions.laterRefuse(context, 'a')

      expect(state.laterCountdown).toBeNull()
      expect(queuedIds(state)).toEqual(['a', 'q'])
    })

    it('counts the players up, and keeps the notices when one goes', async () => {
      const state = freshState()
      const context = contextFor(state)
      context.commit('addLaterNotice', await armed(context, 'a', NOW))

      later.actions.laterPlayerMounted(context)
      expect(later.getters.getLaterPlayerMounted(state)).toBe(true)

      later.actions.laterPlayerUnmounted(context)
      later.actions.laterPlayerUnmounted(context)
      expect(later.getters.getLaterPlayerMounted(state)).toBe(false)
      expect(state.laterNotices.length).toBe(1)
    })
  })

  it('gives the same list after an export and an import into an empty list', async () => {
    const source = freshState()
    const sourceContext = contextFor(source)
    await later.actions.addToLater(sourceContext, video('a'))
    await later.actions.addToLater(sourceContext, video('b'))
    await later.actions.addToLater(sourceContext, video('c'))
    await later.actions.moveLaterItem(sourceContext, { id: 'c', toIndex: 2 })
    await later.actions.arm(sourceContext, { video: video('x'), at: NOW + 5000 })
    await later.actions.arm(sourceContext, { video: video('y'), at: NOW + 1000 })

    const target = freshState()
    const { added } = await later.actions.addManyToLater(contextFor(target), laterFromExport(laterToExport(Object.values(source.laterItems))))

    expect(added).toBe(5)
    expect(queuedIds(target)).toEqual(queuedIds(source))
    expect(armedIds(target)).toEqual(['y', 'x'])
    expect(target.laterItems.x.alarm).toEqual(source.laterItems.x.alarm)

    // And again: everything is there already
    expect((await later.actions.addManyToLater(contextFor(target), laterFromExport(laterToExport(Object.values(source.laterItems))))).added).toBe(0)
  })

  it('forgets that an item went live unanswered once it is disarmed or removed', async () => {
    const state = freshState()
    const context = contextFor(state)
    await later.actions.arm(context, { video: video('a'), at: NOW })
    await later.actions.arm(context, { video: video('b'), at: NOW })
    context.commit('setLaterLiveQuiet', 'a')
    context.commit('setLaterLiveQuiet', 'b')
    expect(later.getters.getLaterIsLiveQuiet(state)('a')).toBe(true)

    await later.actions.disarm(context, 'a')
    await later.actions.laterWatchNow(context, 'b')

    expect(state.laterLiveQuiet).toEqual({})
  })

  it('writes a new view count, and nothing for the same one', async () => {
    const state = freshState()
    const context = contextFor(state)
    await later.actions.addToLater(context, video('a', { viewCount: 10 }))

    await later.actions.updateLaterViewCount(context, { id: 'a', viewCount: 10 })
    await later.actions.updateLaterViewCount(context, { id: 'a', viewCount: 25 })

    expect(state.laterItems.a.viewCount).toBe(25)
    expect(DBLaterHandlers.updateViewCount.mock.calls).toEqual([['a', 25]])
  })
})

describe('what the seam records of the Later store moving an item', () => {
  it('records the move and its new neighbour, and nothing else', async () => {
    const state = freshState()
    state.laterItems = queuedAt({ a: 0, b: 1, c: 2 })
    const onIntent = underTheSeam(Object.values(state.laterItems))

    await later.actions.moveLaterItem(contextFor(state), { id: 'a', toIndex: 2 })

    expect(queuedIds(state)).toEqual(['b', 'c', 'a'])
    expect(onIntent.mock.calls.map(([intent]) => intent)).toEqual([
      { type: 'later.moved', key: 'later/a', data: { after: 'later/c' } },
    ])
  })

  // The positions have drifted below zero, with `b` and `c` a hair apart, so
  // the move forces a renumber. Written one at a time, ascending, taking `a`
  // to nought would put it below the other three before the rest are written,
  // and the seam cannot tell that from a move.
  it('records nothing of the renumber a move forces, from positions below zero', async () => {
    const state = freshState()
    state.laterItems = queuedAt({ a: -5, b: -4, c: -4 + 2e-7, d: 3 })
    const onIntent = underTheSeam(Object.values(state.laterItems))

    await later.actions.moveLaterItem(contextFor(state), { id: 'd', toIndex: 1 })

    expect(queuedIds(state)).toEqual(['a', 'd', 'b', 'c'])
    expect(Object.values(state.laterItems).map(item => item.position)).toEqual([0, 2, 3, 1])
    expect(onIntent.mock.calls.map(([intent]) => intent)).toEqual([
      { type: 'later.moved', key: 'later/d', data: { after: 'later/a' } },
    ])
  })
})
