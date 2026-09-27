import { reactive, ref, shallowRef } from 'vue'

import store from '../store/index'

import {
  fetchedSubscriptionFeeds,
  subscriptionChannelIsFetched,
  subscriptionFeedDescriptor,
  subscriptionFeedUsesRss,
  SUBSCRIPTION_FEEDS
} from './subscriptionFeeds'
import {
  cancelSubscriptionLane,
  enqueueSubscriptionJobs,
  takeSubscriptionPeakInFlight,
  LANE_REFRESH
} from './subscriptionWorker'
import {
  beginSubscriptionTrace,
  endSubscriptionTrace,
  traceChannelFetch,
  traceRefreshCycleEnd
} from './subscriptionTrace'
import {
  beginFetchErrorCollection,
  clearUnavailableChannels,
  endFetchErrorCollection,
  isRetryableFetchStatus,
  reportRateLimited,
  showFetchErrorSummary,
  FETCH_RATE_LIMITED
} from './subscriptionFetchStatus'
import { injectedFetchFailure } from './subscriptionFailureInjection'
import {
  cancelSubscriptionRecovery,
  recoverUnresolvedChannels,
  NO_RETRY_ATTEMPTS
} from './subscriptionRecovery'
import {
  backfillDetailsForFetchedChannel,
  cancelDetailBackfill
} from './subscriptionDetailBackfill'

/**
 * The refresh, for every feed, in one place.
 *
 * A refresh used to belong to a mounted tab: the composable instance held the
 * state, ran the batching and committed the result to its own ref. Everything it
 * touched, though, was global — the progress bar, the cache, and the traffic —
 * so three tabs meant three refreshes writing one progress bar from three
 * private counters, and a refresh whose tab was switched away from finished into
 * a ref nobody was holding any more. Its results reached the cache and never the
 * screen.
 *
 * So the refresh moved out here, where the things it affects already live. One
 * refresh covers every feed there is; it is single-flight per feed, so a second
 * request joins the one in flight rather than doubling the requests; and it
 * commits by bumping a per-feed revision, which the subscriptions page watches
 * in order to rebuild its stream from the cache. A refresh finishing while that
 * page is elsewhere is simply picked up when it comes back.
 */

/**
 * @typedef {object} SubscriptionFeedState
 * @property {import('vue').Ref<boolean>} isRefreshing
 * @property {import('vue').Ref<number>} revision bumped when a refresh commits
 * @property {import('vue').Ref<number | null>} lastSuccessAt
 * @property {import('vue').Ref<boolean>} attemptedFetch
 * @property {import('vue').ShallowRef<object[]>} unresolvedChannels
 */

/** @type {Record<string, SubscriptionFeedState>} */
const states = {}

for (const feed of SUBSCRIPTION_FEEDS) {
  states[feed] = {
    isRefreshing: ref(false),
    revision: ref(0),
    lastSuccessAt: ref(null),
    attemptedFetch: ref(false),
    unresolvedChannels: shallowRef([])
  }
}

/**
 * @param {string} feed
 * @returns {SubscriptionFeedState}
 */
export function subscriptionFeedState(feed) {
  return states[feed]
}

/**
 * How far along the refresh is, counted across every feed it covers.
 *
 * One counter, because there is one refresh. The window's progress bar is
 * mirrored from this, which is what stops it jumping between three feeds'
 * private ratios and being hidden by whichever of them finished first.
 */
export const subscriptionRefreshProgress = reactive({
  active: false,
  /** Channels fetched so far, across every feed refreshing. */
  done: 0,
  /** Channels this refresh will fetch, across every feed refreshing. */
  total: 0,
  /** How many feeds are being refreshed. */
  feeds: 0
})

/**
 * @typedef {object} FeedRefreshContext
 * @property {number} generation
 * @property {number} total
 * @property {number} done
 * @property {boolean} useRss
 * @property {object[]} unresolved
 * @property {object[]} subscriptionUpdates
 * @property {Promise<void>} promise
 * @property {() => void} resolve
 */

/** @type {Map<string, FeedRefreshContext>} */
const running = new Map()

/**
 * Bumped when the active profile changes. Work queued for the old profile is
 * dropped, and anything still in flight when it changes cannot commit.
 */
let profileGeneration = 0

/**
 * Recoveries run one after another rather than all at once: the recovery is a
 * single global escalation, and three feeds calling it together would mean two
 * of them silently doing nothing.
 * @type {Promise<void>}
 */
let recoveryChain = Promise.resolve()

/**
 * Refresh every feed there is, whatever the user has switched on.
 *
 * A refresh cycle is not asked what is on screen. Which kinds are shown is the
 * page's question and it can change between one refresh and the next; a kind
 * fetched only while it was being looked at would be stale the moment it was
 * looked at again.
 *
 * @param {object} [options]
 * @param {string} [options.reason] recorded in the trace
 * @returns {Promise<void>}
 */
export function refreshAllSubscriptionFeeds({ reason } = {}) {
  return refreshSubscriptionFeeds(fetchedSubscriptionFeeds(), { reason })
}

/**
 * Refresh a chosen set of feeds. Feeds already refreshing are joined rather than
 * started again, so a refresh button held down, or the page navigated away from
 * and back, costs nothing.
 *
 * Feeds are queued whole, one after another, rather than interleaved, and in the
 * order given — which is the order they appear in `SUBSCRIPTION_FEEDS`, videos
 * first. Sharing the budget four ways would mean nothing landed until
 * everything had.
 *
 * Every feed named is fetched. There is no setting left that holds one back, so
 * a caller that names a feed gets it, and the only reason to name a subset is
 * that the rest of the cache is already current.
 *
 * @param {string[]} feeds
 * @param {object} [options]
 * @param {string} [options.reason] recorded in the trace
 * @returns {Promise<void>}
 */
export function refreshSubscriptionFeeds(feeds, { reason } = {}) {
  return Promise.all(feeds.map(feed => startFeedRefresh(feed, reason))).then(() => {})
}

/**
 * @param {string} feed
 * @param {string} [reason]
 * @returns {Promise<void>}
 */
function startFeedRefresh(feed, reason) {
  const existing = running.get(feed)

  if (existing != null) { return existing.promise }

  const descriptor = subscriptionFeedDescriptor(feed)
  // Every channel but a PeerTube one while PeerTube is off, or for a feed
  // PeerTube has nothing in (shorts, posts). That one is not asked, so it is
  // neither a failure nor a recovery candidate, and what the cache holds for
  // it stays and still shows.
  const channels = store.getters.getActiveProfile.subscriptions
    .filter(channel => subscriptionChannelIsFetched(channel, feed))
  const state = states[feed]

  if (channels.length === 0) {
    state.attemptedFetch.value = true
    state.revision.value++

    return Promise.resolve()
  }

  // A refresh supersedes any recovery still working through the last one
  cancelSubscriptionRecovery()

  // Read once, so that changing the setting midway cannot split one refresh
  // across both strategies
  const useRss = subscriptionFeedUsesRss(feed)

  let resolveWhenDone

  const promise = new Promise((resolve) => { resolveWhenDone = resolve })

  /** @type {FeedRefreshContext} */
  const context = {
    generation: profileGeneration,
    total: 0,
    done: 0,
    useRss,
    unresolved: [],
    subscriptionUpdates: [],
    promise,
    resolve: resolveWhenDone
  }

  running.set(feed, context)

  state.isRefreshing.value = true
  state.attemptedFetch.value = true

  clearUnavailableChannels(feed)

  beginSubscriptionTrace(feed, {
    channelCount: channels.length,
    useRss,
    backend: store.getters.getBackendPreference,
    reason
  })
  beginFetchErrorCollection(feed, channels.length)

  // Safe to set the total after enqueueing, because the manager starts a job in
  // a microtask at the earliest, so nothing can report itself done before this
  // function returns
  const added = enqueueSubscriptionJobs(LANE_REFRESH, channels.map(channel => ({
    key: `refresh-${feed}-${channel.id}`,
    label: channel.name ?? channel.id,
    run: () => fetchOneChannel(feed, descriptor, channel, context)
  })))

  context.total = added

  if (!subscriptionRefreshProgress.active) {
    subscriptionRefreshProgress.active = true
    store.commit('setShowProgressBar', true)
  }

  subscriptionRefreshProgress.total += added
  subscriptionRefreshProgress.feeds++
  reportProgress()

  if (added === 0) {
    // Every channel was already being fetched by a refresh that is on its way
    // out; nothing will call back, so finish now
    finishFeedRefresh(feed, context)
  }

  return promise
}

/**
 * @param {string} feed
 * @param {import('./subscriptionFeeds').SubscriptionFeedDescriptor} descriptor
 * @param {object} channel
 * @param {FeedRefreshContext} context
 */
async function fetchOneChannel(feed, descriptor, channel, context) {
  // Queued before the profile changed, so nobody wants this any more
  if (context.generation !== profileGeneration) { return }

  try {
    let result

    const traceDone = traceChannelFetch(feed, channel.id)

    try {
      // Only ever returns anything when FT_SUBS_FAIL is set, and the whole
      // branch is removed from a build that does not set it
      result = injectedFetchFailure() ?? await descriptor.fetchChannel(channel, { useRss: context.useRss })
    } finally {
      traceDone({
        entries: result?.entries?.length ?? null,
        outcome: result?.status ?? 'threw'
      })
    }

    if (result == null) {
      // The fetch threw its way past its own ladder, which the ladders are
      // written not to do. Worth retrying, and worth not taking the rest of the
      // refresh down over: one channel failing is the ordinary case here.
      context.unresolved.push(channel)
      return
    }

    const { status } = result

    // Counted here rather than where the 403 is read, so that the tally follows
    // from the outcome itself. Anything that produces a rate limited channel is
    // counted, without each fetch path having to remember to say so, which is
    // how injected failures came to report none at all.
    if (status === FETCH_RATE_LIMITED) {
      reportRateLimited(feed)
    }

    if (isRetryableFetchStatus(status)) {
      context.unresolved.push(channel)
    }

    await cacheChannelResult(descriptor, channel, result, context.subscriptionUpdates)

    if (descriptor.followsDetailBackfill) {
      // Offered now rather than when the refresh commits: the entries are in
      // the cache already, and the enrichment lane has a width of its own, so
      // this fills in during the RSS pass instead of after it
      backfillDetailsForFetchedChannel(feed, result.entries)
    }
  } finally {
    noteChannelDone(feed, context)
  }
}

/**
 * Write one channel's result to the cache and note any change to its name or
 * avatar. Shared by the refresh and by the recovery, so that a channel recovered
 * later is stored exactly as one fetched first time would have been.
 *
 * Awaited, and awaited by both callers, because the cache is what the screen is
 * built from. The store action writes the datastore before it commits, so a
 * result that is merely dispatched is not in the cache yet, and the revision
 * bump that rebuilds the feed can beat it there. Over six hundred channels that
 * loses the last one or two from the first render; over one channel it loses
 * everything, and a refresh that fetched a post says there are none.
 *
 * @param {import('./subscriptionFeeds').SubscriptionFeedDescriptor} descriptor
 * @param {object} channel
 * @param {{ entries: any[] | null, name?: string, thumbnailUrl?: string }} result
 * @param {object[]} subscriptionUpdates collected, to be dispatched in one go
 * @returns {Promise<void>}
 */
async function cacheChannelResult(descriptor, channel, { entries, name, thumbnailUrl }, subscriptionUpdates) {
  // null means the fetch failed, so leave whatever we already had alone.
  // An empty array is a real answer and is worth caching.
  if (entries != null) {
    await store.dispatch(descriptor.updateAction, {
      channelId: channel.id,
      [descriptor.entriesKey]: entries
    })
  }

  if (name || thumbnailUrl) {
    subscriptionUpdates.push({
      channelId: channel.id,
      channelName: name,
      channelThumbnailUrl: thumbnailUrl
    })
  }
}

/**
 * @param {string} feed
 * @param {FeedRefreshContext} context
 */
function noteChannelDone(feed, context) {
  // A refresh that has been cancelled or superseded still has requests in
  // flight, and they are not what the counter is counting any more
  if (running.get(feed) !== context) { return }

  context.done++
  subscriptionRefreshProgress.done++
  reportProgress()

  if (context.done >= context.total) {
    finishFeedRefresh(feed, context)
  }
}

function reportProgress() {
  const { done, total } = subscriptionRefreshProgress

  store.commit('setProgressBarPercentage', total > 0 ? (done / total) * 100 : 0)
}

/**
 * @param {string} feed
 * @param {FeedRefreshContext} context
 * @param {object} [options]
 * @param {boolean} [options.cancelled]
 */
function finishFeedRefresh(feed, context, { cancelled = false } = {}) {
  if (running.get(feed) !== context) { return }

  running.delete(feed)

  const state = states[feed]

  state.isRefreshing.value = false

  endSubscriptionTrace(feed)

  const collector = endFetchErrorCollection(feed)

  subscriptionRefreshProgress.feeds--

  if (running.size === 0) {
    traceRefreshCycleEnd({
      peakInFlight: takeSubscriptionPeakInFlight(),
      channels: subscriptionRefreshProgress.done
    })

    subscriptionRefreshProgress.active = false
    subscriptionRefreshProgress.done = 0
    subscriptionRefreshProgress.total = 0
    store.commit('setShowProgressBar', false)
  }

  const superseded = cancelled || context.generation !== profileGeneration

  if (!superseded) {
    state.unresolvedChannels.value = context.unresolved
    state.lastSuccessAt.value = Date.now()

    // What puts the refresh on screen: the subscriptions page watches this and
    // rebuilds its stream from the cache
    state.revision.value++

    if (context.subscriptionUpdates.length > 0) {
      store.dispatch('batchUpdateSubscriptionDetails', context.subscriptionUpdates.splice(0))
    }

    startRecoveryIfNeeded(feed, context, collector)
  }

  context.resolve()
}

/**
 * Go after the channels the refresh could not reach, in the background.
 *
 * Deliberately does not touch the loading state: the feed shows what the refresh
 * did manage and grows as the rest arrives, which is the difference between this
 * and simply refreshing again.
 *
 * @param {string} feed
 * @param {FeedRefreshContext} context
 * @param {object | undefined} collector the failures the refresh collected, held
 *   back so they can be reported only if recovery cannot resolve them
 */
function startRecoveryIfNeeded(feed, context, collector) {
  const state = states[feed]

  if (!store.getters.getSubscriptionAutoRecovery || context.unresolved.length === 0) {
    // Nothing more is going to be attempted, so now it is worth saying
    showFetchErrorSummary(feed, collector, context.unresolved)
    return
  }

  const descriptor = subscriptionFeedDescriptor(feed)
  const subscriptionUpdates = []

  recoveryChain = recoveryChain
    .then(() => recoverUnresolvedChannels({
      feed,
      channels: state.unresolvedChannels.value.slice(),
      // Injected failures apply here too, or a simulated outage would clear the
      // moment recovery started and the later steps would never be reached.
      // Retries suppressed: sending more requests because requests are being
      // refused is exactly the wrong response to being refused.
      fetchChannel: channel => injectedFetchFailure() ??
        descriptor.fetchChannel(channel, { useRss: context.useRss, failedAttempts: NO_RETRY_ATTEMPTS }),
      onRecovered: async (results) => {
        for (const { channel, result } of results) {
          await cacheChannelResult(descriptor, channel, result, subscriptionUpdates)

          state.unresolvedChannels.value = state.unresolvedChannels.value
            .filter(unresolved => unresolved.id !== channel.id)
        }

        if (subscriptionUpdates.length > 0) {
          store.dispatch('batchUpdateSubscriptionDetails', subscriptionUpdates.splice(0))
        }

        // Recovered channels are in the cache now, so the same signal that
        // commits a refresh puts them on screen
        state.revision.value++
      }
    }))
    .then(() => {
      // Now that nothing further will be attempted, whatever is still missing is
      // worth mentioning. A recovery that got everything back says nothing.
      showFetchErrorSummary(feed, collector, state.unresolvedChannels.value)
    })
    .catch((error) => {
      console.error(error)
    })
}

/**
 * The profile changed, so everything queued is for a set of channels nobody is
 * looking at any more. Requests already in flight are left to finish, since
 * there is nothing here to abort one with, but they cannot commit.
 */
export function cancelSubscriptionRefresh() {
  profileGeneration++

  cancelSubscriptionLane(LANE_REFRESH)
  cancelSubscriptionRecovery()
  cancelDetailBackfill()

  for (const [feed, context] of Array.from(running)) {
    finishFeedRefresh(feed, context, { cancelled: true })
  }

  for (const feed of SUBSCRIPTION_FEEDS) {
    // Both of these describe the profile that is being left: how long ago its
    // feeds were fetched, and whether anyone has tried
    states[feed].lastSuccessAt.value = null
    states[feed].attemptedFetch.value = false
    states[feed].unresolvedChannels.value = []
  }
}
