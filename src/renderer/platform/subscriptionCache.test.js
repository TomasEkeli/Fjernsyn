import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../store/index'
import { getLocalChannelCommunity, getLocalChannelLiveStreams, getLocalChannelVideos } from '../helpers/api/local'
import { getInvidiousChannelLive, getInvidiousChannelVideos, invidiousGetCommunityPosts } from '../helpers/api/invidious'
import { subscriptionFeedDescriptor } from '../helpers/subscriptionFeeds/index'
import { createPlatformLayer } from './index'
import { subscriptionCacheEntries, subscriptionCacheEntry } from './subscriptionCache'
import { createFakeYouTube, withMethods } from './youtube/testing/fakeYouTube'

import invidiousLive from './youtube/fixtures/invidious--channel-live.json'
import invidiousPosts from './youtube/fixtures/invidious--channel-posts.json'
import localOrdinary from './youtube/fixtures/local--channel-ordinary.json'
import localPosts from './youtube/fixtures/local--channel-posts.json'

// A cache entry the channel page writes from a layer summary against the one
// the subscription feed's own descriptor writes for the same module answer
// (story 59): the same answer handed to both paths, the descriptor's
// `fetchChannel` (whose entries the refresh dispatches as they are) and the
// layer's list read through the mapping. Key for key, so that neither the
// feed, nor the back-fill, nor the carry-over (which read `lengthSeconds`,
// `liveNow`, `isUpcoming`, `premiereDate`, `published`, `viewCount`, `isRSS`
// and the other detail flags) can tell which path wrote an entry.

vi.mock('../store/index', async () => {
  const { createFakeStore } = await import('../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getBackendPreference: 'local',
        getBackendFallback: false,
        getCurrentInvidiousInstanceUrl: 'https://invidious.example',
        getForbiddenTitles: '[]',
        getHideLiveStreams: false,
      },
    }),
  }
})

// The modules' fetching functions, which the descriptors call; the layer is
// handed the same answers through its fake
vi.mock('../helpers/api/local', () => ({
  getLocalChannel: vi.fn(),
  getLocalChannelVideos: vi.fn(),
  getLocalChannelLiveStreams: vi.fn(),
  getLocalChannelCommunity: vi.fn(),
}))

vi.mock('../helpers/api/invidious', () => ({
  getInvidiousChannelVideos: vi.fn(),
  getInvidiousChannelLive: vi.fn(),
  invidiousGetCommunityPosts: vi.fn(),
  invidiousFetch: vi.fn(),
}))

vi.mock('../helpers/utils', () => ({
  getChannelPlaylistId: vi.fn(id => id),
  showToast: vi.fn(),
  copyToClipboard: vi.fn(),
}))

vi.mock('../i18n/index', () => ({
  default: { global: { t: key => key } },
}))

vi.mock('./vue', () => ({
  getPlatformLayer: vi.fn(),
  isPeerTubeEnabled: vi.fn(() => false),
}))

const BLENDER = 'UCSMOQeBJ2RAnuFungnQOxLg'
const STUB = Object.freeze({ id: BLENDER, name: 'Blender', thumbnail: 'https://yt3.googleusercontent.com/blender=s176' })

/**
 * A video as Local's `parseLocalListVideo` answers one off a channel's videos
 * tab, with every field it can set (synthesised from the parser)
 */
const LOCAL_VIDEO = Object.freeze({
  type: 'video',
  videoId: 'aaaaaaaaaaa',
  title: 'Blender 5.2 LTS',
  author: 'Blender',
  authorId: BLENDER,
  description: 'The release',
  viewCount: 123000,
  published: 1790000000000,
  lengthSeconds: 312,
  liveNow: false,
  isUpcoming: false,
  premiereDate: undefined,
  isPremiere: false,
  is4k: true,
  is8k: false,
  isNew: true,
  isVr180: false,
  isVr360: false,
  is3d: false,
  hasCaptions: true,
})

/** The same parser's live: no duration, live now */
const LOCAL_LIVE = Object.freeze({ ...LOCAL_VIDEO, videoId: 'liveliveliv', title: 'Blender Today Live', lengthSeconds: '', liveNow: true, published: 1790500000000, is4k: false, isNew: false })

/** The module's answer of the Invidious videos tab: the API's video object, published in ms */
const INVIDIOUS_VIDEOS = Object.freeze({
  videos: [{
    type: 'video',
    title: 'Blender 5.2 LTS',
    videoId: 'aaaaaaaaaaa',
    author: 'Blender',
    authorId: BLENDER,
    description: 'The release',
    descriptionHtml: '<p>The release</p>',
    viewCount: 123456,
    viewCountText: '123K views',
    lengthSeconds: 312,
    published: 1790000000000,
    publishedText: '3 days ago',
    liveNow: false,
    premium: false,
    isUpcoming: false,
    isNew: true,
    is4k: true,
    is8k: false,
    isVr180: false,
    isVr360: false,
    is3d: false,
    hasCaptions: true,
    videoThumbnails: [{ quality: 'medium', url: 'https://invidious.example/vi/aaaaaaaaaaa/mqdefault.jpg', width: 320, height: 180 }],
  }],
  continuation: 'videos-token-2',
})

/** A Local channel tab holding `items` under `key`, one page */
function localTab(key, items) {
  return { filters: [], [key]: items, has_continuation: false }
}

/**
 * The layer over a fake `youtube` answering every list from the same module
 * answers the descriptors are given
 *
 * @param {'local' | 'invidious'} backendPreference
 */
function createLayer(backendPreference) {
  const fake = createFakeYouTube({
    // What the lists read of the header: whose items they are
    parseLocalChannelHeader: () => ({ id: BLENDER, name: 'Blender' }),
    getLocalChannel: async () => withMethods(localOrdinary, () => ({
      getVideos: async () => localTab('videos', [{ id: LOCAL_VIDEO.videoId }]),
      getLiveStreams: async () => localTab('videos', [{ id: LOCAL_LIVE.videoId }]),
      getCommunity: async () => localTab('posts', localPosts.answer.map(post => ({ id: post.postId }))),
    })),
    // The module's parse of each node, the one the descriptor's module answer holds
    parseLocalChannelVideos: nodes => nodes.map(node => structuredClone([LOCAL_VIDEO, LOCAL_LIVE].find(video => video.videoId === node.id))),
    parseLocalCommunityPosts: nodes => nodes.map(node => structuredClone(localPosts.answer.find(post => post.postId === node.id))),
    getInvidiousChannelVideos: async () => structuredClone(INVIDIOUS_VIDEOS),
    getInvidiousChannelLive: async () => structuredClone(invidiousLive.answer),
    invidiousGetCommunityPosts: async () => structuredClone(invidiousPosts.answer),
  })

  return createPlatformLayer({
    fetch: () => Promise.reject(new TypeError('no network in tests')),
    youtube: fake.youtube,
    config: { backendPreference, backendFallback: false, currentInvidiousInstanceUrl: 'https://invidious.example' },
  })
}

beforeEach(() => {
  getLocalChannelVideos.mockReset().mockResolvedValue({ name: 'Blender', thumbnailUrl: STUB.thumbnail, videos: [structuredClone(LOCAL_VIDEO)], untitled: 0 })
  getLocalChannelLiveStreams.mockReset().mockResolvedValue({ name: 'Blender', thumbnailUrl: STUB.thumbnail, videos: [structuredClone(LOCAL_LIVE)] })
  getLocalChannelCommunity.mockReset().mockResolvedValue(structuredClone(localPosts.answer))
  getInvidiousChannelVideos.mockReset().mockResolvedValue(structuredClone(INVIDIOUS_VIDEOS))
  getInvidiousChannelLive.mockReset().mockResolvedValue(structuredClone(invidiousLive.answer))
  invidiousGetCommunityPosts.mockReset().mockResolvedValue(structuredClone(invidiousPosts.answer))
  // A descriptor that fell back to RSS would show as a failure, not a request
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('no network in tests'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** The channel page's list, by the feed it writes to */
const LIST_OF_FEED = {
  videos: layer => layer.listChannelVideos(BLENDER, { kind: 'videos', sort: 'newest' }),
  live: layer => layer.listChannelVideos(BLENDER, { kind: 'live', sort: 'newest' }),
  posts: layer => layer.listChannelPosts(BLENDER),
}

describe('a subscription cache entry written from the channel page', () => {
  it.each([
    ['videos', 'local'],
    ['videos', 'invidious'],
    ['live', 'local'],
    ['live', 'invidious'],
    ['posts', 'local'],
    ['posts', 'invidious'],
  ])('%s, %s: is key for key what the feed descriptor writes for the same answer', async (feed, backend) => {
    store.setGetter('getBackendPreference', backend)

    const descriptorResult = await subscriptionFeedDescriptor(feed).fetchChannel(STUB, { useRss: false })
    const page = await LIST_OF_FEED[feed](createLayer(backend))
    const written = subscriptionCacheEntries(page.items)

    expect(descriptorResult.entries.length).toBeGreaterThan(0)
    expect(written).toStrictEqual(descriptorResult.entries)
    written.forEach((entry, index) => {
      expect(Object.keys(entry).sort()).toEqual(Object.keys(descriptorResult.entries[index]).sort())
    })
  })

  it('leaves the layer\'s item as it was, for the page to go on showing', () => {
    const item = { ...LOCAL_VIDEO, thumbnail: '' }

    const entry = subscriptionCacheEntry(item)
    entry.lengthSeconds = 1

    expect(item).toEqual({ ...LOCAL_VIDEO, thumbnail: '' })
  })
})
