// A YouTube channel, fetched: its details and videos in the common shapes
// (`../shapes.js`), from Local or Invidious through the backend policy
// (`./policy.js`). The mapping is the channel section and the cursor table of
// `./types.js`; the reading is the old channel view's
// (src/renderer/views/Channel/Channel.vue), re-implemented here.
//
// - Details. Local: `getLocalChannel(id)`, a `YT.Channel` read through
//   `parseLocalChannelHeader`, and for the description `channel.getAbout()`,
//   a second request. A terminated channel is not thrown but answered as
//   `{ alert }`, which is `notFound`. Invidious: `invidiousGetChannelInfo(id)`,
//   where "does not exist" is `notFound` by the error tables (`./errors.js`).
//   A `notFound` on the preferred backend is tried once on the other, as the
//   policy does for every first page.
// - Videos. Local: the channel's videos tab, after `applyFilter` for a sort
//   other than newest, continued with `getContinuation()` on the tab instance
//   the cursor holds. An artist topic channel has no videos tab; its uploads
//   playlist stands in. Invidious: `getInvidiousChannelVideos(id, sort,
//   continuation)`, whose token needs the sort repeated on every page, so the
//   cursor carries both.
// - The Local `YT.Channel` instances `getChannel` fetched are kept in a small
//   cache per reader, so per layer instance (a settings change builds a new
//   layer, which starts empty). The first page of a Local list takes the
//   instance from it, and a miss fetches the channel again: without it the
//   list would cost a second `/browse` for what `getChannel` already had.
//
// Channel tags are recorded by the modules themselves (`rememberChannelTags`
// in `getLocalChannel` and `invidiousGetChannelInfo`), so nothing here does.

import { PlatformError } from '../errors'
import { classifyYouTubeError } from './errors'

/** The sorts, in the order of YouTube's filter chips on a channel tab (Latest, Popular, Oldest) */
export const CHANNEL_VIDEO_SORTS = Object.freeze(['newest', 'popular', 'oldest'])

/** How many `YT.Channel` instances the Local cache keeps: a few channels back is all a viewer goes */
export const CHANNEL_CACHE_SIZE = 5

/**
 * The content tabs a channel may have, by the old view's names and in its
 * order, with the `YT.Channel` flag that says Local has each. Home and About
 * are not here: the layer has no home operation, and the about tab is the
 * details themselves.
 */
const TABS = Object.freeze([
  ['videos', 'has_videos'],
  ['shorts', 'has_shorts'],
  ['live', 'has_live_streams'],
  ['releases', 'has_releases'],
  ['podcasts', 'has_podcasts'],
  ['courses', 'has_courses'],
  ['playlists', 'has_playlists'],
  ['community', 'has_community'],
])

/**
 * Where each list of a channel's videos comes from on each backend: the
 * Local tab and its parser, the uploads playlist type standing in for it on
 * an artist topic channel (`getChannelPlaylistId`), and the Invidious module
 * function. Videos only for now; the shorts and live lists are rows of their
 * own.
 */
const LISTS = Object.freeze({
  videos: Object.freeze({
    openTab: channel => channel.getVideos(),
    localParser: 'parseLocalChannelVideos',
    playlistType: 'videos',
    invidious: 'getInvidiousChannelVideos',
  }),
})

/**
 * A least recently used map of a few entries.
 *
 * @param {number} size
 */
function createLruCache(size) {
  /** @type {Map<string, any>} */
  const entries = new Map()

  return {
    /** @param {string} key */
    get(key) {
      if (!entries.has(key)) {
        return undefined
      }

      const value = entries.get(key)
      entries.delete(key)
      entries.set(key, value)
      return value
    },
    /**
     * @param {string} key
     * @param {any} value
     */
    set(key, value) {
      entries.delete(key)
      entries.set(key, value)

      if (entries.size > size) {
        entries.delete(entries.keys().next().value)
      }
    },
  }
}

/**
 * @param {unknown} url
 * @returns {string} `https:` for a protocol-relative URL, `''` for none
 */
function httpsUrl(url) {
  if (typeof url !== 'string' || url === '') {
    return ''
  }

  return url.startsWith('//') ? `https:${url}` : url
}

/** @param {string} id */
function channelUrl(id) {
  return `https://www.youtube.com/channel/${id}`
}

/**
 * The `@handle` a vanity URL ends in, `null` for a channel without one (whose
 * vanity URL is its `/channel/` URL).
 *
 * @param {unknown} vanityUrl
 */
function handleOf(vanityUrl) {
  const match = typeof vanityUrl === 'string' ? /\/(@[^/?#]+)$/.exec(vanityUrl) : null
  return match ? decodeURIComponent(match[1]) : null
}

/**
 * A list item as the card reads it: the card builds a YouTube thumbnail from
 * the id, so the common shape's `thumbnail` is `''`.
 *
 * @param {object} item
 */
function forCard(item) {
  return { ...item, thumbnail: '' }
}

/**
 * @param {object} deps
 * @param {import('./deps').YouTubeDeps} deps.youtube
 * @param {Readonly<import('../index').PlatformConfig>} deps.config
 * @param {ReturnType<typeof import('./policy').createBackendPolicy>} deps.policy
 */
export function createYouTubeChannelReader({ youtube, config, policy }) {
  /** @type {ReturnType<typeof createLruCache>} the `YT.Channel` instances, by the channel ref */
  const localChannels = createLruCache(CHANNEL_CACHE_SIZE)

  // -------------------------------------------------------------------------
  // Local
  // -------------------------------------------------------------------------

  /**
   * The channel, fetched, and kept in the cache.
   *
   * @param {string} id
   */
  async function fetchLocalChannel(id) {
    const channel = await youtube.getLocalChannel(id)

    if (channel?.alert) {
      throw new PlatformError('notFound', `YouTube (Local): ${channel.alert}`)
    }

    // The old view's age gate: YouTube shows the name and avatar only
    if (channel?.memo?.has?.('ChannelAgeGate')) {
      throw new PlatformError('refused', 'This channel is age restricted', { reason: 'ageRestricted' })
    }

    localChannels.set(id, channel)
    return channel
  }

  /** @param {any} channel */
  function localName(channel) {
    return youtube.parseLocalChannelHeader(channel, true).name ?? channel.metadata?.title ?? ''
  }

  /**
   * An artist's auto-generated topic channel, which has no videos tab.
   *
   * @param {any} channel
   * @param {string} name
   */
  function isArtistTopic(channel, name) {
    return name.endsWith('- Topic') && !!channel.metadata?.music_artist_name
  }

  /** @param {any} channel */
  async function localDescription(channel) {
    if (!channel.has_about) {
      return ''
    }

    const about = await channel.getAbout()

    if (about?.type === 'ChannelAboutFullMetadata') {
      return about.description?.text ?? ''
    }

    return about?.metadata?.description ?? ''
  }

  /**
   * @param {string} id
   * @returns {Promise<import('../shapes').ChannelDetails>}
   */
  async function localDetails(id) {
    const channel = await fetchLocalChannel(id)
    const header = youtube.parseLocalChannelHeader(channel)
    const channelId = header.id ?? channel.metadata?.external_id ?? id
    const name = header.name ?? channel.metadata?.title ?? ''
    const thumbnail = httpsUrl(header.thumbnailUrl)
    const subscriberCount = header.subscriberText ? youtube.parseLocalSubscriberCount(header.subscriberText) : null
    const isArtistTopicChannel = isArtistTopic(channel, name)

    return {
      id: channelId,
      name,
      thumbnail,
      handle: handleOf(channel.metadata?.vanity_channel_url),
      subscriberCount: Number.isFinite(subscriberCount) ? subscriberCount : null,
      url: channelUrl(channelId),
      // The header has one avatar, which is the large one too
      avatarLarge: thumbnail,
      banner: httpsUrl(header.bannerUrl) || null,
      description: await localDescription(channel),
      descriptionKind: 'plain',
      // The topic channel's uploads and albums are lists of their own
      tabs: TABS
        .filter(([tab, flag]) => channel[flag] || (isArtistTopicChannel && (tab === 'videos' || tab === 'releases')))
        .map(([tab]) => tab),
      tags: [...new Set([...(header.tags ?? []), ...(channel.metadata?.tags ?? [])])],
      isFamilyFriendly: channel.metadata?.is_family_safe === true,
      isArtistTopicChannel,
    }
  }

  /**
   * @param {any} tab a `YT.Channel` tab or its continuation
   * @param {string} id
   * @param {string} channelName the author of items the page leaves unnamed
   * @param {keyof typeof LISTS} kind
   */
  function localTabPage(tab, id, channelName, kind) {
    return {
      items: youtube[LISTS[kind].localParser](tab.videos ?? [], id, channelName).map(forCard),
      cursor: tab.has_continuation ? { backend: 'local', continuation: tab, from: 'tab', channelName } : null,
    }
  }

  /**
   * @param {any} playlist a `YT.Playlist`, the first or a continuation
   * @param {keyof typeof LISTS} kind
   */
  function localPlaylistPage(playlist, kind) {
    return {
      items: youtube.parseLocalPlaylistVideos(playlist.items ?? []).map(forCard),
      cursor: playlist.has_continuation ? { backend: 'local', continuation: playlist, from: 'playlist' } : null,
    }
  }

  /**
   * An artist topic channel's uploads playlist, as the old view lists it.
   * YouTube keeps uploads playlists newest or popular first only.
   *
   * @param {string} id
   * @param {string} sort
   * @param {keyof typeof LISTS} kind
   */
  async function firstLocalPlaylistPage(id, sort, kind) {
    if (sort === 'oldest') {
      throw new PlatformError('invalid', 'An artist topic channel lists its videos newest or popular first only')
    }

    let playlist

    try {
      playlist = await youtube.getLocalPlaylist(youtube.getChannelPlaylistId(id, LISTS[kind].playlistType, sort))
    } catch (error) {
      // A topic channel with no videos has no uploads playlist either
      if (error instanceof Error && error.message === 'The playlist does not exist.') {
        return { items: [], cursor: null }
      }

      throw error
    }

    return localPlaylistPage(playlist, kind)
  }

  /**
   * @param {string} id
   * @param {string} sort
   * @param {keyof typeof LISTS} kind
   */
  async function firstLocalPage(id, sort, kind) {
    const channel = localChannels.get(id) ?? await fetchLocalChannel(id)
    const channelName = localName(channel)

    if (isArtistTopic(channel, channelName)) {
      return firstLocalPlaylistPage(id, sort, kind)
    }

    let tab = await LISTS[kind].openTab(channel)

    // A channel offering no such sort lists newest first, as the old view
    // does when it hides the sort for want of filters
    const filter = sort === 'newest' ? undefined : tab.filters?.[CHANNEL_VIDEO_SORTS.indexOf(sort)]

    if (filter) {
      tab = await tab.applyFilter(filter)
    }

    return localTabPage(tab, id, channelName, kind)
  }

  /**
   * @param {string} id
   * @param {any} cursor
   * @param {keyof typeof LISTS} kind
   */
  async function laterLocalPage(id, cursor, kind) {
    const { continuation, from } = cursor

    if (typeof continuation?.getContinuation !== 'function') {
      throw new PlatformError('invalid', 'Not a YouTube channel list cursor')
    }

    if (from === 'playlist') {
      // `null` when YouTube answers an empty continuation, which is the end
      const next = await youtube.getLocalPlaylistContinuation(continuation)
      return next ? localPlaylistPage(next, kind) : { items: [], cursor: null }
    }

    return localTabPage(await continuation.getContinuation(), id, cursor.channelName ?? '', kind)
  }

  // -------------------------------------------------------------------------
  // Invidious
  // -------------------------------------------------------------------------

  /**
   * An image shown on the page, moved onto the current instance as the old
   * view does, so that it is not fetched from Google.
   *
   * @param {unknown} url
   */
  function onInstance(url) {
    const absolute = httpsUrl(url)
    return absolute ? youtube.youtubeImageUrlToInvidious(absolute, config.currentInvidiousInstanceUrl || null) : ''
  }

  /**
   * @param {string} id
   * @returns {Promise<import('../shapes').ChannelDetails>}
   */
  async function invidiousDetails(id) {
    const channel = await youtube.invidiousGetChannelInfo(id)
    const thumbnails = Array.isArray(channel?.authorThumbnails) ? channel.authorThumbnails : []
    const banner = Array.isArray(channel?.authorBanners) ? channel.authorBanners[0]?.url : undefined
    const channelId = channel?.authorId || id
    const tabs = Array.isArray(channel?.tabs) ? channel.tabs : []

    return {
      id: channelId,
      name: channel?.author ?? '',
      // As stored in a subscription; `describe` moves it onto the instance when shown
      thumbnail: httpsUrl((thumbnails[3] ?? thumbnails.at(-1))?.url),
      handle: null,
      subscriberCount: typeof channel?.subCount === 'number' ? channel.subCount : null,
      url: channelUrl(channelId),
      avatarLarge: onInstance(thumbnails.at(-1)?.url),
      banner: banner ? onInstance(banner) : null,
      description: channel?.description ?? '',
      descriptionKind: 'plain',
      tabs: TABS.map(([tab]) => tab).filter(tab => tabs.includes(tab)),
      tags: Array.isArray(channel?.tags) ? [...new Set(channel.tags)] : [],
      isFamilyFriendly: channel?.isFamilyFriendly === true,
    }
  }

  /**
   * A page from Invidious, the first when `continuation` is `null`.
   *
   * @param {string} id
   * @param {string} sort
   * @param {string | null} continuation
   * @param {keyof typeof LISTS} kind
   */
  async function invidiousPage(id, sort, continuation, kind) {
    const answer = await youtube[LISTS[kind].invidious](id, sort, continuation)

    return {
      items: (Array.isArray(answer?.videos) ? answer.videos : []).map(forCard),
      cursor: answer?.continuation ? { backend: 'invidious', continuation: answer.continuation, sort } : null,
    }
  }

  // -------------------------------------------------------------------------
  // The reader
  // -------------------------------------------------------------------------

  /**
   * @param {string} id a YouTube channel ref (a `UC` id)
   * @returns {Promise<import('../shapes').ChannelDetails>}
   */
  function getChannel(id) {
    return policy.first(backend => backend === 'local' ? localDetails(id) : invidiousDetails(id), classifyYouTubeError)
  }

  /**
   * A page of the channel's videos. A later page goes to the backend its
   * cursor names, in the sort the first was asked in.
   *
   * @param {string} id a YouTube channel ref
   * @param {{ sort?: string, cursor?: unknown }} [options]
   * @returns {Promise<import('../shapes').Page<import('./types').YouTubeVideoSummary>>}
   */
  async function listChannelVideos(id, { sort = 'newest', cursor = null } = {}) {
    // The one list yet; see `LISTS`
    const kind = 'videos'

    if (cursor != null) {
      return policy.later(cursor, (backend, laterCursor) => {
        if (backend === 'local') {
          return laterLocalPage(id, laterCursor, kind)
        }

        if (typeof laterCursor.continuation !== 'string' || laterCursor.continuation === '') {
          throw new PlatformError('invalid', 'Not a YouTube channel list cursor')
        }

        return invidiousPage(id, laterCursor.sort, laterCursor.continuation, kind)
      }, classifyYouTubeError)
    }

    if (!CHANNEL_VIDEO_SORTS.includes(sort)) {
      throw new PlatformError('invalid', `Not a sort of a channel's videos: ${sort}`)
    }

    return policy.first(
      backend => backend === 'local' ? firstLocalPage(id, sort, kind) : invidiousPage(id, sort, null, kind),
      classifyYouTubeError
    )
  }

  async function listChannelPlaylists() {
    throw new PlatformError('invalid', 'YouTube channel playlists are not on the layer yet')
  }

  return Object.freeze({ getChannel, listChannelVideos, listChannelPlaylists })
}
