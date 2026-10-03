import { describe, expect, it, vi } from 'vitest'

import { parseLocalChannelHeader, parseLocalChannelShorts, parseLocalSubscriberCount } from '../../helpers/api/local'
import { extractNumberFromString } from '../../helpers/utils'
import { createPlatformLayer } from '../index'
import { CHANNEL_CACHE_SIZE } from './channels'
import { createFakeYouTube, withMethods } from './testing/fakeYouTube'

import invidiousCourses from './fixtures/invidious--channel-courses.json'
import invidiousLive from './fixtures/invidious--channel-live.json'
import invidiousNoBanner from './fixtures/invidious--channel-no-banner.json'
import invidiousOrdinary from './fixtures/invidious--channel-ordinary.json'
import invidiousPlaylists from './fixtures/invidious--channel-playlists.json'
import invidiousPodcasts from './fixtures/invidious--channel-podcasts.json'
import invidiousPosts from './fixtures/invidious--channel-posts.json'
import invidiousReleases from './fixtures/invidious--channel-releases.json'
import invidiousSearch from './fixtures/invidious--channel-search.json'
import invidiousShorts from './fixtures/invidious--channel-shorts.json'
import localArtistTopicAbout from './fixtures/local--channel-artist-topic-about.json'
import localArtistTopicReleasesContinuation from './fixtures/local--channel-artist-topic-releases-continuation.json'
import localArtistTopicReleases from './fixtures/local--channel-artist-topic-releases.json'
import localArtistTopic from './fixtures/local--channel-artist-topic.json'
import localLocatedAbout from './fixtures/local--channel-located-about.json'
import localLocatedHome from './fixtures/local--channel-located-home.json'
import localLocated from './fixtures/local--channel-located.json'
import localNoBanner from './fixtures/local--channel-no-banner.json'
import localOrdinaryAbout from './fixtures/local--channel-ordinary-about.json'
import localOrdinaryHome from './fixtures/local--channel-ordinary-home.json'
import localOrdinary from './fixtures/local--channel-ordinary.json'
import localPostsPoll from './fixtures/local--channel-posts-poll.json'
import localPosts from './fixtures/local--channel-posts.json'
import localSearchContinuation from './fixtures/local--channel-search-continuation.json'
import localSearch from './fixtures/local--channel-search.json'
import localShortsPage from './fixtures/local--channel-shorts-page.json'
import localTerminated from './fixtures/local--channel-terminated.json'

const BLENDER = 'UCSMOQeBJ2RAnuFungnQOxLg'
const DAFT_PUNK_TOPIC = 'UCRr1xG_2WIDs18a6cIiCxeA'
const LTT = 'UCXuqSBlHAE6Xw-yeJA0Tunw'
const NO_BANNER = 'UCnobannernobannernoban0'
const GONE = 'UCterminatedterminatedte'
const INSTANCE = 'https://invidious.example'

/** YouTube's filter chips, by the layer's sort */
const CHIPS = { newest: 'Latest', popular: 'Popular', oldest: 'Oldest' }

/**
 * A synthesised videos tab two pages long, in the order of `chip`: each page
 * two videos named by the chip and the page.
 *
 * @param {string} chip
 * @param {number} [page]
 */
function videosTab(chip, page = 1) {
  return {
    filters: Object.values(CHIPS),
    videos: [{ id: `${chip}-${page}a` }, { id: `${chip}-${page}b` }],
    has_continuation: page < 2,
    applyFilter: async filter => videosTab(filter),
    getContinuation: async () => videosTab(chip, page + 1),
  }
}

/**
 * A synthesised channel tab of other lists: one page per entry of `pages`,
 * the nodes under `key` (`videos` or `playlists`).
 *
 * @param {string} key
 * @param {object[][]} pages
 * @param {object} [extra] more of the tab
 */
function pagedTab(key, pages, extra = {}, index = 0) {
  return {
    filters: Object.values(CHIPS),
    content_type_filters: [],
    [key]: structuredClone(pages[index]),
    has_continuation: index < pages.length - 1,
    applyFilter: async () => pagedTab(key, pages, extra),
    getContinuation: async () => pagedTab(key, pages, extra, index + 1),
    ...extra,
  }
}

const LOCAL_LIVE_PAGES = [
  // YouTube's run of pages holding only a continuation
  [],
  [{ id: 'liveliveliv', live: true }, { id: 'upcomingupc', upcoming: true }],
  [{ id: 'finishedfin' }],
]

const LOCAL_PLAYLIST_PAGES = [
  [{ id: 'PLown' }, { id: 'RDmix', mix: true }],
  [{ id: 'OLAKalbum', album: true }],
]

/** A releases, podcasts or courses tab: one of the channel's own, then one naming no channel */
function localKindPages(kind) {
  return [[{ id: `PL${kind}1` }], [{ id: `OLAK${kind}2`, album: true }]]
}

/**
 * YouTube's sort menu on the playlists tab (recorded 2026-10-02, Blender),
 * `applySort` answering the tab by the last video added
 */
const PLAYLIST_SORT_FILTERS = ['Date added (newest)', 'Last video added']

function sortablePlaylistsTab(pages = LOCAL_PLAYLIST_PAGES, sorted = [[{ id: 'PLlast' }, { id: 'PLown' }]]) {
  return pagedTab('playlists', pages, {
    sort_filters: PLAYLIST_SORT_FILTERS,
    applySort: async (filter) => {
      if (filter !== 'Last video added') {
        throw new Error(`not a sort the test knows: ${filter}`)
      }
      return pagedTab('playlists', sorted, { sort_filters: PLAYLIST_SORT_FILTERS })
    },
  })
}

/**
 * Blender's posts tab as the test pages it: the text post, a page holding
 * only a continuation, then the image and video posts. Each node is a marker
 * the fake parser answers the recorded parse for.
 */
const [LOCAL_TEXT_POST, LOCAL_IMAGE_POST, LOCAL_VIDEO_POST] = localPosts.answer
const LOCAL_POST_PAGES = [[LOCAL_TEXT_POST], [], [LOCAL_IMAGE_POST, LOCAL_VIDEO_POST]].map(page => page.map(post => ({ id: post.postId })))
const LOCAL_POSTS_BY_ID = Object.fromEntries([...localPosts.answer, ...localPostsPoll.answer].map(post => [post.postId, post]))

/**
 * What `channel.search(query)` answers, as recorded, and its continuation,
 * which the test makes the last page
 */
function localSearchResult() {
  return withMethods(localSearch, () => ({
    getContinuation: async () => withMethods(localSearchContinuation, answer => ({
      has_continuation: false,
      getContinuation: async () => { throw new Error(`asked past the end of ${answer.contents.contents.length} sections`) },
    })),
  }))
}

/** A `YT.Channel` from a fixture, with its about page and tabs */
function localChannel(fixture, about = null) {
  return withMethods(fixture, () => ({
    getAbout: async () => structuredClone(about?.answer),
    getVideos: async () => videosTab(CHIPS.newest),
    getShorts: async () => pagedTab('videos', localShortsPage.answer.map(node => [node])),
    getLiveStreams: async () => pagedTab('videos', LOCAL_LIVE_PAGES),
    getPlaylists: async () => pagedTab('playlists', LOCAL_PLAYLIST_PAGES),
    getReleases: async () => pagedTab('playlists', localKindPages('releases')),
    getPodcasts: async () => pagedTab('playlists', localKindPages('podcasts')),
    getCourses: async () => pagedTab('playlists', localKindPages('courses')),
    getCommunity: async () => pagedTab('posts', LOCAL_POST_PAGES),
    search: async () => localSearchResult(),
  }))
}

/**
 * An Invidious channel tab answering a fixture's items over two pages: all
 * but the last, then the last.
 *
 * @param {{ answer: any }} fixture
 * @param {string} key `videos` or `playlists`
 */
function invidiousTab(fixture, key) {
  return async (_id, _sort, continuation) => {
    const { [key]: items, continuation: next } = structuredClone(fixture.answer)
    return continuation ? { [key]: items.slice(-1), continuation: null } : { [key]: items.slice(0, -1), continuation: next }
  }
}

/** The same, for a tab whose module function takes no sort: `(id, continuation)` */
function invidiousUnsortedTab(fixture, key = 'playlists') {
  const tab = invidiousTab(fixture, key)
  return (id, continuation) => tab(id, undefined, continuation)
}

/**
 * A synthesised uploads `YT.Playlist`, two pages long. The adapter continues
 * it through `getLocalPlaylistContinuation`, not its own method.
 */
function uploadsPlaylist(id, page = 1) {
  return {
    id,
    items: [{ id: `${id}-${page}` }],
    has_continuation: page < 2,
    page,
    getContinuation: () => { throw new Error('not through the module') },
  }
}

/**
 * @param {object} [options]
 * @param {object} [options.config]
 * @param {Record<string, any>} [options.answers]
 */
function setUp({ config = {}, answers = {} } = {}) {
  const fake = createFakeYouTube({
    parseLocalChannelHeader,
    parseLocalSubscriberCount,
    parseLocalChannelShorts,
    extractNumberFromString,
    // The module's parse of the channel's home tab, as recorded
    parseChannelHomeTab: (channel) => {
      const home = { [BLENDER]: localOrdinaryHome, [LTT]: localLocatedHome }[channel.metadata?.external_id]
      if (!home) {
        throw new Error(`no home tab recorded for ${channel.metadata?.external_id}`)
      }
      return structuredClone(home.answer)
    },
    parseLocalChannelVideos: (videos, channelId, channelName) => videos.map(video => ({
      type: 'video',
      videoId: video.id,
      title: video.id,
      author: channelName,
      authorId: channelId,
      liveNow: !!video.live,
      isUpcoming: !!video.upcoming,
      lengthSeconds: video.live ? '' : 60,
    })),
    // As the module answers a lockup: a mix is left out, an album names no channel
    parseLocalListPlaylist: (node, channelId, channelName) => node.mix
      ? null
      : {
          type: 'playlist',
          dataSource: 'local',
          playlistId: node.id,
          title: node.id,
          thumbnail: `https://i.ytimg.com/vi/${node.id}/hqdefault.jpg`,
          videoCount: 3,
          ...(node.album ? {} : { channelName, channelId }),
        },
    parseLocalPlaylistVideos: items => items.map(item => ({ type: 'video', videoId: item.id, title: item.id })),
    getChannelPlaylistId: (id, type, sort) => id.replace(/^UC/, sort === 'popular' ? 'UULP' : 'UULF'),
    getLocalPlaylist: async id => uploadsPlaylist(id),
    getLocalPlaylistContinuation: async playlist => uploadsPlaylist(playlist.id, playlist.page + 1),
    youtubeImageUrlToInvidious: (url, instance) => url.replace(/^https:\/\/yt3\.(googleusercontent|ggpht)\.com/, `${instance}/ggpht`),
    getLocalChannel: async id => ({
      [BLENDER]: () => localChannel(localOrdinary, localOrdinaryAbout),
      [DAFT_PUNK_TOPIC]: () => localChannel(localArtistTopic, localArtistTopicAbout),
      [LTT]: () => localChannel(localLocated, localLocatedAbout),
      [NO_BANNER]: () => localChannel(localNoBanner),
      [GONE]: () => structuredClone(localTerminated.answer),
    })[id]?.() ?? localChannel(localOrdinary, localOrdinaryAbout),
    invidiousGetChannelInfo: async id => {
      if (id === GONE) {
        throw new Error('This channel does not exist.')
      }
      return structuredClone((id === NO_BANNER ? invidiousNoBanner : invidiousOrdinary).answer)
    },
    getInvidiousChannelVideos: async (id, sort, continuation) => {
      const page = continuation ? Number(continuation.split('-').at(-1)) : 1
      return {
        videos: [{ type: 'video', videoId: `${sort}-${page}`, author: 'Blender', authorId: id, videoThumbnails: [] }],
        continuation: page < 2 ? `token-${sort}-${page + 1}` : null,
      }
    },
    getInvidiousChannelShorts: invidiousTab(invidiousShorts, 'videos'),
    getInvidiousChannelLive: invidiousTab(invidiousLive, 'videos'),
    getInvidiousChannelPlaylists: invidiousTab(invidiousPlaylists, 'playlists'),
    getInvidiousChannelReleases: invidiousUnsortedTab(invidiousReleases),
    getInvidiousChannelPodcasts: invidiousUnsortedTab(invidiousPodcasts),
    getInvidiousChannelCourses: invidiousUnsortedTab(invidiousCourses),
    getLocalArtistTopicChannelReleases: async () => structuredClone(localArtistTopicReleases.answer),
    getLocalArtistTopicChannelReleasesContinuation: async () => structuredClone(localArtistTopicReleasesContinuation.answer),
    // The module's parse of each node, as recorded
    parseLocalCommunityPosts: nodes => nodes.map(node => structuredClone(LOCAL_POSTS_BY_ID[node.id])),
    invidiousGetCommunityPosts: invidiousUnsortedTab(invidiousPosts, 'posts'),
    ...answers,
  })
  const layer = createLayer(fake, config)

  return { fake, layer }
}

function createLayer(fake, config = {}) {
  return createPlatformLayer({
    fetch: () => Promise.reject(new TypeError('no network in tests')),
    youtube: fake.youtube,
    config: { backendPreference: 'local', backendFallback: false, currentInvidiousInstanceUrl: INSTANCE, ...config },
  })
}

/** Every page of a list, following the cursors to the end */
async function allPages(layer, ref, options = {}, operation = 'listChannelVideos') {
  const pages = [await layer[operation](ref, options)]

  while (pages.at(-1).cursor !== null && pages.length < 10) {
    pages.push(await layer[operation](ref, { cursor: pages.at(-1).cursor }))
  }

  return pages
}

/** @param {{ items: any[] }[]} pages */
function itemsOf(pages) {
  return pages.flatMap(page => page.items)
}

async function failure(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a failure')
}

describe('a YouTube channel\'s details', () => {
  it('reads a channel from Local, with its about page\'s description and details, and the channels its home tab features', async () => {
    const { layer } = setUp()

    expect(await layer.getChannel(BLENDER)).toEqual({
      id: BLENDER,
      name: 'Blender',
      thumbnail: expect.stringMatching(/^https:\/\/yt3\.googleusercontent\.com\/.+=s160-/),
      handle: '@BlenderOfficial',
      subscriberCount: 1250000,
      url: `https://www.youtube.com/channel/${BLENDER}`,
      avatarLarge: expect.stringMatching(/=s160-/),
      banner: expect.stringMatching(/^https:\/\/yt3\.googleusercontent\.com\/.+=w2560-/),
      description: localOrdinaryAbout.answer.metadata.description,
      descriptionKind: 'plain',
      tabs: ['videos', 'shorts', 'live', 'podcasts', 'playlists', 'community'],
      tags: localOrdinary.answer.metadata.tags,
      isFamilyFriendly: true,
      isArtistTopicChannel: false,
      hasSearch: true,
      // "Joined May 29, 2008", "133,470,200 views", "1,588 videos"; no country given
      joined: new Date(2008, 4, 29).getTime(),
      viewCount: 133470200,
      videoCount: 1588,
      featuredChannels: [
        {
          id: 'UCAsj9iReHzLEYv9QawGzIOg',
          name: 'Blender Developers',
          thumbnail: expect.stringMatching(/^https:\/\/yt3\.googleusercontent\.com\/.+=s176-/),
        },
        {
          id: 'UCz75RVbH8q2jdBJ4SnwuZZQ',
          name: 'Blender Studio',
          thumbnail: expect.stringMatching(/^https:\/\/yt3\.googleusercontent\.com\/.+=s176-/),
        },
      ],
    })
  })

  it('reads a Local channel\'s location from its about page, and every channel its home tab features, once each', async () => {
    const { layer, fake } = setUp({
      answers: {
        // The featured shelf repeated, as a home tab may show a channel twice
        parseChannelHomeTab: () => [...structuredClone(localLocatedHome.answer), structuredClone(localLocatedHome.answer.at(-1))],
      },
    })

    const channel = await layer.getChannel(LTT)

    expect(channel).toMatchObject({ location: 'Canada', joined: new Date(2008, 10, 25).getTime(), viewCount: 9873760676, videoCount: 7941 })
    expect(channel.featuredChannels).toHaveLength(12)
    expect(channel.featuredChannels[0]).toEqual({
      id: 'UCdBK94H6oZT2Q7l0-b0xmMg',
      name: 'ShortCircuit',
      thumbnail: expect.stringMatching(/^https:\/\/yt3\.googleusercontent\.com\//),
    })
    expect(fake.callsOf('getLocalChannel')).toEqual([[LTT]])
  })

  it('reads the older full about metadata on Local, which gives no video count', async () => {
    const { layer } = setUp({
      answers: {
        getLocalChannel: async () => localChannel(localOrdinary, {
          answer: {
            type: 'ChannelAboutFullMetadata',
            description: { text: 'Old about page' },
            view_count: { text: '1,234 views' },
            joined_date: { text: 'Joined Mar 3, 2010' },
            country: { text: 'Netherlands' },
          },
        }),
      },
    })

    const channel = await layer.getChannel(BLENDER)

    expect(channel).toMatchObject({ description: 'Old about page', viewCount: 1234, joined: new Date(2010, 2, 3).getTime(), location: 'Netherlands' })
    expect(channel).not.toHaveProperty('videoCount')
  })

  it('leaves out what a Local about page does not say, or says unreadably, rather than answering 0', async () => {
    const { layer } = setUp({
      answers: {
        getLocalChannel: async () => localChannel(localOrdinary, {
          // YouTube in another language, without counts or a country
          answer: { type: 'AboutChannel', metadata: { description: 'Hei', joined_date: { text: 'Ble med 29. mai 2008' }, country: '' } },
        }),
      },
    })

    const channel = await layer.getChannel(BLENDER)

    expect(channel.description).toBe('Hei')
    for (const field of ['joined', 'viewCount', 'videoCount', 'location']) {
      expect(channel).not.toHaveProperty(field)
    }
  })

  it('answers a Local channel whose home tab cannot be read without featured channels, and the rest as ever', async () => {
    const { layer } = setUp({ answers: { parseChannelHomeTab: () => { throw new TypeError('no shelves') } } })

    const channel = await layer.getChannel(BLENDER)

    expect(channel).not.toHaveProperty('featuredChannels')
    expect(channel).toMatchObject({ name: 'Blender', viewCount: 133470200 })
  })

  it('knows an artist topic channel on Local, which lists videos and releases it has no tabs for', async () => {
    const { layer } = setUp()

    expect(await layer.getChannel(DAFT_PUNK_TOPIC)).toMatchObject({
      id: DAFT_PUNK_TOPIC,
      name: 'Daft Punk - Topic',
      handle: null,
      subscriberCount: null,
      description: expect.stringMatching(/^Daft Punk were a French electronic music duo/),
      tabs: ['videos', 'releases'],
      isArtistTopicChannel: true,
    })
  })

  it('answers a Local channel without a banner or an about page with null and an empty description, asking no more', async () => {
    const { layer, fake } = setUp({
      answers: { getLocalChannel: async () => withMethods(localNoBanner, () => ({ getAbout: async () => { throw new Error('asked') } })) },
    })

    const channel = await layer.getChannel(NO_BANNER)

    expect(channel).toMatchObject({
      name: 'A small channel',
      thumbnail: 'https://yt3.ggpht.com/small-channel=s176-c-k-c0x00ffffff-no-rj',
      banner: null,
      description: '',
      subscriberCount: 1200,
      tabs: ['videos'],
      tags: [],
      isFamilyFriendly: false,
      hasSearch: false,
    })
    // No about page and no home tab: none of what they would say
    for (const field of ['joined', 'viewCount', 'videoCount', 'location', 'featuredChannels']) {
      expect(channel).not.toHaveProperty(field)
    }
    expect(fake.callsOf('parseChannelHomeTab')).toHaveLength(0)
    expect(fake.calls.filter(call => call.name.startsWith('invidious'))).toHaveLength(0)
  })

  it('reads a channel from Invidious, its page images and featured channels\' avatars moved onto the instance', async () => {
    const { layer } = setUp({ config: { backendPreference: 'invidious' } })

    expect(await layer.getChannel(BLENDER)).toEqual({
      id: BLENDER,
      name: 'Blender',
      thumbnail: 'https://yt3.googleusercontent.com/blender-avatar=s100-c-k-c0x00ffffff-no-rj',
      handle: null,
      subscriberCount: 1250000,
      url: `https://www.youtube.com/channel/${BLENDER}`,
      avatarLarge: `${INSTANCE}/ggpht/blender-avatar=s512-c-k-c0x00ffffff-no-rj`,
      banner: `${INSTANCE}/ggpht/blender-banner=w2560-fcrop64=1`,
      description: invidiousOrdinary.answer.description,
      descriptionKind: 'plain',
      tabs: ['videos', 'shorts', 'live', 'podcasts', 'playlists', 'community'],
      tags: ['blender', 'Blender Foundation', '3d'],
      isFamilyFriendly: true,
      hasSearch: true,
      // Invidious has no video count or location
      joined: Date.UTC(2008, 4, 29),
      viewCount: 133470200,
      featuredChannels: [
        { id: 'UCAsj9iReHzLEYv9QawGzIOg', name: 'Blender Developers', thumbnail: `${INSTANCE}/ggpht/blender-developers=s176-c-k-c0x00ffffff-no-rj` },
        { id: 'UCz75RVbH8q2jdBJ4SnwuZZQ', name: 'Blender Studio', thumbnail: `${INSTANCE}/ggpht/blender-studio=s176-c-k-c0x00ffffff-no-rj` },
      ],
    })
  })

  it('answers an Invidious channel without a banner with null, and leaves out the joined date and view count it answers 0 for', async () => {
    const { layer } = setUp({ config: { backendPreference: 'invidious' } })

    const channel = await layer.getChannel(NO_BANNER)

    expect(channel).toMatchObject({ banner: null, tabs: ['videos'], isFamilyFriendly: false, featuredChannels: [] })
    for (const field of ['joined', 'viewCount', 'videoCount', 'location']) {
      expect(channel).not.toHaveProperty(field)
    }
  })
})

describe('a YouTube channel\'s videos', () => {
  it.each(Object.entries(CHIPS))('pages Local to the end, %s first, with cursors naming Local', async (sort, chip) => {
    const { layer } = setUp()

    const pages = await allPages(layer, BLENDER, { sort })

    expect(pages.flatMap(page => page.items.map(item => item.videoId))).toEqual([`${chip}-1a`, `${chip}-1b`, `${chip}-2a`, `${chip}-2b`])
    expect(pages[0].items[0]).toMatchObject({ author: 'Blender', authorId: BLENDER, thumbnail: '' })
    expect(pages[0].cursor).toMatchObject({ backend: 'local', continuation: expect.objectContaining({ videos: expect.any(Array) }) })
    expect(pages.at(-1).cursor).toBeNull()
  })

  it.each(Object.keys(CHIPS))('pages Invidious to the end, %s first, repeating the sort on later pages', async (sort) => {
    const { layer, fake } = setUp({ config: { backendPreference: 'invidious' } })

    const pages = await allPages(layer, BLENDER, { sort })

    expect(pages.flatMap(page => page.items.map(item => item.videoId))).toEqual([`${sort}-1`, `${sort}-2`])
    expect(pages[0].items[0].thumbnail).toBe('')
    expect(pages[0].cursor).toEqual({ backend: 'invidious', continuation: `token-${sort}-2`, sort, kind: 'videos' })
    expect(pages.at(-1).cursor).toBeNull()
    expect(fake.callsOf('getInvidiousChannelVideos')).toEqual([[BLENDER, sort, null], [BLENDER, sort, `token-${sort}-2`]])
    expect(fake.callsOf('getLocalChannel')).toHaveLength(0)
  })

  it.each(Object.keys(CHIPS))('says the first page is in the sort asked, %s, where the tab has the filter', async (sort) => {
    const { layer } = setUp()

    expect((await layer.listChannelVideos(BLENDER, { sort })).sort).toBe(sort)
  })

  it.each(['popular', 'oldest'])('answers newest first, and says so, for %s on a Local tab without the filter', async (sort) => {
    const { layer } = setUp({
      answers: {
        getLocalChannel: async () => withMethods(localOrdinary, () => ({
          getVideos: async () => ({ ...videosTab(CHIPS.newest), filters: [], applyFilter: async () => { throw new Error('no filter') } }),
        })),
      },
    })

    const page = await layer.listChannelVideos(BLENDER, { sort })

    expect(page.sort).toBe('newest')
    expect(page.items.map(item => item.videoId)).toEqual(['Latest-1a', 'Latest-1b'])
  })

  it('says every Invidious page is in the sort asked', async () => {
    const { layer } = setUp({ config: { backendPreference: 'invidious' } })

    const pages = await allPages(layer, BLENDER, { sort: 'oldest' })

    expect(pages.map(page => page.sort)).toEqual(['oldest', 'oldest'])
  })

  it.each([['newest', 'UULF'], ['popular', 'UULP']])('lists an artist topic channel\'s uploads playlist on Local, %s first', async (sort, prefix) => {
    const { layer, fake } = setUp()
    const playlistId = DAFT_PUNK_TOPIC.replace(/^UC/, prefix)

    const pages = await allPages(layer, DAFT_PUNK_TOPIC, { sort })

    expect(pages.flatMap(page => page.items.map(item => item.videoId))).toEqual([`${playlistId}-1`, `${playlistId}-2`])
    expect(pages[0].cursor).toMatchObject({ backend: 'local', continuation: expect.objectContaining({ id: playlistId }) })
    expect(pages.at(-1).cursor).toBeNull()
    expect(fake.callsOf('getLocalPlaylist')).toEqual([[playlistId]])
    expect(fake.callsOf('getLocalPlaylistContinuation')).toHaveLength(1)
  })
})

describe('the Local channel cache', () => {
  it('lists a channel getChannel fetched without fetching it again', async () => {
    const { layer, fake } = setUp()

    await layer.getChannel(BLENDER)
    await layer.listChannelVideos(BLENDER)

    expect(fake.callsOf('getLocalChannel')).toEqual([[BLENDER]])
  })

  it('fetches a channel it does not hold, once', async () => {
    const { layer, fake } = setUp()

    await layer.listChannelVideos(BLENDER)
    await layer.listChannelVideos(BLENDER, { sort: 'popular' })

    expect(fake.callsOf('getLocalChannel')).toEqual([[BLENDER]])
  })

  it(`holds the ${CHANNEL_CACHE_SIZE} channels used last`, async () => {
    const { layer, fake } = setUp()
    const refs = Array.from({ length: CHANNEL_CACHE_SIZE + 1 }, (_, index) => `UC${String(index).padStart(22, 'x')}`)

    for (const ref of refs) {
      await layer.getChannel(ref)
    }
    await layer.listChannelVideos(refs.at(-1))
    await layer.listChannelVideos(refs[0])

    expect(fake.callsOf('getLocalChannel').slice(refs.length)).toEqual([[refs[0]]])
  })

  it('starts empty on a new layer', async () => {
    const { layer, fake } = setUp()

    await layer.getChannel(BLENDER)
    await createLayer(fake).listChannelVideos(BLENDER)

    expect(fake.callsOf('getLocalChannel')).toEqual([[BLENDER], [BLENDER]])
  })
})

describe('a YouTube channel that is gone', () => {
  it.each([
    ['Local', 'local', 'getLocalChannel'],
    ['Invidious', 'invidious', 'invidiousGetChannelInfo'],
  ])('is notFound on %s, for the details and the videos', async (_name, backendPreference, asked) => {
    const { layer, fake } = setUp({ config: { backendPreference } })

    expect((await failure(layer.getChannel(GONE))).kind).toBe('notFound')
    expect(fake.calls.every(call => call.name === asked)).toBe(true)

    if (backendPreference === 'local') {
      expect((await failure(layer.listChannelVideos(GONE))).kind).toBe('notFound')
    }
  })

  it('is tried once on the other backend when fallback is on', async () => {
    const { layer, fake } = setUp({ config: { backendFallback: true } })

    expect((await failure(layer.getChannel(GONE))).kind).toBe('notFound')
    expect(fake.callsOf('getLocalChannel')).toEqual([[GONE]])
    expect(fake.callsOf('invidiousGetChannelInfo')).toEqual([[GONE]])
  })

  it('is answered by the other backend when only the preferred one has lost it', async () => {
    const { layer, fake } = setUp({
      config: { backendFallback: true },
      answers: { getLocalChannel: async () => structuredClone(localTerminated.answer) },
    })

    expect((await layer.getChannel(BLENDER)).name).toBe('Blender')
    expect(fake.callsOf('invidiousGetChannelInfo')).toEqual([[BLENDER]])
  })

  it('refuses an age-gated channel on Local, without asking Invidious', async () => {
    const { layer, fake } = setUp({
      config: { backendFallback: true },
      answers: { getLocalChannel: async () => withMethods(localOrdinary, () => ({ memo: new Map([['ChannelAgeGate', [{}]]]) })) },
    })

    expect(await failure(layer.getChannel(BLENDER))).toMatchObject({ kind: 'refused', reason: 'ageRestricted' })
    expect(fake.callsOf('invidiousGetChannelInfo')).toHaveLength(0)
  })

  it('carries the name and avatar YouTube shows an age-gated channel with', async () => {
    const ageGate = { channel_title: 'Grown-ups only', avatar: [{ url: '//yt3.ggpht.com/grown-ups=s88' }] }
    const { layer } = setUp({
      answers: { getLocalChannel: async () => withMethods(localOrdinary, () => ({ memo: new Map([['ChannelAgeGate', [ageGate]]]) })) },
    })

    expect((await failure(layer.getChannel(BLENDER))).channel).toEqual({
      id: BLENDER,
      name: 'Grown-ups only',
      thumbnail: 'https://yt3.ggpht.com/grown-ups=s88',
    })
  })
})

describe('a YouTube channel\'s shorts and live broadcasts', () => {
  it('pages Local shorts to the end, as shorts of unknown length', async () => {
    const { layer } = setUp()

    const pages = await allPages(layer, BLENDER, { kind: 'shorts' })

    expect(itemsOf(pages)).toEqual([
      expect.objectContaining({ type: 'shortVideo', videoId: 'A9Yn8Ad_cH8', viewCount: 13000, lengthSeconds: '', author: 'Blender', authorId: BLENDER }),
      expect.objectContaining({ type: 'shortVideo', videoId: 'bchuTN1Hrd0', viewCount: 83000, lengthSeconds: '' }),
    ])
    expect(pages[0].cursor).toMatchObject({ backend: 'local', kind: 'shorts' })
    expect(pages.at(-1).cursor).toBeNull()
  })

  it('pages Invidious shorts to the end, as shorts of unknown length, repeating the sort', async () => {
    const { layer, fake } = setUp({ config: { backendPreference: 'invidious' } })

    const pages = await allPages(layer, BLENDER, { kind: 'shorts', sort: 'popular' })

    expect(itemsOf(pages).map(item => [item.videoId, item.type, item.lengthSeconds])).toEqual([
      ['A9Yn8Ad_cH8', 'shortVideo', ''],
      ['bchuTN1Hrd0', 'shortVideo', ''],
    ])
    expect(pages[0].cursor).toEqual({ backend: 'invidious', continuation: 'shorts-token-2', sort: 'popular', kind: 'shorts' })
    expect(pages.at(-1).cursor).toBeNull()
    expect(fake.callsOf('getInvidiousChannelShorts')).toEqual([[BLENDER, 'popular', null], [BLENDER, 'popular', 'shorts-token-2']])
  })

  it.each([
    ['Local', 'local'],
    ['Invidious', 'invidious'],
  ])('pages %s live broadcasts to the end, live, upcoming and finished', async (_name, backendPreference) => {
    const { layer } = setUp({ config: { backendPreference } })

    const pages = await allPages(layer, BLENDER, { kind: 'live' })

    expect(itemsOf(pages).map(item => [item.videoId, item.liveNow, item.isUpcoming])).toEqual([
      ['liveliveliv', true, false],
      ['upcomingupc', false, true],
      ['finishedfin', false, false],
    ])
    // Local's empty first page is followed, not answered
    expect(pages[0].items).toHaveLength(2)
    expect(pages[0].cursor).toMatchObject({ backend: backendPreference, kind: 'live' })
    expect(pages.at(-1).cursor).toBeNull()
  })

  it.each(['shorts', 'live'])('answers a Local channel without a %s tab with an empty page, opening none', async (kind) => {
    // The fixture's channel has no shorts or live tab, and no methods to open one
    const { layer } = setUp({ answers: { getLocalChannel: async () => structuredClone(localNoBanner.answer) } })

    expect(await layer.listChannelVideos(NO_BANNER, { kind })).toEqual({ items: [], cursor: null })
  })

  it.each([
    ['shorts', 'getInvidiousChannelShorts'],
    ['live', 'getInvidiousChannelLive'],
  ])('answers an Invidious channel without a %s tab with an empty page, asking nothing more once its tabs are known', async (kind, tabFunction) => {
    const { layer, fake } = setUp({ config: { backendPreference: 'invidious' } })

    await layer.getChannel(NO_BANNER)

    expect(await layer.listChannelVideos(NO_BANNER, { kind })).toEqual({ items: [], cursor: null })
    expect(fake.callsOf(tabFunction)).toHaveLength(0)
  })

  it('rejects a kind it does not know, asking nobody', async () => {
    const { layer, fake } = setUp()

    expect((await failure(layer.listChannelVideos(BLENDER, { kind: 'posts' }))).kind).toBe('invalid')
    expect(fake.calls).toHaveLength(0)
  })
})

describe('a YouTube channel\'s playlists', () => {
  it('pages Local to the end, an auto-generated album naming no channel', async () => {
    const { layer } = setUp()

    const pages = await allPages(layer, BLENDER, {}, 'listChannelPlaylists')

    expect(itemsOf(pages)).toEqual([
      {
        type: 'playlist',
        dataSource: 'local',
        playlistId: 'PLown',
        title: 'PLown',
        thumbnail: 'https://i.ytimg.com/vi/PLown/hqdefault.jpg',
        videoCount: 3,
        url: 'https://www.youtube.com/playlist?list=PLown',
        description: '',
        channelName: 'Blender',
        channelId: BLENDER,
      },
      expect.objectContaining({ playlistId: 'OLAKalbum', channelName: '', channelId: null }),
    ])
    expect(pages[0].cursor).toMatchObject({ backend: 'local', kind: 'playlists' })
    expect(pages.at(-1).cursor).toBeNull()
  })

  it('pages Invidious to the end, newest first on every page, thumbnails on the instance', async () => {
    const { layer, fake } = setUp({ config: { backendPreference: 'invidious' } })

    const pages = await allPages(layer, BLENDER, {}, 'listChannelPlaylists')

    expect(itemsOf(pages)).toEqual([
      {
        type: 'playlist',
        dataSource: 'local',
        playlistId: 'PLa1F2ddGya_8acrgoQr1fTeskX2-uzIJJ',
        title: 'Blender Conference 2025',
        thumbnail: `${INSTANCE}/vi/X-zb1FxHuCw/mqdefault.jpg`,
        videoCount: 42,
        url: 'https://www.youtube.com/playlist?list=PLa1F2ddGya_8acrgoQr1fTeskX2-uzIJJ',
        description: '',
        channelName: 'Blender',
        channelId: BLENDER,
      },
      expect.objectContaining({ title: 'Sprite Fright (Soundtrack)', channelName: '', channelId: null }),
    ])
    expect(pages.at(-1).cursor).toBeNull()
    expect(fake.callsOf('getInvidiousChannelPlaylists')).toEqual([[BLENDER, 'newest', null], [BLENDER, 'newest', 'playlists-token-2']])
  })

  it('narrows Local\'s playlists to the channel\'s own where YouTube offers other categories', async () => {
    const applied = []
    const categories = {
      content_type_filters: ['Created playlists', 'Saved playlists'],
      current_tab: {
        content: {
          sub_menu: {
            content_type_sub_menu_items: [
              { title: 'Saved playlists', endpoint: { metadata: { url: '/@BlenderOfficial/playlists?view=58' } } },
              { title: 'Created playlists', endpoint: { metadata: { url: '/@BlenderOfficial/playlists?view=1' } } },
            ],
          },
        },
      },
      applyContentTypeFilter: async (title) => {
        applied.push(title)
        return pagedTab('playlists', LOCAL_PLAYLIST_PAGES)
      },
    }
    const { layer } = setUp({
      answers: {
        getLocalChannel: async () => withMethods(localOrdinary, () => ({
          getPlaylists: async () => pagedTab('playlists', [[]], categories),
        })),
      },
    })

    const page = await layer.listChannelPlaylists(BLENDER)

    expect(applied).toEqual(['Created playlists'])
    expect(page.items.map(item => item.playlistId)).toEqual(['PLown'])
  })

  it('will not continue a list of videos as playlists', async () => {
    const { layer } = setUp()
    const videos = await layer.listChannelVideos(BLENDER)

    expect((await failure(layer.listChannelPlaylists(BLENDER, { cursor: videos.cursor }))).kind).toBe('invalid')
  })
})

describe('a YouTube channel\'s releases, podcasts and courses', () => {
  const KINDS = ['releases', 'podcasts', 'courses']

  /** Blender, as if it had every tab */
  function withEveryTab() {
    return {
      getLocalChannel: async () => Object.assign(localChannel(localOrdinary, localOrdinaryAbout), { has_releases: true, has_courses: true }),
    }
  }

  it.each(KINDS)('pages Local %s to the end, attributed to the channel where an item names none, in no sort', async (kind) => {
    const { layer } = setUp({ answers: withEveryTab() })

    const pages = await allPages(layer, BLENDER, { kind }, 'listChannelPlaylists')

    expect(itemsOf(pages)).toEqual([
      expect.objectContaining({ type: 'playlist', dataSource: 'local', playlistId: `PL${kind}1`, channelName: 'Blender', channelId: BLENDER, url: `https://www.youtube.com/playlist?list=PL${kind}1` }),
      expect.objectContaining({ playlistId: `OLAK${kind}2`, channelName: '', channelId: null }),
    ])
    expect(pages[0].cursor).toMatchObject({ backend: 'local', from: 'tab', kind })
    expect(pages.at(-1).cursor).toBeNull()
    expect(pages.every(page => !('sort' in page))).toBe(true)
  })

  it.each([
    ['releases', 'getInvidiousChannelReleases', invidiousReleases],
    ['podcasts', 'getInvidiousChannelPodcasts', invidiousPodcasts],
    ['courses', 'getInvidiousChannelCourses', invidiousCourses],
  ])('pages Invidious %s to the end, asking no sort, thumbnails on the instance', async (kind, tabFunction, fixture) => {
    const { layer, fake } = setUp({ config: { backendPreference: 'invidious' } })
    const [first, second] = fixture.answer.playlists

    const pages = await allPages(layer, BLENDER, { kind }, 'listChannelPlaylists')

    expect(itemsOf(pages)).toEqual([
      expect.objectContaining({
        type: 'playlist',
        dataSource: 'local',
        playlistId: first.playlistId,
        title: first.title,
        thumbnail: first.playlistThumbnail.replace('https://i.ytimg.com', INSTANCE).replace('hqdefault', 'mqdefault'),
        videoCount: first.videoCount,
        channelName: first.author,
        channelId: first.authorId,
      }),
      expect.objectContaining({ playlistId: second.playlistId, channelId: second.authorId || null }),
    ])
    expect(pages[0].cursor).toEqual({ backend: 'invidious', continuation: `${kind}-token-2`, sort: null, kind })
    expect(pages.at(-1).cursor).toBeNull()
    expect(pages.every(page => !('sort' in page))).toBe(true)
    expect(fake.callsOf(tabFunction)).toEqual([[BLENDER, null], [BLENDER, `${kind}-token-2`]])
  })

  it('lists an artist topic channel\'s releases off its page on Local, as the module reads them', async () => {
    const { layer, fake } = setUp()

    const pages = await allPages(layer, DAFT_PUNK_TOPIC, { kind: 'releases' }, 'listChannelPlaylists')

    expect(itemsOf(pages).map(item => [item.title, item.channelName, item.channelId])).toEqual([
      ['Random Access Memories (Drumless Edition)', 'Daft Punk · Sep 20, 2026', 'UC_kRDKYrUlrbtrSiyu5Tflg'],
      ['Random Access Memories', 'Daft Punk · Mar 28, 2026', 'UC_kRDKYrUlrbtrSiyu5Tflg'],
      ['Alive 1997', 'Daft Punk · Sep 20, 2025', 'UC_kRDKYrUlrbtrSiyu5Tflg'],
    ])
    expect(itemsOf(pages)[0]).toMatchObject({ type: 'playlist', dataSource: 'local', url: expect.stringContaining('list=OLAK5uy_'), description: '' })
    expect(pages[0].cursor).toMatchObject({ backend: 'local', from: 'topicReleases', kind: 'releases' })
    expect(pages.at(-1).cursor).toBeNull()
    // The continuation is called with the channel whose session made it
    const [[channel, continuation]] = fake.callsOf('getLocalArtistTopicChannelReleasesContinuation')
    expect(channel.metadata.music_artist_name).toBeTruthy()
    expect(continuation).toEqual(localArtistTopicReleases.answer.continuationData)
  })

  it.each(KINDS)('answers a Local channel without a %s tab with an empty page, opening none', async (kind) => {
    // The fixture's channel has none of the three, and no methods to open one
    const { layer } = setUp({ answers: { getLocalChannel: async () => structuredClone(localNoBanner.answer) } })

    expect(await layer.listChannelPlaylists(NO_BANNER, { kind })).toEqual({ items: [], cursor: null })
  })

  it.each([
    ['releases', 'getInvidiousChannelReleases'],
    ['podcasts', 'getInvidiousChannelPodcasts'],
    ['courses', 'getInvidiousChannelCourses'],
  ])('answers an Invidious channel without a %s tab with an empty page, asking nothing more once its tabs are known', async (kind, tabFunction) => {
    const { layer, fake } = setUp({ config: { backendPreference: 'invidious' } })

    await layer.getChannel(NO_BANNER)

    expect(await layer.listChannelPlaylists(NO_BANNER, { kind })).toEqual({ items: [], cursor: null })
    expect(fake.callsOf(tabFunction)).toHaveLength(0)
  })

  it.each([
    [{ kind: 'posts' }],
    [{ kind: 'videos' }],
    [{ sort: 'popular' }],
    [{ kind: 'releases', sort: 'last' }],
  ])('rejects %o, asking nobody', async (options) => {
    const { layer, fake } = setUp()

    expect((await failure(layer.listChannelPlaylists(BLENDER, options))).kind).toBe('invalid')
    expect(fake.calls).toHaveLength(0)
  })

  it('continues a list as the kind its cursor names, whatever the options say', async () => {
    const { layer } = setUp({ answers: withEveryTab() })
    const first = await layer.listChannelPlaylists(BLENDER, { kind: 'podcasts' })

    const next = await layer.listChannelPlaylists(BLENDER, { kind: 'playlists', cursor: first.cursor })

    expect(next.items.map(item => item.playlistId)).toEqual(['OLAKpodcasts2'])
  })
})

describe('the sorts of a YouTube channel\'s playlists', () => {
  it('lists Local by the last video added through YouTube\'s sort menu, and says so', async () => {
    const { layer } = setUp({
      answers: { getLocalChannel: async () => withMethods(localOrdinary, () => ({ getPlaylists: async () => sortablePlaylistsTab() })) },
    })

    const page = await layer.listChannelPlaylists(BLENDER, { sort: 'last' })

    expect(page.items.map(item => item.playlistId)).toEqual(['PLlast', 'PLown'])
    expect(page.sort).toBe('last')
  })

  it('lists Local newest first without the sort menu, and says so', async () => {
    const { layer } = setUp({
      answers: { getLocalChannel: async () => withMethods(localOrdinary, () => ({ getPlaylists: async () => sortablePlaylistsTab() })) },
    })

    const page = await layer.listChannelPlaylists(BLENDER, { sort: 'newest' })

    expect(page.items.map(item => item.playlistId)).toEqual(['PLown'])
    expect(page.sort).toBe('newest')
  })

  it.each([
    ['of one playlist', () => sortablePlaylistsTab([[{ id: 'PLonly' }]])],
    ['without a sort menu', () => pagedTab('playlists', LOCAL_PLAYLIST_PAGES)],
  ])('answers newest first, and says so, for last on a Local tab %s', async (_name, tab) => {
    const { layer } = setUp({
      answers: { getLocalChannel: async () => withMethods(localOrdinary, () => ({ getPlaylists: async () => tab() })) },
    })

    const page = await layer.listChannelPlaylists(BLENDER, { sort: 'last' })

    expect(page.sort).toBe('newest')
    expect(page.items.map(item => item.playlistId)).not.toContain('PLlast')
  })

  it.each(['newest', 'last'])('asks Invidious for %s, repeating the sort on every page, and says so on each', async (sort) => {
    const { layer, fake } = setUp({ config: { backendPreference: 'invidious' } })

    const pages = await allPages(layer, BLENDER, { sort }, 'listChannelPlaylists')

    expect(pages.map(page => page.sort)).toEqual([sort, sort])
    expect(pages[0].cursor).toEqual({ backend: 'invidious', continuation: 'playlists-token-2', sort, kind: 'playlists' })
    expect(fake.callsOf('getInvidiousChannelPlaylists')).toEqual([[BLENDER, sort, null], [BLENDER, sort, 'playlists-token-2']])
  })
})

describe('a YouTube channel\'s posts', () => {
  it('pages Local to the end, a text, an image and a video post, as the module parsed them', async () => {
    const { layer } = setUp()

    const pages = await allPages(layer, BLENDER, {}, 'listChannelPosts')

    // The page holding only a continuation is followed, not answered
    expect(pages).toHaveLength(2)
    expect(itemsOf(pages)).toEqual([LOCAL_TEXT_POST, LOCAL_IMAGE_POST, LOCAL_VIDEO_POST])
    expect(itemsOf(pages).map(post => post.postContent?.type ?? null)).toEqual([null, 'image', 'video'])
    expect(LOCAL_VIDEO_POST.postContent.content).toMatchObject({ type: 'video', videoId: '685eur9lMGc', lengthSeconds: 282 })
    expect(pages[0].cursor).toMatchObject({ backend: 'local', from: 'tab', kind: 'community' })
    expect(pages.at(-1).cursor).toBeNull()
    expect(pages.every(page => !('sort' in page))).toBe(true)
  })

  it('reads a Local poll, its choices and votes', async () => {
    const { layer } = setUp({
      answers: {
        getLocalChannel: async () => withMethods(localOrdinary, () => ({
          getCommunity: async () => pagedTab('posts', [localPostsPoll.answer.map(post => ({ id: post.postId }))]),
        })),
      },
    })

    const page = await layer.listChannelPosts(BLENDER)

    expect(page).toEqual({ items: localPostsPoll.answer, cursor: null })
    expect(page.items[0]).toMatchObject({
      type: 'community',
      voteCount: 3600,
      commentCount: 516,
      postContent: { type: 'poll', totalVotes: 223000, content: expect.arrayContaining([expect.objectContaining({ text: 'Concord Purple' })]) },
    })
  })

  it('answers a Local attachment the module does not know as none', async () => {
    const { layer } = setUp({ answers: { parseLocalCommunityPosts: nodes => nodes.map(() => ({ ...LOCAL_TEXT_POST, postContent: undefined })) } })

    const page = await layer.listChannelPosts(BLENDER)

    expect(page.items[0].postContent).toBeNull()
  })

  it('pages Invidious to the end, a text, an image, a video and a poll post, asking no sort', async () => {
    const { layer, fake } = setUp({ config: { backendPreference: 'invidious' } })

    const pages = await allPages(layer, BLENDER, {}, 'listChannelPosts')

    expect(itemsOf(pages)).toEqual(invidiousPosts.answer.posts)
    expect(itemsOf(pages).map(post => post.postContent?.type ?? null)).toEqual([null, 'image', 'video', 'poll'])
    expect(pages[0].cursor).toEqual({ backend: 'invidious', continuation: 'posts-token-2', sort: null, kind: 'community' })
    expect(pages.at(-1).cursor).toBeNull()
    expect(fake.callsOf('invidiousGetCommunityPosts')).toEqual([[BLENDER, null], [BLENDER, 'posts-token-2']])
  })

  it('tries Invidious once when Local fails with fallback on, and pages on there', async () => {
    const { layer, fake } = setUp({
      config: { backendFallback: true },
      answers: { getLocalChannel: async () => withMethods(localOrdinary, () => ({ getCommunity: async () => { throw new TypeError('fetch failed') } })) },
    })

    const pages = await allPages(layer, BLENDER, {}, 'listChannelPosts')

    expect(itemsOf(pages)).toHaveLength(invidiousPosts.answer.posts.length)
    expect(fake.callsOf('invidiousGetCommunityPosts')).toHaveLength(2)
  })

  it('answers a Local channel without posts with an empty page, opening no tab', async () => {
    // The fixture's channel has no community tab, and no methods to open one
    const { layer } = setUp({ answers: { getLocalChannel: async () => structuredClone(localNoBanner.answer) } })

    expect(await layer.listChannelPosts(NO_BANNER)).toEqual({ items: [], cursor: null })
  })

  it('answers an Invidious channel without posts with an empty page, asking nothing more once its tabs are known', async () => {
    const { layer, fake } = setUp({ config: { backendPreference: 'invidious' } })

    await layer.getChannel(NO_BANNER)

    expect(await layer.listChannelPosts(NO_BANNER)).toEqual({ items: [], cursor: null })
    expect(fake.callsOf('invidiousGetCommunityPosts')).toHaveLength(0)
  })

  it('will not continue a list of videos as posts', async () => {
    const { layer } = setUp()
    const videos = await layer.listChannelVideos(BLENDER)

    expect((await failure(layer.listChannelPosts(BLENDER, { cursor: videos.cursor }))).kind).toBe('invalid')
  })
})

describe('searching a YouTube channel', () => {
  const QUERY = 'animation'

  /** Every page of a search, following the cursors to the end */
  async function allSearchPages(layer, ref, query) {
    const pages = [await layer.searchChannel(ref, query)]

    while (pages.at(-1).cursor !== null && pages.length < 10) {
      pages.push(await layer.searchChannel(ref, query, { cursor: pages.at(-1).cursor }))
    }

    return pages
  }

  /** The items of a recorded Local page, as the module parsed them */
  function parsedOf(sections) {
    return sections.flatMap(section => section.contents.map(item => item.parsed))
  }

  /** Invidious' answer over two pages, the fixture's items but the last, then the last, then nothing */
  async function invidiousPages(_id, _query, page) {
    const items = structuredClone(invidiousSearch.answer)
    return [items.slice(0, -1), items.slice(-1)][page - 1] ?? []
  }

  /**
   * @param {object} [options]
   * @param {object} [options.config]
   * @param {Record<string, any>} [options.answers]
   */
  function setUpSearch({ config = {}, answers = {} } = {}) {
    return setUp({
      config,
      answers: {
        // The module's parse of each node, as recorded
        parseLocalListVideo: node => structuredClone(node.parsed),
        parseLocalListPlaylist: node => structuredClone(node.parsed),
        searchInvidiousChannel: invidiousPages,
        ...answers,
      },
    })
  }

  it('pages Local\'s videos and playlists to the end, as the cards read them', async () => {
    const { layer, fake } = setUpSearch()
    await layer.getChannel(BLENDER)

    const pages = await allSearchPages(layer, BLENDER, QUERY)
    const [playlist, ...videos] = itemsOf(pages)

    expect(pages).toHaveLength(2)
    expect(pages[0].cursor).toMatchObject({ backend: 'local', kind: 'search', owner: { id: BLENDER, name: 'Blender' } })
    expect(pages[1].cursor).toBeNull()
    expect(playlist).toEqual({
      ...localSearch.answer.current_tab.content.contents[0].contents[0].parsed,
      url: 'https://www.youtube.com/playlist?list=PL6B3937A5D230E335',
      description: '',
    })
    expect(videos.map(video => video.videoId)).toEqual(parsedOf([
      ...localSearch.answer.current_tab.content.contents,
      ...localSearchContinuation.answer.contents.contents,
    ]).slice(1).map(video => video.videoId))
    expect(videos.every(video => video.type === 'video' && video.thumbnail === '')).toBe(true)
    // The channel getChannel fetched, not fetched again
    expect(fake.callsOf('getLocalChannel')).toHaveLength(1)
    expect(fake.callsOf('parseLocalListPlaylist')[0].slice(1)).toEqual([BLENDER, 'Blender'])
  })

  it('pages Invidious by number, playlists on the instance, until a page answers nothing', async () => {
    const { layer, fake } = setUpSearch({ config: { backendPreference: 'invidious' } })

    const pages = await allSearchPages(layer, BLENDER, QUERY)

    expect(pages.map(page => page.items.length)).toEqual([2, 1, 0])
    expect(pages[0].cursor).toEqual({ backend: 'invidious', page: 2, query: QUERY, kind: 'search' })
    expect(pages.at(-1).cursor).toBeNull()
    expect(pages[0].items[0]).toMatchObject({
      type: 'playlist',
      dataSource: 'local',
      playlistId: 'PL6B3937A5D230E335',
      thumbnail: `${INSTANCE}/vi/WhWc3b3KhnY/mqdefault.jpg`,
      channelId: BLENDER,
    })
    expect(itemsOf(pages).slice(1).map(video => [video.videoId, video.thumbnail])).toEqual([['fxz6p-QATfs', ''], ['e_0ppK_f_rY', '']])
    expect(fake.callsOf('searchInvidiousChannel')).toEqual([[BLENDER, QUERY, 1], [BLENDER, QUERY, 2], [BLENDER, QUERY, 3]])
  })

  it('tries Invidious once when Local fails with fallback on, and asks it for the later pages too', async () => {
    const { layer, fake } = setUpSearch({
      config: { backendFallback: true },
      answers: { getLocalChannel: async () => withMethods(localOrdinary, () => ({ search: async () => { throw new TypeError('fetch failed') } })) },
    })

    const first = await layer.searchChannel(BLENDER, QUERY)
    await layer.searchChannel(BLENDER, 'ignored', { cursor: first.cursor })

    expect(first.cursor.backend).toBe('invidious')
    expect(fake.callsOf('getLocalChannel')).toHaveLength(1)
    expect(fake.callsOf('searchInvidiousChannel')).toEqual([[BLENDER, QUERY, 1], [BLENDER, QUERY, 2]])
  })

  it('continues a Local search on Local, whatever the preference is now', async () => {
    const { fake, layer } = setUpSearch()
    const first = await layer.searchChannel(BLENDER, QUERY)
    const invidiousLayer = createLayer(fake, { backendPreference: 'invidious' })

    const next = await invidiousLayer.searchChannel(BLENDER, QUERY, { cursor: first.cursor })

    expect(next.items).toHaveLength(3)
    expect(fake.callsOf('searchInvidiousChannel')).toHaveLength(0)
  })

  it('refuses a Local channel without search as invalid, asking Invidious nothing', async () => {
    const { layer, fake } = setUpSearch({
      config: { backendFallback: true },
      answers: { getLocalChannel: async () => structuredClone(localNoBanner.answer) },
    })

    expect((await failure(layer.searchChannel(NO_BANNER, QUERY))).kind).toBe('invalid')
    expect(fake.callsOf('searchInvidiousChannel')).toHaveLength(0)
  })

  it('answers a blank query with an empty page, asking nobody', async () => {
    const { layer, fake } = setUpSearch()

    expect(await layer.searchChannel(BLENDER, '  ')).toEqual({ items: [], cursor: null })
    expect(fake.calls).toHaveLength(0)
  })

  it('will not continue a list of videos as a search', async () => {
    const { layer } = setUpSearch()
    const videos = await layer.listChannelVideos(BLENDER)

    expect((await failure(layer.searchChannel(BLENDER, QUERY, { cursor: videos.cursor }))).kind).toBe('invalid')
  })

  it('rejects a PeerTube channel as invalid, without a request', async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError('no network in tests')))
    const layer = createPlatformLayer({ fetch, youtube: createFakeYouTube().youtube, config: { peertubeEnabled: true } })

    expect((await failure(layer.searchChannel('blender@video.blender.org', QUERY))).kind).toBe('invalid')
    expect(fetch).not.toHaveBeenCalled()
  })
})
