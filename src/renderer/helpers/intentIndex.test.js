import { describe, expect, it } from 'vitest'

import { applyIntents, beats } from './intentIndex'

const KNOWN = ['later.added', 'later.removed', 'later.cleared']

const knows = type => KNOWN.includes(type)

const idOf = key => key.slice(key.indexOf('/') + 1)

const sectionOf = key => key.slice(0, key.indexOf('/'))

/**
 * A stand-in for the Later fold, which is a module of its own. It knows just
 * enough to show what this one does with the records the fold leaves behind.
 * @param {Map<string, Record<string, any>>} records
 * @param {import('./intentLog').IntentEvent} event
 */
function fold(records, event) {
  if (event.type === 'later.removed') {
    records.delete(event.key)
    return
  }

  if (event.type === 'later.cleared') {
    for (const key of [...records.keys()]) {
      if (sectionOf(key) === sectionOf(event.key)) { records.delete(key) }
    }
    return
  }

  records.set(event.key, { _id: idOf(event.key), ...event.data })
}

const apply = ({ records = new Map(), index = {}, events, foldEvent = fold }) =>
  applyIntents({ records, index, events, foldEvent, knows })

const ADDED = { seq: 1, at: 10, by: 'm1', type: 'later.added', key: 'later/a', data: { after: null } }

function permutations(items) {
  if (items.length <= 1) { return [items] }

  return items.flatMap((item, at) =>
    permutations([...items.slice(0, at), ...items.slice(at + 1)]).map(rest => [item, ...rest]))
}

describe('beating what was applied before', () => {
  it('takes a key no intent has reached', () => {
    expect(beats(ADDED, undefined)).toBe(true)
  })

  it('loses to the entry its own event wrote', () => {
    expect(beats(ADDED, { at: 10, by: 'm1', seq: 1 })).toBe(false)
  })

  it('loses to an entry written before the index kept a sequence number', () => {
    expect(beats(ADDED, { at: 10, by: 'm1' })).toBe(false)
  })
})

describe('applying events', () => {
  it('applies an event to a key nothing has touched', () => {
    const records = new Map()

    const result = apply({ records, events: [ADDED] })

    expect(result.put).toEqual([{ _id: 'a', after: null }])
    expect(result.remove).toEqual([])
    expect(result.index).toEqual({ 'later/a': { at: 10, by: 'm1', seq: 1 } })
    expect(result.applied).toEqual([ADDED])
    expect(result.skipped).toEqual([])
    expect(records.get('later/a')).toEqual({ _id: 'a', after: null })
  })

  it('leaves a key alone when the event is older than what was applied to it', () => {
    const records = new Map([['later/a', { _id: 'a', position: 1 }]])
    const older = { seq: 4, at: 10, by: 'm1', type: 'later.removed', key: 'later/a', data: {} }

    const result = apply({ records, index: { 'later/a': { at: 20, by: 'm2', seq: 9 } }, events: [older] })

    expect(result.put).toEqual([])
    expect(result.remove).toEqual([])
    expect(result.applied).toHaveLength(1)
    expect(result.index).toEqual({ 'later/a': { at: 20, by: 'm2', seq: 9 } })
    expect(records.get('later/a')).toEqual({ _id: 'a', position: 1 })
  })

  it('leaves a key alone when its section was cleared after the event happened', () => {
    const records = new Map()
    const older = { seq: 2, at: 90, by: 'm2', type: 'later.added', key: 'later/c', data: { after: null } }

    const result = apply({ records, index: { 'later/*': { at: 100, by: 'm1', seq: 5 } }, events: [older] })

    expect(result.put).toEqual([])
    expect(result.applied).toHaveLength(1)
    expect(records.has('later/c')).toBe(false)
  })

  it('folds a batch in the events\' own order', () => {
    const earlier = { seq: 1, at: 10, by: 'm1', type: 'later.added', key: 'later/a', data: { after: null } }
    const later = { seq: 2, at: 12, by: 'm1', type: 'later.added', key: 'later/b', data: { after: 'later/a' } }

    const seen = []
    const noting = (records, event) => {
      seen.push(event.seq)
      fold(records, event)
    }

    apply({ records: new Map(), events: [later, earlier], foldEvent: noting })

    expect(seen).toEqual([1, 2])
  })

  it('hands the fold the index as it stands, so a fold can tell what put a record where it is', () => {
    const second = { seq: 2, at: 12, by: 'm1', type: 'later.added', key: 'later/b', data: { after: 'later/a' } }

    const seen = []
    const noting = (records, event, index) => {
      seen.push({ ...index })
      fold(records, event)
    }

    apply({ records: new Map(), events: [ADDED, second], foldEvent: noting })

    expect(seen[0]).toEqual({})
    expect(seen[1]).toEqual({ 'later/a': { at: 10, by: 'm1', seq: 1 } })
  })

  it('keeps an event of a type it does not know out of applied, and changes nothing', () => {
    const records = new Map([['later/a', { _id: 'a', position: 1 }]])
    const index = { 'later/a': { at: 5, by: 'm1', seq: 7 } }
    const unknown = { seq: 2, at: 40, by: 'm2', type: 'later.quantumLeapt', key: 'later/a', data: {} }

    const result = apply({ records, index, events: [unknown] })

    expect(result.applied).toEqual([])
    expect(result.skipped).toEqual([unknown])
    expect(result.index).toEqual(index)
    expect(result.put).toEqual([])
    expect(result.remove).toEqual([])
    expect(records.get('later/a')).toEqual({ _id: 'a', position: 1 })
  })

  it('names only the keys its events touched in put and remove', () => {
    const records = new Map([
      ['later/bystander', { _id: 'bystander', position: 1 }],
      ['later/gone', { _id: 'gone', position: 2 }],
    ])

    const meddling = (records, event) => {
      records.get('later/bystander').position = 9
      records.delete('later/gone')
      fold(records, event)
    }

    const result = apply({ records, events: [ADDED], foldEvent: meddling })

    expect(result.put).toEqual([{ _id: 'a', after: null }])
    expect(result.remove).toEqual([])
    expect(records.get('later/bystander')).toEqual({ _id: 'bystander', position: 9 })
  })

  it('puts the further keys the fold says it changed', () => {
    const records = new Map([['later/bystander', { _id: 'bystander', position: 1 }]])

    const renumbering = (records, event) => {
      records.get('later/bystander').position = 9
      fold(records, event)

      return ['later/bystander']
    }

    const result = apply({ records, events: [ADDED], foldEvent: renumbering })

    expect(result.put).toEqual([{ _id: 'a', after: null }, { _id: 'bystander', position: 9 }])
    expect(result.remove).toEqual([])
    expect(result.index).toEqual({ 'later/a': { at: 10, by: 'm1', seq: 1 } })
  })

  it('removes only the records older than the clear', () => {
    const records = new Map([['later/old', { _id: 'old', position: 1 }], ['later/new', { _id: 'new', position: 2 }]])
    const index = { 'later/old': { at: 40, by: 'm2', seq: 1 }, 'later/new': { at: 60, by: 'm2', seq: 2 } }
    const cleared = { seq: 3, at: 50, by: 'm1', type: 'later.cleared', key: 'later/*', data: {} }

    const result = apply({ records, index, events: [cleared] })

    expect(result.remove).toEqual(['later/old'])
    expect(result.put).toEqual([])
    expect(records.get('later/new')).toEqual({ _id: 'new', position: 2 })
  })

  it('names every record of the section a clear empties, and none of another', () => {
    const records = new Map([
      ['later/a', { _id: 'a', position: 1 }],
      ['later/b', { _id: 'b', position: 2 }],
      ['history/x', { _id: 'x' }],
    ])
    const cleared = { seq: 3, at: 50, by: 'm2', type: 'later.cleared', key: 'later/*', data: {} }

    const result = apply({ records, events: [cleared] })

    expect(result.remove).toEqual(['later/a', 'later/b'])
    expect(result.put).toEqual([])
    expect(result.index).toEqual({ 'later/*': { at: 50, by: 'm2', seq: 3 } })
    expect(records.get('history/x')).toEqual({ _id: 'x' })
  })
})

describe('arrival across ticks', () => {
  const oneAtATime = events => {
    const records = new Map()
    let index = {}

    for (const event of events) {
      index = apply({ records, index, events: [event] }).index
    }

    return { records: Object.fromEntries(records), index }
  }

  it('reaches the same records and the same index whichever order the events arrive in', () => {
    const events = [
      { seq: 1, at: 10, by: 'm1', type: 'later.added', key: 'later/a', data: { after: null } },
      { seq: 2, at: 12, by: 'm1', type: 'later.removed', key: 'later/a', data: {} },
      { seq: 7, at: 11, by: 'm2', type: 'later.added', key: 'later/b', data: { after: 'later/a' } },
      { seq: 8, at: 14, by: 'm2', type: 'later.added', key: 'later/a', data: { after: null } },
      { seq: 9, at: 13, by: 'm2', type: 'later.added', key: 'later/c', data: { after: 'later/b' } },
    ]

    const orders = permutations(events)
    expect(orders).toHaveLength(120)

    const outcomes = orders.map(oneAtATime)

    expect(outcomes[0].index).toEqual({
      'later/a': { at: 14, by: 'm2', seq: 8 },
      'later/b': { at: 11, by: 'm2', seq: 7 },
      'later/c': { at: 13, by: 'm2', seq: 9 },
    })

    for (const outcome of outcomes) {
      expect(outcome).toEqual(outcomes[0])
    }
  })

  it('breaks a tie on at by the installation id, the same way on both machines', () => {
    const first = { seq: 1, at: 10, by: 'm1', type: 'later.added', key: 'later/a', data: { after: null } }
    const second = { seq: 6, at: 10, by: 'm2', type: 'later.added', key: 'later/a', data: { after: 'later/z' } }

    for (const events of [[first, second], [second, first]]) {
      const { records, index } = oneAtATime(events)

      expect(index).toEqual({ 'later/a': { at: 10, by: 'm2', seq: 6 } })
      expect(records['later/a']).toEqual({ _id: 'a', after: 'later/z' })
    }
  })

  it('breaks a tie on at within one machine by its sequence number', () => {
    const first = { seq: 1, at: 10, by: 'm1', type: 'later.added', key: 'later/a', data: { after: null } }
    const second = { seq: 2, at: 10, by: 'm1', type: 'later.added', key: 'later/a', data: { after: 'later/z' } }

    for (const events of [[first, second], [second, first]]) {
      const { records, index } = oneAtATime(events)

      expect(index).toEqual({ 'later/a': { at: 10, by: 'm1', seq: 2 } })
      expect(records['later/a']).toEqual({ _id: 'a', after: 'later/z' })
    }
  })

  it('leaves a record added after a clear alone, whichever order they arrive in', () => {
    const cleared = { seq: 3, at: 100, by: 'm1', type: 'later.cleared', key: 'later/*', data: {} }
    const added = { seq: 4, at: 101, by: 'm2', type: 'later.added', key: 'later/b', data: { after: null } }

    for (const events of [[cleared, added], [added, cleared]]) {
      const { records, index } = oneAtATime(events)

      expect(Object.keys(records)).toEqual(['later/b'])
      expect(index['later/b']).toEqual({ at: 101, by: 'm2', seq: 4 })
    }
  })
})
