import { describe, expect, it } from 'vitest'

import { languageList, languageName, localeLanguages } from './languages'

describe('the language list', () => {
  it('names PeerTube\'s codes in English', () => {
    expect(languageName('no')).toBe('Norwegian')
    expect(languageName('zh-Hans')).toBe('Simplified Chinese')
    expect(languageName('xx')).toBe('xx')
  })

  it('puts the app locale\'s language first', () => {
    expect(languageList('fr-FR')[0]).toEqual({ code: 'fr', name: 'French' })
    expect(languageList('pt-BR').slice(0, 2).map(language => language.code)).toEqual(['pt', 'pt-PT'])
  })

  it('treats the Norwegian written standards as one language', () => {
    expect(localeLanguages('nb-NO')).toEqual(['nb', 'no', 'nn'])
  })

  it('lists every language once', () => {
    const codes = languageList('en-US').map(language => language.code)

    expect(new Set(codes).size).toBe(codes.length)
    expect(codes.length).toBeGreaterThan(200)
  })
})
