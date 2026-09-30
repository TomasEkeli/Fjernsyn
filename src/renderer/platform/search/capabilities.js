// Which platform honours which search filter, for one query. The one table
// both the layer's search arms (for the `applied` they report) and the search
// view (for which chips and values to offer) read, so the two cannot drift.
// Pure. See `.scratch/search-ux/spec.md`, "Capability mapping".
//
// YouTube, as youtubei.js and Invidious offer it now: `prioritize` relevance
// or popularity (no sort by date, and no rating), upload date buckets, every
// type, three duration buckets, and the `live` feature.
//
// PeerTube: every sort, time as a start date, exact dates, video or channel
// search, duration bounds, languages, live, NSFW and a single instance. On the
// channel endpoint only the text and the instance apply.

import { FILTER_NAMES, SCOPE_ALL, SCOPE_PEERTUBE, SCOPE_YOUTUBE, SORTS, TYPES, isSet } from './query'

export const PLATFORM_YOUTUBE = 'youtube'
export const PLATFORM_PEERTUBE = 'peertube'

/** The types PeerTube can search for; anything else searches its videos */
const PEERTUBE_TYPES = Object.freeze(['video', 'channel'])

/**
 * The platforms a scope sends a query to.
 *
 * @param {string} scope
 * @returns {('youtube' | 'peertube')[]}
 */
export function platformsOf(scope) {
  switch (scope) {
    case SCOPE_PEERTUBE:
      return [PLATFORM_PEERTUBE]
    case SCOPE_ALL:
      return [PLATFORM_YOUTUBE, PLATFORM_PEERTUBE]
    case SCOPE_YOUTUBE:
    default:
      return [PLATFORM_YOUTUBE]
  }
}

/**
 * Whether a platform honours a filter at the value the query holds.
 *
 * @param {'youtube' | 'peertube'} platform
 * @param {string} name one of `FILTER_NAMES`
 * @param {import('./query').SearchParameters} query
 * @returns {boolean}
 */
export function honours(platform, name, query) {
  if (platform === PLATFORM_YOUTUBE) {
    switch (name) {
      case 'sort':
        return query.sort === null || query.sort === 'views'
      case 'time':
      case 'type':
      case 'length':
      case 'live':
        return true
      default:
        return false
    }
  }

  if (query.type === 'channel') {
    return name === 'type' || name === 'instance'
  }

  if (name === 'type') {
    return query.type === null || PEERTUBE_TYPES.includes(query.type)
  }

  return FILTER_NAMES.includes(name)
}

/**
 * The set filters of a query a platform honours: its `applied`.
 *
 * @param {'youtube' | 'peertube'} platform
 * @param {import('./query').SearchParameters} query
 * @returns {string[]}
 */
export function appliedFilters(platform, query) {
  return FILTER_NAMES.filter(name => isSet(query, name) && honours(platform, name, query))
}

/**
 * The values of the sort and type chips a scope offers: what at least one of
 * its platforms honours. `null` (relevance, any type) is always first.
 *
 * @param {'sort' | 'type'} name
 * @param {string} scope
 * @returns {(string | null)[]}
 */
export function optionsFor(name, scope) {
  const platforms = platformsOf(scope)
  const values = name === 'sort' ? SORTS : TYPES

  return [null, ...values.filter(value => platforms.some(platform => {
    return honours(platform, name, { [name]: value, type: name === 'type' ? value : null })
  }))]
}

/**
 * Whether a chip is offered at all in a scope while it is unset: whether any
 * of the scope's platforms could honour it. A set chip is always shown (muted
 * where it is not applied), so a URL naming it never hides it.
 *
 * @param {string} name one of `FILTER_NAMES`
 * @param {string} scope
 * @returns {boolean}
 */
export function offeredIn(name, scope) {
  const probe = {
    instance: 'example.org',
    sort: 'views',
    time: 'week',
    after: '2000-01-01',
    before: '2000-01-01',
    type: 'video',
    length: 'short',
    language: ['en'],
    live: true,
    nsfw: true,
  }

  return platformsOf(scope).some(platform => honours(platform, name, { ...probe, type: name === 'type' ? 'video' : null }))
}
