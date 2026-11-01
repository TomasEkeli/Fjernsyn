import { reactive, readonly } from 'vue'

import store from '../../store/index'

import { enqueueSubscriptionJobs, LANE_ENRICHMENT, removeSubscriptionJobs } from '../subscriptionWorker'
import { createCollectionsCrawl } from './crawl'
import { COLLECTIONS_CRAWL_LIMIT } from './crawlLimit'
import { detailsFor, missingDetails, needsDetails } from './details'

/**
 * The app's one crawl, built from the store, the request manager and the
 * Local API (see `./crawl.js` for the rules, and ADR-0020 for the budget).
 *
 * At module scope, as the request manager is, so that leaving Collections
 * does not abandon it: it carries on whichever page is shown. Every window
 * has a runner, and only one crawls at a time: main grants the crawl to one
 * window (`main/collectionsCrawlClaim.js`), until that window gives it back
 * when its crawl is done, or closes or loads again.
 *
 * Started once, it starts again by itself: when shares arrive, so that a
 * video new in a refresh gets its details with no more asked of whoever added
 * it; after a profile switch cancels the enrichment lane, as collections are
 * not per profile; and when the backend comes back to Local.
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

/** Whether this session has started the crawl, which makes it start again by itself */
let started = false

/** @type {(() => void)[]} the watches that start it again, to undo in tests */
const unwatch = []

/** Whether main has granted this window the crawl */
let holding = false

async function claim() {
  if (!process.env.IS_ELECTRON) { return true }

  holding = (await window.ftElectron.claimCollectionsCrawl()) === true

  return holding
}

function release() {
  if (!holding) { return }

  holding = false
  window.ftElectron.releaseCollectionsCrawl()
}

const crawl = createCollectionsCrawl({
  missing: () => missingDetails(store.getters.getCollectionShares, store.getters.getCollectionVideos, Date.now()),
  isDone: videoId => !needsDetails(detailsFor(store.getters.getCollectionVideos, videoId), Date.now()),
  recordFor: videoId => detailsFor(store.getters.getCollectionVideos, videoId),
  request,
  record: records => store.dispatch('putCollectionVideos', records),
  // Never promoted: the crawl takes the turns nothing else wants
  schedule: job => enqueueSubscriptionJobs(LANE_ENRICHMENT, [{ ...job, weight: 1 }]) > 0,
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

    if (status.state === 'done' || status.state === 'limited') {
      release()
    } else if (status.state === 'stopped') {
      // A lane cancelled, or the backend changed: once the cancel is over,
      // start again, which does nothing while it may not ask
      setTimeout(resume, 0)
    }
  },
  onFailure: (message, error) => console.warn(message, error ?? ''),
})

async function resume() {
  if (!started) { return }
  if (!(await claim())) { return }

  crawl.start()
}

/**
 * Start the crawl, once Collections has its data in place, if main grants
 * this window the crawl.
 *
 * @returns {Promise<void>}
 */
export function startCollectionsCrawl() {
  if (!started) {
    started = true
    unwatch.push(
      store.watch(() => store.getters.getCollectionShares, resume),
      store.watch(() => store.getters.getBackendPreference, (backend) => {
        if (backend === 'local') { resume() }
      })
    )
  }

  return resume()
}

/** Test seam: stop this runner starting again by itself */
export function forgetCollectionsCrawlForTests() {
  started = false
  unwatch.splice(0).forEach(stop => stop())
}
