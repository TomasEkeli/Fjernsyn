import { describe, expect, it } from 'vitest'

import { applyIntents } from './../intentIndex'
import { LATER_EVENTS, foldLaterEvent, positionBetween, renumber } from './later'

const knows = type => LATER_EVENTS.includes(type)

/**
 * @param {string} type
 * @param {string} id the video's id, or `*` for the whole section
 * @param {Record<string, any>} data
 * @param {{ at?: number, by?: string, seq?: number }} written
 */
function event(type, id, data = {}, { at = 10, by = 'm1', seq = 1 } = {}) {
  return { seq, at, by, type, key: `later/${id}`, data }
}

/** @param {Record<string, any>[]} items */
function records(...items) {
  return new Map(items.map(item => [`later/${item._id}`, { ...item }]))
}

const positionsOf = records => Object.fromEntries([...records].map(([key, record]) => [key, record.position]))

describe('folding a Later event', () => {
  it('adds a record with its position after the one it follows', () => {
    const list = records({ _id: 'a', videoId: 'a', position: 0 }, { _id: 'b', videoId: 'b', position: 1 })

    foldLaterEvent(list, event('later.added', 'c', { after: 'later/a' }))

    expect(list.get('later/c').position).toBeGreaterThan(0)
    expect(list.get('later/c').position).toBeLessThan(1)
  })

  it('adds at the front when after is null', () => {
    const list = records({ _id: 'a', videoId: 'a', position: 0 }, { _id: 'b', videoId: 'b', position: 1 })

    foldLaterEvent(list, event('later.added', 'c', { after: null }))

    expect(list.get('later/c').position).toBeLessThan(0)
  })

  it('adds a record the fold has never seen with only the fields the event sets', () => {
    const list = new Map()

    foldLaterEvent(list, event('later.added', 'dQw4w9WgXcQ', { after: null }))

    expect(list.get('later/dQw4w9WgXcQ')).toEqual({ _id: 'dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ', position: 0 })
  })

  it('removes a record', () => {
    const list = records({ _id: 'a', videoId: 'a', position: 0 }, { _id: 'b', videoId: 'b', position: 1 })

    foldLaterEvent(list, event('later.removed', 'a'))

    expect([...list.keys()]).toEqual(['later/b'])
  })

  it('moves a record between two others, and leaves every other position alone', () => {
    const list = records(
      { _id: 'a', videoId: 'a', position: 0 },
      { _id: 'b', videoId: 'b', position: 2 },
      { _id: 'c', videoId: 'c', position: 4 },
    )

    const changed = foldLaterEvent(list, event('later.moved', 'c', { after: 'later/a' }))

    expect(positionsOf(list)).toEqual({ 'later/a': 0, 'later/b': 2, 'later/c': 1 })
    expect(changed).toBeUndefined()
  })

  it('moves to the end when the record it should follow is gone', () => {
    const list = records({ _id: 'a', videoId: 'a', position: 0 }, { _id: 'b', videoId: 'b', position: 1 })

    foldLaterEvent(list, event('later.moved', 'a', { after: 'later/gone' }))

    expect(list.get('later/a').position).toBeGreaterThan(1)
    expect(list.get('later/b').position).toBe(1)
  })

  it('leaves the stored premiere date alone when the event has none', () => {
    const list = records({ _id: 'a', videoId: 'a', position: 0, premiereDate: 99 })

    foldLaterEvent(list, event('later.alarmArmed', 'a', { alarm: { at: 2, armedAt: 1 } }))

    expect(list.get('later/a').premiereDate).toBe(99)
  })

  it('leaves a known video where it is when its alarm is armed', () => {
    const list = records({ _id: 'a', videoId: 'a', position: 0 }, { _id: 'b', videoId: 'b', position: 4 })

    foldLaterEvent(list, event('later.alarmArmed', 'b', { alarm: { at: 2, armedAt: 1 } }))

    expect(list.get('later/b').position).toBe(4)
  })

  it('does not throw clearing the alarm of a video it has never seen', () => {
    expect(() => foldLaterEvent(new Map(), event('later.alarmCleared', 'x'))).not.toThrow()
  })

  it('arms an alarm, and sets the premiere date when the event has one', () => {
    const list = records({ _id: 'a', videoId: 'a', position: 0, title: 'A talk', alarm: null })

    foldLaterEvent(list, event('later.alarmArmed', 'a', { alarm: { at: 200, armedAt: 100 }, premiereDate: 200 }))

    expect(list.get('later/a')).toEqual({
      _id: 'a',
      videoId: 'a',
      position: 0,
      title: 'A talk',
      alarm: { at: 200, armedAt: 100 },
      premiereDate: 200,
    })
  })

  it('arms a video it has never seen, putting it at the front', () => {
    const list = records({ _id: 'a', videoId: 'a', position: 0 })

    foldLaterEvent(list, event('later.alarmArmed', 'b', { alarm: { at: 200, armedAt: 100 } }))

    expect(list.get('later/b')).toEqual({ _id: 'b', videoId: 'b', position: -1, alarm: { at: 200, armedAt: 100 } })
  })

  it('clears an alarm and leaves the rest of the record alone', () => {
    const list = records({ _id: 'a', videoId: 'a', position: 3, title: 'A talk', alarm: { at: 200, armedAt: 100 } })

    foldLaterEvent(list, event('later.alarmCleared', 'a'))

    expect(list.get('later/a')).toEqual({ _id: 'a', videoId: 'a', position: 3, title: 'A talk', alarm: null })
  })
})

describe('a clear meeting a record added after it', () => {
  /**
   * One event per call, with the index carried over, as two machines meet
   * each other's events across ticks
   * @param {import('./../intentLog').IntentEvent[]} events
   */
  function oneAtATime(events) {
    const records = new Map()
    let index = {}

    for (const event of events) {
      index = applyIntents({ records, index, events: [event], foldEvent: foldLaterEvent, knows }).index
    }

    return records
  }

  it('clears the list, and leaves a video added after the clear alone', () => {
    const before = event('later.added', 'a', { after: null }, { at: 10, by: 'm2', seq: 1 })
    const cleared = event('later.cleared', '*', {}, { at: 100, by: 'm1', seq: 3 })
    const after = event('later.added', 'b', { after: null }, { at: 101, by: 'm2', seq: 4 })

    const arrivals = [
      [before, cleared, after],
      [after, cleared, before],
      [after, before, cleared],
    ]

    for (const events of arrivals) {
      const folded = oneAtATime(events)

      expect([...folded.keys()]).toEqual(['later/b'])
      expect(folded.get('later/b')).toEqual({ _id: 'b', videoId: 'b', position: 0 })
    }
  })
})

describe('two machines placing after the same video', () => {
  const order = records => [...records.values()].sort((a, b) => a.position - b.position).map(record => record._id)

  const seed = () => records({ _id: 'a', videoId: 'a', position: 0 }, { _id: 'b', videoId: 'b', position: 1 })

  /**
   * One event per call, with the index carried over, as two machines meet
   * each other's events across ticks
   * @param {import('./../intentLog').IntentEvent[]} events
   */
  function oneAtATime(events) {
    const list = seed()
    let index = {}

    for (const event of events) {
      index = applyIntents({ records: list, index, events: [event], foldEvent: foldLaterEvent, knows }).index
    }

    return order(list)
  }

  function inOneBatch(events) {
    const list = seed()

    applyIntents({ records: list, index: {}, events, foldEvent: foldLaterEvent, knows })

    return order(list)
  }

  it('puts two adds after one video in one order, whichever arrives first', () => {
    const older = event('later.added', 'c', { after: 'later/a' }, { at: 10, by: 'm1' })
    const newer = event('later.added', 'd', { after: 'later/a' }, { at: 11, by: 'm2', seq: 2 })

    expect(oneAtATime([older, newer])).toEqual(['a', 'd', 'c', 'b'])
    expect(oneAtATime([newer, older])).toEqual(['a', 'd', 'c', 'b'])
  })

  it('puts two adds at the front in one order, whichever arrives first', () => {
    const older = event('later.added', 'c', { after: null }, { at: 10, by: 'm1' })
    const newer = event('later.added', 'd', { after: null }, { at: 11, by: 'm2', seq: 2 })

    expect(oneAtATime([older, newer])).toEqual(['d', 'c', 'a', 'b'])
    expect(oneAtATime([newer, older])).toEqual(['d', 'c', 'a', 'b'])
  })

  it('reaches across ticks what one batch of the same events reaches', () => {
    const older = event('later.added', 'c', { after: 'later/a' }, { at: 10, by: 'm1' })
    const newer = event('later.added', 'd', { after: 'later/a' }, { at: 11, by: 'm2', seq: 2 })

    expect(oneAtATime([newer, older])).toEqual(inOneBatch([older, newer]))
  })
})

describe('running out of room between two neighbours', () => {
  it('gives no position at all, so none ever equals a neighbour\'s', () => {
    expect(positionBetween(1, 1.0000000000000002)).toBeNull()
    expect(positionBetween(1.0000000000000002, 1.0000000000000004)).toBeNull()
    expect(positionBetween(1, 2)).toBe(1.5)
  })

  it('needs no renumber when the gap has closed behind the record itself', () => {
    const list = records(
      { _id: 'a', videoId: 'a', position: 1 },
      { _id: 'c', videoId: 'c', position: 1.0000000000000002 },
      { _id: 'b', videoId: 'b', position: 5 },
    )

    expect(foldLaterEvent(list, event('later.moved', 'c', { after: 'later/a' }))).toBeUndefined()
    expect(list.get('later/a').position).toBe(1)
  })

  it('breaks a tie on position by key, whatever order the map is in', () => {
    const list = records({ _id: 'b', videoId: 'b', position: 3 }, { _id: 'a', videoId: 'a', position: 3 })

    renumber(list)

    expect(list.get('later/a').position).toBe(0)
    expect(list.get('later/b').position).toBe(1)
  })

  it('renumbers to whole numbers in the order they are in, and names what changed', () => {
    const list = records(
      { _id: 'a', videoId: 'a', position: -3 },
      { _id: 'b', videoId: 'b', position: 0.5 },
      { _id: 'c', videoId: 'c', position: 2 },
    )

    const changed = renumber(list)

    expect(positionsOf(list)).toEqual({ 'later/a': 0, 'later/b': 1, 'later/c': 2 })
    expect(changed.map(record => record._id)).toEqual(['a', 'b'])
  })

  it('renumbers when the gap has closed, and names the records it moved out of the way', () => {
    const list = records(
      { _id: 'a', videoId: 'a', position: 1 },
      { _id: 'b', videoId: 'b', position: 1.0000000000000002 },
      { _id: 'c', videoId: 'c', position: 5 },
    )

    const changed = foldLaterEvent(list, event('later.moved', 'c', { after: 'later/a' }))

    expect(list.get('later/c').position).toBeGreaterThan(list.get('later/a').position)
    expect(list.get('later/c').position).toBeLessThan(list.get('later/b').position)
    expect(changed).toEqual(['later/a', 'later/b'])
  })
})
