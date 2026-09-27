import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'

import store from '../store/index'
import { isPeerTubeEnabled } from '../platform/vue'
import { refreshAllSubscriptionFeeds, refreshSubscriptionFeeds } from '../helpers/subscriptionRefresh'
import { mountWithApp } from '../testing/mount'
import { useSubscriptionFeed } from './useSubscriptionFeed'

// What the subscriptions page decides to fetch when it is opened from the
// cache: every kind the cache cannot supply in full for the profile. Only that
// decision is under test, through what it asks the refresh for.

vi.mock('../store/index', async () => {
  const { createFakeStore } = await import('../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getActiveProfile: { _id: 'allChannels', subscriptions: [] },
        getSubscriptionCacheReady: true,
        getFetchSubscriptionsAutomatically: true,
        // Not the first visit of the window, so the page reads the cache
        // rather than refreshing everything on principle
        getSubscriptionsFirstAutoFetchRun: true,
        getVideoCache: {},
        getShortsCache: {},
        getLiveCache: {},
        getPostsCache: {},
      },
    }),
  }
})

vi.mock('../helpers/subscriptionRefresh', async () => {
  const { ref } = await import('vue')
  const states = new Map()
  return {
    refreshSubscriptionFeeds: vi.fn(async () => {}),
    refreshAllSubscriptionFeeds: vi.fn(async () => {}),
    cancelSubscriptionRefresh: vi.fn(),
    subscriptionFeedState: (feed) => {
      if (!states.has(feed)) {
        states.set(feed, { isRefreshing: ref(false), attemptedFetch: ref(false), revision: ref(0), lastSuccessAt: ref(null), unresolvedChannels: ref([]) })
      }
      return states.get(feed)
    },
  }
})

vi.mock('../helpers/subscriptionDetailBackfill', async () => {
  const { ref } = await import('vue')
  return { backfillDetailsForVisibleVideos: vi.fn(), detailBackfillRevision: ref(0) }
})

vi.mock('../platform/vue', () => ({
  getPlatformLayer: vi.fn(),
  isPeerTubeEnabled: vi.fn(() => false),
}))

vi.mock('../helpers/api/local', () => ({}))
vi.mock('../helpers/api/invidious', () => ({}))

const FEEDS = ['videos', 'shorts', 'live', 'posts']

const youtube = n => ({ id: `UC${String(n).padStart(22, 'a')}`, name: `YouTube ${n}`, thumbnail: '' })
const peerTube = n => ({ id: `channel_${n}@video.example`, name: `PeerTube ${n}`, thumbnail: '', platform: 'peertube', host: 'video.example' })

const CACHE_GETTERS = { videos: 'getVideoCache', shorts: 'getShortsCache', live: 'getLiveCache', posts: 'getPostsCache' }

/** A cache entry for one feed, as the store keeps it */
function cacheEntry(feed, entries = []) {
  return { timestamp: new Date('2026-09-27T12:00:00Z'), [feed === 'posts' ? 'posts' : 'videos']: entries }
}

/**
 * @param {object[]} subscriptions
 * @param {Record<string, object[]>} cached channels with a cache entry, per feed
 */
function given(subscriptions, cached) {
  store.setGetter('getActiveProfile', { _id: 'allChannels', subscriptions })

  for (const feed of FEEDS) {
    store.setGetter(CACHE_GETTERS[feed], Object.fromEntries((cached[feed] ?? []).map(channel => [channel.id, cacheEntry(feed)])))
  }
}

const everyFeed = channels => Object.fromEntries(FEEDS.map(feed => [feed, channels]))

let wrapper = null

/** Opens the page, and answers which kinds it asked the refresh for */
async function openPage() {
  wrapper = mountWithApp(defineComponent({
    setup() {
      useSubscriptionFeed()
      return () => h('div')
    },
  }), { store })
  await flushPromises()

  expect(refreshAllSubscriptionFeeds).not.toHaveBeenCalled()
  return refreshSubscriptionFeeds.mock.calls.map(([feeds]) => feeds)
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

beforeEach(() => {
  refreshSubscriptionFeeds.mockClear()
  refreshAllSubscriptionFeeds.mockClear()
  isPeerTubeEnabled.mockReturnValue(false)
})

describe('the subscriptions page, opened from the cache, with only YouTube channels (as before PeerTube)', () => {
  const channels = [youtube(1), youtube(2)]

  it.each([false, true])('fetches nothing when every kind is cached for every channel (PeerTube on: %s)', async (enabled) => {
    isPeerTubeEnabled.mockReturnValue(enabled)
    given(channels, everyFeed(channels))

    expect(await openPage()).toEqual([])
  })

  it.each([false, true])('fetches the kinds a channel is missing from (PeerTube on: %s)', async (enabled) => {
    isPeerTubeEnabled.mockReturnValue(enabled)
    given(channels, { ...everyFeed(channels), shorts: [channels[0]], posts: [] })

    expect(await openPage()).toEqual([['shorts', 'posts']])
  })

  it('counts a cache entry without its list as missing', async () => {
    given(channels, everyFeed(channels))
    store.setGetter('getLiveCache', { ...store.getters.getLiveCache, [channels[1].id]: { timestamp: new Date(), videos: null } })

    expect(await openPage()).toEqual([['live']])
  })

  it('fetches every kind for a profile with no channels, as before', async () => {
    given([], {})

    expect(await openPage()).toEqual([FEEDS])
  })
})

describe('the subscriptions page, opened from the cache, with PeerTube channels', () => {
  it('does not wait on shorts or posts from a PeerTube channel, which has neither', async () => {
    isPeerTubeEnabled.mockReturnValue(true)
    const [yt, pt] = [youtube(1), peerTube(1)]
    given([yt, pt], { videos: [yt, pt], live: [yt, pt], shorts: [yt], posts: [yt] })

    expect(await openPage()).toEqual([])
  })

  it('does wait on videos and live from a PeerTube channel, while PeerTube is on', async () => {
    isPeerTubeEnabled.mockReturnValue(true)
    const [yt, pt] = [youtube(1), peerTube(1)]
    given([yt, pt], { videos: [yt, pt], live: [yt], shorts: [yt], posts: [yt] })

    expect(await openPage()).toEqual([['live']])
  })

  it('does not wait on a PeerTube channel while PeerTube is off', async () => {
    const [yt, pt] = [youtube(1), peerTube(1)]
    given([yt, pt], everyFeed([yt]))

    expect(await openPage()).toEqual([])
  })

  it('fetches nothing for a profile of PeerTube channels only, with PeerTube off and nothing cached', async () => {
    given([peerTube(1), peerTube(2)], {})

    expect(await openPage()).toEqual([])
  })

  it('fetches only videos and live for a profile of PeerTube channels only, with PeerTube on and nothing cached', async () => {
    isPeerTubeEnabled.mockReturnValue(true)
    given([peerTube(1)], {})

    expect(await openPage()).toEqual([['videos', 'live']])
  })
})
