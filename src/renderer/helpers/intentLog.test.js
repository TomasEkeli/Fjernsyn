import { describe, expect, it } from 'vitest'

import {
  addToRanges,
  compareEvents,
  parseSegmentName,
  rangesHold,
  readSegment,
  segmentName,
  writeEventLine,
} from './intentLog'

const REMOVED = { seq: 3, at: 7, by: 'm1', type: 'later.removed', key: 'later/a', data: {} }
const ADDED = { seq: 4, at: 8, by: 'm1', type: 'later.added', key: 'later/b', data: { after: 'later/a' } }

describe('the event line', () => {
  it('writes the keys in the stable order and ends in a newline', () => {
    expect(writeEventLine({ data: {}, key: 'later/a', type: 'later.removed', by: 'm1', at: 7, seq: 3 }))
      .toBe('{"seq":3,"at":7,"by":"m1","type":"later.removed","key":"later/a","data":{}}\n')
  })

  it('reads back what it wrote', () => {
    expect(readSegment(writeEventLine(ADDED))).toEqual({ events: [ADDED], partial: false })
  })
})

describe('reading a segment', () => {
  it('drops a last line with no newline and says it was partial', () => {
    const text = writeEventLine(REMOVED) + '{"seq":4,"at":8,"by":"m1"'

    expect(readSegment(text)).toEqual({ events: [REMOVED], partial: true })
  })

  it('takes the line whole once the append has finished', () => {
    const text = writeEventLine(REMOVED) + '{"seq":4,"at":8,"by":"m1"' +
      ',"type":"later.added","key":"later/b","data":{"after":"later/a"}}\n'

    expect(readSegment(text)).toEqual({ events: [REMOVED, ADDED], partial: false })
  })

  it('skips a line that is not JSON, one missing seq, at, by, type or key, and one whose data is not an object', () => {
    const lines = [
      'not JSON at all',
      JSON.stringify({ at: 7, by: 'm1', type: 'later.removed', key: 'later/a', data: {} }),
      JSON.stringify({ seq: 3, by: 'm1', type: 'later.removed', key: 'later/a', data: {} }),
      JSON.stringify({ seq: 3, at: 7, type: 'later.removed', key: 'later/a', data: {} }),
      JSON.stringify({ seq: 3, at: 7, by: 'm1', key: 'later/a', data: {} }),
      JSON.stringify({ seq: 3, at: 7, by: 'm1', type: 'later.removed', data: {} }),
      JSON.stringify({ ...REMOVED, data: null }),
      JSON.stringify({ ...REMOVED, data: ['later/a'] }),
      JSON.stringify({ ...REMOVED, data: 'later/a' }),
      JSON.stringify({ ...REMOVED, data: 7 }),
    ]

    const text = lines.map(line => line + '\n').join('') + writeEventLine(ADDED)

    expect(readSegment(text)).toEqual({ events: [ADDED], partial: false })
  })

  it('reads an empty segment as no events at all', () => {
    expect(readSegment('')).toEqual({ events: [], partial: false })
  })
})

describe('ordering', () => {
  it('orders by at, then by installation id, then by sequence number', () => {
    const first = { seq: 1, at: 10, by: 'm1', type: 'later.added', key: 'later/a', data: {} }
    const second = { seq: 2, at: 10, by: 'm1', type: 'later.removed', key: 'later/a', data: {} }
    const third = { seq: 9, at: 10, by: 'm2', type: 'later.added', key: 'later/b', data: {} }
    const fourth = { seq: 8, at: 11, by: 'm1', type: 'later.added', key: 'later/c', data: {} }
    const fifth = { seq: 7, at: 12, by: 'm2', type: 'later.removed', key: 'later/c', data: {} }

    const shuffled = [fourth, third, fifth, first, second]

    expect([...shuffled].sort(compareEvents)).toEqual([first, second, third, fourth, fifth])
  })
})

describe('the applied ranges', () => {
  it('joins a sequence number onto the range below it', () => {
    expect(addToRanges([[1, 3]], 4)).toEqual([[1, 4]])
  })

  it('joins two ranges when the gap between them is filled', () => {
    expect(addToRanges([[1, 3], [5, 7]], 4)).toEqual([[1, 7]])
  })

  it('keeps a range of its own for a sequence number far ahead', () => {
    expect(addToRanges([[1, 3]], 900)).toEqual([[1, 3], [900, 900]])
  })

  it('leaves the ranges as they were for one they already cover', () => {
    expect(addToRanges([[1, 3], [5, 7]], 6)).toEqual([[1, 3], [5, 7]])
  })

  it('says yes to every sequence number in the ranges and no to every other', () => {
    const ranges = [[1, 3], [5, 7]]

    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(seq => rangesHold(ranges, seq)))
      .toEqual([false, true, true, true, false, true, true, true, false])
  })
})

describe('segment names', () => {
  it('round trips a name', () => {
    const name = segmentName('9b0c4f21', 12)

    expect(name).toBe('events-9b0c4f21-12.jsonl')
    expect(parseSegmentName(name)).toEqual({ installationId: '9b0c4f21', index: 12 })
  })

  it('refuses a name that is not a segment', () => {
    expect(parseSegmentName('base-0123456789abcdef.json.gz')).toBeNull()
    expect(parseSegmentName('state-m1.json')).toBeNull()
    expect(parseSegmentName('events-9b0c4f21.jsonl')).toBeNull()
    expect(parseSegmentName('events-9b0c4f21-x.jsonl')).toBeNull()
  })
})
