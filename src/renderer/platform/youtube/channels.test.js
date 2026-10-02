import { describe, expect, it } from 'vitest'

import { parseLocalChannelHeader, parseLocalChannelShorts, parseLocalSubscriberCount } from '../../helpers/api/local'
import { createPlatformLayer } from '../index'
import { CHANNEL_CACHE_SIZE } from './channels'
import { createFakeYouTube, withMethods } from './testing/fakeYouTube'

import invidiousLive from './fixtures/invidious--channel-live.json'
import invidiousNoBanner from './fixtures/invidious--channel-no-banner.json'
import invidiousOrdinary from './fixtures/invidious--channel-ordinary.json'
import invidiousPlaylists from './fixtures/invidious--channel-playlists.json'
import invidiousShorts from './fixtures/invidious--channel-shorts.json'
import localArtistTopicAbout from './fixtures/local--channel-artist-topic-about.json'
import localArtistTopic from './fixtures/local--channel-artist-topic.json'
import localNoBanner from './fixtures/local--channel-no-banner.json'
import localOrdinaryAbout from './fixtures/local--channel-ordinary-about.json'
import localOrdinary from './fixtures/local--channel-ordinary.json'
import localShortsPage from './fixtures/local--channel-shorts-page.json'
import localTerminated from './fixtures/local--channel-terminated.json'

const BLENDER = 'UCSMOQeBJ2RAnuFungnQOxLg'
const DAFT_PUNK_TOPIC = 'UCRr1xG_2WIDs18a6cIiCxeA'
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

/** A `YT.Channel` from a fixture, with its about page and tabs */
function localChannel(fixture, about = null) {
  return withMethods(fixture, () => ({
    getAbout: async () => structuredClone(about?.answer),
    getVideos: async () => videosTab(CHIPS.newest),
    getShorts: async () => pagedTab('videos', localShortsPage.answer.map(node => [node])),
    getLiveStreams: async () => pagedTab('videos', LOCAL_LIVE_PAGES),
    getPlaylists: async () => pagedTab('playlists', LOCAL_PLAYLIST_PAGES),
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
  it('reads a channel from Local, with its about page\'s description', async () => {
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
    })
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

    expect(await layer.getChannel(NO_BANNER)).toMatchObject({
      name: 'A small channel',
      thumbnail: 'https://yt3.ggpht.com/small-channel=s176-c-k-c0x00ffffff-no-rj',
      banner: null,
      description: '',
      subscriberCount: 1200,
      tabs: ['videos'],
      tags: [],
      isFamilyFriendly: false,
    })
    expect(fake.calls.filter(call => call.name.startsWith('invidious'))).toHaveLength(0)
  })

  it('reads a channel from Invidious, its page images moved onto the instance', async () => {
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
    })
  })

  it('answers an Invidious channel without a banner with null', async () => {
    const { layer } = setUp({ config: { backendPreference: 'invidious' } })

    expect(await layer.getChannel(NO_BANNER)).toMatchObject({ banner: null, tabs: ['videos'], isFamilyFriendly: false })
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
