import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ordinary from '../api/fixtures/local--player-ordinary.json'

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getCollectionShares: [],
        getCollectionVideos: {},
        getBackendPreference: 'local',
        getCollectionsReady: true,
        getCollectionsGrabFailed: false,
        getEnablePeerTube: false,
      },
    }),
  }
})

/** The enrichment lane, as jobs the test runs or drops */
const lane = []

vi.mock('../subscriptionWorker', () => ({
  LANE_ENRICHMENT: 'enrichment',
  enqueueSubscriptionJobs: vi.fn((_, jobs) => {
    lane.push(...jobs)
    return jobs.length
  }),
  removeSubscriptionJobs: vi.fn(),
}))

// The platform layer, which the PeerTube path asks
const fakeLayer = vi.hoisted(() => ({ getVideoSummary: vi.fn() }))
vi.mock('../../platform/vue', () => ({ getPlatformLayer: () => fakeLayer }))

vi.mock('../api/local', () => ({
  getLocalPlayerResponse: vi.fn(async () => ordinary.answer),
}))

const share = videoId => ({ _id: `hackertube|${videoId}`, sourceId: 'hackertube', videoId, title: '', author: '', votes: 1, sharedAt: null, seenAt: 0 })

/** The store the fresh runner reads, which the mock keeps from one test to the next */
let store

/** The runner of the test before, whose watches would otherwise answer this test's changes */
let runner = null

/** The crawl runner, fresh, with a store of its own: it keeps its state at module scope */
async function freshRunner() {
  runner?.forgetCollectionsCrawlForTests()
  vi.resetModules()
  store = (await import('../../store/index')).default
  store.setGetter('getCollectionShares', [share('aaaaaaaaaaa'), share('bbbbbbbbbbb'), share('ccccccccccc')])
  store.setGetter('getCollectionVideos', {})
  store.setGetter('getBackendPreference', 'local')
  store.setGetter('getEnablePeerTube', false)
  store.dispatched.length = 0
  runner = await import('./crawlRunner')
  return runner
}

/** A profile switch: the lane cancelled, every queued job told it will not run */
function cancelLane() {
  for (const job of lane.splice(0)) { job.dropped() }
}

describe('the crawl runner', () => {
  beforeEach(() => {
    lane.length = 0
    window.ftElectron = {
      claimCollectionsCrawl: vi.fn(async () => true),
      releaseCollectionsCrawl: vi.fn(),
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    delete window.ftElectron
  })

  it('crawls only once main has granted this window the crawl', async () => {
    window.ftElectron.claimCollectionsCrawl.mockResolvedValue(false)
    const { startCollectionsCrawl } = await freshRunner()

    await startCollectionsCrawl()

    expect(window.ftElectron.claimCollectionsCrawl).toHaveBeenCalled()
    expect(lane).toHaveLength(0)
  })

  it('crawls once granted, on the enrichment lane, a job weighing one request each', async () => {
    const { startCollectionsCrawl, collectionsCrawlProgress } = await freshRunner()

    await startCollectionsCrawl()

    expect(lane.map(job => [job.key, job.weight])).toEqual([
      ['collection-details-aaaaaaaaaaa', 1],
      ['collection-details-bbbbbbbbbbb', 1],
    ])
    expect(collectionsCrawlProgress.state).toBe('running')
  })

  it('gives the crawl back to main when it is done', async () => {
    const { startCollectionsCrawl, collectionsCrawlProgress } = await freshRunner()

    await startCollectionsCrawl()
    while (lane.length > 0) { await lane.shift().run() }

    expect(collectionsCrawlProgress.state).toBe('done')
    expect(window.ftElectron.releaseCollectionsCrawl).toHaveBeenCalled()
  })

  it('starts again by itself after a profile switch cancels the lane, collections not being per profile', async () => {
    const { startCollectionsCrawl, collectionsCrawlProgress } = await freshRunner()
    await startCollectionsCrawl()

    cancelLane()
    expect(collectionsCrawlProgress.state).toBe('stopped')

    await vi.waitFor(() => expect(lane).toHaveLength(2))
    expect(collectionsCrawlProgress.state).toBe('running')
  })

  it('does not start by itself when it was never started this session', async () => {
    await freshRunner()

    store.setGetter('getCollectionShares', [share('ddddddddddd')])
    await flushPromises()

    expect(lane).toHaveLength(0)
  })

  it('starts again when the backend comes back to Local', async () => {
    const { startCollectionsCrawl, collectionsCrawlProgress } = await freshRunner()
    await startCollectionsCrawl()

    store.setGetter('getBackendPreference', 'invidious')
    while (lane.length > 0) { await lane.shift().run() }
    await flushPromises()
    expect(collectionsCrawlProgress.state).toBe('stopped')
    expect(lane).toHaveLength(0)

    store.setGetter('getBackendPreference', 'local')
    await vi.waitFor(() => expect(lane.length).toBeGreaterThan(0))
    expect(collectionsCrawlProgress.state).toBe('running')
  })

  describe('its PeerTube path', () => {
    const UUID = '059ca8df-3049-44a3-93a9-d603327f2e74'
    const peerTubeShare = { _id: `lemmy:peertube@lemmy.world|${UUID}@tilvids.com`, sourceId: 'lemmy:peertube@lemmy.world', videoId: UUID, platform: 'peertube', host: 'tilvids.com', title: '', author: '', votes: 1, sharedAt: null, seenAt: 0 }

    beforeEach(() => {
      fakeLayer.getVideoSummary.mockReset()
      fakeLayer.getVideoSummary.mockImplementation(async ref => ({ type: 'video', platform: 'peertube', host: ref.host, videoId: ref.videoId, title: 'T', author: 'C', authorId: `c@${ref.host}`, lengthSeconds: 60, liveNow: false, isUpcoming: false, nsfw: false, thumbnail: '' }))
    })

    it('fills in a PeerTube video\'s details from the platform layer, off the lane, while PeerTube is on', async () => {
      const { startCollectionsCrawl } = await freshRunner()
      store.setGetter('getCollectionShares', [peerTubeShare])
      store.setGetter('getEnablePeerTube', true)

      await startCollectionsCrawl()
      await vi.waitFor(() => expect(store.dispatched.some(({ type }) => type === 'putCollectionVideos')).toBe(true))

      expect(fakeLayer.getVideoSummary).toHaveBeenCalledWith({ platform: 'peertube', host: 'tilvids.com', videoId: UUID })
      expect(store.dispatched.find(({ type }) => type === 'putCollectionVideos').payload).toEqual([expect.objectContaining({ _id: `${UUID}@tilvids.com`, lengthSeconds: 60 })])
      expect(lane).toHaveLength(0)
    })

    it('asks nothing while PeerTube is off, and starts once it is switched on', async () => {
      const { startCollectionsCrawl } = await freshRunner()
      store.setGetter('getCollectionShares', [peerTubeShare])

      await startCollectionsCrawl()
      await flushPromises()
      expect(fakeLayer.getVideoSummary).not.toHaveBeenCalled()

      store.setGetter('getEnablePeerTube', true)
      await vi.waitFor(() => expect(fakeLayer.getVideoSummary).toHaveBeenCalled())
    })
  })
})
