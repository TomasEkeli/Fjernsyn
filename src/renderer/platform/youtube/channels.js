// A YouTube channel, fetched: its details, videos (with its shorts and live
// tabs) and playlists in the common shapes (`../shapes.js`), from Local or
// Invidious through the backend policy (`./policy.js`). The mapping is the channel section and the cursor table of
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
// - Shorts and live are a `kind` of video list, the same machinery on other
//   tabs (`getShorts()`, `getLiveStreams()`; `getInvidiousChannelShorts`,
//   `getInvidiousChannelLive`). Playlists are the channel's own ("Created
//   playlists"), newest first, the old view's default, or by the last video
//   added, from `getPlaylists()` (then `applySort`) and
//   `getInvidiousChannelPlaylists`. Releases, podcasts and courses are a
//   `kind` of playlist list, in the one order YouTube gives them, from
//   `getReleases()`, `getPodcasts()` and `getCourses()`, and
//   `getInvidiousChannelReleases`, `…Podcasts` and `…Courses`; an artist
//   topic channel's releases are its albums and singles, which Local reads
//   off the channel page (`getLocalArtistTopicChannelReleases`), as the old
//   view does. Posts (YouTube's community tab, `listChannelPosts`) are a list
//   in one order too, from `getCommunity()` read by
//   `parseLocalCommunityPosts`, and `invidiousGetCommunityPosts`; YouTube
//   sends some posts tabs as pages holding only a continuation, which are
//   followed on every page, as the old view does. Each list's backend calls
//   and item shapes are a row of `LISTS`; a cursor names its list, so a later
//   page never needs the caller to repeat it.
// - A page of a sorted list says which sort it is in (`Page.sort`), so that
//   the view can tell when the sort asked was not applied: Local's first page
//   of a tab without that filter (for playlists: without the sort, or of one
//   playlist) answers `newest`, and an uploads playlist the sort asked;
//   Invidious every page the sort asked, which it always applies. A later
//   Local page, an empty page for a missing tab, and every page of an
//   unsorted list (releases, podcasts, courses, posts) say none.
// - A channel without a tab answers an empty page, without opening it: Local
//   reads the channel's `has_*` flags; Invidious, which reports no such
//   thing per tab, the channel's `tabs` when `getChannel` read them on this
//   layer, and otherwise asks the tab and answers what it has.
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

/** The kinds of video list `listChannelVideos` takes, YouTube's tabs */
export const CHANNEL_VIDEO_KINDS = Object.freeze(['videos', 'shorts', 'live'])

/** The kinds of playlist list `listChannelPlaylists` takes: the channel's own, and YouTube's tabs of others */
export const CHANNEL_PLAYLIST_KINDS = Object.freeze(['playlists', 'releases', 'podcasts', 'courses'])

/** The sorts of the channel's own playlists, in the order of YouTube's sort menu (date added, last video added) */
export const CHANNEL_PLAYLIST_SORTS = Object.freeze(['newest', 'last'])

/** The list `listChannelPosts` reads, by the old view's name for the tab */
const CHANNEL_POST_KINDS = Object.freeze(['community'])

/**
 * How many empty pages a page is followed past. YouTube sends some live and
 * posts tabs as a run of pages holding only a continuation (the old view's
 * workaround, for https://www.youtube.com/@TWLIVES/streams and
 * https://www.youtube.com/@TheLinuxEXP/community); a few more requests find
 * the next items, and past that the empty page is answered with its cursor.
 * The old view follows without a bound.
 */
const EMPTY_PAGES_FOLLOWED = 3

/** @param {string} id */
function playlistUrl(id) {
  return `https://www.youtube.com/playlist?list=${id}`
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
 * A short as the card reads it. Neither backend's shorts tab gives a
 * duration: Local answers `''`, Invidious may answer 0. `''` is "unknown, not
 * live" to the card, where 0 would show as a length and absent as a live.
 *
 * @param {any} item
 */
function asShort(item) {
  return { ...forCard(item), type: 'shortVideo', lengthSeconds: item.lengthSeconds || '' }
}

/**
 * A post as the module parsed it, which is the common shape already (the
 * post component's field names), with `null` for no attachment where a
 * module leaves one it does not know `undefined`.
 *
 * @param {any} post
 * @returns {import('../shapes').Post}
 */
function asPost(post) {
  return { ...post, postContent: post.postContent ?? null }
}

/**
 * `parseLocalListPlaylist`'s answer, completed to the common shape. Its
 * `channelId` is the channel page's, or the item's own author's; an item
 * naming no channel (an auto-generated album, a station) has none, `null`.
 *
 * @param {any} playlist
 * @returns {import('./types').YouTubePlaylistSummary}
 */
function localPlaylist(playlist) {
  return {
    ...playlist,
    type: 'playlist',
    dataSource: 'local',
    url: playlistUrl(playlist.playlistId),
    description: '',
    channelName: playlist.channelName ?? '',
    channelId: playlist.channelId || null,
  }
}

/**
 * An `InvidiousPlaylistObject` renamed into the card's Local field names. Its
 * thumbnail moves onto the instance in a smaller size, as the card does for
 * an Invidious playlist; `authorId` is empty for an auto-generated album.
 *
 * @param {any} playlist
 * @param {Readonly<import('../index').PlatformConfig>} config
 * @returns {import('./types').YouTubePlaylistSummary}
 */
function invidiousPlaylist(playlist, config) {
  const thumbnail = typeof playlist.playlistThumbnail === 'string' ? playlist.playlistThumbnail : ''

  return {
    type: 'playlist',
    dataSource: 'local',
    playlistId: playlist.playlistId,
    title: playlist.title ?? '',
    thumbnail: thumbnail
      .replace('https://i.ytimg.com', config.currentInvidiousInstanceUrl || 'https://i.ytimg.com')
      .replace('hqdefault', 'mqdefault'),
    videoCount: typeof playlist.videoCount === 'number' ? playlist.videoCount : null,
    url: playlistUrl(playlist.playlistId),
    description: '',
    channelName: playlist.author ?? '',
    channelId: playlist.authorId || null,
  }
}

/**
 * The `YT.Channel` playlists tab, narrowed to the channel's own playlists
 * where YouTube offers other categories too (the old view's choice: the
 * "Created playlists" view, `view=1`, holds all of them).
 *
 * @param {any} channel
 */
async function openCreatedPlaylists(channel) {
  const tab = await channel.getPlaylists()

  if (!(tab.content_type_filters?.length > 1)) {
    return tab
  }

  const created = tab.current_tab?.content?.sub_menu?.content_type_sub_menu_items?.find(item => {
    const url = item.endpoint?.metadata?.url
    return typeof url === 'string' && new URL(url, 'https://www.youtube.com').searchParams.get('view') === '1'
  })

  return created ? tab.applyContentTypeFilter(created.title) : tab
}

/**
 * A video tab in a sort other than newest, through YouTube's filter chip for
 * it; `null` where the tab has no such chip, which lists newest first.
 *
 * @param {any} tab
 * @param {string} sort
 */
async function sortByChip(tab, sort) {
  const filter = sort === 'newest' ? undefined : tab.filters?.[CHANNEL_VIDEO_SORTS.indexOf(sort)]
  return filter ? tab.applyFilter(filter) : null
}

/**
 * The playlists tab by the last video added, through its sort menu; `null`
 * where it lists newest first: newest asked, no sort menu, or (the old
 * view's rule, since YouTube offers the menu there too) one playlist or none.
 *
 * @param {any} tab
 * @param {string} sort
 */
async function sortPlaylists(tab, sort) {
  const filters = Array.isArray(tab.sort_filters) ? tab.sort_filters : []
  const filter = sort === 'newest' ? undefined : filters[CHANNEL_PLAYLIST_SORTS.indexOf(sort)]

  if (!filter || filters.length < 2 || !((tab.playlists?.length ?? 0) > 1)) {
    return null
  }

  return tab.applySort(filter)
}

/**
 * The Local parse of a tab of playlists, attributed to the channel where an
 * item names none.
 *
 * @param {import('./deps').YouTubeDeps} youtube
 * @param {any[]} nodes
 * @param {{ id: string, name: string } | null} owner
 */
function parseLocalPlaylists(youtube, nodes, owner) {
  return nodes.map(node => youtube.parseLocalListPlaylist(node, owner?.id, owner?.name))
}

/**
 * Where each list of a channel comes from on each backend, and its items' shape:
 *
 * - `flag`: the `YT.Channel` flag saying Local has the tab; `tab`: the
 *   name in Invidious' `tabs` (as the module maps them).
 * - `sorts`: the sorts the list takes, the first its default; `null` for a
 *   list in one order, whose pages say no sort. `sortTab`: the Local tab in
 *   the sort asked, `null` where it stays newest first.
 * - `openTab`, `localItems`, `parseLocal`: the Local tab, the nodes on one
 *   of its pages, and the parser call.
 * - `othersContent`: a channel that shows other channels' items (an artist
 *   topic channel, a topic header) leaves them unattributed, as the old view
 *   does for shorts, rather than naming the channel page as their author.
 * - `followEmpty`: follow a first page that came back empty (see
 *   `EMPTY_PAGES_FOLLOWED`); `followEmptyLater`: a later one too.
 * - `topicPlaylist`: the uploads playlist type standing in for the tab on an
 *   artist topic channel (`getChannelPlaylistId`), which has no videos tab.
 *   `topicReleases`: on an artist topic channel the list is the albums and
 *   singles of its page (`getLocalArtistTopicChannelReleases`).
 * - `invidious`, `invidiousItems`: the Invidious module function and where
 *   its answer keeps the items. A sorted list's function takes `(id, sort,
 *   continuation)`, an unsorted one's `(id, continuation)`.
 * - `localItem`, `invidiousItem`: one item, in the common shape.
 */
const LISTS = Object.freeze({
  videos: Object.freeze({
    flag: 'has_videos',
    tab: 'videos',
    sorts: CHANNEL_VIDEO_SORTS,
    sortTab: sortByChip,
    openTab: channel => channel.getVideos(),
    localItems: page => page.videos,
    parseLocal: (youtube, nodes, owner) => youtube.parseLocalChannelVideos(nodes, owner?.id, owner?.name),
    topicPlaylist: 'videos',
    invidious: 'getInvidiousChannelVideos',
    invidiousItems: 'videos',
    localItem: forCard,
    invidiousItem: forCard,
  }),
  shorts: Object.freeze({
    flag: 'has_shorts',
    tab: 'shorts',
    sorts: CHANNEL_VIDEO_SORTS,
    sortTab: sortByChip,
    openTab: channel => channel.getShorts(),
    localItems: page => page.videos,
    parseLocal: (youtube, nodes, owner) => youtube.parseLocalChannelShorts(nodes, owner?.id, owner?.name),
    othersContent: true,
    invidious: 'getInvidiousChannelShorts',
    invidiousItems: 'videos',
    localItem: asShort,
    invidiousItem: asShort,
  }),
  live: Object.freeze({
    flag: 'has_live_streams',
    tab: 'live',
    sorts: CHANNEL_VIDEO_SORTS,
    sortTab: sortByChip,
    openTab: channel => channel.getLiveStreams(),
    localItems: page => page.videos,
    parseLocal: (youtube, nodes, owner) => youtube.parseLocalChannelVideos(nodes, owner?.id, owner?.name),
    followEmpty: true,
    invidious: 'getInvidiousChannelLive',
    invidiousItems: 'videos',
    localItem: forCard,
    invidiousItem: forCard,
  }),
  playlists: Object.freeze({
    flag: 'has_playlists',
    tab: 'playlists',
    sorts: CHANNEL_PLAYLIST_SORTS,
    sortTab: sortPlaylists,
    openTab: openCreatedPlaylists,
    localItems: page => page.playlists,
    parseLocal: parseLocalPlaylists,
    invidious: 'getInvidiousChannelPlaylists',
    invidiousItems: 'playlists',
    localItem: localPlaylist,
    invidiousItem: invidiousPlaylist,
  }),
  releases: Object.freeze({
    flag: 'has_releases',
    tab: 'releases',
    sorts: null,
    openTab: channel => channel.getReleases(),
    localItems: page => page.playlists,
    parseLocal: parseLocalPlaylists,
    topicReleases: true,
    invidious: 'getInvidiousChannelReleases',
    invidiousItems: 'playlists',
    localItem: localPlaylist,
    invidiousItem: invidiousPlaylist,
  }),
  podcasts: Object.freeze({
    flag: 'has_podcasts',
    tab: 'podcasts',
    sorts: null,
    openTab: channel => channel.getPodcasts(),
    localItems: page => page.playlists,
    parseLocal: parseLocalPlaylists,
    invidious: 'getInvidiousChannelPodcasts',
    invidiousItems: 'playlists',
    localItem: localPlaylist,
    invidiousItem: invidiousPlaylist,
  }),
  courses: Object.freeze({
    flag: 'has_courses',
    tab: 'courses',
    sorts: null,
    openTab: channel => channel.getCourses(),
    localItems: page => page.playlists,
    parseLocal: parseLocalPlaylists,
    invidious: 'getInvidiousChannelCourses',
    invidiousItems: 'playlists',
    localItem: localPlaylist,
    invidiousItem: invidiousPlaylist,
  }),
  community: Object.freeze({
    flag: 'has_community',
    tab: 'community',
    sorts: null,
    openTab: channel => channel.getCommunity(),
    localItems: page => page.posts,
    // The module's parser reads a whole page at once: it drops the posts a
    // shared post repeats, which it does not show
    parseLocal: (youtube, nodes) => youtube.parseLocalCommunityPosts(nodes),
    followEmpty: true,
    followEmptyLater: true,
    invidious: 'invidiousGetCommunityPosts',
    invidiousItems: 'posts',
    localItem: asPost,
    invidiousItem: asPost,
  }),
})

/** @typedef {keyof typeof LISTS} ListKind */

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
 * @param {object} deps
 * @param {import('./deps').YouTubeDeps} deps.youtube
 * @param {Readonly<import('../index').PlatformConfig>} deps.config
 * @param {ReturnType<typeof import('./policy').createBackendPolicy>} deps.policy
 */
export function createYouTubeChannelReader({ youtube, config, policy }) {
  /** @type {ReturnType<typeof createLruCache>} the `YT.Channel` instances, by the channel ref */
  const localChannels = createLruCache(CHANNEL_CACHE_SIZE)
  /** @type {ReturnType<typeof createLruCache>} the tabs Invidious said a channel has, by the channel ref */
  const invidiousTabs = createLruCache(CHANNEL_CACHE_SIZE)

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

    // The old view's age gate: YouTube shows the name and avatar only, which
    // the refusal carries for the page to show
    if (channel?.memo?.has?.('ChannelAgeGate')) {
      const ageGate = channel.memo.get('ChannelAgeGate')?.[0]

      throw new PlatformError('refused', 'This channel is age restricted', {
        reason: 'ageRestricted',
        channel: {
          id,
          name: typeof ageGate?.channel_title === 'string' ? ageGate.channel_title : '',
          thumbnail: httpsUrl(ageGate?.avatar?.[0]?.url),
        },
      })
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
   * Whose items a channel's lists hold: the channel's own, named after it
   * where the page leaves them unnamed, unless the channel shows other
   * channels' items too (`othersContent`).
   *
   * @param {any} channel
   * @param {string} id
   * @param {ListKind} kind
   * @returns {{ id: string, name: string } | null}
   */
  function ownerOf(channel, id, kind) {
    const name = localName(channel)
    const header = channel.header
    const showsOthers = isArtistTopic(channel, name) ||
      header?.type === 'CarouselHeader' ||
      header?.type === 'InteractiveTabbedHeader' ||
      (header?.type === 'PageHeader' && !!header.content?.animated_image)

    return LISTS[kind].othersContent && showsOthers ? null : { id, name }
  }

  /**
   * The tab page, or the first after it with items, following at most
   * `EMPTY_PAGES_FOLLOWED` pages that hold only a continuation.
   *
   * @param {any} tab a `YT.Channel` tab or its continuation
   * @param {ListKind} kind
   */
  async function pastEmptyPages(tab, kind) {
    const list = LISTS[kind]

    for (let followed = 0; followed < EMPTY_PAGES_FOLLOWED; followed++) {
      if ((list.localItems(tab)?.length ?? 0) > 0 || !tab.has_continuation) {
        break
      }

      tab = await tab.getContinuation()
    }

    return tab
  }

  /**
   * @param {any} tab a `YT.Channel` tab or its continuation
   * @param {{ id: string, name: string } | null} owner
   * @param {ListKind} kind
   */
  function localTabPage(tab, owner, kind) {
    const list = LISTS[kind]

    return {
      items: list.parseLocal(youtube, list.localItems(tab) ?? [], owner).filter(item => item != null).map(list.localItem),
      cursor: tab.has_continuation ? { backend: 'local', continuation: tab, from: 'tab', kind, owner } : null,
    }
  }

  /**
   * @param {any} playlist a `YT.Playlist`, the first or a continuation
   * @param {ListKind} kind
   */
  function localPlaylistPage(playlist, kind) {
    return {
      items: youtube.parseLocalPlaylistVideos(playlist.items ?? []).map(LISTS[kind].localItem),
      cursor: playlist.has_continuation ? { backend: 'local', continuation: playlist, from: 'playlist', kind } : null,
    }
  }

  /**
   * An artist topic channel's uploads playlist, as the old view lists it.
   * YouTube keeps uploads playlists newest or popular first only.
   *
   * @param {string} id
   * @param {string} sort
   * @param {ListKind} kind
   */
  async function firstLocalPlaylistPage(id, sort, kind) {
    if (sort === 'oldest') {
      throw new PlatformError('invalid', 'An artist topic channel lists its videos newest or popular first only')
    }

    let playlist

    try {
      playlist = await youtube.getLocalPlaylist(youtube.getChannelPlaylistId(id, LISTS[kind].topicPlaylist, sort))
    } catch (error) {
      // A topic channel with no videos has no uploads playlist either
      if (error instanceof Error && error.message === 'The playlist does not exist.') {
        return { items: [], cursor: null }
      }

      throw error
    }

    return { ...localPlaylistPage(playlist, kind), sort }
  }

  /**
   * A page of an artist topic channel's releases, as the module reads them
   * off the channel page. The continuation is a node that only the channel's
   * session can call, so the cursor holds the channel too.
   *
   * @param {{ releases?: any[], continuationData?: any }} answer
   * @param {any} channel the `YT.Channel`
   * @param {ListKind} kind
   */
  function localTopicReleasesPage(answer, channel, kind) {
    const releases = Array.isArray(answer?.releases) ? answer.releases : []

    return {
      items: releases.filter(item => item != null).map(LISTS[kind].localItem),
      cursor: answer?.continuationData
        ? { backend: 'local', continuation: answer.continuationData, from: 'topicReleases', kind, channel }
        : null,
    }
  }

  /**
   * @param {string} id
   * @param {string} sort
   * @param {ListKind} kind
   */
  async function firstLocalPage(id, sort, kind) {
    const list = LISTS[kind]
    const channel = localChannels.get(id) ?? await fetchLocalChannel(id)

    if ((list.topicPlaylist || list.topicReleases) && isArtistTopic(channel, localName(channel))) {
      return list.topicPlaylist
        ? firstLocalPlaylistPage(id, sort, kind)
        : localTopicReleasesPage(await youtube.getLocalArtistTopicChannelReleases(channel), channel, kind)
    }

    if (!channel[list.flag]) {
      return { items: [], cursor: null }
    }

    let tab = await list.openTab(channel)

    // A tab offering no such sort lists newest first, as the old view does
    // when it hides the sort for want of filters, and the page says so
    const sorted = list.sortTab ? await list.sortTab(tab, sort) : null

    if (sorted) {
      tab = sorted
    }

    if (list.followEmpty) {
      tab = await pastEmptyPages(tab, kind)
    }

    const page = localTabPage(tab, ownerOf(channel, id, kind), kind)

    return list.sorts ? { ...page, sort: sorted ? sort : 'newest' } : page
  }

  /**
   * @param {any} cursor
   * @param {ListKind} kind
   */
  async function laterLocalPage(cursor, kind) {
    const { continuation, from } = cursor

    if (from === 'topicReleases') {
      if (continuation == null || typeof continuation !== 'object' || cursor.channel == null) {
        throw new PlatformError('invalid', 'Not a YouTube channel list cursor')
      }

      return localTopicReleasesPage(
        await youtube.getLocalArtistTopicChannelReleasesContinuation(cursor.channel, continuation),
        cursor.channel,
        kind
      )
    }

    if (typeof continuation?.getContinuation !== 'function') {
      throw new PlatformError('invalid', 'Not a YouTube channel list cursor')
    }

    if (from === 'playlist') {
      // `null` when YouTube answers an empty continuation, which is the end
      const next = await youtube.getLocalPlaylistContinuation(continuation)
      return next ? localPlaylistPage(next, kind) : { items: [], cursor: null }
    }

    const next = await continuation.getContinuation()

    return localTabPage(LISTS[kind].followEmptyLater ? await pastEmptyPages(next, kind) : next, cursor.owner ?? null, kind)
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

    invidiousTabs.set(id, tabs)

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
   * A page from Invidious, the first when `continuation` is `null`. A first
   * page of a tab the channel is known not to have is empty, without a
   * request.
   *
   * @param {string} id
   * @param {string | null} sort `null` for a list in one order
   * @param {string | null} continuation
   * @param {ListKind} kind
   */
  async function invidiousPage(id, sort, continuation, kind) {
    const list = LISTS[kind]

    if (continuation === null && invidiousTabs.get(id)?.includes(list.tab) === false) {
      return { items: [], cursor: null }
    }

    const answer = list.sorts
      ? await youtube[list.invidious](id, sort, continuation)
      : await youtube[list.invidious](id, continuation)
    const items = Array.isArray(answer?.[list.invidiousItems]) ? answer[list.invidiousItems] : []
    const page = {
      items: items.map(item => list.invidiousItem(item, config)),
      cursor: answer?.continuation ? { backend: 'invidious', continuation: answer.continuation, sort, kind } : null,
    }

    // Invidious applies the sort it is asked, on every page
    return list.sorts ? { ...page, sort } : page
  }

  /**
   * A page of one of the channel's lists: the first from the backend the
   * policy picks, a later one from the backend and of the list its cursor
   * names, in the sort the first was asked in.
   *
   * @param {string} id
   * @param {ListKind} kind
   * @param {string} sort
   * @param {unknown} cursor
   * @param {readonly string[]} kinds the lists the operation lists, which a cursor must be of
   */
  function listPage(id, kind, sort, cursor, kinds) {
    if (cursor != null) {
      return policy.later(cursor, (backend, laterCursor) => {
        if (!kinds.includes(laterCursor.kind)) {
          throw new PlatformError('invalid', 'Not a cursor of this list')
        }

        if (backend === 'local') {
          return laterLocalPage(laterCursor, laterCursor.kind)
        }

        if (typeof laterCursor.continuation !== 'string' || laterCursor.continuation === '') {
          throw new PlatformError('invalid', 'Not a YouTube channel list cursor')
        }

        return invidiousPage(id, laterCursor.sort, laterCursor.continuation, laterCursor.kind)
      }, classifyYouTubeError)
    }

    const listSort = LISTS[kind].sorts ? sort : null

    return policy.first(
      backend => backend === 'local' ? firstLocalPage(id, sort, kind) : invidiousPage(id, listSort, null, kind),
      classifyYouTubeError
    )
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
   * A page of the channel's videos, shorts or live broadcasts. A channel
   * without the tab answers an empty page. A later page keeps the first's
   * kind and sort, whatever the options say.
   *
   * @param {string} id a YouTube channel ref
   * @param {{ kind?: string, sort?: string, cursor?: unknown }} [options]
   * @returns {Promise<import('../shapes').Page<import('./types').YouTubeVideoSummary>>}
   */
  async function listChannelVideos(id, { kind = 'videos', sort = 'newest', cursor = null } = {}) {
    if (cursor == null && !CHANNEL_VIDEO_KINDS.includes(kind)) {
      throw new PlatformError('invalid', `Not a kind of a channel's videos: ${kind}`)
    }

    if (cursor == null && !CHANNEL_VIDEO_SORTS.includes(sort)) {
      throw new PlatformError('invalid', `Not a sort of a channel's videos: ${sort}`)
    }

    return listPage(id, /** @type {ListKind} */ (kind), sort, cursor, CHANNEL_VIDEO_KINDS)
  }

  /**
   * A page of the channel's own playlists, newest first or by the last video
   * added, or of its releases, podcasts or courses, which have one order and
   * take no sort. A channel without the tab answers an empty page. A later
   * page keeps the first's kind and sort, whatever the options say.
   *
   * @param {string} id a YouTube channel ref
   * @param {{ kind?: string, sort?: string, cursor?: unknown }} [options]
   * @returns {Promise<import('../shapes').Page<import('./types').YouTubePlaylistSummary>>}
   */
  async function listChannelPlaylists(id, { kind = 'playlists', sort = 'newest', cursor = null } = {}) {
    if (cursor == null && !CHANNEL_PLAYLIST_KINDS.includes(kind)) {
      throw new PlatformError('invalid', `Not a kind of a channel's playlists: ${kind}`)
    }

    if (cursor == null && !(LISTS[kind].sorts ?? ['newest']).includes(sort)) {
      throw new PlatformError('invalid', `Not a sort of a channel's ${kind}: ${sort}`)
    }

    return listPage(id, /** @type {ListKind} */ (kind), sort, cursor, CHANNEL_PLAYLIST_KINDS)
  }

  /**
   * A page of the channel's posts, newest first, YouTube's one order. A
   * channel without the tab answers an empty page.
   *
   * @param {string} id a YouTube channel ref
   * @param {{ cursor?: unknown }} [options]
   * @returns {Promise<import('../shapes').Page<import('../shapes').Post>>}
   */
  async function listChannelPosts(id, { cursor = null } = {}) {
    return listPage(id, 'community', 'newest', cursor, CHANNEL_POST_KINDS)
  }

  return Object.freeze({ getChannel, listChannelVideos, listChannelPlaylists, listChannelPosts })
}
