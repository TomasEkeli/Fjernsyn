// Operators: the search query's parameters typed into the search box as
// `key:value` words, a second way to set what the chips set.
//
//   on:youtube|peertube|all     instance:<host>
//   sort:relevance|date|views|trending
//   time:today|week|month|year  after:YYYY-MM-DD  before:YYYY-MM-DD
//   type:video|channel|playlist|shorts|movie     length:short|medium|long
//   lang:xx[,yy]                live:yes|no       nsfw:yes|no
//
// A word is an operator only when both its key and its value are known; any
// other `word:value` stays in the text, so a search for `re:zero` still
// works. `after` and `before` also take a month (`2024-06`) or a year
// (`2024`), meaning its first or its last day. Quoted values are not
// supported: hosts and codes have no spaces. Keys are read in any case. The
// last of a repeated operator wins. `instance` also sets the scope to
// PeerTube, the only one it means anything in, and `time` and the dates
// replace each other, so what was typed wins over a remembered set.
//
// Pure. The chips are never written back into the box as operators.

import { validHost } from './query'

const SCOPES = ['youtube', 'peertube', 'all']
const SORTS = ['relevance', 'date', 'views', 'trending']
const TIMES = ['today', 'week', 'month', 'year']
const TYPES = ['video', 'channel', 'playlist', 'shorts', 'movie']
const LENGTHS = ['short', 'medium', 'long']
const YES_NO = ['yes', 'no']

const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/
const OPERATOR_PATTERN = /^([A-Za-z]+):(\S+)$/

/**
 * A date operator's value as a day: a full date as it is, a month or a year
 * as its first day (`after`) or its last (`before`).
 *
 * @param {string} value
 * @param {'first' | 'last'} end
 * @returns {string | null}
 */
function dayOf(value, end) {
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)

  if (match) {
    const date = new Date(`${value}T00:00:00Z`)
    return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null
  }

  match = /^(\d{4})(?:-(\d{2}))?$/.exec(value)

  if (!match) {
    return null
  }

  const year = Number(match[1])
  const month = match[2] === undefined ? null : Number(match[2])

  if (month !== null && (month < 1 || month > 12)) {
    return null
  }

  const date = end === 'first'
    ? new Date(Date.UTC(year, month === null ? 0 : month - 1, 1))
    : new Date(Date.UTC(year, month === null ? 12 : month, 0))

  return date.toISOString().slice(0, 10)
}

/**
 * What one operator sets, or null when the word is not an operator.
 *
 * @param {string} key lower case
 * @param {string} value
 * @returns {Record<string, unknown> | null}
 */
function readOperator(key, value) {
  const lower = value.toLowerCase()
  const oneOf = (allowed) => allowed.includes(lower) ? lower : null

  switch (key) {
    case 'on': {
      const scope = oneOf(SCOPES)
      return scope && { scope }
    }
    case 'instance': {
      const host = validHost(value)
      return host && { instance: host, scope: 'peertube' }
    }
    case 'sort': {
      const sort = oneOf(SORTS)
      return sort && { sort }
    }
    case 'time': {
      const time = oneOf(TIMES)
      return time && { time, after: null, before: null }
    }
    case 'after': {
      const after = dayOf(value, 'first')
      return after && { after, time: null }
    }
    case 'before': {
      const before = dayOf(value, 'last')
      return before && { before, time: null }
    }
    case 'type': {
      const type = oneOf(TYPES)
      return type && { type }
    }
    case 'length': {
      const length = oneOf(LENGTHS)
      return length && { length }
    }
    case 'lang': {
      const codes = value.split(',').map((code) => {
        const [primary, ...rest] = code.split('-')
        return [primary.toLowerCase(), ...rest].join('-')
      })
      return codes.length > 0 && codes.every(code => LANGUAGE_PATTERN.test(code)) ? { language: codes } : null
    }
    case 'live': {
      const answer = oneOf(YES_NO)
      return answer && { live: answer === 'yes' }
    }
    case 'nsfw': {
      const answer = oneOf(YES_NO)
      return answer && { nsfw: answer === 'yes' }
    }
    default:
      return null
  }
}

/**
 * The operators in a search box's text, taken out of it.
 *
 * @param {string} input
 * @returns {{ text: string, parameters: Partial<import('./query').SearchParameters> }}
 */
export function parseOperators(input) {
  const words = typeof input === 'string' ? input.trim().split(/\s+/).filter(word => word !== '') : []
  const kept = []
  /** @type {Record<string, unknown>} */
  const parameters = {}

  for (const word of words) {
    const match = OPERATOR_PATTERN.exec(word)
    const set = match ? readOperator(match[1].toLowerCase(), match[2]) : null

    if (set === null) {
      kept.push(word)
    } else {
      Object.assign(parameters, set)
    }
  }

  return { text: kept.join(' '), parameters: /** @type {any} */ (parameters) }
}

/** The values offered as suggestions after each key and a colon */
const SUGGESTED_VALUES = Object.freeze({
  on: SCOPES,
  sort: SORTS,
  time: TIMES,
  type: TYPES,
  length: LENGTHS,
  live: ['yes'],
  nsfw: YES_NO,
})

/**
 * Completions for the last word of the search box's text when it is a known
 * key, its colon, and the start of a value (`sort:`, `sort:d`): the whole
 * text with each value that fits. Empty otherwise, and empty when there is no
 * text to search for besides operators, since choosing a suggestion searches.
 *
 * @param {string} input
 * @returns {string[]}
 */
export function operatorSuggestions(input) {
  if (typeof input !== 'string') {
    return []
  }

  const match = /(^|\s)([A-Za-z]+):([A-Za-z]*)$/.exec(input)
  const values = match ? SUGGESTED_VALUES[match[2].toLowerCase()] : undefined

  if (!values) {
    return []
  }

  const typed = match[3].toLowerCase()
  const before = input.slice(0, input.length - match[2].length - 1 - match[3].length)

  // Choosing a suggestion searches at once, so there has to be something to search for
  if (parseOperators(before).text === '') {
    return []
  }

  return values
    .filter(value => value.startsWith(typed) && value !== typed)
    .map(value => `${before}${match[2].toLowerCase()}:${value}`)
}
