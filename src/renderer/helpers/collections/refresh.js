/**
 * Refreshing Collections: asking every followed source what it shares now,
 * and keeping what is new or changed.
 *
 * A refresh runs when the refresh button is pressed, or when Collections
 * opens and the last refresh was more than an hour ago (`refreshIsDue`);
 * never at startup and never on a timer. It asks every followed source,
 * whatever the page shows, each through its source kind (`kinds/`), a few at
 * a time. A source that fails keeps everything it has and is marked failed;
 * the others carry on. Nothing is removed: a share a source no longer gives
 * stays (`sharesToPut`).
 *
 * When each source was last asked is kept on its record (`checkedAt`, and
 * `failedAt` while its last ask failed), so the rule holds across restarts
 * and other windows hear of it as of any other change to a source.
 *
 * Framework-free: the store hands it what it needs (`store/modules/collections.js`).
 */

import { sharesToPut } from './shares.js'

/** How old the last refresh must be for opening Collections to refresh */
export const REFRESH_AFTER_MS = 60 * 60 * 1000

/** How many sources are asked at once: they are other people's servers, and few */
const SOURCES_AT_ONCE = 3

/**
 * Whether opening Collections refreshes: when it has never been refreshed,
 * or last was more than an hour ago, or the last refresh is in the future,
 * which only a clock put back explains.
 *
 * @param {number | null} lastRefreshAt
 * @param {number} now
 * @returns {boolean}
 */
export function refreshIsDue(lastRefreshAt, now) {
  if (lastRefreshAt === null) { return true }

  return lastRefreshAt > now || now - lastRefreshAt > REFRESH_AFTER_MS
}

/**
 * When Collections was last refreshed, as far as every followed source is
 * concerned: the oldest of their last refreshes, and never while one of them
 * has not been refreshed at all, or nothing is followed.
 *
 * @param {{ checkedAt?: number | null }[]} sources
 * @returns {number | null}
 */
export function lastRefreshOf(sources) {
  if (sources.length === 0) { return null }

  let oldest = Infinity

  for (const source of sources) {
    if (typeof source.checkedAt !== 'number') { return null }
    oldest = Math.min(oldest, source.checkedAt)
  }

  return oldest
}

/**
 * @typedef {object} RefreshDependencies
 * @property {import('./shares.js').Source[]} sources the sources to ask
 * @property {Record<string, import('./kinds/index.js').SourceKind>} kinds by kind
 * @property {typeof fetch} fetch what every request goes through
 * @property {() => number} now
 * @property {() => Record<string, import('./shares.js').Share>} keptShares the shares kept now, by `_id`
 * @property {(sourceId: string) => boolean} isFollowed whether the source is still followed
 * @property {(shares: import('./shares.js').Share[]) => Promise<void>} putShares
 * @property {(sourceId: string, fields: object) => Promise<void>} updateSource
 *   lays the fields given over the source's record as it is now
 * @property {(progress: { done: number, total: number }) => void} [onProgress]
 */

/**
 * Asks each source given for what it shares now, puts the shares that are
 * new or changed, and marks the source refreshed, or failed.
 *
 * @param {RefreshDependencies} deps
 * @returns {Promise<{ failed: string[], put: number }>} the ids of the
 *   sources that failed, and how many shares were put
 */
export async function refreshCollectionSources(deps) {
  const { sources, onProgress = () => {} } = deps
  const failed = []
  let put = 0
  let done = 0
  let next = 0

  onProgress({ done, total: sources.length })

  async function work() {
    while (next < sources.length) {
      const source = sources[next++]

      try {
        put += await refreshSource(deps, source)
      } catch (error) {
        console.warn(`Collections: could not refresh ${source._id}`, error)
        failed.push(source._id)
        await markFailed(deps, source._id)
      }

      onProgress({ done: ++done, total: sources.length })
    }
  }

  await Promise.all(Array.from({ length: Math.min(SOURCES_AT_ONCE, sources.length) }, work))

  return { failed, put }
}

/**
 * @param {RefreshDependencies} deps
 * @param {import('./shares.js').Source} source
 * @returns {Promise<number>} how many shares were put
 */
async function refreshSource(deps, source) {
  const kind = Object.hasOwn(deps.kinds, source.kind) ? deps.kinds[source.kind] : undefined

  if (kind === undefined) {
    throw new Error(`no source kind ${source.kind}`)
  }

  const { items, sourceFields } = await kind.fetch(source, { fetch: deps.fetch })
  const shares = sharesToPut(deps.keptShares(), kind.toShares(items, source, deps.now()))

  // Unfollowed meanwhile: its shares went with it, and must not come back
  if (!deps.isFollowed(source._id)) { return 0 }

  if (shares.length > 0) {
    await deps.putShares(shares)
  }

  // Only once the shares are in, so that what the source's record says was
  // loaded (HackerTube's export date) never runs ahead of them
  await deps.updateSource(source._id, { ...sourceFields, checkedAt: deps.now(), failedAt: null })

  return shares.length
}

/**
 * @param {RefreshDependencies} deps
 * @param {string} sourceId
 */
async function markFailed(deps, sourceId) {
  if (!deps.isFollowed(sourceId)) { return }

  const at = deps.now()

  try {
    await deps.updateSource(sourceId, { checkedAt: at, failedAt: at })
  } catch (error) {
    console.warn(`Collections: could not mark ${sourceId} failed`, error)
  }
}
