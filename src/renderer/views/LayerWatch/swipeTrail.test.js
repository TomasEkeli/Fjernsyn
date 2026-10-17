import { describe, expect, it, vi } from 'vitest'

import { createSwipeTrail } from './swipeTrail'

/** A sequence of pages, each a list of ids; the last page's cursor is `null` */
function fakeSequence(pages) {
  const listShorts = vi.fn(async (_id, cursor) => {
    const index = cursor === null ? 0 : /** @type {number} */ (cursor)
    return {
      items: pages[index].map(videoId => ({ videoId })),
      cursor: index + 1 < pages.length ? index + 1 : null,
    }
  })

  return listShorts
}

/** Lets a page asked for ahead of need come in */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('moving down through shorts', () => {
  it('moves to the shorts of the sequence after the first short, in order, asking once', async () => {
    const listShorts = fakeSequence([['b', 'c', 'd', 'e']])
    const trail = createSwipeTrail({ listShorts })

    expect(await trail.nextShort('a')).toBe('b')
    expect(await trail.nextShort('b')).toBe('c')
    expect(listShorts).toHaveBeenCalledTimes(1)
    expect(listShorts).toHaveBeenCalledWith('a', null)
  })

  it('continues the first short\'s sequence with its cursor, before the shorts in hand run out', async () => {
    const listShorts = fakeSequence([['b', 'c', 'd'], ['e', 'f']])
    const trail = createSwipeTrail({ listShorts })

    expect(await trail.nextShort('a')).toBe('b')
    await settle()

    expect(listShorts).toHaveBeenLastCalledWith('a', 1)
    expect(await trail.nextShort('b')).toBe('c')
    expect(await trail.nextShort('c')).toBe('d')
    expect(await trail.nextShort('d')).toBe('e')
    expect(await trail.nextShort('e')).toBe('f')
    expect(listShorts).toHaveBeenCalledTimes(2)
  })

  it('is nothing at the sequence\'s end', async () => {
    const trail = createSwipeTrail({ listShorts: fakeSequence([['b']]) })

    expect(await trail.nextShort('a')).toBe('b')
    expect(await trail.nextShort('b')).toBeNull()
  })

  it('offers no short twice, nor the one it started from, nor one passed over', async () => {
    const listShorts = fakeSequence([['a', 'b', 'w', 'b', 'c'], ['c', 'd']])
    const trail = createSwipeTrail({ listShorts, skip: id => id === 'w' })

    expect(await trail.nextShort('a')).toBe('b')
    expect(await trail.nextShort('b')).toBe('c')
    expect(await trail.nextShort('c')).toBe('d')
  })

  it('asks for a few more pages while every short on them is passed over, then gives up for this move', async () => {
    const listShorts = fakeSequence([['w1'], ['w2'], ['w3'], ['w4'], ['b']])
    const trail = createSwipeTrail({ listShorts, skip: id => id.startsWith('w') })

    expect(await trail.nextShort('a')).toBeNull()
    expect(listShorts).toHaveBeenCalledTimes(3)
    expect(await trail.nextShort('a')).toBe('b')
  })

  it('says the shorts it moved to came from the sequence', async () => {
    const trail = createSwipeTrail({ listShorts: fakeSequence([['b']]) })

    await trail.nextShort('a')

    expect(trail.isFromSequence('b')).toBe(true)
    expect(trail.isFromSequence('a')).toBe(false)
  })

  it('rejects when the page it needs fails, and asks again on the next move', async () => {
    const listShorts = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [{ videoId: 'b' }], cursor: null })
    const trail = createSwipeTrail({ listShorts })

    await expect(trail.nextShort('a')).rejects.toThrow('offline')
    expect(await trail.nextShort('a')).toBe('b')
    expect(listShorts).toHaveBeenNthCalledWith(2, 'a', null)
  })

  it('moves once for two presses before the next short is open', async () => {
    const listShorts = fakeSequence([['b', 'c']])
    const trail = createSwipeTrail({ listShorts })

    const [first, second] = await Promise.all([trail.nextShort('a'), trail.nextShort('a')])

    expect(first).toBe('b')
    expect(second).toBe('b')
    expect(listShorts).toHaveBeenCalledTimes(1)
  })
})

describe('moving up, and down again', () => {
  it('goes back along the trail, and forward along it again rather than to a new short', async () => {
    const listShorts = fakeSequence([['b', 'c', 'd']])
    const trail = createSwipeTrail({ listShorts })
    await trail.nextShort('a')
    await trail.nextShort('b')

    expect(trail.previous('c')).toBe('b')
    expect(trail.previous('b')).toBe('a')
    expect(trail.previous('a')).toBeNull()

    expect(trail.following('a')).toBe('b')
    expect(await trail.nextShort('a')).toBe('b')
    expect(await trail.nextShort('b')).toBe('c')
    expect(await trail.nextShort('c')).toBe('d')
  })

  it('records a move to a video that is not from the sequence, so that up comes back', () => {
    const trail = createSwipeTrail({ listShorts: fakeSequence([[]]) })

    trail.step('v1', 'v2')
    trail.step('v2', 'v3')

    expect(trail.previous('v3')).toBe('v2')
    expect(trail.previous('v2')).toBe('v1')
    expect(trail.following('v1')).toBe('v2')
  })

  it('replaces what was after a video moved back to, when the next move is elsewhere', () => {
    const trail = createSwipeTrail({ listShorts: fakeSequence([[]]) })
    trail.step('v1', 'v2')
    trail.step('v2', 'v3')

    trail.step('v1', 'x')

    expect(trail.following('v1')).toBe('x')
    expect(trail.previous('v3')).toBeNull()
  })

  it('continues the sequence from a short reached by a step', async () => {
    const listShorts = fakeSequence([['s2', 's3']])
    const trail = createSwipeTrail({ listShorts })

    trail.step('v1', 's1')

    expect(await trail.nextShort('s1')).toBe('s2')
    expect(listShorts).toHaveBeenCalledWith('s1', null)
    expect(trail.previous('s1')).toBe('v1')
  })
})

describe('a video opened some other way', () => {
  it('starts a new trail, and a short opened so seeds a new sequence', async () => {
    const listShorts = vi.fn(async id => ({ items: [{ videoId: `${id}-next` }, { videoId: `${id}-after` }], cursor: null }))
    const trail = createSwipeTrail({ listShorts })
    await trail.nextShort('a')

    expect(trail.previous('z')).toBeNull()
    expect(await trail.nextShort('z')).toBe('z-next')
    expect(listShorts).toHaveBeenLastCalledWith('z', null)
    expect(trail.previous('z')).toBeNull()
    expect(trail.following('a')).toBeNull()
  })

  it('drops a page asked for the trail it replaced', async () => {
    let answer
    const listShorts = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
      .mockResolvedValueOnce({ items: [{ videoId: 'z-next' }], cursor: null })
    const trail = createSwipeTrail({ listShorts })

    const old = trail.nextShort('a')
    const fresh = trail.nextShort('z')
    answer({ items: [{ videoId: 'a-next' }], cursor: null })

    expect(await old).toBeNull()
    expect(await fresh).toBe('z-next')
    expect(trail.isFromSequence('a-next')).toBe(false)
  })
})
