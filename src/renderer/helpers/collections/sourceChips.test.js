import { describe, expect, it } from 'vitest'

import { chipSources, hiddenSourcesWith, shownSourceIds } from './sourceChips'

const source = (_id, name = _id) => ({ _id, kind: 'lemmy', url: `https://x.y/c/${_id}`, name, followedAt: 0 })

describe('the sources shown on Collections', () => {
  const sources = [source('hackertube', 'HackerTube'), source('lemmy:a@x.y'), source('lemmy:b@x.y')]

  it('is every source followed while no chip is off', () => {
    expect([...shownSourceIds(sources, [])].sort()).toEqual(['hackertube', 'lemmy:a@x.y', 'lemmy:b@x.y'])
  })

  it('leaves out each source whose chip is off', () => {
    expect([...shownSourceIds(sources, ['lemmy:a@x.y', 'hackertube'])]).toEqual(['lemmy:b@x.y'])
  })

  it('shows a source followed after the chips were set, as nothing says it is off', () => {
    const later = [...sources, source('lemmy:new@x.y')]

    expect(shownSourceIds(later, ['lemmy:a@x.y']).has('lemmy:new@x.y')).toBe(true)
  })

  it('never shows a source not followed, whatever the chips say', () => {
    expect(shownSourceIds(sources, ['lemmy:gone@x.y']).has('lemmy:gone@x.y')).toBe(false)
  })

  it('is empty when every chip is off, or nothing is followed', () => {
    expect(shownSourceIds(sources, sources.map(each => each._id)).size).toBe(0)
    expect(shownSourceIds([], []).size).toBe(0)
  })

  it('takes a stored setting that is not a list as no chip off', () => {
    expect(shownSourceIds(sources, /** @type {any} */ (null)).size).toBe(3)
    expect(shownSourceIds(sources, /** @type {any} */ ('hackertube')).size).toBe(3)
  })
})

describe('turning a source\'s chip on or off', () => {
  it('adds the source to those off when turned off', () => {
    expect(hiddenSourcesWith(['a'], 'b', false)).toEqual(['a', 'b'])
  })

  it('takes it out of those off when turned on, and only it', () => {
    expect(hiddenSourcesWith(['a', 'b', 'c'], 'b', true)).toEqual(['a', 'c'])
  })

  it('is the list as it was when the chip is already so', () => {
    const hidden = ['a']

    expect(hiddenSourcesWith(hidden, 'a', false)).toBe(hidden)
    expect(hiddenSourcesWith(hidden, 'b', true)).toBe(hidden)
  })

  it('does not change the list it was given', () => {
    const hidden = Object.freeze(['a'])

    expect(hiddenSourcesWith(hidden, 'b', false)).toEqual(['a', 'b'])
    expect(hiddenSourcesWith(hidden, 'a', true)).toEqual([])
  })

  it('starts from no chip off for a stored setting that is not a list', () => {
    expect(hiddenSourcesWith(/** @type {any} */ (null), 'a', false)).toEqual(['a'])
  })
})

describe('the chips', () => {
  it('are one per source followed, by name, whatever the case', () => {
    const chips = chipSources([source('3', 'videos@lemmy.world'), source('1', 'HackerTube'), source('2', 'documentaries@lemmy.cafe')])

    expect(chips.map(chip => chip.name)).toEqual(['documentaries@lemmy.cafe', 'HackerTube', 'videos@lemmy.world'])
  })

  it('does not reorder the list it was given', () => {
    const sources = Object.freeze([source('b'), source('a')])

    expect(chipSources(sources).map(chip => chip._id)).toEqual(['a', 'b'])
  })
})
