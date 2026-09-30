import { describe, expect, it } from 'vitest'

import { defaults, withText } from './query'
import { invertsPill, searchBoxQuery } from './searchBox'

const remembered = { ...defaults('peertube'), sort: 'date', language: ['no'] }
const ON = { peertubeEnabled: true, defaultScope: 'all' }

describe('the query the search box runs', () => {
  it('is the text with the remembered set while the pill is lit', () => {
    expect(searchBoxQuery('blender', { remembered, latched: true, ...ON })).toEqual(withText(remembered, 'blender'))
  })

  it('is the text with no filters, in the default scope, while the pill is not lit', () => {
    expect(searchBoxQuery('blender', { remembered, latched: false, ...ON })).toEqual(withText(defaults('all'), 'blender'))
  })

  it('is the opposite of the pill, this once, when asked', () => {
    expect(searchBoxQuery('blender', { remembered, latched: true, invert: true, ...ON })).toEqual(withText(defaults('all'), 'blender'))
    expect(searchBoxQuery('blender', { remembered, latched: false, invert: true, ...ON })).toEqual(withText(remembered, 'blender'))
  })

  it('is plain when there is no set, lit or not', () => {
    expect(searchBoxQuery('blender', { remembered: null, latched: true, ...ON })).toEqual(withText(defaults('all'), 'blender'))
  })

  it('takes typed operators over the set, field by field, and out of the text', () => {
    expect(searchBoxQuery('blender sort:views time:year', { remembered, latched: true, ...ON }))
      .toEqual({ ...withText(remembered, 'blender'), sort: 'views', time: 'year' })
    expect(searchBoxQuery('blender sort:relevance', { remembered, latched: true, ...ON }).sort).toBeNull()
  })

  it('searches YouTube alone while PeerTube is off, whatever the setting, the set or the operators say', () => {
    const query = searchBoxQuery('blender on:peertube lang:no length:long', { remembered, latched: true, defaultScope: 'all', peertubeEnabled: false })

    expect(query).toEqual({ ...withText(defaults('youtube'), 'blender'), sort: 'date', length: 'long' })
  })
})

describe('invertsPill', () => {
  it('is Ctrl or Cmd held, and not Shift, which opens a new window', () => {
    expect(invertsPill({ ctrlKey: true })).toBe(true)
    expect(invertsPill({ metaKey: true })).toBe(true)
    expect(invertsPill({ shiftKey: true })).toBe(false)
    expect(invertsPill(undefined)).toBe(false)
  })
})
