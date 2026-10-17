// YouTube's shorts sequence: the feed youtube.com's shorts player moves down
// through after a short, read as pages of the shorts it names. Local only:
// Invidious has no such feed, so where the policy asks Invidious alone the
// answer is `unavailable`, and with fallback on Local is asked after it.
//
// - Local: `getLocalShortsSequence(id, safetyMode)`, with
//   `showFamilyFriendlyOnly` as the safety mode, as search has it; a later
//   page is `getLocalShortsSequenceContinuation` of the sequence the cursor
//   holds. A feed entry is a `reelWatchEndpoint` whose payload names the
//   short. An ad is one too, told apart by its payload's `adClientParams`, and
//   dropped here, as are an entry naming no video and one already on the page.
//
// The page names shorts by id and nothing more: the feed carries no title,
// channel or length, which the watch page reads when it opens the short.

import { PlatformError } from '../errors'
import { classifyYouTubeError } from './errors'

/** A YouTube video id */
const VIDEO_ID = /^[\w-]{11}$/

/**
 * One short in the sequence.
 *
 * @typedef {object} ShortsSequenceItem
 * @property {string} videoId
 */

/**
 * The shorts a page of the feed names, in its order: ads, entries without a
 * video id and repeats dropped.
 *
 * @param {unknown} feed a `ShortFormVideoInfo`'s `watch_next_feed`
 * @returns {ShortsSequenceItem[]}
 */
export function shortsOfFeed(feed) {
  const seen = new Set()
  /** @type {ShortsSequenceItem[]} */
  const items = []

  for (const entry of Array.isArray(feed) ? feed : []) {
    const payload = entry?.payload

    if (payload == null || payload.adClientParams != null) {
      continue
    }

    const videoId = payload.videoId

    if (typeof videoId === 'string' && VIDEO_ID.test(videoId) && !seen.has(videoId)) {
      seen.add(videoId)
      items.push({ videoId })
    }
  }

  return items
}

/**
 * @param {any} sequence a `ShortFormVideoInfo`
 * @returns {import('../shapes').Page<ShortsSequenceItem>}
 */
function pageOf(sequence) {
  return {
    items: shortsOfFeed(sequence?.watch_next_feed),
    cursor: sequence?.wn_has_continuation ? { backend: 'local', continuation: sequence } : null,
  }
}

/**
 * @param {object} deps
 * @param {import('./deps').YouTubeDeps} deps.youtube
 * @param {Readonly<import('../index').PlatformConfig>} deps.config
 * @param {ReturnType<typeof import('./policy').createBackendPolicy>} deps.policy
 */
export function createYouTubeShortsReader({ youtube, config, policy }) {
  /**
   * @param {string} id
   */
  async function fromLocal(id) {
    return pageOf(await youtube.getLocalShortsSequence(id, config.showFamilyFriendlyOnly))
  }

  /**
   * A page of the shorts sequence after the short `id`. Hand the page's
   * `cursor` back for the next; `null` is the end. A later page keeps the
   * first page's short, whatever `id` is then.
   *
   * @param {string} id a YouTube video ref
   * @param {{ cursor?: unknown }} [options]
   * @returns {Promise<import('../shapes').Page<ShortsSequenceItem>>}
   */
  function listShortsSequence(id, { cursor = null } = {}) {
    if (cursor != null) {
      return policy.later(cursor, async (_backend, later) => {
        const sequence = await youtube.getLocalShortsSequenceContinuation(later.continuation)
        return sequence == null ? { items: [], cursor: null } : pageOf(sequence)
      }, classifyYouTubeError)
    }

    return policy.first(
      backend => backend === 'local'
        ? fromLocal(id)
        : Promise.reject(new PlatformError('unavailable', 'YouTube (Invidious) has no shorts sequence')),
      classifyYouTubeError
    )
  }

  return Object.freeze({ listShortsSequence })
}
