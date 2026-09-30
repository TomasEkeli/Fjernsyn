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
// - `platform` is `'peertube'` or absent; YouTube search is the YouTube
//   adapter's (`../youtube/search.js`).
//
// `searchQuery` takes a whole search query (`../search/query.js`) and sends
// its filters as the search API's fields, reporting in `applied` the ones it
// honoured (`../search/capabilities.js`):
//
// - `sort`: `-publishedAt`, `-views`, `-trending`; relevance sends none.
// - `time`: `startDate`, now minus 24 hours, 7, 30 or 365 days.
// - `after` / `before`: `startDate` / `endDate`, the start and end of those
//   days in UTC.
// - `length`: `durationMax=180`; `durationMin=180&durationMax=1200`;
//   `durationMin=1200` (YouTube's buckets, so the chip means the same).
// - `language`: `languageOneOf[]`, and `boostedLanguages[]` when the search
//   goes to the search source rather than to one instance.
// - `live`: `isLive=true`.
// - `nsfw`: `both` or `false`, from the query when it says, else from the
//   setting; the client filter follows the same value.
// - `instance`: that instance's own search API, `searchTarget=local`.
// - `type`: `channel` searches channels (the text, and the instance, alone);
//   any other searches videos.

import { isNeverPeerTubeHost } from '../../../peerTubeHosts.js'
import { PlatformError } from '../errors'
import { PLATFORM_PEERTUBE } from '../refs'
import { appliedFilters } from '../search/capabilities'
import { channelListItem, hostOfUrl, videoSummary } from './normalise'
import { nsfwFilter, nsfwParam } from './nsfw'
import { PAGE_COUNT, fetchSkippingEmpty, pageOf, startOf } from './paging'

const SEARCH_TYPES = Object.freeze({
  video: '/search/videos',
  channel: '/search/video-channels',
})

const SORTS = Object.freeze({
  date: '-publishedAt',
  views: '-views',
  trending: '-trending',
})

const DAY_MS = 24 * 60 * 60 * 1000

const TIME_SPANS = Object.freeze({
  today: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  year: 365 * DAY_MS,
})

const DURATIONS = Object.freeze({
  short: { durationMax: 180 },
  medium: { durationMin: 180, durationMax: 1200 },
  long: { durationMin: 1200 },
})

/**
 * The video search fields a query's filters become (see the header).
 *
 * @param {import('../search/query').SearchQuery} query
 * @param {{ now: number, showNsfw: boolean, toSource: boolean }} options
 * @returns {Record<string, unknown>}
 */
export function videoSearchFields(query, { now, showNsfw, toSource }) {
  /** @type {Record<string, unknown>} */
  const fields = { nsfw: showNsfw ? 'both' : 'false' }

  if (query.sort !== null) {
    fields.sort = SORTS[query.sort]
  }

  if (query.time !== null) {
    fields.startDate = new Date(now - TIME_SPANS[query.time]).toISOString()
  }

  if (query.after !== null) {
    fields.startDate = `${query.after}T00:00:00.000Z`
  }

  if (query.before !== null) {
    fields.endDate = `${query.before}T23:59:59.999Z`
  }

  if (query.length !== null) {
    Object.assign(fields, DURATIONS[query.length])
  }

  if (query.language.length > 0) {
    fields['languageOneOf[]'] = query.language

    if (toSource) {
      fields['boostedLanguages[]'] = query.language
    }
  }

  if (query.live) {
    fields.isLive = 'true'
  }

  return fields
}

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
 * @param {() => number} [deps.now] the clock, for the time buckets
 */
export function createSearcher({ client, config, now = Date.now }) {
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

  /**
   * A page of results for a search query, with the filters it honoured.
   *
   * @param {import('../search/query').SearchQuery} query normalised
   * @param {{ cursor?: unknown }} [options]
   * @returns {Promise<import('../shapes').Page<import('../shapes').VideoSummary | import('../shapes').ChannelListItem> & { applied: string[] }>}
   */
  async function searchQuery(query, { cursor = null } = {}) {
    const start = startOf(cursor)
    const applied = appliedFilters(PLATFORM_PEERTUBE, query)
    const text = typeof query?.text === 'string' ? query.text.trim() : ''

    if (text === '') {
      return { items: [], cursor: null, applied }
    }

    const source = query.instance ? `https://${query.instance}` : config.peertubeSearchSource
    const sourceHost = hostOfUrl(source) ?? ''
    const target = query.instance ? { searchTarget: 'local' } : {}

    if (query.type === 'channel') {
      const body = await client.getAt(source, SEARCH_TYPES.channel, { search: text, start, count: PAGE_COUNT, ...target })
      const page = pageOf(body, start, channel => fromPeerTubeOrigin(channelListItem(channel, pathHost(channel, sourceHost))))

      return { ...page, applied }
    }

    const showNsfw = query.nsfw ?? config.peertubeShowNsfw
    const fields = videoSearchFields(query, { now: now(), showNsfw, toSource: !query.instance })

    const page = await fetchSkippingEmpty(async (from) => {
      const body = await client.getAt(source, SEARCH_TYPES.video, {
        search: text,
        start: from,
        count: PAGE_COUNT,
        ...target,
        ...fields,
      })

      return pageOf(
        body,
        from,
        video => fromPeerTubeOrigin(videoSummary(video, pathHost(video, sourceHost))),
        nsfwFilter({ peertubeShowNsfw: showNsfw })
      )
    }, start)

    return { ...page, applied }
  }

  return Object.freeze({ search, searchQuery })
}
