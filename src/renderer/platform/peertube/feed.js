// A subscribed PeerTube channel's feed, for the subscription refresh: the
// layer's `fetchChannelFeed`, answering in the refresh's own fetch status
// contract (`src/subscriptionFetchStatusValues.js`), so the refresh machinery
// needs no new vocabulary (spec, "Subscription fetching").
//
// - `videos`: the channel's latest uploads, one request to its origin,
//   `/api/v1/video-channels/{name@host}/videos?sort=-publishedAt&count=30&isLive=false`.
//   Lives are left out by the instance (`isLive`, which every supported
//   version understands) and again here, should one come through anyway.
// - `live`: the same list with `isLive=true`: a live on now (`liveNow`), a
//   waiting one (`isUpcoming`, with `premiereDate` when it is scheduled). An
//   ended live is dropped. YouTube's live feed lists past streams because they
//   are watchable; an ended PeerTube live is not (a replay, where the instance
//   saves one, becomes an upload and is in `videos`).
// - `shorts` and `posts`: PeerTube has neither. An empty answer, no request.
// - One request per channel and feed, never the NSFW refills a channel page
//   makes: the request manager's budget counts one job as one request
//   (ADR-0002). NSFW is filtered as everywhere in the layer (`./nsfw.js`).
// - Entries are video summaries (`../shapes.js`), which carry the fields the
//   cache, the stream, the cards and the filters read. No `name` or
//   `thumbnailUrl` is returned: the refresh would write them into the stub
//   through a rewrite made for YouTube's avatars.
//
// Only a confirmed disappearance may write emptiness (ADR-0012):
//
// - A 404 on the channel from its own origin, with PeerTube's own not-found
//   body (a problem document, not a proxy's HTML or an empty page), while that
//   origin still answers as a PeerTube instance (its `/api/v1/config`, asked
//   afresh for each 404, never the session's remembered yes), is `unavailable`
//   with `entries: []`. That is a claim, not a verdict: the caller hands it to
//   `resolveGoneVerdict`, which is the only place a channel may be declared
//   gone, and which stops believing a host that claims more than one.
// - A 429 is `rateLimited` with `entries: null`; the client then refuses that
//   host until its `Retry-After` has passed, without a request.
// - Anything else (unreachable, refused, a 5xx, a body that is not a list, a
//   404 whose body is not PeerTube's, a 404 from a host that no longer answers
//   as PeerTube, a ref that is not a PeerTube channel) is `failed` with
//   `entries: null`.
//
// Every answer but `ok` carries the `PlatformError` it came from as `error`.
//
// Not gated on the PeerTube switch, as nothing that reads a stored PeerTube
// record is: whether PeerTube channels are fetched at all is the refresh's
// decision (`src/renderer/helpers/subscriptionFeeds/peertube.js`).

import {
  FETCH_FAILED,
  FETCH_OK,
  FETCH_RATE_LIMITED,
  FETCH_UNAVAILABLE,
} from '../../../subscriptionFetchStatusValues.js'
import { PlatformError } from '../errors'
import { PLATFORM_PEERTUBE, parseChannelHandle, peerTubeChannelRef } from '../refs'
import { liveStatusOf, videoSummary } from './normalise'
import { nsfwFilter, nsfwParam } from './nsfw'

/** The fetch status values, as the refresh machinery names them */
export const FEED_STATUS = Object.freeze({
  ok: FETCH_OK,
  rateLimited: FETCH_RATE_LIMITED,
  unavailable: FETCH_UNAVAILABLE,
  failed: FETCH_FAILED,
})

/** How many of a channel's newest are asked for, per feed */
export const FEED_COUNT = 30

/** The feeds PeerTube has nothing for */
const EMPTY_FEEDS = new Set(['shorts', 'posts'])

/**
 * @typedef {object} ChannelFeedResult
 * @property {'ok' | 'rateLimited' | 'unavailable' | 'failed'} status
 * @property {import('../shapes').VideoSummary[] | null} entries `null` for
 *   anything that must not touch the cache
 * @property {PlatformError} [error] what went wrong, for anything but `ok`
 */

/**
 * The handle a stored stub or a handle stands for, or `null`.
 *
 * @param {unknown} channelRef
 * @returns {{ host: string, handle: string } | null}
 */
function handleOf(channelRef) {
  let value = channelRef

  if (typeof channelRef === 'object' && channelRef !== null) {
    if (channelRef.platform !== PLATFORM_PEERTUBE) {
      return null
    }

    value = channelRef.id
  }

  const parsed = parseChannelHandle(value)
  const handle = parsed && peerTubeChannelRef(parsed.name, parsed.host)

  return handle ? { host: parsed.host, handle } : null
}

/**
 * Whether a 404's body is PeerTube's own not-found, a problem document
 * (RFC 7807, `application/problem+json`) of status 404, as
 * `fixtures/video.blender.org--not-found.json` records. An HTML page, an
 * empty body or anyone else's JSON is a proxy, a parked domain or a
 * misrouted request speaking, not the instance.
 *
 * @param {unknown} body
 * @returns {boolean}
 */
function isPeerTubeNotFound(body) {
  return typeof body === 'object' &&
    body !== null &&
    body.status === 404 &&
    (typeof body.detail === 'string' || typeof body.title === 'string')
}

/**
 * @param {'rateLimited' | 'failed' | 'unavailable'} status
 * @param {PlatformError} error
 * @returns {ChannelFeedResult}
 */
function notAnAnswer(status, error) {
  return { status, entries: status === FETCH_UNAVAILABLE ? [] : null, error }
}

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('./client').createPeerTubeClient>} deps.client
 * @param {{ peertubeShowNsfw: boolean }} deps.config
 */
export function createFeedReader({ client, config }) {
  const keep = nsfwFilter(config)

  /**
   * Whether a 404 from a host is the host's word that the channel is gone,
   * rather than a host that has stopped being a PeerTube instance (a lapsed
   * domain answers 404 for everything). Asked afresh, not from what the
   * session remembers: the yes has to be about now (ADR-0012).
   *
   * @param {string} host
   * @returns {Promise<boolean>}
   */
  async function stillPeerTube(host) {
    try {
      await client.getConfig(host, { fresh: true })
      return true
    } catch {
      return false
    }
  }

  /**
   * @param {unknown} error
   * @param {string} host
   * @returns {Promise<ChannelFeedResult>}
   */
  async function statusForError(error, host) {
    if (!(error instanceof PlatformError)) {
      return notAnAnswer(FETCH_FAILED, new PlatformError('unavailable', `${host} answered something unreadable`, { host, cause: error }))
    }

    if (error.kind === 'rateLimited') {
      return notAnAnswer(FETCH_RATE_LIMITED, error)
    }

    if (error.kind === 'notFound' && error.status === 404 && isPeerTubeNotFound(error.body) && await stillPeerTube(host)) {
      return notAnAnswer(FETCH_UNAVAILABLE, error)
    }

    return notAnAnswer(FETCH_FAILED, error)
  }

  /**
   * @param {unknown} channelRef a stored PeerTube stub, or its `name@host` handle
   * @param {string} feed `videos`, `live`, `shorts` or `posts`
   * @returns {Promise<ChannelFeedResult>}
   */
  async function fetchChannelFeed(channelRef, feed) {
    const channel = handleOf(channelRef)

    if (!channel) {
      return notAnAnswer(FETCH_FAILED, new PlatformError('invalid', 'Not a PeerTube channel'))
    }

    if (EMPTY_FEEDS.has(feed)) {
      return { status: FETCH_OK, entries: [] }
    }

    if (feed !== 'videos' && feed !== 'live') {
      return notAnAnswer(FETCH_FAILED, new PlatformError('invalid', `Not a subscription feed: ${String(feed)}`))
    }

    const { host, handle } = channel
    const wantsLives = feed === 'live'

    let body

    try {
      body = await client.get(host, `/video-channels/${handle}/videos`, {
        start: 0,
        count: FEED_COUNT,
        sort: '-publishedAt',
        isLive: wantsLives,
        nsfw: nsfwParam(config),
      })
    } catch (error) {
      return statusForError(error, host)
    }

    if (!Array.isArray(body?.data)) {
      return notAnAnswer(FETCH_FAILED, new PlatformError('unavailable', `${host} answered without a list of videos`, { status: 200, host }))
    }

    const entries = []

    for (const video of body.data) {
      const liveStatus = liveStatusOf(video)

      if (wantsLives ? liveStatus === null || liveStatus === 'ended' : liveStatus !== null) {
        continue
      }

      const summary = videoSummary(video, host)

      if (summary === null || !keep(summary)) {
        continue
      }

      // Every video in the list is the channel's; an item that could not name
      // its channel still belongs to it
      if (summary.authorId === '') {
        summary.authorId = handle
      }

      entries.push(summary)
    }

    return { status: FETCH_OK, entries }
  }

  return Object.freeze({ fetchChannelFeed })
}
