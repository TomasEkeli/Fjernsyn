import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { getLocalChannelLiveStreams, getLocalChannelVideos } from '../api/local'
import { getPlatformLayer, isPeerTubeEnabled } from '../../platform/vue'
import { subscriptionFeedDescriptor } from './index'
import { refreshSubscriptionFeeds, subscriptionFeedState } from '../subscriptionRefresh'
import {
  resetSubscriptionWorkerForTests,
  setSubscriptionWorkerDelayForTests,
  subscriptionWorkerBusy
} from '../subscriptionWorker'
import { resetSubscriptionRecoveryForTests } from '../subscriptionRecovery'
import { resetDetailBackfillForTests } from '../subscriptionDetailBackfill'
import {
  unavailableChannels,
  FETCH_FAILED,
  FETCH_OK,
  FETCH_RATE_LIMITED,
  FETCH_SKIPPED,
  FETCH_UNAVAILABLE
} from '../subscriptionFetchStatus'

// The refresh path as the app runs it, from the feed descriptors down, with
// every edge replaced: the store (what the refresh reads and dispatches), the
// YouTube backends (spies, so a PeerTube channel reaching one shows), and the
// platform layer (a fake whose `fetchChannelFeed` answers what each test says).

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getActiveProfile: { _id: 'allChannels', subscriptions: [] },
        getProfileList: [],
        getBackendPreference: 'local',
        getBackendFallback: false,
        getUseRssFeeds: false,
        getSubscriptionAutoRecovery: true,
        getSubscriptionBackfillDetails: true,
        getCurrentInvidiousInstanceUrl: 'https://invidious.example',
        getHideLiveStreams: false,
        getHideUpcomingPremieres: false,
        getForbiddenTitles: '[]',
      },
    }),
  }
})

vi.mock('../api/local', () => ({
  getLocalChannel: vi.fn(),
  getLocalChannelVideos: vi.fn(),
  getLocalChannelLiveStreams: vi.fn(),
  getLocalChannelCommunity: vi.fn(),
}))

vi.mock('../api/invidious', () => ({
  getInvidiousChannelVideos: vi.fn(),
  getInvidiousChannelLive: vi.fn(),
  invidiousGetCommunityPosts: vi.fn(),
  invidiousFetch: vi.fn(),
}))

vi.mock('../utils', () => ({
  getChannelPlaylistId: vi.fn((id) => id),
  showToast: vi.fn(),
  copyToClipboard: vi.fn(),
}))

vi.mock('../../i18n/index', () => ({
  default: { global: { t: (key) => key } },
}))

vi.mock('../../platform/vue', () => {
  const layer = { fetchChannelFeed: vi.fn() }
  return {
    getPlatformLayer: vi.fn(() => layer),
    isPeerTubeEnabled: vi.fn(() => true),
  }
})

const YOUTUBE = Object.freeze({ id: 'UCaaaaaaaaaaaaaaaaaaaaaa', name: 'A YouTube channel', thumbnail: 'https://yt3.ggpht.com/a' })

/**
 * @param {number} n
 * @param {string} [host]
 */
function peerTubeStub(n = 0, host = 'video.example') {
  const handle = `channel_${n}@${host}`
  return { id: handle, name: `PeerTube ${n}`, thumbnail: `https://${host}/avatar.png`, platform: 'peertube', host }
}

const PEERTUBE = Object.freeze(peerTubeStub())

const PEERTUBE_ENTRY = Object.freeze({
  type: 'video',
  platform: 'peertube',
  host: 'video.example',
  videoId: '2c9347ab-7090-4f5a-a541-ca27340e9c9b',
  title: 'An upload',
  author: 'PeerTube 0',
  authorId: PEERTUBE.id,
  thumbnail: 'https://video.example/thumb.jpg',
  // Deliberately without a duration: the back-fill would ask YouTube for one
  liveNow: false,
  isUpcoming: false,
  published: 1790000000000,
})

const layer = getPlatformLayer()

/** @param {object[]} subscriptions */
function subscribe(subscriptions) {
  store.setGetter('getActiveProfile', { _id: 'allChannels', subscriptions })
}

/** The cache writes the refresh asked the store for, by channel */
function cacheWrites(action = 'updateSubscriptionVideosCacheByChannel') {
  return store.dispatched.filter(({ type }) => type === action).map(({ payload }) => payload)
}

beforeEach(() => {
  resetSubscriptionWorkerForTests()
  resetSubscriptionRecoveryForTests()
  resetDetailBackfillForTests()
  setSubscriptionWorkerDelayForTests(0)
  store.dispatched.length = 0
  store.committed.length = 0
  store.setGetter('getSubscriptionAutoRecovery', true)
  isPeerTubeEnabled.mockReturnValue(true)
  layer.fetchChannelFeed.mockReset()
  getLocalChannelVideos.mockReset()
  getLocalChannelLiveStreams.mockReset()
  getLocalChannelVideos.mockResolvedValue({ videos: [], name: 'A YouTube channel', thumbnailUrl: 'https://yt3.ggpht.com/a=s88' })
  getLocalChannelLiveStreams.mockResolvedValue({ videos: [], name: 'A YouTube channel', thumbnailUrl: 'https://yt3.ggpht.com/a=s88' })
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('no network in tests'))
  subscribe([])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the feed descriptors dispatch on the channel\'s platform', () => {
  it.each(['videos', 'live', 'shorts', 'posts'])('a PeerTube channel\'s %s go to the layer, and never to YouTube', async (feed) => {
    layer.fetchChannelFeed.mockResolvedValue({ status: FETCH_OK, entries: [PEERTUBE_ENTRY] })

    const result = await subscriptionFeedDescriptor(feed).fetchChannel(PEERTUBE, { useRss: true })

    expect(layer.fetchChannelFeed).toHaveBeenCalledWith(PEERTUBE, feed)
    expect(result).toEqual({ status: FETCH_OK, entries: [PEERTUBE_ENTRY] })
    expect(getLocalChannelVideos).not.toHaveBeenCalled()
    expect(getLocalChannelLiveStreams).not.toHaveBeenCalled()
    // No RSS either
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('a YouTube channel goes where it always went, and the layer is not asked', async () => {
    const result = await subscriptionFeedDescriptor('videos').fetchChannel(YOUTUBE, { useRss: false })

    expect(getLocalChannelVideos).toHaveBeenCalledWith(YOUTUBE.id)
    expect(result).toEqual({
      status: FETCH_OK,
      entries: [],
      name: 'A YouTube channel',
      thumbnailUrl: 'https://yt3.ggpht.com/a=s88'
    })
    expect(layer.fetchChannelFeed).not.toHaveBeenCalled()
  })

  it('a YouTube channel over RSS still asks YouTube\'s RSS, not the layer', async () => {
    await subscriptionFeedDescriptor('videos').fetchChannel(YOUTUBE, { useRss: true })

    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining('youtube.com/feeds/videos.xml'))
    expect(layer.fetchChannelFeed).not.toHaveBeenCalled()
  })

  it.each([
    [FETCH_RATE_LIMITED],
    [FETCH_FAILED],
  ])('passes a %s answer through, writing nothing', async (status) => {
    layer.fetchChannelFeed.mockResolvedValue({ status, entries: null, error: new Error('down') })

    expect(await subscriptionFeedDescriptor('videos').fetchChannel(PEERTUBE, { useRss: false }))
      .toEqual({ status, entries: null })
  })

  it('a layer that throws is a failure, not a thrown refresh', async () => {
    layer.fetchChannelFeed.mockRejectedValue(new Error('surprise'))

    expect(await subscriptionFeedDescriptor('live').fetchChannel(PEERTUBE, { useRss: false }))
      .toEqual({ status: FETCH_FAILED, entries: null })
  })

  it('returns no name or avatar for a PeerTube channel, so the stub is never rewritten as YouTube\'s', async () => {
    layer.fetchChannelFeed.mockResolvedValue({ status: FETCH_OK, entries: [], name: 'x', thumbnailUrl: 'https://x.example/a=s88' })

    const result = await subscriptionFeedDescriptor('videos').fetchChannel(PEERTUBE, { useRss: false })

    expect(result).not.toHaveProperty('name')
    expect(result).not.toHaveProperty('thumbnailUrl')
  })

  it('with PeerTube off, a PeerTube channel is skipped without asking anyone', async () => {
    isPeerTubeEnabled.mockReturnValue(false)

    expect(await subscriptionFeedDescriptor('videos').fetchChannel(PEERTUBE, { useRss: false }))
      .toEqual({ status: FETCH_SKIPPED, entries: null })
    expect(layer.fetchChannelFeed).not.toHaveBeenCalled()
    expect(getLocalChannelVideos).not.toHaveBeenCalled()
  })
})

describe('a refresh with PeerTube channels in it', () => {
  it('caches a PeerTube channel\'s answer beside YouTube\'s, with no back-fill and no stub rewrite for it', async () => {
    subscribe([YOUTUBE, PEERTUBE])
    layer.fetchChannelFeed.mockResolvedValue({ status: FETCH_OK, entries: [PEERTUBE_ENTRY] })

    await refreshSubscriptionFeeds(['videos'])

    expect(cacheWrites()).toEqual(expect.arrayContaining([
      { channelId: PEERTUBE.id, videos: [PEERTUBE_ENTRY] },
      { channelId: YOUTUBE.id, videos: [] },
    ]))
    // Only YouTube's name and avatar are handed on for the stubs
    const details = store.dispatched.filter(({ type }) => type === 'batchUpdateSubscriptionDetails')
    expect(details.flatMap(({ payload }) => payload).map(({ channelId }) => channelId)).toEqual([YOUTUBE.id])
    // The PeerTube entry lacks a duration and the back-fill still did not ask
    // YouTube for its channel
    await vi.waitFor(() => expect(subscriptionWorkerBusy()).toBe(false))
    expect(getLocalChannelVideos.mock.calls).toEqual([[YOUTUBE.id]])
  })

  it('a 404 from the origin goes through the gone verdict: the channel is reported, and emptiness cached', async () => {
    subscribe([PEERTUBE])
    layer.fetchChannelFeed.mockResolvedValue({ status: FETCH_UNAVAILABLE, entries: [], error: new Error('404') })

    await refreshSubscriptionFeeds(['videos'])

    expect(unavailableChannels('videos').map(channel => channel.id)).toEqual([PEERTUBE.id])
    expect(cacheWrites()).toEqual([{ channelId: PEERTUBE.id, videos: [] }])
    expect(subscriptionFeedState('videos').unresolvedChannels.value).toEqual([])
  })

  it('counts PeerTube disappearances against the anomaly limit: past it, nothing more is condemned', async () => {
    // The limit is max(15, 20% of the channels): 15 here. One channel per
    // host, so that no host's own limit is reached first
    const channels = Array.from({ length: 16 }, (_, n) => peerTubeStub(n, `video${n}.example`))
    subscribe(channels)
    store.setGetter('getSubscriptionAutoRecovery', false)
    layer.fetchChannelFeed.mockResolvedValue({ status: FETCH_UNAVAILABLE, entries: [], error: new Error('404') })

    await refreshSubscriptionFeeds(['videos'])

    expect(unavailableChannels('videos')).toHaveLength(15)
    expect(cacheWrites()).toHaveLength(15)
    expect(subscriptionFeedState('videos').unresolvedChannels.value).toHaveLength(1)
  })

  it('a single disappearance on a host is believed, beside that host\'s other channels answering', async () => {
    const gone = peerTubeStub(0)
    subscribe([gone, peerTubeStub(1), peerTubeStub(2)])
    layer.fetchChannelFeed.mockImplementation(async channel => channel.id === gone.id
      ? { status: FETCH_UNAVAILABLE, entries: [], error: new Error('404') }
      : { status: FETCH_OK, entries: [] })

    await refreshSubscriptionFeeds(['videos'])

    expect(unavailableChannels('videos').map(channel => channel.id)).toEqual([gone.id])
    expect(subscriptionFeedState('videos').unresolvedChannels.value).toEqual([])
  })

  it('a wave of disappearances from one host is not believed past the first: the rest are failures, their cache untouched', async () => {
    const wave = Array.from({ length: 5 }, (_, n) => peerTubeStub(n, 'wave.example'))
    const elsewhere = peerTubeStub(9, 'other.example')
    subscribe([...wave, elsewhere])
    store.setGetter('getSubscriptionAutoRecovery', false)
    layer.fetchChannelFeed.mockResolvedValue({ status: FETCH_UNAVAILABLE, entries: [], error: new Error('404') })

    await refreshSubscriptionFeeds(['videos'])

    const condemned = unavailableChannels('videos').map(channel => channel.id)
    expect(condemned.filter(id => id.endsWith('@wave.example'))).toHaveLength(1)
    // Another host's word is its own
    expect(condemned).toContain(elsewhere.id)
    expect(cacheWrites()).toHaveLength(2)
    expect(subscriptionFeedState('videos').unresolvedChannels.value).toHaveLength(4)
  })

  it('a host that claimed a wave is still not believed while its channels are recovered', async () => {
    const wave = Array.from({ length: 3 }, (_, n) => peerTubeStub(n, 'wave.example'))
    subscribe(wave)
    layer.fetchChannelFeed.mockResolvedValue({ status: FETCH_UNAVAILABLE, entries: [], error: new Error('404') })

    await refreshSubscriptionFeeds(['videos'])
    await vi.waitFor(() => expect(layer.fetchChannelFeed.mock.calls.length).toBeGreaterThan(wave.length))
    await vi.waitFor(() => expect(subscriptionWorkerBusy()).toBe(false))

    expect(unavailableChannels('videos')).toHaveLength(1)
    expect(cacheWrites()).toHaveLength(1)
  })

  it('the next refresh listens to the host again', async () => {
    const [first, second] = [peerTubeStub(0, 'wave.example'), peerTubeStub(1, 'wave.example')]
    store.setGetter('getSubscriptionAutoRecovery', false)
    layer.fetchChannelFeed.mockResolvedValue({ status: FETCH_UNAVAILABLE, entries: [], error: new Error('404') })

    subscribe([first, second])
    await refreshSubscriptionFeeds(['videos'])
    expect(unavailableChannels('videos')).toHaveLength(1)

    subscribe([second])
    await refreshSubscriptionFeeds(['videos'])
    expect(unavailableChannels('videos').map(channel => channel.id)).toEqual([second.id])
  })

  it('an outage writes nothing for the channel and sends it to recovery', async () => {
    subscribe([PEERTUBE])
    layer.fetchChannelFeed.mockResolvedValue({ status: FETCH_FAILED, entries: null, error: new Error('down') })

    await refreshSubscriptionFeeds(['videos'])

    expect(cacheWrites()).toEqual([])
    // Recovery goes back to the layer, and only to the layer
    await vi.waitFor(() => expect(layer.fetchChannelFeed.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(layer.fetchChannelFeed.mock.calls.every(([channel]) => channel === PEERTUBE)).toBe(true)
    expect(getLocalChannelVideos).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(subscriptionWorkerBusy()).toBe(false))
  })

  it('with PeerTube off, PeerTube channels are not fetched: their cache is untouched and nothing is recovered', async () => {
    isPeerTubeEnabled.mockReturnValue(false)
    subscribe([YOUTUBE, PEERTUBE])

    await refreshSubscriptionFeeds(['videos', 'live'])

    expect(layer.fetchChannelFeed).not.toHaveBeenCalled()
    expect(getLocalChannelVideos).toHaveBeenCalledWith(YOUTUBE.id)
    expect(getLocalChannelVideos).not.toHaveBeenCalledWith(PEERTUBE.id)
    for (const action of ['updateSubscriptionVideosCacheByChannel', 'updateSubscriptionLiveCacheByChannel']) {
      expect(cacheWrites(action).map(({ channelId }) => channelId)).toEqual([YOUTUBE.id])
    }
    expect(subscriptionFeedState('videos').unresolvedChannels.value).toEqual([])
    expect(subscriptionFeedState('live').unresolvedChannels.value).toEqual([])
  })

  it('never queues shorts or posts for a PeerTube channel, which has neither, and writes nothing for it there', async () => {
    subscribe([YOUTUBE, PEERTUBE])
    layer.fetchChannelFeed.mockResolvedValue({ status: FETCH_OK, entries: [] })

    await refreshSubscriptionFeeds(['shorts', 'posts'])
    await vi.waitFor(() => expect(subscriptionWorkerBusy()).toBe(false))

    expect(layer.fetchChannelFeed).not.toHaveBeenCalled()
    for (const action of ['updateSubscriptionShortsCacheByChannel', 'updateSubscriptionPostsCacheByChannel']) {
      expect(cacheWrites(action).map(({ channelId }) => channelId)).not.toContain(PEERTUBE.id)
    }
    expect(subscriptionFeedState('shorts').unresolvedChannels.value.map(({ id }) => id)).not.toContain(PEERTUBE.id)
    expect(subscriptionFeedState('posts').unresolvedChannels.value.map(({ id }) => id)).not.toContain(PEERTUBE.id)
  })

  it('still queues videos and live for a PeerTube channel', async () => {
    subscribe([PEERTUBE])
    layer.fetchChannelFeed.mockResolvedValue({ status: FETCH_OK, entries: [] })

    await refreshSubscriptionFeeds(['videos', 'shorts', 'live', 'posts'])

    expect(layer.fetchChannelFeed.mock.calls.map(([, feed]) => feed).sort()).toEqual(['live', 'videos'])
    expect(subscriptionFeedState('shorts').isRefreshing.value).toBe(false)
    expect(subscriptionFeedState('posts').isRefreshing.value).toBe(false)
  })

  it('with PeerTube off and only PeerTube channels, a refresh asks nobody and still finishes', async () => {
    isPeerTubeEnabled.mockReturnValue(false)
    subscribe([PEERTUBE])

    await refreshSubscriptionFeeds(['videos'])

    expect(layer.fetchChannelFeed).not.toHaveBeenCalled()
    expect(cacheWrites()).toEqual([])
    expect(subscriptionFeedState('videos').isRefreshing.value).toBe(false)
  })
})
