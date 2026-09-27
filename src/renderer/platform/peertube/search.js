// PeerTube search, from the configured search source: SepiaSearch by default,
// or any index or instance speaking PeerTube's search API
// (`config.peertubeSearchSource`, an https URL).
//
// - Requests: `GET {source}/api/v1/search/videos?search&start&count&nsfw`
//   and `GET {source}/api/v1/search/video-channels?search&start&count`. An
//   index has no `/api/v1/config`, so the source is asked directly, through
//   the client's `getAt` (https only, never a YouTube or Google host, marked
//   `probe`).
// - Every result carries its origin host (its channel's, else its account's,
//   else its URL's), so that it plays and opens from its origin whichever
//   source found it. Results whose origin is never PeerTube are dropped.
// - Images: absolute URLs are taken as they are. A path is resolved against
//   the host that serves it: for an index's result, the origin (an index sends
//   absolute `thumbnailUrl`, `previewUrl` and avatar `url` fields beside the
//   paths, which name it); for an instance's own search, the instance
//   searched, which caches remote thumbnails and avatars locally.
// - Video results are filtered by the NSFW preference (see `./nsfw.js`).
//   A page the filter empties is followed by the next (see
//   `fetchSkippingEmpty`). Channels carry no NSFW flag.
// - `platform` is `'peertube'` or absent; YouTube search is not the layer's yet.

import { isNeverPeerTubeHost } from '../../../peerTubeHosts.js'
import { PlatformError } from '../errors'
import { PLATFORM_PEERTUBE } from '../refs'
import { channelListItem, hostOfUrl, videoSummary } from './normalise'
import { nsfwFilter, nsfwParam } from './nsfw'
import { PAGE_COUNT, fetchSkippingEmpty, pageOf, startOf } from './paging'

const SEARCH_TYPES = Object.freeze({
  video: '/search/videos',
  channel: '/search/video-channels',
})

/**
 * The host of the first absolute `url` of an actor's images, which only an
 * index sends.
 *
 * @param {any} actor
 * @returns {string | null}
 */
function indexImageHost(actor) {
  const images = Array.isArray(actor?.avatars) ? actor.avatars : []

  for (const image of images) {
    const host = hostOfUrl(image?.url)
    if (host) {
      return host
    }
  }

  return null
}

/**
 * The host a search result's paths are relative to (see the header).
 *
 * @param {any} item a video or channel result
 * @param {string} sourceHost
 * @returns {string}
 */
function pathHost(item, sourceHost) {
  return hostOfUrl(item?.thumbnailUrl) ??
    hostOfUrl(item?.previewUrl) ??
    indexImageHost(item) ??
    indexImageHost(item?.channel) ??
    sourceHost
}

/**
 * @template {{ host?: string } | null} T
 * @param {T} item
 * @returns {T | null}
 */
function fromPeerTubeOrigin(item) {
  return item && !isNeverPeerTubeHost(item.host) ? item : null
}

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('./client').createPeerTubeClient>} deps.client
 * @param {{ peertubeSearchSource: string, peertubeShowNsfw: boolean }} deps.config
 */
export function createSearcher({ client, config }) {
  /**
   * @param {unknown} query
   * @param {{ platform?: 'peertube', type?: 'video' | 'channel', cursor?: unknown }} [options]
   * @returns {Promise<import('../shapes').Page<import('../shapes').VideoSummary | import('../shapes').ChannelListItem>>}
   */
  async function search(query, { platform = PLATFORM_PEERTUBE, type = 'video', cursor = null } = {}) {
    if (platform !== PLATFORM_PEERTUBE) {
      throw new PlatformError('invalid', `Not a platform this search covers: ${String(platform)}`)
    }

    if (!Object.hasOwn(SEARCH_TYPES, type)) {
      throw new PlatformError('invalid', `Not a PeerTube search type: ${String(type)}`)
    }

    const start = startOf(cursor)
    const text = typeof query === 'string' ? query.trim() : ''

    if (text === '') {
      return { items: [], cursor: null }
    }

    const source = config.peertubeSearchSource
    const sourceHost = hostOfUrl(source) ?? ''

    if (type === 'channel') {
      const body = await client.getAt(source, SEARCH_TYPES.channel, { search: text, start, count: PAGE_COUNT })

      return pageOf(body, start, channel => fromPeerTubeOrigin(channelListItem(channel, pathHost(channel, sourceHost))))
    }

    return fetchSkippingEmpty(async (from) => {
      const body = await client.getAt(source, SEARCH_TYPES.video, {
        search: text,
        start: from,
        count: PAGE_COUNT,
        nsfw: nsfwParam(config),
      })

      return pageOf(
        body,
        from,
        video => fromPeerTubeOrigin(videoSummary(video, pathHost(video, sourceHost))),
        nsfwFilter(config)
      )
    }, start)
  }

  return Object.freeze({ search })
}
