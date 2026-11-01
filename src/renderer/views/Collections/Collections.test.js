import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'
import FtElementList from '../../components/FtElementList/FtElementList.vue'
import FtLoader from '../../components/FtLoader/FtLoader.vue'
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
      },
    }),
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

describe('Collections', () => {
  beforeEach(() => {
    sessionStorage.clear()
    store.dispatched.length = 0
    store.setGetter('getCollectionsReady', false)
    store.setGetter('getCollectionsLoading', false)
    store.setGetter('getCollectionsLoadFailed', false)
    store.setGetter('getCollectionShares', [])
  })

  it('opens Collections once the datastore has loaded, and not before', async () => {
    const wrapper = mountCollections()
    await flushPromises()

    expect(store.dispatched.map(({ type }) => type)).toEqual([])
    expect(wrapper.findComponent(FtLoader).exists()).toBe(true)

    store.setGetter('getCollectionsReady', true)
    await flushPromises()

    expect(store.dispatched.map(({ type }) => type)).toEqual(['openCollections'])
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

    await wrapper.find('button').trigger('click')

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
})
