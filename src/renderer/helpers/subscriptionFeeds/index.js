import store from '../../store/index'

import { videosFeed } from './videos'
import { shortsFeed } from './shorts'
import { liveFeed } from './live'
import { postsFeed } from './posts'
import { withPlatformDispatch } from './peertube'

export { subscriptionChannelIsFetched } from './peertube'

/**
 * Every subscription feed, and what each one needs to be fetched and shown.
 *
 * The four tab components were copies of each other: the same state, the same
 * cache-or-remote decision, the same batching, the same progress bar handling,
 * differing only in which store keys and fetch functions they named. The
 * composable took the shared behaviour; this takes what genuinely differs.
 *
 * The tabs are gone now — one stream shows every kind at once — and what is
 * left of a feed is exactly this: where its entries are cached, how they are
 * fetched, and how they are filtered before assembly.
 *
 * @typedef {object} SubscriptionFeedDescriptor
 * @property {string} feed identifier used for tracing, caching and error collection
 * @property {string} cacheGetter store getter holding this feed's cache
 * @property {string} updateAction store action that writes one channel's entries
 * @property {'videos' | 'posts'} entriesKey field name inside a cache entry
 * @property {'setting' | 'always' | 'never'} rssMode where RSS use is decided.
 *   `never` is not a preference but a fact about what YouTube publishes: with
 *   no RSS to read there is nothing lighter to read, whatever the setting says.
 * @property {boolean} followsDetailBackfill whether this feed's entries can be
 *   filled in in the background, and so needs rebuilding when they are
 * @property {string} shownGetter store getter holding this feed's chip: whether
 *   the reader has it switched on. Only ever about what is shown. What is
 *   fetched is a separate question with a separate answer: every feed, every
 *   time.
 * @property {string} shownAction store action the chip writes through
 * @property {(() => boolean) | undefined} isHiddenAppWide whether a setting
 *   outside this page hides this kind everywhere. It overrules the chip, and
 *   the chip is not offered while it holds — there is no sense in a control
 *   that cannot do anything. Only live has one.
 * @property {(channel: object, context: { useRss: boolean, failedAttempts?: number }) => Promise<{
 *   status: string, entries: any[] | null, name?: string, thumbnailUrl?: string
 * }>} fetchChannel
 * @property {(entries: any[]) => any[]} postProcess filter and sort for display
 */

/**
 * Each feed's descriptor, its `fetchChannel` dispatching on the channel's
 * platform: a PeerTube stub to the platform layer, a YouTube one to the
 * feed's own fetchers exactly as before. See `./peertube.js`.
 *
 * @type {Record<string, SubscriptionFeedDescriptor>}
 */
const DESCRIPTORS = {
  videos: withPlatformDispatch(videosFeed),
  shorts: withPlatformDispatch(shortsFeed),
  live: withPlatformDispatch(liveFeed),
  posts: withPlatformDispatch(postsFeed)
}

/**
 * The order feeds are refreshed in, and the order they are assembled into the
 * stream in — which decides only which kind an entry two feeds both claim is
 * counted as, since the stream itself is sorted by date.
 */
export const SUBSCRIPTION_FEEDS = ['videos', 'shorts', 'live', 'posts']

/**
 * @param {string} feed
 * @returns {SubscriptionFeedDescriptor}
 */
export function subscriptionFeedDescriptor(feed) {
  const descriptor = DESCRIPTORS[feed]

  if (descriptor == null) {
    throw new Error(`unknown subscription feed: ${feed}`)
  }

  return descriptor
}

/**
 * The feeds the user has switched on. What the stream is assembled from, and
 * the answer to that question only.
 *
 * Two things decide it: the chip, which is the reader's choice for this stream,
 * and the app-wide hide setting, which is their choice for the whole app and
 * wins.
 *
 * @returns {string[]}
 */
export function enabledSubscriptionFeeds() {
  return SUBSCRIPTION_FEEDS.filter(feed => {
    return !subscriptionFeedIsHiddenAppWide(feed) && subscriptionFeedIsShown(feed)
  })
}

/**
 * The feeds worth offering a chip for.
 *
 * Everything except a kind already hidden across the whole app: a chip that
 * could not change what is on screen would be a lie about who is in charge.
 *
 * @returns {string[]}
 */
export function choosableSubscriptionFeeds() {
  return SUBSCRIPTION_FEEDS.filter(feed => !subscriptionFeedIsHiddenAppWide(feed))
}

/**
 * Whether the reader has this feed's chip switched on.
 *
 * Their choice as they made it, which is not the same as what the stream ends
 * up showing — `enabledSubscriptionFeeds` is where the two are put together.
 * The chip must go on saying what it was left saying.
 *
 * @param {string} feed
 * @returns {boolean}
 */
export function subscriptionFeedIsShown(feed) {
  return store.getters[subscriptionFeedDescriptor(feed).shownGetter]
}

/**
 * Switch a feed's chip on or off. Persisted, because it is a standing
 * preference and not a mood.
 *
 * @param {string} feed
 * @param {boolean} shown
 * @returns {Promise<void>}
 */
export function setSubscriptionFeedShown(feed, shown) {
  return store.dispatch(subscriptionFeedDescriptor(feed).shownAction, shown)
}

/**
 * @param {string} feed
 * @returns {boolean}
 */
function subscriptionFeedIsHiddenAppWide(feed) {
  const { isHiddenAppWide } = subscriptionFeedDescriptor(feed)

  return isHiddenAppWide != null && isHiddenAppWide()
}

/**
 * The feeds a refresh fetches: every one of them, whatever is switched on.
 *
 * Deliberately not `enabledSubscriptionFeeds()` filtered down, and deliberately
 * a function of its own rather than a list read off the one above. What is
 * shown and what is fetched were the same list once, and the cost of that was a
 * kind switched off going stale: switching it back on showed yesterday, and
 * then a spinner. Switching a kind on is meant to be instant, and it can only
 * be instant if what it was hiding had been fetched anyway.
 *
 * Fetching four kinds where one was fetched costs roughly double, mostly posts,
 * which are the one kind RSS cannot serve. That was weighed and accepted: the
 * request manager's budget and lanes pace it, and nothing here throttles.
 *
 * @returns {string[]}
 */
export function fetchedSubscriptionFeeds() {
  return SUBSCRIPTION_FEEDS.slice()
}

/**
 * Whether this feed is fetched over RSS. Read once per refresh, so that
 * changing the setting midway cannot split one refresh across both strategies.
 *
 * @param {string} feed
 */
export function subscriptionFeedUsesRss(feed) {
  switch (subscriptionFeedDescriptor(feed).rssMode) {
    case 'always':
      return true
    case 'never':
      return false
    default:
      return store.getters.getUseRssFeeds
  }
}
