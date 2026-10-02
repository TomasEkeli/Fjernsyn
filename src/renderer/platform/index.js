// The platform layer: what the new views talk to instead of the services.
// Framework-free (no Vue, Vuex, router, store or i18n here or below; the
// wiring is `vue.js`), constructed with its dependencies so that tests can
// replace them. See "Platforms" in docs/CONTEXT.md and ADR-0014.

import { describe } from './describe'
import { PlatformError } from './errors'
import { createChannelReader } from './peertube/channels'
import { createPeerTubeClient } from './peertube/client'
import { createCommentReader } from './peertube/comments'
import { createFeedReader } from './peertube/feed'
import { createSearcher } from './peertube/search'
import { createUrlResolver, parsePeerTubeInput } from './peertube/urls'
import { createVideoReader } from './peertube/videos'
import { isYouTubeChannelRef, isYouTubeVideoRef } from './refs'
import { SCOPE_ALL, SCOPE_PEERTUBE, SCOPE_YOUTUBE, normalise } from './search/query'
import { createYouTubeAdapter } from './youtube/index'

// The wiring builds one client for the session with this and hands it to
// every rebuild of the layer, so that what is known of each host survives
export { createPeerTubeClient }

/**
 * Configuration, as plain values read from the settings.
 *
 * @typedef {object} PlatformConfig
 * @property {boolean} peertubeEnabled the experimental switch; off, PeerTube URLs are not recognised
 * @property {string} peertubeSearchSource the instance or index PeerTube search goes to
 * @property {boolean} peertubeShowNsfw
 * @property {'local' | 'invidious'} backendPreference
 * @property {boolean} backendFallback
 * @property {string} currentInvidiousInstanceUrl
 * @property {string} thumbnailPreference
 * @property {string} locale for ordering captions
 * @property {boolean} showFamilyFriendlyOnly YouTube search's safety mode, on Local
 * @property {boolean} supportsLocalApi false in the web build, where YouTube is Invidious alone
 * @property {boolean} proxyVideos YouTube streams through the current Invidious instance
 */

/** @type {Readonly<PlatformConfig>} */
export const DEFAULT_CONFIG = Object.freeze({
  peertubeEnabled: false,
  peertubeSearchSource: 'https://sepiasearch.org',
  peertubeShowNsfw: false,
  backendPreference: 'local',
  backendFallback: false,
  currentInvidiousInstanceUrl: '',
  thumbnailPreference: '',
  locale: 'en-US',
  showFamilyFriendlyOnly: false,
  supportsLocalApi: true,
  proxyVideos: false,
})

// The hosts whose URLs are YouTube's, handed to the YouTube parser and never
// to PeerTube
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
])

/**
 * @param {string} input
 * @returns {boolean}
 */
function isYouTubeUrl(input) {
  try {
    const url = new URL(input)
    return (url.protocol === 'https:' || url.protocol === 'http:') && YOUTUBE_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

/**
 * The host of the current Invidious instance, lower case, or null.
 *
 * @param {string} instanceUrl
 * @returns {string | null}
 */
function hostOf(instanceUrl) {
  try {
    return new URL(instanceUrl).hostname || null
  } catch {
    return null
  }
}

/**
 * @param {object} deps
 * @param {typeof fetch} [deps.fetch] the fetch PeerTube requests go through;
 *   not needed when `peertubeClient` is given
 * @param {ReturnType<typeof createPeerTubeClient>} [deps.peertubeClient] the
 *   session's PeerTube client, from `createPeerTubeClient`. It holds all
 *   per-host state (configs, which hosts are PeerTube, rate limits), so the
 *   wiring passes the same one to every rebuild. Without it, a new client is
 *   made from `fetch` and `now`, knowing nothing.
 * @param {import('./youtube/deps').YouTubeDeps} [deps.youtube] the existing YouTube
 *   module functions the layer wraps, as `./youtube/deps.js` lists them
 * @param {Partial<PlatformConfig>} [deps.config]
 * @param {() => number} [deps.now] the clock, for rate limits of a new client
 *   and for search's time buckets
 */
export function createPlatformLayer({ fetch, peertubeClient, youtube = {}, config = {}, now = Date.now }) {
  /** @type {Readonly<PlatformConfig>} */
  const frozenConfig = Object.freeze({ ...DEFAULT_CONFIG, ...config })

  const peertube = peertubeClient ?? createPeerTubeClient({ fetch, now })
  // Stateless: what is known of each host is the client's
  const urls = createUrlResolver({ client: peertube })
  const videos = createVideoReader({ client: peertube, config: frozenConfig })
  const channels = createChannelReader({ client: peertube, config: frozenConfig })
  const searcher = createSearcher({ client: peertube, config: frozenConfig, now })
  const youtubeAdapter = createYouTubeAdapter({ youtube, config: frozenConfig })
  const comments = createCommentReader({ client: peertube })
  const feeds = createFeedReader({ client: peertube, config: frozenConfig })

  const invidiousHost = hostOf(frozenConfig.currentInvidiousInstanceUrl)
  const excludedHosts = invidiousHost ? [invidiousHost] : []

  /**
   * Where a stored or fetched video or channel routes, its thumbnail, share
   * URL and external player URL. Pure; see `./describe.js`.
   *
   * @param {unknown} entity
   * @param {import('./describe').DescribeOptions} [options]
   * @returns {import('./describe').Description}
   */
  function describeEntity(entity, options) {
    return describe(entity, frozenConfig, options)
  }

  /**
   * A ref and its kind for a pasted URL or PeerTube handle, or `null` for
   * what is not recognised.
   *
   * - A URL on a YouTube host (youtube.com and its www., m. and music.
   *   subdomains, youtu.be, youtube-nocookie.com) is handed to
   *   `youtube.resolveUrl`, whose answer is returned as it is; PeerTube is
   *   never asked. This is narrower than today's parser, which reads YouTube
   *   shapes on any host: an Invidious-style `https://yewtu.be/watch?v=...`
   *   is `null` here. Callers fall back to the existing parser when this
   *   answers `null`.
   * - YouTube's and Google's hosts and the current Invidious instance's host
   *   are never taken for PeerTube, whatever the path: `null`, no request.
   * - A PeerTube-shaped URL or handle, while PeerTube is on, is answered once
   *   its host is confirmed as PeerTube (see `./peertube/urls.js`), as a
   *   `PeerTubeResolution`. It rejects with a `PlatformError` when the host
   *   could not be asked (`unavailable`, `rateLimited`) or the video could
   *   not be resolved there (`notFound`, ...).
   * - Anything else is `null`, without a request.
   *
   * @param {unknown} input
   * @returns {Promise<unknown>}
   */
  async function resolveUrl(input) {
    if (typeof input !== 'string') {
      return null
    }

    const trimmed = input.trim()

    if (isYouTubeUrl(trimmed)) {
      return (await youtube.resolveUrl?.(trimmed)) ?? null
    }

    if (!frozenConfig.peertubeEnabled) {
      return null
    }

    const candidate = parsePeerTubeInput(trimmed, { excludedHosts })

    return candidate ? urls.resolve(candidate) : null
  }

  /**
   * A video's details, its playback source and its download options: a
   * PeerTube ref from its origin (see `./peertube/videos.js`), a YouTube
   * `videoId` from the backend the policy picks (see `./youtube/videos.js`).
   * Any other ref rejects as `invalid`, without a request.
   *
   * Rejects with a `PlatformError`: `refused` (with a `reason` where the
   * instance gives one), `notFound`, `rateLimited`, `unavailable`, `invalid`.
   *
   * @param {import('./shapes').VideoRef} ref
   * @returns {Promise<import('./shapes').VideoDetails>}
   */
  function getVideo(ref) {
    return isYouTubeVideoRef(ref) ? youtubeAdapter.getVideo(ref) : videos.getVideo(ref)
  }

  /**
   * A channel's details: a PeerTube `name@host` handle from its origin (see
   * `./peertube/channels.js`), a YouTube `UC` id through the backend policy
   * (see `./youtube/channels.js`). Anything else rejects as `invalid`,
   * without a request. A channel that does not exist is `notFound`.
   *
   * @param {import('./shapes').ChannelRef} ref
   * @returns {Promise<import('./shapes').ChannelDetails>}
   */
  function getChannel(ref) {
    return isYouTubeChannelRef(ref) ? youtubeAdapter.getChannel(ref) : channels.getChannel(ref)
  }

  /**
   * A page of a channel's videos, sorted `newest` (the default), `popular` or
   * `oldest`, filtered by the NSFW preference. Hand the page's `cursor` back
   * for the next page; `null` is the end.
   *
   * @param {import('./shapes').ChannelRef} ref
   * @param {{ sort?: 'newest' | 'popular' | 'oldest', cursor?: unknown }} [options]
   * @returns {Promise<import('./shapes').Page<import('./shapes').VideoSummary>>}
   */
  function listChannelVideos(ref, options) {
    return isYouTubeChannelRef(ref) ? youtubeAdapter.listChannelVideos(ref, options) : channels.listChannelVideos(ref, options)
  }

  /**
   * A page of a channel's playlists.
   *
   * @param {import('./shapes').ChannelRef} ref
   * @param {{ cursor?: unknown }} [options]
   * @returns {Promise<import('./shapes').Page<import('./shapes').PlaylistSummary>>}
   */
  function listChannelPlaylists(ref, options) {
    return isYouTubeChannelRef(ref) ? youtubeAdapter.listChannelPlaylists(ref, options) : channels.listChannelPlaylists(ref, options)
  }

  /**
   * Every video channel of a PeerTube account, from the account's own
   * instance, as channel summaries: `handle` (`name@host`, also `id`), `name`
   * (the display name), `thumbnail` (the avatar a subscription stub holds,
   * `''` when none) and `host` (the channel's origin), plus its `url` and
   * follower count. Following an account means following all its videos, so
   * this is what an account becomes when it is followed (NewPipe stores its
   * PeerTube subscriptions as accounts). The ref is the account's
   * `name@host` handle; anything else rejects as `invalid`, without a
   * request. An account the instance does not know is `notFound`.
   *
   * @param {string} accountHandle
   * @returns {Promise<import('./shapes').ChannelSummary[]>}
   */
  function listAccountChannels(accountHandle) {
    return channels.listAccountChannels(accountHandle)
  }

  /**
   * A page of PeerTube search results from the configured search source
   * (`peertubeSearchSource`: SepiaSearch by default, or any index or instance
   * speaking PeerTube's search API; see `./peertube/search.js`). Videos are
   * video summaries and channels channel list items, each carrying its
   * origin host so that it plays and opens from there. Video results are
   * filtered by the NSFW preference. A blank query is an empty page, without
   * a request. `platform` is `'peertube'` or absent; any other rejects as
   * `invalid`.
   *
   * @param {string} query
   * @param {{ platform?: 'peertube', type?: 'video' | 'channel', cursor?: unknown }} [options]
   * @returns {Promise<import('./shapes').Page<import('./shapes').VideoSummary | import('./shapes').ChannelListItem>>}
   */
  function search(query, options) {
    return searcher.search(query, options)
  }

  /**
   * Results for a search query (`./search/query.js`), from the platforms its
   * scope names, each page carrying `applied`: the filters that platform
   * honoured (`./search/capabilities.js`), so that a view can say which were
   * not. Filters a platform cannot honour are not dropped from the query.
   *
   * - Scope `youtube` or `peertube`: a page, `{ items, cursor, applied }`.
   *   Hand the cursor back for the next.
   * - Scope `all`: both platforms asked at once, answering
   *   `{ sections: { youtube, peertube } }`, each a page or the
   *   `PlatformError` that platform failed with; one failing never fails
   *   the other. More of one section is this again with that section's
   *   scope and cursor.
   *
   * YouTube goes through the backend preference and fallback
   * (`./youtube/search.js`), PeerTube to the search source or the query's
   * instance (`./peertube/search.js`). A scope naming PeerTube while PeerTube
   * is off rejects as `invalid`, as does a cursor with scope `all`.
   *
   * @param {import('./search/query').SearchQuery} input
   * @param {{ cursor?: unknown }} [options]
   * @returns {Promise<any>}
   */
  async function searchQuery(input, { cursor = null } = {}) {
    const query = normalise({ ...input, text: typeof input?.text === 'string' ? input.text : '' })

    if (query.scope !== SCOPE_YOUTUBE && !frozenConfig.peertubeEnabled) {
      throw new PlatformError('invalid', 'PeerTube is switched off')
    }

    if (query.scope === SCOPE_YOUTUBE) {
      return youtubeAdapter.search(query, { cursor })
    }

    if (query.scope === SCOPE_PEERTUBE) {
      return searcher.searchQuery(query, { cursor })
    }

    if (query.scope === SCOPE_ALL && cursor != null) {
      throw new PlatformError('invalid', 'More of the All scope is asked of one section, by its scope')
    }

    const [youtubeAnswer, peertubeAnswer] = await Promise.allSettled([
      youtubeAdapter.search({ ...query, scope: SCOPE_YOUTUBE }),
      searcher.searchQuery({ ...query, scope: SCOPE_PEERTUBE }),
    ])

    const settled = (answer) => answer.status === 'fulfilled' ? answer.value : answer.reason

    return {
      sections: {
        youtube: settled(youtubeAnswer),
        peertube: settled(peertubeAnswer),
      },
    }
  }

  /**
   * A page of a video's comment threads, read only. PeerTube: newest first
   * (see `./peertube/comments.js`); a video whose details say comments are off
   * (`commentsEnabled: false`) is an empty page, without a request. YouTube
   * (see `./youtube/comments.js`): `sort` `top` (the default) or `newest`,
   * ignored by PeerTube; a video whose backend says its comments are off is
   * `{ items: [], cursor: null, commentsEnabled: false }`.
   *
   * @param {import('./shapes').VideoRef} ref
   * @param {{ sort?: 'top' | 'newest', cursor?: unknown }} [options]
   * @returns {Promise<import('./shapes').Page<import('./shapes').Comment>>}
   */
  function getComments(ref, options) {
    return isYouTubeVideoRef(ref) ? youtubeAdapter.getComments(ref, options) : comments.getComments(ref, options)
  }

  /**
   * A page of a comment's direct replies, each with its own `replyCount`, so
   * that deeper replies load on demand in the same way. A YouTube comment's
   * replies start from its `repliesCursor` and stay on that backend.
   *
   * @param {import('./shapes').VideoRef} ref
   * @param {import('./shapes').Comment} comment as `getComments` or this returned it
   * @param {{ cursor?: unknown }} [options]
   * @returns {Promise<import('./shapes').Page<import('./shapes').Comment>>}
   */
  function getCommentReplies(ref, comment, options) {
    return isYouTubeVideoRef(ref)
      ? youtubeAdapter.getCommentReplies(ref, comment, options)
      : comments.getCommentReplies(ref, comment, options)
  }

  /**
   * One subscribed channel's entries for one subscription feed (`videos`,
   * `live`, `shorts`, `posts`), in the refresh's fetch status contract (see
   * `./peertube/feed.js`): `{ status, entries }`, with `status` one of the
   * values in `src/subscriptionFetchStatusValues.js`. Never rejects.
   *
   * - `ok`: `entries` are video summaries, cache entries as they are (an
   *   empty list is a real answer); `shorts` and `posts` are always an empty
   *   answer, without a request.
   * - `unavailable`: a 404 on the channel from its origin, still a PeerTube
   *   instance. `entries: []`, and a claim only: the caller passes it through
   *   `resolveGoneVerdict` as an authoritative claim (ADR-0012), which is the
   *   only place a channel may be declared gone.
   * - `rateLimited` (a 429; the host's `Retry-After` is honoured) and
   *   `failed` (anything else): `entries: null`, so nothing is written.
   *
   * PeerTube only: the ref is a stored PeerTube stub or its `name@host`
   * handle; anything else is `failed`, without a request.
   *
   * @param {unknown} channelRef
   * @param {string} feed
   * @returns {Promise<import('./peertube/feed').ChannelFeedResult>}
   */
  function fetchChannelFeed(channelRef, feed) {
    return feeds.fetchChannelFeed(channelRef, feed)
  }

  return Object.freeze({
    config: frozenConfig,
    describe: describeEntity,
    resolveUrl,
    getVideo,
    getChannel,
    listChannelVideos,
    listChannelPlaylists,
    listAccountChannels,
    search,
    searchQuery,
    getComments,
    getCommentReplies,
    fetchChannelFeed,
  })
}
