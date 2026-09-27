import { getPlatformLayer, isPeerTubeEnabled } from '../../platform/vue'
import { parseChannelHandle, platformOf, PLATFORM_PEERTUBE } from '../../platform/refs'
import { traceFetchStatus } from '../subscriptionTrace'
import {
  reportFetchError,
  resolveGoneVerdict,
  FETCH_FAILED,
  FETCH_OK,
  FETCH_SKIPPED,
  FETCH_UNAVAILABLE
} from '../subscriptionFetchStatus'

/**
 * How a PeerTube channel is fetched for the subscription feeds, and the one
 * place the refresh path tells the platforms apart.
 *
 * Every feed descriptor's `fetchChannel` is wrapped by `withPlatformDispatch`:
 * a stub with `platform: 'peertube'` goes to the platform layer's
 * `fetchChannelFeed`, anything else to the descriptor's own YouTube function,
 * called exactly as it was before. That is the whole of the change to the
 * refresh path (spec, "Subscription fetching"); everything around it, the
 * budget, the lanes, the cache writes, the recovery, is the same code for both,
 * and a PeerTube fetch runs inside the refresh job's `run` like any other, so
 * it is paced by the same budget (ADR-0002).
 *
 * What a PeerTube channel does not get, by not going through the YouTube
 * functions: RSS, the liveness probe, and channel tags (written only by the
 * YouTube Local fetchers). The detail back-fill and the carry-over each skip
 * PeerTube entries themselves (`subscriptionDetailBackfill.js`,
 * `src/subscriptionVideoDetails.js`): PeerTube's list already carries the
 * duration and the live and scheduled flags, and nothing is missing to fill in.
 * No `name` or `thumbnailUrl` is handed back, so `batchUpdateSubscriptionDetails`,
 * whose avatar rewrite is YouTube's, never touches a PeerTube stub.
 *
 * The layer claims a disappearance (a 404 with PeerTube's own not-found body
 * on the channel from its own origin, which answers as PeerTube when asked
 * afresh); this is where the claim is judged, by `resolveGoneVerdict`, the
 * only place a channel may be declared gone (ADR-0012). The origin's word is
 * authoritative, as Innertube's `ChannelError` is, so there is no probe; it
 * still counts against the refresh's anomaly limit, and past that limit it is
 * a failure to retry. Each instance is also its own service with its own
 * limit: past one claim from a host in one refresh (its recovery included),
 * that host's claims are failures to retry.
 */

/**
 * @param {{ platform?: string }} channel a subscription stub
 * @returns {boolean}
 */
export function isPeerTubeChannel(channel) {
  return platformOf(channel) === PLATFORM_PEERTUBE
}

/** The feeds a PeerTube channel has anything in: PeerTube has no shorts or posts */
const PEERTUBE_FEEDS = new Set(['videos', 'live'])

/**
 * Whether a refresh of one feed fetches this channel at all. Every YouTube
 * channel is fetched for every feed; a PeerTube channel only for `videos` and
 * `live`, and only while PeerTube is switched on. One that is not fetched keeps
 * whatever its cache holds (for shorts and posts, nothing), which goes on
 * showing; it is neither a failure nor anything recovery goes after, and no
 * feed is incomplete for want of it.
 *
 * @param {{ platform?: string }} channel
 * @param {string} feed
 * @returns {boolean}
 */
export function subscriptionChannelIsFetched(channel, feed) {
  return !isPeerTubeChannel(channel) || (PEERTUBE_FEEDS.has(feed) && isPeerTubeEnabled())
}

/**
 * One PeerTube channel's entries for one feed, in the refresh's fetch status
 * contract.
 *
 * Never rejects: a thrown layer (none should) is a failure to retry, as the
 * YouTube ladders' exhausted rungs are.
 *
 * @param {string} feed
 * @param {{ id: string, name?: string }} channel
 * @returns {Promise<{ status: string, entries: any[] | null }>}
 */
export async function fetchPeerTubeChannelFeed(feed, channel) {
  // Only reached if the switch was turned off with the channel already queued,
  // or already unresolved and waiting for recovery. The refresh leaves PeerTube
  // channels out of the job list while PeerTube is off, and out of the shorts
  // and posts job lists always (the layer answers those empty if asked).
  if (!isPeerTubeEnabled()) {
    return { status: FETCH_SKIPPED, entries: null }
  }

  let result

  try {
    result = await getPlatformLayer().fetchChannelFeed(channel, feed)
  } catch (error) {
    reportFetchError(feed, { channel, error, api: 'peertube' })
    return { status: FETCH_FAILED, entries: null }
  }

  traceFetchStatus(feed, channel.id, {
    rung: 'peertube',
    status: result.error?.status ?? (result.status === FETCH_OK ? 200 : null),
    attempt: 0,
    note: result.status
  })

  if (result.status === FETCH_UNAVAILABLE) {
    return await resolveGoneVerdict(feed, channel, {
      source: 'peertube',
      authoritative: true,
      origin: parseChannelHandle(channel.id)?.host ?? channel.host ?? channel.id
    })
  }

  if (result.status === FETCH_FAILED) {
    reportFetchError(feed, { channel, error: result.error, api: 'peertube' })
  }

  // Only the status and the entries: nothing about the channel's name or
  // avatar goes back towards the stub
  return { status: result.status, entries: result.entries }
}

/**
 * A feed descriptor whose `fetchChannel` sends PeerTube channels to the layer
 * and YouTube channels, untouched, to the descriptor's own.
 *
 * @template {import('./index').SubscriptionFeedDescriptor} T
 * @param {T} descriptor
 * @returns {T}
 */
export function withPlatformDispatch(descriptor) {
  const fetchYouTubeChannel = descriptor.fetchChannel

  return {
    ...descriptor,
    fetchChannel: (channel, context) => {
      return isPeerTubeChannel(channel)
        ? fetchPeerTubeChannelFeed(descriptor.feed, channel)
        : fetchYouTubeChannel(channel, context)
    }
  }
}
