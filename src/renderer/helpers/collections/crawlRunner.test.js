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
})
