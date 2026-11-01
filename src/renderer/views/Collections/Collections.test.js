import { enableAutoUnmount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { collectionsCrawlProgress, startCollectionsCrawl } from '../../helpers/collections/crawlRunner'
import { mountWithApp } from '../../testing/mount'
import FtElementList from '../../components/FtElementList/FtElementList.vue'
import FtLoader from '../../components/FtLoader/FtLoader.vue'
import FtRefreshWidget from '../../components/FtRefreshWidget/FtRefreshWidget.vue'
import Collections from './Collections.vue'

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getCollectionsReady: false,
        getCollectionsLoading: false,
        getCollectionsLoadFailed: false,
        getCollectionShares: [],
        getCollectionVideos: {},
        getCollectionsGrabFailed: false,
        getCollectionsRefreshing: false,
        getCollectionsRefreshProgress: { done: 0, total: 0 },
        getCollectionsLastRefreshAt: null,
        getCollectionsRefreshFailures: [],
      },
    }),
  }
})

// The crawl itself is tested in helpers/collections; here, only whether the
// page starts it and shows how far it has got
vi.mock('../../helpers/collections/crawlRunner', async () => {
  const { reactive } = await import('vue')
  return {
    collectionsCrawlProgress: reactive({ state: 'idle', requests: 0 }),
    startCollectionsCrawl: vi.fn(),
  }
})

// helpers/utils imports the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

/**
 * @param {number} index
 * @param {number} votes
 */
function share(index, votes) {
  const videoId = `video${String(index).padStart(6, '0')}`
  return { _id: `hackertube|${videoId}`, sourceId: 'hackertube', videoId, title: `Title ${index}`, author: 'Channel', votes, sharedAt: 0 }
}

function mountCollections() {
  return mountWithApp(Collections, {
    store,
    stubs: { FtElementList: true, FtAutoLoadNextPageWrapper: false },
  })
}

/** @param {import('@vue/test-utils').VueWrapper} wrapper */
function listed(wrapper) {
  return wrapper.findComponent(FtElementList).props('data')
}

enableAutoUnmount(afterEach)

describe('Collections', () => {
  beforeEach(() => {
    sessionStorage.clear()
    store.dispatched.length = 0
    store.setGetter('getCollectionsReady', false)
    store.setGetter('getCollectionsLoading', false)
    store.setGetter('getCollectionsLoadFailed', false)
    store.setGetter('getCollectionShares', [])
    store.setGetter('getCollectionVideos', {})
    store.setGetter('getCollectionsGrabFailed', false)
    store.setGetter('getCollectionsRefreshing', false)
    store.setGetter('getCollectionsRefreshProgress', { done: 0, total: 0 })
    store.setGetter('getCollectionsLastRefreshAt', null)
    store.setGetter('getCollectionsRefreshFailures', [])
    collectionsCrawlProgress.state = 'idle'
    vi.mocked(startCollectionsCrawl).mockClear()
  })

  it('opens Collections once the datastore has loaded, and not before', async () => {
    const wrapper = mountCollections()
    await flushPromises()

    expect(store.dispatched.map(({ type }) => type)).toEqual([])
    expect(wrapper.findComponent(FtLoader).exists()).toBe(true)

    store.setGetter('getCollectionsReady', true)
    await flushPromises()

    expect(store.dispatched.map(({ type }) => type)).toEqual(['openCollections', 'refreshCollectionsIfDue'])
  })

  it('shows a loader while the bundle loads', async () => {
    store.setGetter('getCollectionsReady', true)
    store.setGetter('getCollectionsLoading', true)

    const wrapper = mountCollections()
    await flushPromises()

    expect(wrapper.findComponent(FtLoader).exists()).toBe(true)
    expect(wrapper.findComponent(FtElementList).exists()).toBe(false)
  })

  it('is one ordinary card per video, the most voted first, a hundred at a time on a wall that looks up AI labels', async () => {
    store.setGetter('getCollectionsReady', true)
    store.setGetter('getCollectionShares', Array.from({ length: 150 }, (_, index) => share(index, index)))

    const wrapper = mountCollections()
    await flushPromises()

    const data = listed(wrapper)
    expect(data).toHaveLength(100)
    expect(data[0]).toMatchObject({ type: 'video', videoId: 'video000149', title: 'Title 149', author: 'Channel', lengthSeconds: '' })
    expect(data[99].videoId).toBe('video000050')
    expect(wrapper.findComponent(FtElementList).props('aiWall')).toBe(true)

    // Load more, after the refresh button
    await wrapper.findAll('button').at(-1).trigger('click')

    expect(listed(wrapper)).toHaveLength(150)
  })

  it('shows a hundred when the window remembered for the session is not a number', async () => {
    for (const saved of ['garbage', '0', '-5']) {
      sessionStorage.setItem('collectionsLimit', saved)
      store.setGetter('getCollectionsReady', true)
      store.setGetter('getCollectionShares', Array.from({ length: 150 }, (_, index) => share(index, index)))

      const wrapper = mountCollections()
      await flushPromises()

      expect(listed(wrapper), saved).toHaveLength(100)
      wrapper.unmount()
    }
  })

  it('credits HackerTube, the dataset and the licence, with links', async () => {
    store.setGetter('getCollectionsReady', true)

    const wrapper = mountCollections()
    await flushPromises()

    const credit = wrapper.find('.credit')
    expect(credit.text()).toBe('Videos and notes from HackerTube, built on the open-index/hacker-news dataset, under ODC-By 1.0.')
    expect(credit.findAll('a').map(link => link.attributes('href'))).toEqual([
      'https://hackertube.org',
      'https://huggingface.co/datasets/open-index/hacker-news',
      'https://opendatacommons.org/licenses/by/1-0/',
    ])
  })

  it('says so when the bundle could not be loaded and there is nothing to show', async () => {
    store.setGetter('getCollectionsReady', true)
    store.setGetter('getCollectionsLoadFailed', true)

    const wrapper = mountCollections()
    await flushPromises()

    expect(wrapper.find('.message').text()).toContain('could not be loaded')
  })

  it('starts the crawl once Collections is open and has videos', async () => {
    store.setGetter('getCollectionShares', [share(1, 1)])
    mountCollections()
    await flushPromises()
    expect(startCollectionsCrawl).not.toHaveBeenCalled()

    store.setGetter('getCollectionsReady', true)
    await flushPromises()

    expect(startCollectionsCrawl).toHaveBeenCalledTimes(1)
  })

  it('starts the crawl without waiting for the refresh, but after the bundle is in', async () => {
    store.setGetter('getCollectionShares', [share(1, 1)])
    const dispatch = store.dispatch
    let finishOpen
    store.dispatch = (type, payload) => {
      dispatch(type, payload)
      if (type === 'openCollections') { return new Promise((resolve) => { finishOpen = resolve }) }
      // A refresh that never ends
      return new Promise(() => {})
    }

    try {
      store.setGetter('getCollectionsReady', true)
      mountCollections()
      await flushPromises()
      expect(startCollectionsCrawl).not.toHaveBeenCalled()

      finishOpen()
      await flushPromises()

      expect(store.dispatched.map(({ type }) => type)).toEqual(['openCollections', 'refreshCollectionsIfDue'])
      expect(startCollectionsCrawl).toHaveBeenCalledTimes(1)
    } finally {
      store.dispatch = dispatch
    }
  })

  it('does not start the crawl when the videos could not be loaded', async () => {
    store.setGetter('getCollectionsReady', true)
    store.setGetter('getCollectionsLoadFailed', true)

    mountCollections()
    await flushPromises()

    expect(startCollectionsCrawl).not.toHaveBeenCalled()
  })

  it('starts the crawl once a refresh brings the videos the bundle could not', async () => {
    store.setGetter('getCollectionsReady', true)
    store.setGetter('getCollectionsLoadFailed', true)
    mountCollections()
    await flushPromises()

    store.setGetter('getCollectionsLoadFailed', false)
    store.setGetter('getCollectionShares', [share(1, 1)])
    await flushPromises()

    expect(startCollectionsCrawl).toHaveBeenCalledTimes(1)
  })

  it('shows the crawl in the refresh widget while it runs, with how many videos have their details, and nothing once it is done', async () => {
    store.setGetter('getCollectionsReady', true)
    store.setGetter('getCollectionShares', Array.from({ length: 4 }, (_, index) => share(index, index)))
    store.setGetter('getCollectionVideos', { video000001: { _id: 'video000001', videoId: 'video000001', fetchedAt: 1 } })
    collectionsCrawlProgress.state = 'running'

    const wrapper = mountCollections()
    await flushPromises()

    const widget = () => wrapper.findComponent(FtRefreshWidget)
    expect(widget().props('activityLabel')).toBe('Fetching video details')
    expect(widget().props('activityProgress')).toBe(0.25)

    collectionsCrawlProgress.state = 'paused'
    await flushPromises()
    expect(widget().props('activityLabel')).toBe('Video details paused')

    collectionsCrawlProgress.state = 'done'
    await flushPromises()
    expect(widget().props('activityLabel')).toBe('')
    expect(widget().props('activityProgress')).toBe(null)
  })

  describe('the refresh widget', () => {
    it('says when every source was last refreshed', async () => {
      store.setGetter('getCollectionsReady', true)
      store.setGetter('getCollectionsLastRefreshAt', 1_700_000_000_000)

      const wrapper = mountCollections()
      await flushPromises()

      expect(wrapper.findComponent(FtRefreshWidget).props('lastRefreshAt')).toBe(1_700_000_000_000)
    })

    it('refreshes from its button', async () => {
      store.setGetter('getCollectionsReady', true)
      const wrapper = mountCollections()
      await flushPromises()
      store.dispatched.length = 0

      wrapper.findComponent(FtRefreshWidget).vm.$emit('click')

      expect(store.dispatched.map(({ type }) => type)).toEqual(['refreshCollections'])
    })

    it('refreshes on R and F5, and not on a key held down or while typing', async () => {
      store.setGetter('getCollectionsReady', true)
      mountCollections()
      await flushPromises()
      store.dispatched.length = 0

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5' }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', repeat: true }))

      const input = document.createElement('input')
      input.classList.add('ft-input')
      document.body.appendChild(input)
      input.focus()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }))
      input.remove()

      expect(store.dispatched.map(({ type }) => type)).toEqual(['refreshCollections', 'refreshCollections'])
    })

    it('does not refresh while a refresh runs, while the bundle loads, or before the datastore is read', async () => {
      for (const [getter, value] of [['getCollectionsRefreshing', true], ['getCollectionsLoading', true], ['getCollectionsReady', false], ['getCollectionsGrabFailed', true]]) {
        store.setGetter('getCollectionsReady', true)
        store.setGetter(getter, value)
        const wrapper = mountCollections()
        await flushPromises()
        store.dispatched.length = 0

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }))

        expect(wrapper.findComponent(FtRefreshWidget).props('disableRefresh'), getter).toBe(true)
        expect(store.dispatched, getter).toEqual([])
        wrapper.unmount()
        store.setGetter(getter, getter === 'getCollectionsReady')
      }
    })

    it('says it is refreshing in place of the crawl, with how many sources are done when there is more than one', async () => {
      store.setGetter('getCollectionsReady', true)
      store.setGetter('getCollectionsRefreshing', true)
      store.setGetter('getCollectionsRefreshProgress', { done: 0, total: 1 })
      collectionsCrawlProgress.state = 'running'

      const wrapper = mountCollections()
      await flushPromises()

      const widget = wrapper.findComponent(FtRefreshWidget)
      expect(widget.props('activityLabel')).toBe('Asking the sources for new videos')
      expect(widget.props('activityProgress')).toBe(null)

      store.setGetter('getCollectionsRefreshProgress', { done: 1, total: 4 })
      await flushPromises()
      expect(widget.props('activityProgress')).toBe(0.25)
    })

    it('says which sources could not be refreshed, and nothing when all could', async () => {
      store.setGetter('getCollectionsReady', true)
      const wrapper = mountCollections()
      await flushPromises()

      expect(wrapper.find('.refreshFailed').exists()).toBe(false)

      store.setGetter('getCollectionsRefreshFailures', [{ _id: 'hackertube', name: 'HackerTube', failedAt: 1 }])
      await flushPromises()

      expect(wrapper.find('.refreshFailed').text()).toBe('Could not refresh HackerTube')
    })
  })

  it('shows a video\'s details on its card once they are in, and leaves an unavailable one off', async () => {
    store.setGetter('getCollectionsReady', true)
    store.setGetter('getCollectionShares', [share(1, 2), share(2, 1)])
    store.setGetter('getCollectionVideos', {
      video000001: { _id: 'video000001', videoId: 'video000001', fetchedAt: 7, authorId: 'UCaaaaaaaaaaaaaaaaaaaaaa', lengthSeconds: 60, viewCount: 5 },
      video000002: { _id: 'video000002', videoId: 'video000002', fetchedAt: 7, unavailable: 'private' },
    })

    const wrapper = mountCollections()
    await flushPromises()

    expect(listed(wrapper)).toEqual([expect.objectContaining({ videoId: 'video000001', authorId: 'UCaaaaaaaaaaaaaaaaaaaaaa', lengthSeconds: 60, viewCount: 5, lastUpdatedAt: 7 })])
  })
})
