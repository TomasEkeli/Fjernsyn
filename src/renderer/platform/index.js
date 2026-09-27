// The platform layer: what the new views talk to instead of the services.
// Framework-free (no Vue, Vuex, router, store or i18n here or below; the
// wiring is `vue.js`), constructed with its dependencies so that tests can
// replace them. See "Platforms" in docs/CONTEXT.md and ADR-0014.

import { describe } from './describe'
import { createChannelReader } from './peertube/channels'
import { createPeerTubeClient } from './peertube/client'
import { createCommentReader } from './peertube/comments'
import { createSearcher } from './peertube/search'
import { createUrlResolver, parsePeerTubeInput } from './peertube/urls'
import { createVideoReader } from './peertube/videos'

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
 * @typedef {object} YouTubeDeps
 * @property {(url: string) => unknown} [resolveUrl] the existing YouTube URL
 *   parser; its answer is returned as it is
 */

/**
 * @param {object} deps
 * @param {typeof fetch} [deps.fetch] the fetch PeerTube requests go through;
 *   not needed when `peertubeClient` is given
 * @param {ReturnType<typeof createPeerTubeClient>} [deps.peertubeClient] the
 *   session's PeerTube client, from `createPeerTubeClient`. It holds all
 *   per-host state (configs, which hosts are PeerTube, rate limits), so the
 *   wiring passes the same one to every rebuild. Without it, a new client is
 *   made from `fetch` and `now`, knowing nothing.
 * @param {YouTubeDeps} [deps.youtube] the existing YouTube functions the layer wraps
 * @param {Partial<PlatformConfig>} [deps.config]
 * @param {() => number} [deps.now] the clock, for rate limits of a new client
 */
export function createPlatformLayer({ fetch, peertubeClient, youtube = {}, config = {}, now = Date.now }) {
  /** @type {Readonly<PlatformConfig>} */
  const frozenConfig = Object.freeze({ ...DEFAULT_CONFIG, ...config })

  const peertube = peertubeClient ?? createPeerTubeClient({ fetch, now })
  // Stateless: what is known of each host is the client's
  const urls = createUrlResolver({ client: peertube })
  const videos = createVideoReader({ client: peertube, config: frozenConfig })
  const channels = createChannelReader({ client: peertube, config: frozenConfig })
  const searcher = createSearcher({ client: peertube, config: frozenConfig })
  const comments = createCommentReader({ client: peertube })

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
   * A video's details, its playback source and its download options (see
   * `./peertube/videos.js`). PeerTube only, until phase 2 teaches the layer
   * YouTube: any other ref rejects as `invalid`, without a request.
   *
   * Rejects with a `PlatformError`: `refused` (with a `reason` where the
   * instance gives one), `notFound`, `rateLimited`, `unavailable`, `invalid`.
   *
   * @param {import('./shapes').VideoRef} ref
   * @returns {Promise<import('./shapes').VideoDetails>}
   */
  function getVideo(ref) {
    return videos.getVideo(ref)
  }

  /**
   * A channel's details, from its origin (see `./peertube/channels.js`).
   * PeerTube only for now: the ref is a `name@host` handle; anything else
   * rejects as `invalid`, without a request. A channel the instance does not
   * know is `notFound`.
   *
   * @param {import('./shapes').ChannelRef} ref
   * @returns {Promise<import('./shapes').ChannelDetails>}
   */
  function getChannel(ref) {
    return channels.getChannel(ref)
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
    return channels.listChannelVideos(ref, options)
  }

  /**
   * A page of a channel's playlists.
   *
   * @param {import('./shapes').ChannelRef} ref
   * @param {{ cursor?: unknown }} [options]
   * @returns {Promise<import('./shapes').Page<import('./shapes').PlaylistSummary>>}
   */
  function listChannelPlaylists(ref, options) {
    return channels.listChannelPlaylists(ref, options)
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
   * A page of a video's comment threads, newest first, read only (see
   * `./peertube/comments.js`). A video whose details say comments are off
   * (`commentsEnabled: false`) is an empty page, without a request.
   *
   * @param {import('./shapes').VideoRef} ref
   * @param {{ cursor?: unknown }} [options]
   * @returns {Promise<import('./shapes').Page<import('./shapes').Comment>>}
   */
  function getComments(ref, options) {
    return comments.getComments(ref, options)
  }

  /**
   * A page of a comment's direct replies, each with its own `replyCount`, so
   * that deeper replies load on demand in the same way.
   *
   * @param {import('./shapes').VideoRef} ref
   * @param {import('./shapes').Comment} comment as `getComments` or this returned it
   * @param {{ cursor?: unknown }} [options]
   * @returns {Promise<import('./shapes').Page<import('./shapes').Comment>>}
   */
  function getCommentReplies(ref, comment, options) {
    return comments.getCommentReplies(ref, comment, options)
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
    getComments,
    getCommentReplies,

    // A later ticket adds fetchChannelFeed here, over the same client and
    // returning the fetch status contract
  })
}
