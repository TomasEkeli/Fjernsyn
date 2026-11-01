/**
 * A development run's cap on the crawl: at most this many video detail
 * requests while the app runs, set by `FT_COLLECTIONS_CRAWL_LIMIT` at launch.
 *
 * The full crawl is some six and a half thousand YouTube requests, which is
 * fine on the machine the app is used on and not on one where it is only being
 * built and tried, where a rate limit earned would land on someone's own
 * viewing. So a development run can be held to a few:
 *
 *   FT_COLLECTIONS_CRAWL_LIMIT=10 pnpm dev
 *
 * Honoured only in a development build, and baked in by DefinePlugin, since
 * the renderer has no runtime `process.env` (`_scripts/webpack.renderer.config.js`,
 * which bakes it in only for a development build too). Any other build has no
 * cap. In a development build the cap is always on: unset, it is
 * `DEVELOPMENT_CRAWL_LIMIT`; only `none` lifts it; anything else that is not a
 * whole number of nought or more allows no requests at all. A cap forgotten
 * or mistyped must not become no cap.
 */

/** A development run's cap when none is set */
export const DEVELOPMENT_CRAWL_LIMIT = 30

/**
 * @param {string | undefined} raw the variable as set
 * @param {string | undefined} nodeEnv which build this is
 * @returns {number | null} the most requests allowed, or null for no cap
 */
export function crawlLimitFrom(raw, nodeEnv) {
  if (nodeEnv !== 'development') { return null }
  if (raw == null || raw === '') { return DEVELOPMENT_CRAWL_LIMIT }
  if (raw === 'none') { return null }

  const limit = /^\d+$/.test(raw) ? Number(raw) : Number.NaN

  return Number.isSafeInteger(limit) ? limit : 0
}

/** The cap in force in this build, or null for none */
export const COLLECTIONS_CRAWL_LIMIT = crawlLimitFrom(process.env.FT_COLLECTIONS_CRAWL_LIMIT, process.env.NODE_ENV)

if (COLLECTIONS_CRAWL_LIMIT !== null) {
  console.warn(`[collections] CRAWL LIMIT ACTIVE: at most ${COLLECTIONS_CRAWL_LIMIT} video detail requests while the app runs. FT_COLLECTIONS_CRAWL_LIMIT=none lifts it.`)
}

/**
 * A development run's wait between the crawl's requests, set by
 * `FT_COLLECTIONS_CRAWL_DELAY_MS` at launch: one job on the lane at a time,
 * and the next queued that many milliseconds after it finishes, to watch the
 * crawl at a pace a person can follow, or to keep it gentle:
 *
 *   FT_COLLECTIONS_CRAWL_DELAY_MS=2000 pnpm dev
 *
 * Honoured only in a development build and baked in the same way as the cap.
 * Unset, or anything but a whole number above nought, is no delay: the
 * crawl as it always is.
 *
 * @param {string | undefined} raw the variable as set
 * @param {string | undefined} nodeEnv which build this is
 * @returns {number | null} the wait in ms, or null for none
 */
export function crawlDelayFrom(raw, nodeEnv) {
  if (nodeEnv !== 'development' || raw == null || !/^\d+$/.test(raw)) { return null }

  const delay = Number(raw)

  return Number.isSafeInteger(delay) && delay > 0 ? delay : null
}

/** The delay in force in this build, or null for none */
export const COLLECTIONS_CRAWL_DELAY_MS = crawlDelayFrom(process.env.FT_COLLECTIONS_CRAWL_DELAY_MS, process.env.NODE_ENV)

if (COLLECTIONS_CRAWL_DELAY_MS !== null) {
  console.warn(`[collections] CRAWL DELAY ACTIVE: one video detail request at a time, ${COLLECTIONS_CRAWL_DELAY_MS} ms apart.`)
}
