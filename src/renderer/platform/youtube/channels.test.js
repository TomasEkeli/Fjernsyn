import { describe, expect, it } from 'vitest'

import { parseLocalChannelHeader, parseLocalSubscriberCount } from '../../helpers/api/local'
import { createPlatformLayer } from '../index'
import { CHANNEL_CACHE_SIZE } from './channels'
import { createFakeYouTube, withMethods } from './testing/fakeYouTube'

import invidiousNoBanner from './fixtures/invidious--channel-no-banner.json'
import invidiousOrdinary from './fixtures/invidious--channel-ordinary.json'
import localArtistTopicAbout from './fixtures/local--channel-artist-topic-about.json'
import localArtistTopic from './fixtures/local--channel-artist-topic.json'
import localNoBanner from './fixtures/local--channel-no-banner.json'
import localOrdinaryAbout from './fixtures/local--channel-ordinary-about.json'
import localOrdinary from './fixtures/local--channel-ordinary.json'
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

/** A `YT.Channel` from a fixture, with its about page and videos tab */
function localChannel(fixture, about = null) {
  return withMethods(fixture, () => ({
    getAbout: async () => structuredClone(about?.answer),
    getVideos: async () => videosTab(CHIPS.newest),
  }))
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
    parseLocalChannelVideos: (videos, channelId, channelName) => videos.map(video => ({
      type: 'video', videoId: video.id, title: video.id, author: channelName, authorId: channelId,
    })),
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
async function allPages(layer, ref, options = {}) {
  const pages = [await layer.listChannelVideos(ref, options)]

  while (pages.at(-1).cursor !== null && pages.length < 10) {
    pages.push(await layer.listChannelVideos(ref, { cursor: pages.at(-1).cursor }))
  }

  return pages
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
    expect(pages[0].cursor).toEqual({ backend: 'invidious', continuation: `token-${sort}-2`, sort })
    expect(pages.at(-1).cursor).toBeNull()
    expect(fake.callsOf('getInvidiousChannelVideos')).toEqual([[BLENDER, sort, null], [BLENDER, sort, `token-${sort}-2`]])
    expect(fake.callsOf('getLocalChannel')).toHaveLength(0)
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
})
