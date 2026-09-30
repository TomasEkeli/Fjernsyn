import { describe, expect, it } from 'vitest'

import { operatorSuggestions, parseOperators } from './operators'

describe('parseOperators', () => {
  it.each([
    ['on:peertube', { scope: 'peertube' }],
    ['on:ALL', { scope: 'all' }],
    ['instance:tilvids.com', { instance: 'tilvids.com', scope: 'peertube' }],
    ['sort:date', { sort: 'date' }],
    ['sort:relevance', { sort: 'relevance' }],
    ['time:week', { time: 'week', after: null, before: null }],
    ['after:2024-06-01', { after: '2024-06-01', time: null }],
    ['after:2024-06', { after: '2024-06-01', time: null }],
    ['after:2024', { after: '2024-01-01', time: null }],
    ['before:2024-02', { before: '2024-02-29', time: null }],
    ['before:2024', { before: '2024-12-31', time: null }],
    ['type:channel', { type: 'channel' }],
    ['length:long', { length: 'long' }],
    ['lang:no', { language: ['no'] }],
    ['lang:NO,nb,zh-Hans', { language: ['no', 'nb', 'zh-Hans'] }],
    ['live:yes', { live: true }],
    ['live:no', { live: false }],
    ['nsfw:yes', { nsfw: true }],
    ['nsfw:no', { nsfw: false }],
    ['SORT:views', { sort: 'views' }],
  ])('reads %s', (word, parameters) => {
    expect(parseOperators(`blender ${word}`)).toEqual({ text: 'blender', parameters })
  })

  it('takes several out of the text, wherever they are', () => {
    expect(parseOperators('sort:date blender  after:2024-06 tutorials lang:no')).toEqual({
      text: 'blender tutorials',
      parameters: { sort: 'date', after: '2024-06-01', time: null, language: ['no'] },
    })
  })

  it.each([
    're:zero',
    'sort:rating',
    'time:decade',
    'after:2024-13',
    'after:2024-02-30',
    'lang:english',
    'instance:not_a_host',
    'live:maybe',
    'http://example.com',
    ':date',
    'sort:',
  ])('leaves %s in the text', (word) => {
    expect(parseOperators(`blender ${word}`)).toEqual({ text: `blender ${word}`, parameters: {} })
  })

  it('lets the last of a repeated operator win', () => {
    expect(parseOperators('sort:date sort:views x').parameters).toEqual({ sort: 'views' })
  })

  it('reads nothing from nothing', () => {
    expect(parseOperators('')).toEqual({ text: '', parameters: {} })
    expect(parseOperators(undefined)).toEqual({ text: '', parameters: {} })
  })
})

describe('operatorSuggestions', () => {
  it('offers a key\'s values after its colon', () => {
    expect(operatorSuggestions('blender sort:')).toEqual([
      'blender sort:relevance', 'blender sort:date', 'blender sort:views', 'blender sort:trending',
    ])
  })

  it('narrows to what has been typed of the value', () => {
    expect(operatorSuggestions('blender time:w')).toEqual(['blender time:week'])
    expect(operatorSuggestions('krita on:p')).toEqual(['krita on:peertube'])
  })

  it('offers nothing when there is nothing to search for besides operators, since choosing one searches', () => {
    expect(operatorSuggestions('sort:')).toEqual([])
    expect(operatorSuggestions('time:week sort:')).toEqual([])
    expect(operatorSuggestions('time:week blender sort:d')).toEqual(['time:week blender sort:date'])
  })

  it('offers nothing for a finished value, an unknown key, or a word without a colon', () => {
    expect(operatorSuggestions('blender time:week')).toEqual([])
    expect(operatorSuggestions('re:')).toEqual([])
    expect(operatorSuggestions('blender')).toEqual([])
    expect(operatorSuggestions('sort: blender')).toEqual([])
  })
})
