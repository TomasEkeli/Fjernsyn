// The search query: the value that fully describes one search, which lives in
// the route and nowhere else (never in the store). Text, a scope (where the
// search goes) and the filters (everything else). Pure and framework-free.
// See `.scratch/search-ux/spec.md`, "The query module" and "Route".
//
// The shape:
//
//   {
//     text:     string,
//     scope:    'youtube' | 'peertube' | 'all',
//     instance: string | null,        PeerTube host; only with scope peertube
//     sort:     'date' | 'views' | 'trending' | null,   null: relevance
//     time:     'today' | 'week' | 'month' | 'year' | null,
//     after:    'YYYY-MM-DD' | null,  PeerTube only
//     before:   'YYYY-MM-DD' | null,  PeerTube only
//     type:     'video' | 'channel' | 'playlist' | 'shorts' | 'movie' | null,
//     length:   'short' | 'medium' | 'long' | null,
//     language: string[],             PeerTube's language codes
//     live:     boolean,
//     nsfw:     boolean | null,       null: the setting decides; PeerTube only
//   }
//
// In the URL (`/search/:text?scope=...`) the scope is always written, so a URL
// means the same search after the default scope setting changes; every other
// unset parameter is absent. `language` is `lang`, comma joined; `live=1`;
// `nsfw=1` shows and `nsfw=0` hides.

import { lengthWord, nsfwWord, scopeWord, sortWord, timeWord, typeWord } from './labels'

export const SCOPE_YOUTUBE = 'youtube'
export const SCOPE_PEERTUBE = 'peertube'
export const SCOPE_ALL = 'all'

export const SCOPES = Object.freeze([SCOPE_YOUTUBE, SCOPE_PEERTUBE, SCOPE_ALL])
export const SORTS = Object.freeze(['date', 'views', 'trending'])
export const TIMES = Object.freeze(['today', 'week', 'month', 'year'])
export const TYPES = Object.freeze(['video', 'channel', 'playlist', 'shorts', 'movie'])
export const LENGTHS = Object.freeze(['short', 'medium', 'long'])

/** Every parameter but the text and the scope, in the order they are described */
export const FILTER_NAMES = Object.freeze([
  'instance', 'sort', 'time', 'after', 'before', 'type', 'length', 'language', 'live', 'nsfw',
])

/** The filters only PeerTube can honour, dropped when PeerTube is off */
const PEERTUBE_ONLY = Object.freeze(['instance', 'after', 'before', 'language', 'nsfw'])

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
// PeerTube's codes: ISO 639 with, for a few, a region or script (`pt-PT`, `zh-Hans`)
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/
// A bare host name, lower case, no port: what `instance` may hold
const HOST_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/**
 * @typedef {object} SearchQuery
 * @property {string} text
 * @property {'youtube' | 'peertube' | 'all'} scope
 * @property {string | null} instance
 * @property {'date' | 'views' | 'trending' | null} sort
 * @property {'today' | 'week' | 'month' | 'year' | null} time
 * @property {string | null} after
 * @property {string | null} before
 * @property {'video' | 'channel' | 'playlist' | 'shorts' | 'movie' | null} type
 * @property {'short' | 'medium' | 'long' | null} length
 * @property {string[]} language
 * @property {boolean} live
 * @property {boolean | null} nsfw
 */

/** @typedef {Omit<SearchQuery, 'text'>} SearchParameters */

/**
 * @param {unknown} value a route query field, which vue-router may hand over as an array
 * @returns {string | null}
 */
function single(value) {
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' ? first : null
}

/**
 * @template {string} T
 * @param {unknown} value
 * @param {readonly T[]} allowed
 * @returns {T | null}
 */
function oneOf(value, allowed) {
  return typeof value === 'string' && allowed.includes(/** @type {T} */ (value)) ? /** @type {T} */ (value) : null
}

/**
 * A calendar date as `YYYY-MM-DD` that exists, or null.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function validDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    return null
  }

  const date = new Date(`${value}T00:00:00Z`)
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null
}

/**
 * A bare, lower case host name, or null. A pasted URL is read for its host.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function validHost(value) {
  if (typeof value !== 'string') {
    return null
  }

  let host = value.trim().toLowerCase()

  if (host.includes('/')) {
    try {
      host = new URL(host.includes('://') ? host : `https://${host}`).hostname
    } catch {
      return null
    }
  }

  return HOST_PATTERN.test(host) ? host : null
}

/**
 * Language codes: lower case, known shape, each once, in the order given.
 *
 * @param {unknown} value an array, or a comma joined string
 * @returns {string[]}
 */
function validLanguages(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const codes = []

  for (const item of list) {
    const [primary = '', ...rest] = typeof item === 'string' ? item.trim().split('-') : []
    const code = [primary.toLowerCase(), ...rest].join('-')
    if (LANGUAGE_PATTERN.test(code) && !codes.includes(code)) {
      codes.push(code)
    }
  }

  return codes
}

/**
 * @param {unknown} scope
 * @returns {'youtube' | 'peertube' | 'all'}
 */
function validScope(scope) {
  return oneOf(scope, SCOPES) ?? SCOPE_YOUTUBE
}

/**
 * Every filter unset, in the given scope.
 *
 * @param {string} [scope] the default scope setting
 * @returns {SearchParameters}
 */
export function defaults(scope = SCOPE_YOUTUBE) {
  return {
    scope: validScope(scope),
    instance: null,
    sort: null,
    time: null,
    after: null,
    before: null,
    type: null,
    length: null,
    language: [],
    live: false,
    nsfw: null,
  }
}

/**
 * The rules every query is held to, in this order:
 *
 * 1. `instance` needs scope `peertube`; otherwise dropped.
 * 2. `after` or `before` set clears `time` (the dates are the more specific).
 * 3. `sort: 'relevance'` becomes `null`.
 *
 * Every value is also checked, and one that is not a value of its parameter is
 * unset, so anything built from outside (a stored set, an operator) is safe.
 * A filter one platform cannot honour is kept, the time of a channel search
 * included: that platform reports it unapplied, and it applies again when
 * the type changes back.
 *
 * @template {Partial<SearchQuery>} T
 * @param {T} query
 * @returns {T extends { text: string } ? SearchQuery : SearchParameters}
 */
export function normalise(query) {
  const source = query ?? {}
  const result = {
    ...(typeof source.text === 'string' ? { text: source.text } : {}),
    scope: validScope(source.scope),
    instance: validHost(source.instance),
    sort: source.sort === 'relevance' ? null : oneOf(source.sort, SORTS),
    time: oneOf(source.time, TIMES),
    after: validDate(source.after),
    before: validDate(source.before),
    type: oneOf(source.type, TYPES),
    length: oneOf(source.length, LENGTHS),
    language: validLanguages(source.language),
    live: source.live === true,
    nsfw: typeof source.nsfw === 'boolean' ? source.nsfw : null,
  }

  if (result.scope !== SCOPE_PEERTUBE) {
    result.instance = null
  }

  if (result.after !== null || result.before !== null) {
    result.time = null
  }

  return /** @type {any} */ (result)
}

/**
 * The query a route stands for. Unknown or malformed values are dropped, never
 * thrown on. A missing scope takes `defaultScope`. With PeerTube off every
 * scope is YouTube and the PeerTube-only filters are dropped.
 *
 * @param {Record<string, unknown>} routeQuery the route's query fields
 * @param {unknown} text the route's `query` param
 * @param {{ defaultScope?: string, peertubeEnabled?: boolean }} [options]
 * @returns {SearchQuery}
 */
export function parse(routeQuery, text, { defaultScope = SCOPE_YOUTUBE, peertubeEnabled = false } = {}) {
  const fields = routeQuery ?? {}
  const flag = (value) => value === '1' || value === 'true'
  const nsfw = single(fields.nsfw)

  const query = normalise({
    text: typeof text === 'string' ? text.trim() : '',
    scope: /** @type {any} */ (single(fields.scope) ?? defaultScope),
    instance: single(fields.instance),
    sort: /** @type {any} */ (single(fields.sort)),
    time: /** @type {any} */ (single(fields.time)),
    after: single(fields.after),
    before: single(fields.before),
    type: /** @type {any} */ (single(fields.type)),
    length: /** @type {any} */ (single(fields.length)),
    language: validLanguages(single(fields.lang)),
    live: flag(single(fields.live)),
    nsfw: nsfw === '1' ? true : nsfw === '0' ? false : null,
  })

  return peertubeEnabled ? query : withoutPeerTube(query)
}

/**
 * The query as YouTube alone can take it: scope YouTube, and none of the
 * filters only PeerTube honours.
 *
 * @template {SearchParameters} T
 * @param {T} query
 * @returns {T}
 */
export function withoutPeerTube(query) {
  const result = { ...query, scope: SCOPE_YOUTUBE }
  const unset = defaults()

  for (const name of PEERTUBE_ONLY) {
    result[name] = unset[name]
  }

  return normalise(result)
}

/**
 * The route of a query: its path and query fields. Unset parameters are
 * absent; the scope is always there.
 *
 * @param {SearchQuery} query
 * @returns {{ path: string, query: Record<string, string> }}
 */
export function toRoute(query) {
  const q = normalise(query)
  /** @type {Record<string, string>} */
  const fields = { scope: q.scope }

  for (const name of ['instance', 'sort', 'time', 'after', 'before', 'type', 'length']) {
    if (q[name] !== null) {
      fields[name] = q[name]
    }
  }

  if (q.language.length > 0) {
    fields.lang = q.language.join(',')
  }

  if (q.live) {
    fields.live = '1'
  }

  if (q.nsfw !== null) {
    fields.nsfw = q.nsfw ? '1' : '0'
  }

  return { path: `/search/${encodeURIComponent(q.text)}`, query: fields }
}

/**
 * One string per distinct search, for caches: the route, fields sorted.
 *
 * @param {SearchQuery} query
 * @returns {string}
 */
export function routeKey(query) {
  const { path, query: fields } = toRoute(query)
  const params = new URLSearchParams(fields)
  params.sort()
  return `${path}?${params.toString()}`
}

/**
 * Whether a filter holds a value. Unset is `null`, an empty `language` and a
 * false `live`; `nsfw: false` is set (hide, whatever the setting says).
 *
 * @param {SearchParameters} query
 * @param {string} name one of `FILTER_NAMES`
 * @returns {boolean}
 */
export function isSet(query, name) {
  const value = query[name]

  if (name === 'live') {
    return value === true
  }

  return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined
}

/**
 * Every filter unset. The scope does not count: it is where a search goes.
 *
 * @param {SearchParameters} query
 * @returns {boolean}
 */
export function isPlain(query) {
  const q = normalise(query)
  return FILTER_NAMES.every(name => !isSet(q, name))
}

/**
 * Everything but the text: what the remembered set holds.
 *
 * @param {SearchQuery | SearchParameters} query
 * @returns {SearchParameters}
 */
export function parameters(query) {
  const { text: _text, ...rest } = normalise({ ...query, text: '' })
  return rest
}

/**
 * A query from a set of parameters (the remembered set, or the defaults) and
 * new text.
 *
 * @param {SearchParameters} params
 * @param {string} text
 * @returns {SearchQuery}
 */
export function withText(params, text) {
  return normalise({ ...params, text: typeof text === 'string' ? text.trim() : '' })
}

/**
 * The same query with one parameter changed, and what a change to it clears
 * beyond `normalise`'s rules: a time bucket clears the dates, and a date the
 * bucket (which `normalise` already does), so the last choice wins.
 *
 * @template {SearchParameters} T
 * @param {T} query
 * @param {string} name
 * @param {unknown} value
 * @returns {T}
 */
export function withParameter(query, name, value) {
  const next = { ...query, [name]: value }

  if (name === 'time' && value !== null) {
    next.after = null
    next.before = null
  }

  return normalise(next)
}

/**
 * The same parameters with one filter unset.
 *
 * @template {SearchParameters} T
 * @param {T} query
 * @param {string} name
 * @returns {T}
 */
export function withoutFilter(query, name) {
  return normalise({ ...query, [name]: defaults()[name] })
}

/**
 * The same text and scope with every filter unset: what `Clear` runs.
 *
 * @param {SearchQuery} query
 * @returns {SearchQuery}
 */
export function cleared(query) {
  return withText(defaults(query.scope), query.text)
}

/**
 * Whether two sets of parameters are the same search, text aside.
 *
 * @param {SearchParameters | null} a
 * @param {SearchParameters | null} b
 * @returns {boolean}
 */
export function sameParameters(a, b) {
  if (a === null || b === null) {
    return a === b
  }

  return routeKey(withText(a, '')) === routeKey(withText(b, ''))
}

/**
 * A stored remembered set, cleaned: `null` when it is missing, malformed or
 * plain, since a plain set is never remembered.
 *
 * @param {unknown} stored
 * @param {{ peertubeEnabled?: boolean }} [options]
 * @returns {SearchParameters | null}
 */
export function readRemembered(stored, { peertubeEnabled = false } = {}) {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return null
  }

  const params = parameters(/** @type {any} */ (stored))
  const usable = peertubeEnabled ? params : withoutPeerTube(params)

  return isPlain(usable) ? null : usable
}

/**
 * The words a set of parameters is shown in, such as
 * `PeerTube · newest · Norwegian · this year`: the scope first, then each
 * set filter. Unset filters are left out.
 *
 * @param {SearchParameters} params
 * @param {(key: string, values?: Record<string, unknown>) => string} t the app's translation function
 * @param {{ languageName?: (code: string) => string, withScope?: boolean }} [options]
 *   `withScope: false` leaves the scope out, for a list of filters alone
 * @returns {string}
 */
export function describe(params, t, { languageName = code => code, withScope = true } = {}) {
  const q = normalise(params)
  const words = withScope ? [scopeWord(t, q.scope)] : []

  if (q.instance !== null) {
    words.push(t('Layer Search.Words.Instance', { host: q.instance }))
  }

  if (q.sort !== null) {
    words.push(sortWord(t, q.sort))
  }

  if (q.time !== null) {
    words.push(timeWord(t, q.time))
  }

  if (q.after !== null && q.before !== null) {
    words.push(t('Layer Search.Words.Between', { after: q.after, before: q.before }))
  } else if (q.after !== null) {
    words.push(t('Layer Search.Words.After', { date: q.after }))
  } else if (q.before !== null) {
    words.push(t('Layer Search.Words.Before', { date: q.before }))
  }

  if (q.type !== null) {
    words.push(typeWord(t, q.type))
  }

  if (q.length !== null) {
    words.push(lengthWord(t, q.length))
  }

  if (q.language.length > 0) {
    words.push(q.language.map(languageName).join(', '))
  }

  if (q.live) {
    words.push(t('Layer Search.Words.Live'))
  }

  if (q.nsfw !== null) {
    words.push(nsfwWord(t, q.nsfw))
  }

  return words.join(' · ')
}
