import { reactive, readonly } from 'vue'

import store from '../../store/index'

import { enqueueSubscriptionJobs, LANE_ENRICHMENT, removeSubscriptionJobs } from '../subscriptionWorker'
import { createCollectionsCrawl } from './crawl'
import { COLLECTIONS_CRAWL_LIMIT } from './crawlLimit'
import { missingDetails } from './details'

/**
 * The app's one crawl, built from the store, the request manager and the
 * Local API (see `./crawl.js` for the rules, and ADR-0020 for the budget).
 *
 * At module scope, as the request manager is, so that leaving Collections
 * does not abandon it: it carries on whichever page is shown. Each window has
 * its own; only one that opens Collections starts it.
 */

const progress = reactive({
  /** @type {import('./crawl').CrawlStatus['state']} */
  state: 'idle',
  requests: 0,
})

/** The crawl's state, for the page to show its progress by. Mutated only in here. */
export const collectionsCrawlProgress = readonly(progress)

/** @param {string} videoId */
async function request(videoId) {
  // Loaded on the first request: the Local API is large
  const { getLocalPlayerResponse } = await import('../api/local')

  return getLocalPlayerResponse(videoId)
}

const crawl = createCollectionsCrawl({
  missing: () => missingDetails(store.getters.getCollectionShares, store.getters.getCollectionVideos),
  hasDetails: videoId => Object.hasOwn(store.getters.getCollectionVideos, videoId),
  request,
  record: records => store.dispatch('putCollectionVideos', records),
  schedule: ({ key, run, dropped }) => {
    // Never promoted: the crawl takes the turns nothing else wants
    const added = enqueueSubscriptionJobs(LANE_ENRICHMENT, [{ key, weight: 1, run, dropped }])

    // Already on the manager under this key, which the crawl's own note of
    // what it queued rules out; told it will not run, the crawl stops until
    // its next start rather than wait on it for good
    if (added === 0) { dropped() }
  },
  unschedule: keys => removeSubscriptionJobs(LANE_ENRICHMENT, keys),
  limit: COLLECTIONS_CRAWL_LIMIT,
  // Local only, as the AI lookups are; and never over a datastore that could
  // not be read, where every video would look missing
  enabled: () => !!process.env.SUPPORTS_LOCAL_API &&
    store.getters.getBackendPreference === 'local' &&
    store.getters.getCollectionsReady &&
    !store.getters.getCollectionsGrabFailed,
  onChange: (status) => {
    progress.state = status.state
    progress.requests = status.requests
  },
  onFailure: (message, error) => console.warn(message, error ?? ''),
})

let watching = false

/**
 * Start the crawl, once Collections has its data in place. Started, it also
 * starts again by itself whenever shares arrive, so that a video new in a
 * refresh gets its details with no more asked of whoever added it.
 */
export function startCollectionsCrawl() {
  crawl.start()

  if (!watching) {
    watching = true
    store.watch(state => state.collections.collectionShares, () => crawl.start())
  }
}
