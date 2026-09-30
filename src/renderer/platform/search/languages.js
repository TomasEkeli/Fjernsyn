// The languages PeerTube search can filter by: PeerTube's own list, bundled
// (`./languages.json`), so the codes are the ones PeerTube stores on a video.
// Names are the English ones for now.

import data from './languages.json'

/** @type {Readonly<Record<string, string>>} code to English name */
export const LANGUAGES = Object.freeze({ ...data.languages })

// The Norwegian written standards are one language to a reader looking for it
const FAMILIES = Object.freeze({
  no: ['nb', 'no', 'nn'],
  nb: ['nb', 'no', 'nn'],
  nn: ['nn', 'no', 'nb'],
})

/**
 * @param {string} code
 * @returns {string}
 */
export function languageName(code) {
  return LANGUAGES[code] ?? code
}

/**
 * The codes a locale's language stands for, most specific first.
 *
 * @param {string} locale such as `nb-NO`
 * @returns {string[]}
 */
export function localeLanguages(locale) {
  const primary = String(locale ?? '').split(/[-_]/)[0].toLowerCase()
  const family = FAMILIES[primary] ?? [primary]
  const codes = Object.keys(LANGUAGES)

  return family.flatMap(member => codes.filter(code => code === member || code.startsWith(`${member}-`)))
}

/**
 * Every language as `{ code, name }`, the locale's language first and the
 * rest by name.
 *
 * @param {string} locale
 * @returns {{ code: string, name: string }[]}
 */
export function languageList(locale) {
  const first = localeLanguages(locale)
  const rest = Object.keys(LANGUAGES).filter(code => !first.includes(code))

  return [...first, ...rest].map(code => ({ code, name: LANGUAGES[code] }))
}
