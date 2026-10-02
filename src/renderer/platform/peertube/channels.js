// A PeerTube channel, fetched: its details, its videos and its playlists, in
// the common shapes (`../shapes.js`).
//
// - A channel's ref is its `name@host` handle, and every request goes to that
//   host, its origin: `/api/v1/video-channels/{name@host}`, then `/videos`
//   and `/video-playlists` below it.
// - Lists are pages by offset (see `./paging.js`), 30 at a time.
// - Videos are sorted `newest` (`-publishedAt`), `popular` (`-views`) or
//   `oldest` (`publishedAt`), and filtered by the NSFW preference (see
//   `./nsfw.js`); a page the filter empties is followed by the next (see
//   `fetchSkippingEmpty`). Lives and scheduled lives are listed with their flags.
//   The `shorts` and `live` kinds are YouTube's tabs: an empty page here.
// - Playlists are the channel's, in PeerTube's order. The `releases`,
//   `podcasts` and `courses` kinds are YouTube's tabs: an empty page here.
//   The playlist sort is YouTube's too, and not read.
// - Posts are YouTube's community tab: an empty page here.
// - A handle the instance does not know is `notFound` (see `./client.js`).
// - An account's channels (`listAccountChannels`) are asked of the account's
//   host, `/api/v1/accounts/{name@host}/video-channels`, all at once: 100 is
//   PeerTube's largest page, far more channels than an account keeps.

import { PlatformError } from '../errors'
import { PLATFORM_PEERTUBE, parseChannelHandle, peerTubeChannelRef } from '../refs'
import {
  absoluteUrl,
  channelSummary,
  pickBanner,
  pickLargestAvatar,
  pickThumbnail,
  videoSummary,
} from './normalise'
import { nsfwFilter, nsfwParam } from './nsfw'
import { PAGE_COUNT, fetchSkippingEmpty, pageOf, startOf } from './paging'

/** The sorts a channel's videos can be listed in, and PeerTube's name for each */
/** How many of an account's channels are asked for, PeerTube's largest page */
const ACCOUNT_CHANNELS_COUNT = 100

export const CHANNEL_VIDEO_SORTS = Object.freeze({
  newest: '-publishedAt',
  popular: '-views',
  oldest: 'publishedAt',
})

/** The lists of a channel's videos the layer knows, YouTube's tabs; PeerTube has the first only */
export const CHANNEL_VIDEO_KINDS = Object.freeze(['videos', 'shorts', 'live'])

/** The lists of a channel's playlists the layer knows, YouTube's tabs; PeerTube has the first only */
export const CHANNEL_PLAYLIST_KINDS = Object.freeze(['playlists', 'releases', 'podcasts', 'courses'])

/**
 * An actor's handle (a channel's or an account's, both `name@host`), parsed.
 *
 * @param {unknown} handle
 * @param {string} [what] for the error
 * @returns {{ host: string, handle: string }}
 */
function channelOf(handle, what = 'channel') {
  const parsed = parseChannelHandle(handle)
  const ref = parsed && peerTubeChannelRef(parsed.name, parsed.host)

  if (!ref) {
    throw new PlatformError('invalid', `Not a PeerTube ${what} handle`)
  }

  return { host: parsed.host, handle: ref }
}

/**
 * A playlist in a list.
 *
 * @param {any} playlist
 * @param {string} host the instance that answered
 * @returns {import('../shapes').PlaylistSummary | null}
 */
function playlistSummary(playlist, host) {
  if (typeof playlist?.uuid !== 'string' || playlist.uuid === '') {
    return null
  }

  const channel = channelSummary(playlist.videoChannel, host)
  const origin = channel?.host ?? host

  return {
    type: 'playlist',
    platform: PLATFORM_PEERTUBE,
    host: origin,
    playlistId: playlist.uuid.toLowerCase(),
    title: typeof playlist.displayName === 'string' ? playlist.displayName : '',
    thumbnail: pickThumbnail(playlist, host),
    videoCount: typeof playlist.videosLength === 'number' ? playlist.videosLength : null,
    url: absoluteUrl(origin, playlist.url) ?? `https://${origin}/video-playlists/${playlist.uuid.toLowerCase()}`,
    description: typeof playlist.description === 'string' ? playlist.description : '',
    channelName: channel?.name ?? '',
    channelId: channel?.id ?? '',
  }
}

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('./client').createPeerTubeClient>} deps.client
 * @param {{ peertubeShowNsfw: boolean }} deps.config
 */
export function createChannelReader({ client, config }) {
  /**
   * @param {import('../shapes').PeerTubeChannelRef} ref
   * @returns {Promise<import('../shapes').ChannelDetails>}
   */
  async function getChannel(ref) {
    const { host, handle } = channelOf(ref)
    const body = await client.get(host, `/video-channels/${handle}`)
    const summary = channelSummary(body, host)

    if (!summary) {
      throw new PlatformError('unavailable', `${host} answered without a channel`, { status: 200, host })
    }

    return {
      ...summary,
      // `thumbnail` stays the summary's pick, the size a stored subscription
      // stub holds; the header shows the largest
      avatarLarge: pickLargestAvatar(body, host),
      banner: pickBanner(body, host),
      description: typeof body.description === 'string' ? body.description : '',
      descriptionKind: 'markdown',
      support: typeof body.support === 'string' && body.support !== '' ? body.support : null,
    }
  }

  /**
   * A page of the channel's videos. PeerTube has no shorts or live tab, so
   * those kinds are an empty page, without a request.
   *
   * @param {import('../shapes').PeerTubeChannelRef} ref
   * @param {{ kind?: 'videos' | 'shorts' | 'live', sort?: 'newest' | 'popular' | 'oldest', cursor?: unknown }} [options]
   * @returns {Promise<import('../shapes').Page<import('../shapes').VideoSummary>>}
   */
  async function listChannelVideos(ref, { kind = 'videos', sort = 'newest', cursor = null } = {}) {
    const { host, handle } = channelOf(ref)

    if (!CHANNEL_VIDEO_KINDS.includes(kind)) {
      throw new PlatformError('invalid', `Not a kind of a channel's videos: ${String(kind)}`)
    }

    if (!Object.hasOwn(CHANNEL_VIDEO_SORTS, sort)) {
      throw new PlatformError('invalid', `Not a channel video sort: ${String(sort)}`)
    }

    if (kind !== 'videos') {
      return { items: [], cursor: null }
    }

    return fetchSkippingEmpty(async (start) => {
      const body = await client.get(host, `/video-channels/${handle}/videos`, {
        start,
        count: PAGE_COUNT,
        sort: CHANNEL_VIDEO_SORTS[sort],
        nsfw: nsfwParam(config),
      })

      return pageOf(body, start, video => videoSummary(video, host), nsfwFilter(config))
    }, startOf(cursor))
  }

  /**
   * A page of the channel's playlists. PeerTube has no releases, podcasts or
   * courses tab, so those kinds are an empty page, without a request.
   *
   * @param {import('../shapes').PeerTubeChannelRef} ref
   * @param {{ kind?: 'playlists' | 'releases' | 'podcasts' | 'courses', cursor?: unknown }} [options]
   * @returns {Promise<import('../shapes').Page<import('../shapes').PlaylistSummary>>}
   */
  async function listChannelPlaylists(ref, { kind = 'playlists', cursor = null } = {}) {
    const { host, handle } = channelOf(ref)

    if (!CHANNEL_PLAYLIST_KINDS.includes(kind)) {
      throw new PlatformError('invalid', `Not a kind of a channel's playlists: ${String(kind)}`)
    }

    if (kind !== 'playlists') {
      return { items: [], cursor: null }
    }

    const start = startOf(cursor)
    const body = await client.get(host, `/video-channels/${handle}/video-playlists`, { start, count: PAGE_COUNT })

    return pageOf(body, start, playlist => playlistSummary(playlist, host))
  }

  /**
   * The channel's posts. PeerTube has none, so an empty page, without a
   * request; the handle is still checked.
   *
   * @param {import('../shapes').PeerTubeChannelRef} ref
   * @returns {Promise<import('../shapes').Page<import('../shapes').Post>>}
   */
  async function listChannelPosts(ref) {
    channelOf(ref)
    return { items: [], cursor: null }
  }

  /**
   * @param {string} accountHandle `name@host`
   * @returns {Promise<import('../shapes').ChannelSummary[]>}
   */
  async function listAccountChannels(accountHandle) {
    const { host, handle } = channelOf(accountHandle, 'account')
    const body = await client.get(host, `/accounts/${handle}/video-channels`, { count: ACCOUNT_CHANNELS_COUNT })

    if (!Array.isArray(body?.data)) {
      throw new PlatformError('unavailable', `${host} answered without a list of channels`, { status: 200, host })
    }

    return body.data.map(channel => channelSummary(channel, host)).filter(channel => channel !== null)
  }

  return Object.freeze({ getChannel, listChannelVideos, listChannelPlaylists, listChannelPosts, listAccountChannels })
}
