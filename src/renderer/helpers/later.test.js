import { describe, expect, it } from 'vitest'

import {
  armedInOrder,
  distanceTo,
  laterFromExport,
  laterItemFromVideo,
  laterToExport,
  laterStateAt,
  moveTo,
  needsRenumbering,
  positionBetween,
  queuedInOrder,
  renumbered,
  topPosition,
} from './later'

function item(id, position, extra = {}) {
  return { _id: id, videoId: id, title: id, author: '', authorId: '', addedAt: 0, position, alarm: null, ...extra }
}

const A = item('a', 0)
const B = item('b', 1)
const C = item('c', 2)
const D = item('d', 3)
const LIST = [C, A, D, B]

const ids = list => list.map(i => i._id)

describe('the Later list helpers', () => {
  describe('topPosition', () => {
    it('is 0 for an empty list', () => {
      expect(topPosition([])).toBe(0)
    })

    it('is one less than the smallest', () => {
      expect(topPosition(LIST)).toBe(-1)
      expect(topPosition([item('x', 4.5), item('y', 7)])).toBe(3.5)
    })
  })

  describe('positionBetween', () => {
    it('takes the midpoint', () => {
      expect(positionBetween(1, 2)).toBe(1.5)
    })

    it('goes one past either end', () => {
      expect(positionBetween(undefined, 2)).toBe(1)
      expect(positionBetween(5, undefined)).toBe(6)
      expect(positionBetween(undefined, undefined)).toBe(0)
    })
  })

  describe('moveTo', () => {
    it('moves to the top', () => {
      expect(moveTo(LIST, 'c', 0)).toBe(-1)
    })

    it('moves to the bottom', () => {
      expect(moveTo(LIST, 'a', 3)).toBe(4)
    })

    it('moves one place up and one place down', () => {
      // c above b: between a and b
      expect(moveTo(LIST, 'c', 1)).toBe(0.5)
      // b below c: between c and d
      expect(moveTo(LIST, 'b', 2)).toBe(2.5)
    })

    it('writes nothing for a move to where it is', () => {
      expect(moveTo(LIST, 'b', 1)).toBeNull()
      expect(moveTo(LIST, 'a', 0)).toBeNull()
      expect(moveTo(LIST, 'd', 3)).toBeNull()
    })

    it('writes nothing for an item not queued', () => {
      expect(moveTo([...LIST, item('e', 9, { alarm: { at: 1, armedAt: 0 } })], 'e', 0)).toBeNull()
      expect(moveTo(LIST, 'nope', 0)).toBeNull()
    })

    it('keeps a moved list in the order asked for', () => {
      const position = moveTo(LIST, 'd', 1)
      const moved = LIST.map(i => i._id === 'd' ? { ...i, position } : i)
      expect(ids(queuedInOrder(moved))).toEqual(['a', 'd', 'b', 'c'])
    })
  })

  describe('renumbering', () => {
    it('is not needed while there is room', () => {
      expect(needsRenumbering(LIST)).toBe(false)
    })

    it('is needed when a gap closes', () => {
      let list = [item('a', 0), item('b', 1)]
      // Keep putting a new item just above b until the gap is gone
      for (let n = 0; n < 40; n++) {
        const position = positionBetween(list[0].position, queuedInOrder(list)[1].position)
        list = [list[0], item(`x${n}`, position), ...list.slice(1)]
      }
      expect(needsRenumbering(list)).toBe(true)

      const rewritten = renumbered(list)
      expect(rewritten.map(r => r.position)).toEqual(rewritten.map((_, i) => i))
      expect(rewritten.map(r => r._id)).toEqual(ids(queuedInOrder(list)))
    })
  })

  describe('the two sections', () => {
    const armedLate = item('late', 0, { alarm: { at: 2000, armedAt: 0 }, addedAt: 1 })
    const armedSoonNew = item('soonNew', 0, { alarm: { at: 1000, armedAt: 0 }, addedAt: 5 })
    const armedSoonOld = item('soonOld', 0, { alarm: { at: 1000, armedAt: 0 }, addedAt: 2 })
    const all = [...LIST, armedLate, armedSoonNew, armedSoonOld]

    it('orders the queued by position, leaving the armed out', () => {
      expect(ids(queuedInOrder(all))).toEqual(['a', 'b', 'c', 'd'])
    })

    it('orders the armed by time, then by time added', () => {
      expect(ids(armedInOrder(all))).toEqual(['soonOld', 'soonNew', 'late'])
    })

    it('moves an item between them when armed or disarmed', () => {
      const armed = all.map(i => i._id === 'b' ? { ...i, alarm: { at: 1500, armedAt: 0 } } : i)
      expect(ids(queuedInOrder(armed))).toEqual(['a', 'c', 'd'])
      expect(ids(armedInOrder(armed))).toEqual(['soonOld', 'soonNew', 'b', 'late'])

      const disarmed = armed.map(i => i._id === 'late' ? { ...i, alarm: null, position: topPosition(armed) } : i)
      expect(ids(queuedInOrder(disarmed))).toEqual(['late', 'a', 'c', 'd'])
    })
  })

  describe('laterStateAt', () => {
    const at = Date.parse('2026-10-04T20:00:00Z')

    it('waits until two minutes before', () => {
      expect(laterStateAt(at - 3 * 60 * 1000, at)).toBe('waiting')
    })

    it('checks from two minutes before until three hours after', () => {
      expect(laterStateAt(at - 2 * 60 * 1000, at)).toBe('checking')
      expect(laterStateAt(at, at)).toBe('checking')
      expect(laterStateAt(at + 3 * 60 * 60 * 1000, at)).toBe('checking')
    })

    it('did not start after that', () => {
      expect(laterStateAt(at + 3 * 60 * 60 * 1000 + 1, at)).toBe('didNotStart')
    })
  })

  describe('distanceTo', () => {
    const at = Date.parse('2026-10-04T20:00:00Z')
    const MINUTE = 60 * 1000
    const HOUR = 60 * MINUTE
    const DAY = 24 * HOUR

    it('is nothing within half a minute either side', () => {
      expect(distanceTo(at - 29 * 1000, at)).toEqual({ past: false, duration: {} })
      expect(distanceTo(at + 29 * 1000, at)).toEqual({ past: false, duration: {} })
    })

    it('is minutes alone under an hour', () => {
      expect(distanceTo(at - 25 * MINUTE, at)).toEqual({ past: false, duration: { minutes: 25 } })
      expect(distanceTo(at - 59 * MINUTE, at)).toEqual({ past: false, duration: { minutes: 59 } })
    })

    it('is hours and minutes under a day, leaving out no minutes', () => {
      expect(distanceTo(at - (HOUR + 40 * MINUTE), at)).toEqual({ past: false, duration: { hours: 1, minutes: 40 } })
      expect(distanceTo(at - 3 * HOUR, at)).toEqual({ past: false, duration: { hours: 3 } })
    })

    it('is days and hours from a day on, never weeks', () => {
      expect(distanceTo(at - (DAY + 11 * HOUR + 59 * MINUTE), at)).toEqual({ past: false, duration: { days: 1, hours: 11 } })
      expect(distanceTo(at - 19 * DAY, at)).toEqual({ past: false, duration: { days: 19 } })
    })

    it('rounds to the minute', () => {
      expect(distanceTo(at - (HOUR + 59 * MINUTE + 40 * 1000), at)).toEqual({ past: false, duration: { hours: 2 } })
    })

    it('says when the time has passed', () => {
      expect(distanceTo(at + 5 * MINUTE, at)).toEqual({ past: true, duration: { minutes: 5 } })
      expect(distanceTo(at + 4 * HOUR, at)).toEqual({ past: true, duration: { hours: 4 } })
    })
  })

  describe('laterItemFromVideo', () => {
    it('takes the card fields, with times in ms', () => {
      expect(laterItemFromVideo({
        videoId: 'abc',
        title: 'T',
        author: 'Au',
        authorId: 'UC1',
        lengthSeconds: 60,
        viewCount: 1234,
        published: 1000,
        isUpcoming: true,
        premiereDate: '2026-10-04T20:00:00.000Z',
        description: 'left out',
      }, 42)).toEqual({
        _id: 'abc',
        videoId: 'abc',
        title: 'T',
        author: 'Au',
        authorId: 'UC1',
        lengthSeconds: 60,
        viewCount: 1234,
        published: 1000,
        isUpcoming: true,
        premiereDate: Date.parse('2026-10-04T20:00:00Z'),
        addedAt: 42,
        position: 0,
        alarm: null,
      })
    })

    it('reads a premiere timestamp in seconds', () => {
      expect(laterItemFromVideo({ videoId: 'x', premiereTimestamp: 10 }, 0).premiereDate).toBe(10000)
    })

    it('keeps a PeerTube video\'s platform, host and thumbnail, keyed by its uuid', () => {
      const item = laterItemFromVideo({ ...PEERTUBE_VIDEO, description: 'left out', authorThumbnail: 'https://example.org/a.jpg' }, 42)

      expect(item).toEqual({
        _id: PEERTUBE_UUID,
        videoId: PEERTUBE_UUID,
        title: 'Sprite Fright',
        author: 'Blender',
        authorId: 'blender@video.blender.org',
        lengthSeconds: 629,
        platform: 'peertube',
        host: 'video.blender.org',
        thumbnail: PEERTUBE_THUMBNAIL,
        addedAt: 42,
        position: 0,
        alarm: null,
      })
    })

    it('adds nothing of a platform to a YouTube video', () => {
      const item = laterItemFromVideo({ videoId: 'abc', title: 'T', thumbnail: 'https://i.ytimg.com/x.jpg', host: 'www.youtube.com' }, 0)

      expect(item).not.toHaveProperty('platform')
      expect(item).not.toHaveProperty('host')
      expect(item).not.toHaveProperty('thumbnail')
    })
  })
})

const PEERTUBE_UUID = 'b29290cc-dc51-4a12-bcb2-2aa5fece7605'
const PEERTUBE_THUMBNAIL = 'https://video.blender.org/lazy-static/previews/sprite-fright.jpg'
const PEERTUBE_VIDEO = {
  videoId: PEERTUBE_UUID,
  platform: 'peertube',
  host: 'video.blender.org',
  thumbnail: PEERTUBE_THUMBNAIL,
  title: 'Sprite Fright',
  author: 'Blender',
  authorId: 'blender@video.blender.org',
  lengthSeconds: 629,
}

describe('the Later list export', () => {
  const items = [
    item('q2', 5, { addedAt: 2 }),
    item('q1', 1, { addedAt: 1 }),
    item('armed', 0, { addedAt: 3, alarm: { at: 99, armedAt: 50 }, isUpcoming: true, premiereDate: 99 }),
  ]

  it('writes one item a line, armed first, then the queued in order', () => {
    const lines = laterToExport(items).trim().split('\n').map(line => JSON.parse(line)._id)
    expect(lines).toEqual(['armed', 'q1', 'q2'])
  })

  it('reads back the same list, order and alarms included', () => {
    const read = laterFromExport(laterToExport(items))

    expect(read.map(i => i._id)).toEqual(['armed', 'q1', 'q2'])
    expect(read[0].alarm).toEqual({ at: 99, armedAt: 50 })
    expect(read[0]).toMatchObject({ title: 'armed', isUpcoming: true, premiereDate: 99 })
  })

  it('skips the lines that are not items', () => {
    const text = [
      'not json',
      JSON.stringify({ videoId: 'x' }),
      JSON.stringify({ title: 'no id' }),
      '',
      JSON.stringify({ videoId: 'ok', title: 'Ok', alarm: { at: 'soon' } }),
    ].join('\n')

    expect(laterFromExport(text)).toEqual([expect.objectContaining({ _id: 'ok', alarm: null })])
  })

  it('reads back a PeerTube item with its platform fields', () => {
    const peertube = laterItemFromVideo(PEERTUBE_VIDEO, 7)

    expect(laterFromExport(laterToExport([peertube]))).toEqual([{ ...peertube, position: 0 }])
  })

  it('checks a PeerTube item as the other imports do: its uuid in lower case, a thumbnail only over https, no alarm', () => {
    const text = [
      JSON.stringify({ ...PEERTUBE_VIDEO, videoId: PEERTUBE_UUID.toUpperCase(), thumbnail: 'http://video.blender.org/x.jpg', alarm: { at: 99, armedAt: 50 } }),
      JSON.stringify({ ...PEERTUBE_VIDEO, videoId: 'not-a-uuid' }),
      JSON.stringify({ ...PEERTUBE_VIDEO, host: undefined }),
    ].join('\n')

    const read = laterFromExport(text)

    expect(read).toHaveLength(1)
    expect(read[0]).toMatchObject({ _id: PEERTUBE_UUID, videoId: PEERTUBE_UUID, platform: 'peertube', host: 'video.blender.org', alarm: null })
    expect(read[0]).not.toHaveProperty('thumbnail')
  })
})
