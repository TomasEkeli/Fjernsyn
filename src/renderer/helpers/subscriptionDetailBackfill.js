import { ref } from 'vue'

import store from '../store/index'

import { getLocalChannelLiveStreams, getLocalChannelVideos } from './api/local'
import { getInvidiousChannelLive, getInvidiousChannelVideos } from './api/invidious'
import {
  enqueueSubscriptionJobs,
  cancelSubscriptionLane,
  promoteSubscriptionJobs,
  subscriptionWorkerProgress,
  LANE_ENRICHMENT
} from './subscriptionWorker'
import { traceBackfill } from './subscriptionTrace'
import { durationIsMissing } from '../../subscriptionVideoDetails'
import { platformOf, PLATFORM_PEERTUBE } from '../platform/refs'

/**
 * Filling in the details RSS leaves out, for the part of the feed being looked
 * at.
 *
 * RSS carries no duration, so a feed built from it shows no duration badge. The
 * only source is the channel's own page, which is the very thing being avoided
 * when falling back to RSS, so this asks as little as it can: only the channels
 * contributing to what is on screen, in feed order from the top, one at a time
 * on the shared worker.
 *
 * One channel request covers every entry that channel contributes, which is why
 * this works per channel rather than per video. The result is written through to
 * the cache and carried across refreshes, so a channel is asked once and stays
 * filled in.
 *
 * If the channel page is blocked too then nothing happens and nothing is lost:
 * the feed keeps the RSS data it already had. That is the bargain of doing this
 * in the background.
 *
 * Live streams want this more than videos do. Their RSS entries have no live
 * flag either, so a stream happening right now is indistinguishable from an
 * ordinary video until somebody asks the channel. Shorts are excluded because
 * no duration exists for them anywhere: the parsers write an empty one whatever
 * the source.
 */

/**
 * @typedef {object} BackfillFeed
 * @property {(channelId: string) => Promise<any[] | null>} fetchLocal
 * @property {(channelId: string) => Promise<any[] | null>} fetchInvidious
 * @property {string} updateAction
 */

/** @type {Record<string, BackfillFeed>} */
const FEEDS = {
  videos: {
    fetchLocal: async channelId => (await getLocalChannelVideos(channelId))?.videos ?? null,
    fetchInvidious: async channelId => (await getInvidiousChannelVideos(channelId))?.videos ?? null,
    updateAction: 'updateSubscriptionVideosCacheWithChannelPageVideos'
  },
  live: {
    fetchLocal: async channelId => (await getLocalChannelLiveStreams(channelId))?.videos ?? null,
    fetchInvidious: async channelId => (await getInvidiousChannelLive(channelId))?.videos ?? null,
    updateAction: 'updateSubscriptionLiveCacheWithChannelPageVideos'
  }
}

/**
 * Channels tried and given up on, and channels already done, per feed. Kept
 * apart because a channel filled in for videos says nothing about its streams.
 * @type {Record<string, { failed: Set<string>, completed: Set<string> }>}
 */
const seen = {
  videos: { failed: new Set(), completed: new Set() },
  live: { failed: new Set(), completed: new Set() }
}

/**
 * Bumped whenever a merge actually changed something.
 *
 * The merge writes into the entry objects the feed is already holding, but the
 * feed holds them in a shallowRef, so mutating them tells Vue nothing. Without a
 * signal the durations land in the store and on disk and never appear on
 * screen, which is exactly what happened the first time this was tried against a
 * real subscription list. The feed watches this and rebuilds its array, which
 * both triggers the shallowRef and lets the changed keys remount the items whose
 * details arrived.
 */
export const detailBackfillRevision = ref(0)

/**
 * Work out which channels are worth asking about, in the order they first appear
 * in what is being looked at.
 *
 * @param {any[]} visibleEntries the slice of the feed actually rendered
 * @param {string} feed
 * @returns {{ channelId: string, channelName?: string }[]}
 */
export function channelsNeedingDetails(visibleEntries, feed = 'videos') {
  const { failed, completed } = seen[feed]

  /** @type {Map<string, string | undefined>} */
  const needed = new Map()

  for (const entry of visibleEntries) {
    const channelId = entry?.authorId

    if (channelId == null) { continue }
    // A PeerTube list already carries the duration and the live flags, and a
    // PeerTube handle means nothing to the YouTube channel pages asked here
    if (platformOf(entry) === PLATFORM_PEERTUBE) { continue }
    if (needed.has(channelId)) { continue }
    if (failed.has(channelId) || completed.has(channelId)) { continue }

    // Something already known to be live or upcoming has no duration to find,
    // and its status is the thing we would have been asking for
    if (entry.liveNow || entry.isUpcoming) { continue }

    if (durationIsMissing(entry.lengthSeconds)) {
      needed.set(channelId, entry.author)
    }
  }

  return Array.from(needed, ([channelId, channelName]) => ({ channelId, channelName }))
}

/**
 * Offer the visible part of a feed for filling in, and put it at the front of
 * the queue. Safe to call whenever the visible slice changes: the manager drops
 * channels it already has queued, and moves the rest rather than repeating them.
 *
 * Since the refresh offers every channel it finds short of details, most of what
 * is on screen is usually queued already, somewhere behind several hundred
 * others. Promotion is what makes the part being read fill in first.
 *
 * @param {any[]} visibleEntries
 * @param {string} feed
 * @returns {number} how many channels were newly queued
 */
export function backfillDetailsForVisibleVideos(visibleEntries, feed = 'videos') {
  if (!store.getters.getSubscriptionBackfillDetails) { return 0 }
  if (FEEDS[feed] == null) { return 0 }

  const channels = channelsNeedingDetails(visibleEntries, feed)

  if (channels.length === 0) { return 0 }

  const added = enqueueChannels(feed, channels)

  promoteSubscriptionJobs(LANE_ENRICHMENT, channels.map(({ channelId }) => `${feed}-${channelId}`))

  return added
}

/**
 * Offer one channel for filling in, as soon as a refresh has cached what RSS
 * had to say about it.
 *
 * This used to wait for the whole refresh to commit, because it was triggered by
 * the visible slice changing and the slice only changed when the feed was
 * replaced at the end. Waiting achieved nothing: the details are wanted for
 * entries that are already in the cache, the manager's budget decides how fast
 * they are fetched either way, and starting at the end meant the back-fill ran
 * in a silence after the refresh instead of in the slack during it.
 *
 * Steady-state cost is small. Carry-over means only channels with genuinely new
 * uploads are short of durations after the first full pass; the first pass
 * back-fills everything, which is what it is for.
 *
 * @param {string} feed
 * @param {any[] | null} entries what the refresh just cached for one channel
 * @returns {number} how many channels were newly queued, so at most one
 */
export function backfillDetailsForFetchedChannel(feed, entries) {
  if (!store.getters.getSubscriptionBackfillDetails) { return 0 }
  if (FEEDS[feed] == null) { return 0 }
  if (entries == null || entries.length === 0) { return 0 }

  return enqueueChannels(feed, channelsNeedingDetails(entries, feed))
}

/**
 * @param {string} feed
 * @param {{ channelId: string, channelName?: string }[]} channels
 * @returns {number}
 */
function enqueueChannels(feed, channels) {
  if (channels.length === 0) { return 0 }

  const descriptor = FEEDS[feed]
  const { failed, completed } = seen[feed]

  return enqueueSubscriptionJobs(LANE_ENRICHMENT, channels.map(({ channelId, channelName }) => ({
    key: `${feed}-${channelId}`,
    label: channelName ?? channelId,
    run: async () => {
      const startedAt = Date.now()

      /** @param {string} outcome */
      const done = outcome => traceBackfill(feed, channelId, {
        outcome,
        ms: Date.now() - startedAt,
        queued: subscriptionWorkerProgress.lanes.enrichment.queued
      })

      let entries

      try {
        entries = (!process.env.SUPPORTS_LOCAL_API || store.getters.getBackendPreference === 'invidious')
          ? await descriptor.fetchInvidious(channelId)
          : await descriptor.fetchLocal(channelId)
      } catch (error) {
        console.error(error)
        failed.add(channelId)
        done('threw')
        return
      }

      if (entries == null || entries.length === 0) {
        failed.add(channelId)
        done('empty')
        return
      }

      completed.add(channelId)

      await store.dispatch(descriptor.updateAction, { channelId, videos: entries })

      detailBackfillRevision.value++
      done(`ok:${entries.length}`)
    }
  })))
}

/**
 * Called when the feed being looked at changes out from under the queue, for
 * instance on switching profile. Anything queued is for a feed nobody is reading
 * any more.
 */
export function cancelDetailBackfill() {
  cancelSubscriptionLane(LANE_ENRICHMENT)
}

/** Test seam. */
export function resetDetailBackfillForTests() {
  for (const sets of Object.values(seen)) {
    sets.failed.clear()
    sets.completed.clear()
  }
}
