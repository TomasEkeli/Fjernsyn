import { reactive } from 'vue'

import i18n from '../i18n/index'

import { traceGoneVerdict } from './subscriptionTrace'
import { copyToClipboard, showToast } from './utils'
import {
  FETCH_FAILED,
  FETCH_OK,
  FETCH_RATE_LIMITED,
  FETCH_UNAVAILABLE
} from '../../subscriptionFetchStatusValues'

/**
 * Outcomes of fetching one channel's feed.
 *
 * Before these existed, nearly every failure path returned an empty array,
 * which is also what a channel with no videos returns. That made "YouTube
 * blocked us" indistinguishable from "nothing posted here", so nothing could
 * decide whether a refresh was worth retrying.
 */

// The values live in an import-free module of their own, because the platform
// layer returns the same contract and must not import this one. What each
// means here:
//
// - `FETCH_OK`: got an answer. The entries are trustworthy, even if there are
//   none.
// - `FETCH_RATE_LIMITED`: blocked, HTTP 403 or 429 (for PeerTube, a 429).
//   Retryable, and must never overwrite the cache.
// - `FETCH_UNAVAILABLE`: the channel is gone, as `resolveGoneVerdict` decided
//   and nothing else may. Not retryable, and caching emptiness for it is
//   correct.
// - `FETCH_FAILED`: threw, or returned something unparseable, and every
//   fallback was exhausted. Retryable, and must never overwrite the cache.
export { FETCH_FAILED, FETCH_OK, FETCH_RATE_LIMITED, FETCH_UNAVAILABLE }

/**
 * Not asked at all, on purpose: a PeerTube channel while PeerTube is switched
 * off. Never the platform layer's answer, only the dispatch's. Not retryable,
 * and with `entries: null` it writes nothing, so the channel's cached entries
 * stay as they were and it neither counts as a failure nor enters recovery.
 */
export const FETCH_SKIPPED = 'skipped'

/** @param {string} status */
export function isRetryableFetchStatus(status) {
  return status === FETCH_RATE_LIMITED || status === FETCH_FAILED
}

/**
 * Channels that are gone rather than unreachable, per feed, so the interface can
 * offer to unsubscribe from them.
 *
 * Module scope because the fetches that discover them are module scope: they
 * used to be closures inside the tab components, pushing into a ref the
 * composable owned, which meant a channel found to be dead while its tab was
 * unmounted was reported into nothing.
 *
 * @type {Record<string, { id: string }[]>}
 */
const unavailableChannelsByFeed = reactive({})

/**
 * @param {string} feed
 * @param {{ id: string }} channel
 */
export function reportChannelUnavailable(feed, channel) {
  const existing = unavailableChannelsByFeed[feed]

  if (existing == null) {
    unavailableChannelsByFeed[feed] = [channel]
    return
  }

  // A refresh and the recovery behind it can both reach the same dead channel
  if (existing.some(known => known.id === channel.id)) { return }

  existing.push(channel)
}

/**
 * @param {string} feed
 * @returns {{ id: string }[]}
 */
export function unavailableChannels(feed) {
  return unavailableChannelsByFeed[feed] ?? []
}

/** Forget what the last refresh found, at the start of the next one. */
export function clearUnavailableChannels(feed) {
  unavailableChannelsByFeed[feed] = []
}

/**
 * @typedef {object} FetchErrorCollector
 * @property {number} total
 * @property {{ channelId: string, channelName: string, api: string, error: unknown }[]} errors
 * @property {number} rateLimited
 * @property {number} suspectedGone how many channels this run has been told are gone
 * @property {boolean} goneBreakerTripped whether that count stopped being believed
 */

/** @type {Map<string, FetchErrorCollector>} */
const collectors = new Map()

/**
 * Per feed, how many gone claims each origin has made since the feed's last
 * refresh began: that refresh and the recovery after it. Kept apart from the
 * collector, which closes before recovery starts.
 *
 * @type {Map<string, Map<string, number>>}
 */
const originGoneClaims = new Map()

/**
 * How many channels one origin may claim gone in one refresh and still be
 * believed. A PeerTube instance is its own service, so the refresh-wide
 * anomaly limit, sized for YouTube's one service, is far too loose for it:
 * one dead channel on an instance is ordinary, a second in the same refresh
 * is more likely the instance misbehaving than two deletions at once.
 */
const ORIGIN_GONE_LIMIT = 1

/**
 * Counts one gone claim from an origin, and says whether it is still within
 * that origin's limit.
 *
 * @param {string} feed
 * @param {string} origin
 * @returns {boolean}
 */
function noteOriginGoneClaim(feed, origin) {
  let claims = originGoneClaims.get(feed)

  if (claims == null) {
    claims = new Map()
    originGoneClaims.set(feed, claims)
  }

  const count = (claims.get(origin) ?? 0) + 1
  claims.set(origin, count)

  return count <= ORIGIN_GONE_LIMIT
}

/** How many individual failures reach the console during one refresh. */
const MAX_LOGGED_ERRORS_PER_RUN = 5

/** How many entries each list in the copied report carries before it is cut short. */
const MAX_REPORTED_ITEMS = 40

/**
 * Start collecting fetch errors for a feed instead of showing them one by one.
 *
 * Each failed channel used to raise its own ten second click-to-copy toast, and
 * the retry ladder could raise three per channel. A few hundred blocked
 * channels therefore produced the better part of a thousand toasts, which is
 * how a mass failure announced itself. One summary is more use than that.
 *
 * @param {string} feed
 * @param {number} total how many channels this refresh will attempt
 */
export function beginFetchErrorCollection(feed, total) {
  originGoneClaims.delete(feed)

  collectors.set(feed, {
    total,
    errors: [],
    rateLimited: 0,
    suspectedGone: 0,
    goneBreakerTripped: false
  })
}

/**
 * The share of a profile's channels that can be declared gone in one refresh
 * before the verdict stops being believed, and the floor below which the share
 * is not applied at all.
 *
 * Channels do get terminated, and a handful in one refresh is ordinary. What is
 * not ordinary is a fifth of a subscription list going at once: that is a
 * broken endpoint, a blocked address or a bad deploy, and acting on it means
 * caching emptiness over content that is still there. The floor keeps a small
 * profile from tripping the guard over two or three genuinely dead channels.
 */
const GONE_ANOMALY_FRACTION = 0.2
const GONE_ANOMALY_FLOOR = 15

/**
 * @param {FetchErrorCollector} collector
 */
function goneAnomalyLimit(collector) {
  return Math.max(GONE_ANOMALY_FLOOR, Math.ceil(collector.total * GONE_ANOMALY_FRACTION))
}

/**
 * Decide what a claim that a channel is gone actually means.
 *
 * Two separate problems are solved here, both found when YouTube's RSS service
 * began answering 404 for every valid id on 2026-08-22.
 *
 * The first is that the claim used to be believed outright. A 404 on the RSS
 * playlist feed was checked against the RSS channel feed, which is the same
 * service, so the check agreed with it whenever the service was the thing at
 * fault. `corroborate` asks something independent instead, and an unconfirmed
 * claim now means `FETCH_FAILED`: retryable, and the cache left alone. Refusing
 * to condemn a channel costs a retry later, while condemning it wrongly caches
 * emptiness over a feed that was fine and marks it not worth retrying, so the
 * two errors are not equally bad and this leans the safe way deliberately.
 *
 * The second is that no amount of individually reasonable verdicts should add up
 * to "your entire subscription list was terminated". Past the anomaly limit the
 * guard stops believing any of them, and stops probing: during an outage the
 * corroboration would otherwise be several hundred extra requests fired at a
 * host that is already refusing everything.
 *
 * @param {string} feed
 * @param {{ id: string, name?: string }} channel
 * @param {object} options
 * @param {string} options.source what claimed the channel is gone, for the trace
 * @param {boolean} [options.authoritative] set when the claim came from an
 *   endpoint that reports termination explicitly rather than by absence, which
 *   needs no second opinion. Still counted against the anomaly limit, because a
 *   flood of explicit terminations is no more believable than a flood of 404s.
 * @param {() => Promise<'gone' | 'alive' | 'unknown'>} [options.corroborate]
 * @param {string | null} [options.origin] the independent service that made
 *   the claim, where there are many (a PeerTube channel's instance). Past
 *   `ORIGIN_GONE_LIMIT` claims from one origin since the feed's refresh began,
 *   recovery included, that origin's claims are failures to retry. YouTube's
 *   callers pass none, and nothing changes for them.
 * @returns {Promise<{ status: string, entries: any[] | null }>}
 */
export async function resolveGoneVerdict(feed, channel, { source, authoritative = false, corroborate, origin = null }) {
  const collector = collectors.get(feed)
  const originBelieved = origin == null || noteOriginGoneClaim(feed, origin)

  // No refresh open, so this is a one-off fetch with no run to be anomalous
  // within. Keep the old behaviour for it.
  if (collector == null) {
    if (!originBelieved) {
      traceGoneVerdict(feed, channel.id, { source, verdict: 'origin-breaker' })
      return { status: FETCH_FAILED, entries: null }
    }

    if (authoritative) {
      reportChannelUnavailable(feed, channel)
      return { status: FETCH_UNAVAILABLE, entries: [] }
    }

    const verdict = corroborate == null ? 'unknown' : await corroborate()

    if (verdict === 'gone') {
      reportChannelUnavailable(feed, channel)
      return { status: FETCH_UNAVAILABLE, entries: [] }
    }

    return { status: FETCH_FAILED, entries: null }
  }

  collector.suspectedGone++

  if (collector.goneBreakerTripped) {
    return { status: FETCH_FAILED, entries: null }
  }

  if (collector.suspectedGone > goneAnomalyLimit(collector)) {
    collector.goneBreakerTripped = true

    console.warn(
      `[subscriptions] ${collector.suspectedGone} of ${collector.total} ${feed} channels reported gone in one refresh, ` +
      'which is not credible. Treating these as failures to retry rather than terminations, and leaving the cache alone. ' +
      'Something the feed depends on is broken rather than the channels.'
    )

    traceGoneVerdict(feed, channel.id, {
      source,
      verdict: 'breaker-tripped',
      suspected: collector.suspectedGone
    })

    return { status: FETCH_FAILED, entries: null }
  }

  if (!originBelieved) {
    traceGoneVerdict(feed, channel.id, { source, verdict: 'origin-breaker', suspected: collector.suspectedGone })
    return { status: FETCH_FAILED, entries: null }
  }

  if (authoritative) {
    traceGoneVerdict(feed, channel.id, { source, verdict: 'gone', suspected: collector.suspectedGone })
    reportChannelUnavailable(feed, channel)

    return { status: FETCH_UNAVAILABLE, entries: [] }
  }

  const verdict = corroborate == null ? 'unknown' : await corroborate()

  traceGoneVerdict(feed, channel.id, {
    source,
    verdict: verdict === 'gone' ? 'gone' : `unconfirmed:${verdict}`,
    suspected: collector.suspectedGone
  })

  if (verdict === 'gone') {
    reportChannelUnavailable(feed, channel)

    return { status: FETCH_UNAVAILABLE, entries: [] }
  }

  // 'alive' means the source lied and this is retryable. 'unknown' means the
  // probe failed and nothing was established, which is not grounds to condemn
  // a channel either. Both leave the cache untouched.
  return { status: FETCH_FAILED, entries: null }
}

/**
 * Record a channel that could not be fetched. Falls back to a toast when no
 * collection is open, so single-channel callers keep their existing behaviour.
 *
 * @param {string} feed
 * @param {object} details
 * @param {{ id: string, name?: string }} details.channel
 * @param {unknown} details.error
 * @param {'local' | 'invidious' | 'peertube'} details.api
 */
export function reportFetchError(feed, { channel, error, api }) {
  const collector = collectors.get(feed)

  if (collector == null) {
    console.error(error)

    // Both toasts name a YouTube backend, which would be wrong for an
    // instance. A PeerTube channel that stays unreachable is still counted in
    // the summary that follows its recovery.
    if (api === 'peertube') { return }

    const message = api === 'invidious'
      ? i18n.global.t('Invidious API Error (Click to copy)')
      : i18n.global.t('Local API Error (Click to copy)')

    showToast(`${message}: ${error}`, 10000, () => {
      copyToClipboard(error)
    })

    return
  }

  // Only the first few go to the console. A mass failure produces one of these
  // per channel per rung of its retry ladder, so several hundred subscriptions
  // can mean well over a thousand in the space of a few seconds, each one
  // serialised and forwarded to the main process when logging is enabled. That
  // is a lot of work to pile onto a renderer at the exact moment it is already
  // struggling, and a run that did so ended with the renderer dying. Every
  // error is still kept, and the summary can copy the lot.
  if (collector.errors.length < MAX_LOGGED_ERRORS_PER_RUN) {
    console.error(error)
  } else if (collector.errors.length === MAX_LOGGED_ERRORS_PER_RUN) {
    console.error(`[subscriptions] further ${feed} fetch errors suppressed, see the summary`)
  }

  collector.errors.push({
    channelId: channel.id,
    channelName: channel.name ?? channel.id,
    api,
    error
  })
}

/**
 * Note that a channel ended up rate limited. Counted separately from errors
 * because being blocked says something different from a channel being broken,
 * and it is the number that says to back off rather than investigate.
 *
 * Called once per channel, from whatever settles that channel's outcome, rather
 * than at each place an HTTP 403 is read.
 *
 * @param {string} feed
 */
export function reportRateLimited(feed) {
  const collector = collectors.get(feed)

  if (collector != null) {
    collector.rateLimited++
  }
}

/**
 * Stop collecting and hand back what was collected. Says nothing on its own:
 * whether anything is worth telling anyone depends on what happens next, which
 * the caller knows and this does not.
 *
 * @param {string} feed
 * @returns {FetchErrorCollector | undefined}
 */
export function endFetchErrorCollection(feed) {
  const collector = collectors.get(feed)

  collectors.delete(feed)

  return collector
}

/**
 * Report channels that could not be fetched, once, when nothing further is
 * going to be done about them.
 *
 * Two things decide whether this is worth saying. The count is channels left
 * unresolved rather than errors seen, because one channel can error at every
 * rung of its retry ladder and usually gets recovered by a fallback anyway, so
 * a run that logged forty two errors and resolved all but eight should say
 * eight. And it must not be said while the recovery is still working: a refresh
 * that loses three hundred and eighty channels and quietly gets every one of
 * them back is a success, and announcing the failure in the middle of it is
 * alarming about a problem that is already being solved.
 *
 * @param {string} feed
 * @param {FetchErrorCollector | undefined} collector
 * @param {{ id: string, name?: string }[]} unresolvedChannels
 */
export function showFetchErrorSummary(feed, collector, unresolvedChannels) {
  if (collector == null || unresolvedChannels.length === 0) { return }

  const message = collector.rateLimited > 0
    ? i18n.global.t('Subscriptions.Fetch Errors Rate Limited', {
        failed: unresolvedChannels.length,
        total: collector.total,
        rateLimited: collector.rateLimited
      })
    : i18n.global.t('Subscriptions.Fetch Errors', {
        failed: unresolvedChannels.length,
        total: collector.total
      })

  showToast(message, 10000, () => {
    copyToClipboard(formatErrorReport(feed, collector, unresolvedChannels))
  })
}

/**
 * @param {string} feed
 * @param {FetchErrorCollector} collector
 * @param {{ id: string, name?: string }[]} unresolvedChannels
 */
function formatErrorReport(feed, collector, unresolvedChannels) {
  const lines = [
    `Subscription fetch (${feed})`,
    `${unresolvedChannels.length} of ${collector.total} channels could not be fetched`,
    `${collector.rateLimited} rate limited, ${collector.errors.length} failed attempt(s) across all retries`,
    ''
  ]

  appendCapped(lines, 'Channels left unresolved', unresolvedChannels,
    channel => `  ${channel.name ?? channel.id} (${channel.id})`)

  // Every attempt, including ones a fallback went on to recover, because which
  // rung failed is the useful part when working out what is wrong
  appendCapped(lines, 'Failed attempts', collector.errors,
    ({ channelId, channelName, api, error }) => `  ${channelName} (${channelId}) via ${api}: ${error}`)

  return lines.join('\n')
}

/**
 * A mass failure can leave hundreds of channels unresolved, and a report that
 * long stops being something anyone reads or can paste anywhere useful. The
 * first few dozen say what is going on; the rest only say it again.
 *
 * @template T
 * @param {string[]} lines
 * @param {string} heading
 * @param {T[]} items
 * @param {(item: T) => string} format
 */
function appendCapped(lines, heading, items, format) {
  if (items.length === 0) { return }

  lines.push(`${heading} (${items.length}):`)

  for (const item of items.slice(0, MAX_REPORTED_ITEMS)) {
    lines.push(format(item))
  }

  if (items.length > MAX_REPORTED_ITEMS) {
    lines.push(`  ... and ${items.length - MAX_REPORTED_ITEMS} more`)
  }

  lines.push('')
}
