// YouTube search through the layer: the phase 2 YouTube search adapter. It
// wraps the existing module functions unchanged, handed in as the layer's
// `youtube` dependencies (`getLocalSearchResults`,
// `getLocalSearchContinuation`, `getInvidiousSearchResults`), and applies the
// backend preference and fallback in one place.
//
// - The query's filters become the upstream filters object both backends
//   already take: `{ prioritize, time, type, duration, features }`. YouTube
//   sorts by relevance or popularity only; `date` and `trending` are not
//   honoured and are left out of `applied` (see `../search/capabilities.js`).
// - The first page goes to the preferred backend (Invidious alone where the
//   build has no Local API) and, when that fails and fallback is on, to the
//   other. A cursor names the backend that made it, and the next page goes
//   there, never falling back mid-list (see `./types.js`).
// - Results are the backends' list items as the cards already read them
//   (`parseLocalListVideo` and Invidious' objects); hashtags are dropped,
//   playlists and channels kept.
// - Failures reject as `PlatformError` `unavailable`, with the backend's error
//   as the cause.

import { PlatformError } from '../errors'
import { appliedFilters, honours } from '../search/capabilities'

const DURATIONS = Object.freeze({
  short: 'under_three_mins',
  medium: 'three_to_twenty_mins',
  long: 'over_twenty_mins',
})

/**
 * @typedef {object} YouTubeSearchDeps
 * @property {(query: string, filters: object, safetyMode: boolean) => Promise<{ results: any[], continuationData: unknown }>} [getLocalSearchResults]
 * @property {(continuationData: unknown) => Promise<{ results: any[], continuationData: unknown }>} [getLocalSearchContinuation]
 * @property {(query: string, page: number, searchSettings: object) => Promise<any[] | null>} [getInvidiousSearchResults]
 */

/**
 * The upstream filters object for a query: what YouTube honours of it, and
 * nothing it does not (a channel search is sent no time, say).
 *
 * @param {import('../search/query').SearchQuery} query
 */
export function youtubeFilters(query) {
  const sent = name => honours('youtube', name, query)

  return {
    prioritize: query.sort === 'views' ? 'popularity' : 'relevance',
    time: query.time !== null && sent('time') ? query.time : '',
    type: query.type ?? 'all',
    duration: query.length !== null && sent('length') ? DURATIONS[query.length] : '',
    features: query.live && sent('live') ? ['live'] : [],
  }
}

/**
 * @param {any[]} results
 */
function withoutHashtags(results) {
  return (Array.isArray(results) ? results : []).filter(item => item?.type !== 'hashtag')
}

/**
 * @param {unknown} error
 * @param {string} backend
 * @returns {PlatformError}
 */
function asPlatformError(error, backend) {
  if (error instanceof PlatformError) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)
  return new PlatformError('unavailable', `YouTube search (${backend}) failed: ${message}`, { cause: error })
}

/**
 * @param {object} deps
 * @param {YouTubeSearchDeps} deps.youtube
 * @param {{ backendPreference: string, backendFallback: boolean, showFamilyFriendlyOnly?: boolean, supportsLocalApi?: boolean }} deps.config
 */
export function createYouTubeSearcher({ youtube, config }) {
  const localSupported = config.supportsLocalApi !== false

  /** The backends to try for a first page, in order */
  function backendOrder() {
    if (!localSupported) {
      return ['invidious']
    }

    const preferred = config.backendPreference === 'invidious' ? 'invidious' : 'local'
    const other = preferred === 'local' ? 'invidious' : 'local'

    return config.backendFallback ? [preferred, other] : [preferred]
  }

  /**
   * @param {string} backend
   * @param {string} text
   * @param {object} filters
   * @param {unknown} continuation the Local continuation, or the Invidious page
   */
  async function fetchPage(backend, text, filters, continuation) {
    if (backend === 'local') {
      const { results, continuationData } = continuation == null
        ? await youtube.getLocalSearchResults(text, filters, config.showFamilyFriendlyOnly === true)
        : await youtube.getLocalSearchContinuation(continuation)

      return {
        items: withoutHashtags(results),
        cursor: continuationData ? { backend: 'local', continuation: continuationData } : null,
      }
    }

    const page = typeof continuation === 'number' ? continuation : 1
    const results = await youtube.getInvidiousSearchResults(text, page, filters)

    // Invidious never says it is the end; an empty answer is
    if (!Array.isArray(results) || results.length === 0) {
      return { items: [], cursor: null }
    }

    return { items: withoutHashtags(results), cursor: { backend: 'invidious', page: page + 1 } }
  }

  /**
   * A page of YouTube results for a query.
   *
   * @param {import('../search/query').SearchQuery} query
   * @param {{ cursor?: unknown }} [options]
   * @returns {Promise<import('../shapes').Page<any> & { applied: string[] }>}
   */
  async function search(query, { cursor = null } = {}) {
    const applied = appliedFilters('youtube', query)

    if (query.text === '') {
      return { items: [], cursor: null, applied }
    }

    const filters = youtubeFilters(query)

    if (cursor != null) {
      const backend = /** @type {any} */ (cursor)?.backend
      const continuation = backend === 'local' ? /** @type {any} */ (cursor).continuation : /** @type {any} */ (cursor)?.page

      if ((backend !== 'local' && backend !== 'invidious') || continuation == null || (backend === 'local' && !localSupported)) {
        throw new PlatformError('invalid', 'Not a YouTube search cursor')
      }

      try {
        return { ...await fetchPage(backend, query.text, filters, continuation), applied }
      } catch (error) {
        throw asPlatformError(error, backend)
      }
    }

    let lastError = null

    for (const backend of backendOrder()) {
      try {
        return { ...await fetchPage(backend, query.text, filters, null), applied }
      } catch (error) {
        lastError = asPlatformError(error, backend)
      }
    }

    throw lastError
  }

  return Object.freeze({ search })
}
