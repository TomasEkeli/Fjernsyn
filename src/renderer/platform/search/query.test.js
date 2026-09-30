import { describe, expect, it } from 'vitest'

import { createTestI18n } from '../../testing/i18n'
import {
  cleared,
  defaults,
  describe as describeParameters,
  isPlain,
  normalise,
  parameters,
  parse,
  readRemembered,
  routeKey,
  sameParameters,
  toRoute,
  withParameter,
  withText,
  withoutFilter,
} from './query'

const ON = { peertubeEnabled: true }

/** A query with every filter set to a value, in scope PeerTube */
function everything() {
  return withText({
    ...defaults('peertube'),
    instance: 'tilvids.com',
    sort: 'date',
    after: '2024-06-01',
    before: '2024-06-30',
    type: 'all',
    length: 'medium',
    language: ['no', 'nb'],
    live: true,
    nsfw: false,
  }, 'blender')
}

describe('parse and toRoute', () => {
  it('round trip every parameter', () => {
    const query = everything()
    const route = toRoute(query)

    expect(route).toEqual({
      path: '/search/blender',
      query: {
        scope: 'peertube',
        instance: 'tilvids.com',
        sort: 'date',
        after: '2024-06-01',
        before: '2024-06-30',
        type: 'all',
        length: 'medium',
        lang: 'no,nb',
        live: '1',
        nsfw: '0',
      },
    })
    expect(parse(route.query, 'blender', ON)).toEqual(query)
  })

  it.each([
    ['time', 'year'],
    ['sort', 'views'],
    ['sort', 'trending'],
    ['type', 'shorts'],
    ['length', 'long'],
    ['nsfw', true],
  ])('round trip %s %s', (name, value) => {
    const query = withParameter(withText(defaults('all'), 'krita'), name, value)

    expect(parse(toRoute(query).query, 'krita', ON)).toEqual(query)
  })

  it('always write the scope, and leave every unset parameter out', () => {
    expect(toRoute(withText(defaults('youtube'), 'krita'))).toEqual({
      path: '/search/krita',
      query: { scope: 'youtube' },
    })
  })

  it('encode the text in the path', () => {
    expect(toRoute(withText(defaults(), 'a/b c?')).path).toBe('/search/a%2Fb%20c%3F')
  })

  it('take the default scope when the route names none', () => {
    expect(parse({}, 'x', { defaultScope: 'all', peertubeEnabled: true }).scope).toBe('all')
    expect(parse({ scope: 'peertube' }, 'x', { defaultScope: 'all', peertubeEnabled: true }).scope).toBe('peertube')
  })

  it('drop unknown and malformed values, without throwing', () => {
    const query = parse({
      scope: 'vimeo',
      sort: 'rating',
      time: 'decade',
      after: '2024-02-30',
      before: 'yesterday',
      type: 'mixed',
      length: 'epic',
      lang: 'NO,english,,nb,no',
      live: 'yes',
      nsfw: 'maybe',
      instance: 'not a host',
    }, '  blender  ', ON)

    expect(query).toEqual({ ...withText(defaults('youtube'), 'blender'), language: ['no', 'nb'] })
  })

  it('take the first of a repeated field', () => {
    expect(parse({ sort: ['views', 'date'] }, 'x', ON).sort).toBe('views')
  })

  it('read the old search page\'s time and type, and ignore its other fields', () => {
    const query = parse({ prioritize: 'popularity', time: 'week', type: 'all', duration: 'over_twenty_mins', features: ['live'] }, 'x', ON)

    expect(query).toEqual({ ...withText(defaults('youtube'), 'x'), time: 'week', type: 'all' })
  })

  it('read type video as the unset type, which is videos', () => {
    expect(parse({ type: 'video' }, 'x', ON).type).toBeNull()
  })

  it('read every scope as YouTube, and drop the PeerTube-only filters, while PeerTube is off', () => {
    const route = toRoute(withText({ ...everything(), after: null, before: null, time: 'year' }, 'blender'))

    expect(parse(route.query, 'blender', { defaultScope: 'all', peertubeEnabled: false })).toEqual({
      ...withText(defaults('youtube'), 'blender'),
      sort: 'date',
      time: 'year',
      type: 'all',
      length: 'medium',
      live: true,
    })
  })

  it('give one key per distinct search, whatever order the fields came in', () => {
    const a = parse({ scope: 'all', sort: 'date', time: 'year' }, 'x', ON)
    const b = parse({ time: 'year', sort: 'date', scope: 'all' }, 'x', ON)

    expect(routeKey(a)).toBe(routeKey(b))
    expect(routeKey(a)).not.toBe(routeKey({ ...a, scope: 'youtube' }))
  })
})

describe('normalise', () => {
  it('drops an instance outside the PeerTube scope', () => {
    expect(normalise({ ...defaults('all'), instance: 'tilvids.com' }).instance).toBeNull()
    expect(normalise({ ...defaults('peertube'), instance: 'tilvids.com' }).instance).toBe('tilvids.com')
  })

  it('reads a pasted instance URL for its host', () => {
    expect(normalise({ ...defaults('peertube'), instance: 'https://TilVids.com/videos' }).instance).toBe('tilvids.com')
  })

  it('lets dates clear the time bucket', () => {
    expect(normalise({ ...defaults('peertube'), time: 'year', after: '2024-01-01' })).toMatchObject({ time: null, after: '2024-01-01' })
    expect(normalise({ ...defaults('peertube'), time: 'year', before: '2024-01-01' })).toMatchObject({ time: null, before: '2024-01-01' })
  })

  it('keeps what channels and shorts have not, for when the type changes back', () => {
    const query = normalise({ ...defaults('peertube'), type: 'channel', time: 'week', length: 'long', live: true, sort: 'date' })

    expect(query).toMatchObject({ type: 'channel', time: 'week', length: 'long', live: true, sort: 'date' })
    expect(normalise({ ...defaults(), type: 'shorts', length: 'long' }).length).toBe('long')
  })

  it('makes relevance the unset sort', () => {
    expect(normalise({ ...defaults(), sort: 'relevance' }).sort).toBeNull()
  })

  it('keeps a filter one platform cannot honour', () => {
    expect(normalise({ ...defaults('youtube'), sort: 'trending' }).sort).toBe('trending')
  })
})

describe('isPlain', () => {
  it('is true with every filter unset, whatever the scope', () => {
    expect(isPlain(defaults('youtube'))).toBe(true)
    expect(isPlain(defaults('all'))).toBe(true)
  })

  it('is true for relevance alone, which is the backend\'s default', () => {
    expect(isPlain({ ...defaults(), sort: 'relevance' })).toBe(true)
  })

  it.each([
    ['sort', 'date'], ['time', 'today'], ['type', 'all'], ['length', 'short'],
    ['language', ['no']], ['live', true], ['nsfw', false], ['after', '2024-01-01'],
  ])('is false with %s set', (name, value) => {
    expect(isPlain({ ...defaults('peertube'), [name]: value })).toBe(false)
  })
})

describe('building queries', () => {
  it('parameters are everything but the text', () => {
    const { text: _text, ...rest } = everything()

    expect(parameters(everything())).toEqual(rest)
  })

  it('withText puts new text to a set of parameters', () => {
    expect(withText(parameters(everything()), ' krita ')).toEqual({ ...everything(), text: 'krita' })
  })

  it('a time bucket chosen clears the dates, so the last choice wins', () => {
    const query = withParameter(everything(), 'time', 'week')

    expect(query).toMatchObject({ time: 'week', after: null, before: null })
  })

  it('a date chosen clears the time bucket', () => {
    const query = withParameter({ ...everything(), after: null, before: null, time: 'week' }, 'after', '2024-01-01')

    expect(query).toMatchObject({ time: null, after: '2024-01-01' })
  })

  it('withoutFilter unsets one filter', () => {
    expect(withoutFilter(everything(), 'language').language).toEqual([])
    expect(withoutFilter(everything(), 'live').live).toBe(false)
  })

  it('cleared keeps the text and the scope, and unsets every filter', () => {
    expect(cleared(everything())).toEqual(withText(defaults('peertube'), 'blender'))
  })

  it('sameParameters compares everything but the text', () => {
    expect(sameParameters(parameters(everything()), parameters({ ...everything(), text: 'other' }))).toBe(true)
    expect(sameParameters(parameters(everything()), defaults('peertube'))).toBe(false)
    expect(sameParameters(null, null)).toBe(true)
    expect(sameParameters(null, defaults())).toBe(false)
  })
})

describe('readRemembered', () => {
  it('cleans a stored set', () => {
    expect(readRemembered({ scope: 'all', sort: 'date', bogus: 1, time: 'decade' }, ON)).toEqual({ ...defaults('all'), sort: 'date' })
  })

  it('is null for nothing, junk, or a plain set', () => {
    expect(readRemembered(null, ON)).toBeNull()
    expect(readRemembered('sort:date', ON)).toBeNull()
    expect(readRemembered([], ON)).toBeNull()
    expect(readRemembered({ scope: 'peertube' }, ON)).toBeNull()
  })

  it('is YouTube\'s part of a set while PeerTube is off, or null when nothing is left', () => {
    expect(readRemembered({ scope: 'peertube', language: ['no'], sort: 'date' })).toEqual({ ...defaults('youtube'), sort: 'date' })
    expect(readRemembered({ scope: 'peertube', language: ['no'] })).toBeNull()
  })
})

describe('describe', () => {
  const { t } = createTestI18n().global
  const names = { no: 'Norwegian', nb: 'Norwegian Bokmål' }
  const languageName = code => names[code] ?? code

  it('names the scope first, then each set filter', () => {
    const params = { ...defaults('peertube'), sort: 'date', language: ['no'], time: 'year' }

    expect(describeParameters(params, t, { languageName })).toBe('PeerTube · newest · this year · Norwegian')
  })

  it('names every filter', () => {
    expect(describeParameters(parameters(everything()), t, { languageName }))
      .toBe('PeerTube · on tilvids.com · newest · 2024-06-01 to 2024-06-30 · all types · 3 to 20 min · Norwegian, Norwegian Bokmål · live · without NSFW')
  })

  it('names one date alone, and both scopes', () => {
    expect(describeParameters({ ...defaults('all'), after: '2024-06-01', nsfw: true }, t)).toBe('YouTube and PeerTube · from 2024-06-01 · with NSFW')
    expect(describeParameters({ ...defaults('youtube'), before: '2024-06-01', type: 'channel' }, t)).toBe('YouTube · until 2024-06-01 · channels')
  })
})
