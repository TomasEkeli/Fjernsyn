import store from '../../store/index'

import { enqueueSubscriptionJobs, LANE_ENRICHMENT, promoteSubscriptionJobs } from '../subscriptionWorker'
import { isChannelMarkedAi } from '../aiShown'
import { createAiLookup } from './lookup'

/**
 * The app's one AI lookup, built from the store, the request manager and the
 * Local API (see `./lookup.js` for the rules, and ADR-0020 for the budget).
 *
 * Lookups ride the request manager's enrichment lane, one request each, so
 * that a wall's lookups and a subscription refresh share one budget and never
 * add up to a burst. Within the lane they go ahead of the detail back-fill:
 * the back-fill improves a feed that is already usable and may run for most
 * of an hour after a refresh, while a lookup is for a tile on screen now, and
 * behind six hundred channels it would answer long after anyone was looking.
 */

/** Keeps a lookup's key apart from the back-fill's, which shares the lane */
const KEY_PREFIX = 'ai-label-'

/**
 * Lookups queued and not yet started, oldest first, so that each new one
 * moves them all ahead of the back-fill in the order they were asked for.
 * @type {Set<string>}
 */
const queued = new Set()

/** @param {string} videoId */
async function requestWatchNext(videoId) {
  // Loaded on the first lookup: the Local API is large, and a tile should not
  // pull it in to render
  const { getLocalWatchNext } = await import('../api/local')

  return getLocalWatchNext(videoId, { client: 'MWEB' })
}

/**
 * @param {{ key: string, run: () => Promise<void>, dropped: () => void }} job
 */
function schedule({ key, run, dropped }) {
  const workerKey = KEY_PREFIX + key

  queued.add(workerKey)

  const added = enqueueSubscriptionJobs(LANE_ENRICHMENT, [{
    key: workerKey,
    weight: 1,
    run: () => {
      queued.delete(workerKey)
      return run()
    },
    dropped: () => {
      queued.delete(workerKey)
      dropped()
    },
  }])

  if (added === 0) {
    // Already on the manager under this key; the lookup's own note of it is
    // all that stops a second one, so this cannot happen, and if it does the
    // video is left to be asked about again rather than never
    queued.delete(workerKey)
    dropped()
    return
  }

  promoteSubscriptionJobs(LANE_ENRICHMENT, Array.from(queued))
}

const lookup = createAiLookup({
  request: requestWatchNext,
  verdicts: {
    get: (videoId) => {
      const ai = store.getters.getAiVerdicts[videoId]

      return ai === undefined ? undefined : (ai ? 'ai' : 'not-ai')
    },
    set: (videoId, verdict) => {
      store.dispatch('recordAiVerdict', { videoId, verdict })
    },
  },
  schedule,
  isChannelMarked: isChannelMarkedAi,
  // Local only: YouTube is asked from the user's own address, which is the
  // backend that already does so. The web build has no Local API at all
  enabled: () => process.env.SUPPORTS_LOCAL_API && store.getters.getBackendPreference === 'local',
  onFailure: (message, error) => console.warn(message, error),
})

/**
 * Ask for a video's verdict, on behalf of a tile showing it on a wall that
 * looks up. Answers the function to call when the tile goes.
 *
 * @param {any} video
 * @returns {() => void}
 */
export function wantAiVerdict(video) {
  return lookup.want(video)
}
