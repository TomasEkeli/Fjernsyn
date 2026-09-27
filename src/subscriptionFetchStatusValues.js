/**
 * The values of the fetch status: what fetching one channel's feed came to.
 *
 * Kept here, import-free, because two modules that must not import each other
 * both speak it. `src/renderer/helpers/subscriptionFetchStatus.js` is the
 * refresh machinery's and imports Vue, i18n and the toast helpers; the platform
 * layer (`src/renderer/platform/`) is framework-free and returns the same
 * contract from `fetchChannelFeed`. Both import these, so the two cannot drift
 * apart, and `src/renderer/platform/peertube/feed.test.js` pins that they have
 * not.
 *
 * What each one means is documented where it is acted on, in
 * `subscriptionFetchStatus.js`.
 */

/** Got an answer. The entries are trustworthy, even if there are none. */
export const FETCH_OK = 'ok'

/** Blocked, HTTP 403 or 429. Retryable, and must never overwrite the cache. */
export const FETCH_RATE_LIMITED = 'rateLimited'

/** The channel is gone. Not retryable, and caching emptiness for it is correct. */
export const FETCH_UNAVAILABLE = 'unavailable'

/** Anything else. Retryable, and must never overwrite the cache. */
export const FETCH_FAILED = 'failed'
