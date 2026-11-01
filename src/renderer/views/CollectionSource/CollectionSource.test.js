import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { h } from 'vue'
import { RouterView } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { createTestI18n } from '../../testing/i18n'
import { createTestRouter } from '../../testing/router'
import FtElementList from '../../components/FtElementList/FtElementList.vue'
import FtLoader from '../../components/FtLoader/FtLoader.vue'
import CollectionSource from './CollectionSource.vue'

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getCollectionsReady: true,
        getCollectionsLoading: false,
        getCollectionsLoadFailed: false,
        getCollectionSources: [],
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

vi.mock('../../helpers/collections/crawlRunner', async () => {
  const { reactive } = await import('vue')
  return {
    collectionsCrawlProgress: reactive({ state: 'idle', requests: 0 }),
    startCollectionsCrawl: vi.fn(),
  }
})

// helpers/utils imports the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

const HACKERTUBE = { _id: 'hackertube', kind: 'hackertube', url: 'https://hackertube.org', name: 'HackerTube' }
const MEALTIME = { _id: 'lemmy:mealtimevideos@lemmy.cafe', kind: 'lemmy', url: 'https://lemmy.cafe/c/mealtimevideos', name: 'mealtimevideos@lemmy.cafe' }

/**
 * @param {{ _id: string }} source
 * @param {string} videoId
 * @param {number} votes
 */
function share(source, videoId, votes) {
  return { _id: `${source._id}|${videoId}`, sourceId: source._id, videoId, title: videoId, author: '', votes, sharedAt: 0 }
}

/**
 * Opens a source's page as the app would host it, in a router view
 *
 * @param {string} sourceId
 */
async function openSourcePage(sourceId) {
  const router = createTestRouter([
    { path: '/sources/:sourceId', name: 'collectionSource', component: CollectionSource },
    { path: '/sources', name: 'sources' },
  ])
  await router.push({ name: 'collectionSource', params: { sourceId } })

  const wrapper = mount({ render: () => h(RouterView) }, {
    global: {
      plugins: [createTestI18n(), router, store],
      stubs: { FtElementList: true },
    },
  })
  await flushPromises()

  return { wrapper, router }
}

/** @param {import('@vue/test-utils').VueWrapper} wrapper */
const listed = wrapper => wrapper.findComponent(FtElementList).props('data')

enableAutoUnmount(afterEach)

describe('a source\'s page', () => {
  beforeEach(() => {
    sessionStorage.clear()
    store.dispatched.length = 0
    store.setGetter('getCollectionsReady', true)
    store.setGetter('getCollectionsGrabFailed', false)
    store.setGetter('getCollectionSources', [HACKERTUBE, MEALTIME])
    store.setGetter('getCollectionShares', [
      share(HACKERTUBE, 'aaaaaaaaaaa', 20),
      share(MEALTIME, 'aaaaaaaaaaa', 100),
      share(MEALTIME, 'bbbbbbbbbbb', 3),
      share(HACKERTUBE, 'ccccccccccc', 5),
    ])
  })

  it('is the wall of that source\'s videos alone, in the order of its own votes', async () => {
    const { wrapper } = await openSourcePage(MEALTIME._id)

    expect(listed(wrapper).map(video => [video.videoId, video.collection.votes])).toEqual([
      ['aaaaaaaaaaa', 100],
      ['bbbbbbbbbbb', 3],
    ])
    expect(wrapper.findComponent(FtElementList).props('aiWall')).toBe(true)
  })

  it('opens Collections, as Collections does, so that the bundle, a refresh and the crawl happen from here too', async () => {
    await openSourcePage(MEALTIME._id)

    expect(store.dispatched.map(({ type }) => type)).toEqual(['openCollections', 'refreshCollectionsIfDue'])
  })

  it('says what the source is, what kind of place, and the instance it is on, linked', async () => {
    const { wrapper } = await openSourcePage(MEALTIME._id)

    expect(wrapper.find('.sourceName').text()).toBe('mealtimevideos@lemmy.cafe')
    expect(wrapper.find('.sourceAbout').text()).toContain('Lemmy community')
    expect(wrapper.find('.sourceAbout a').attributes('href')).toBe('https://lemmy.cafe/c/mealtimevideos')
    expect(wrapper.find('.sourceAbout a').text()).toBe('lemmy.cafe')
  })

  it('carries HackerTube\'s credit on HackerTube\'s page, with links, and on no other', async () => {
    const { wrapper } = await openSourcePage(HACKERTUBE._id)

    const credit = wrapper.find('.credit')
    expect(credit.text()).toBe('Videos and notes from HackerTube, built on the open-index/hacker-news dataset, under ODC-By 1.0.')
    expect(credit.findAll('a').map(link => link.attributes('href'))).toEqual([
      'https://hackertube.org',
      'https://huggingface.co/datasets/open-index/hacker-news',
      'https://opendatacommons.org/licenses/by/1-0/',
    ])
    expect(listed(wrapper).map(video => [video.videoId, video.collection.votes])).toEqual([
      ['aaaaaaaaaaa', 20],
      ['ccccccccccc', 5],
    ])

    const other = await openSourcePage(MEALTIME._id)
    expect(other.wrapper.find('.credit').exists()).toBe(false)
  })

  it('says a source is not followed, with the way to those that are, and opens nothing', async () => {
    const { wrapper } = await openSourcePage('lemmy:gone@lemmy.example')

    expect(wrapper.find('.message').text()).toBe('This source is not followed. Sources lists those that are.')
    expect(wrapper.find('.message a').attributes('href')).toBe('/sources')
    expect(wrapper.findComponent(FtElementList).exists()).toBe(false)
    expect(store.dispatched).toEqual([])
  })

  it('stops being the source\'s page when it is unfollowed, as from another window', async () => {
    const { wrapper } = await openSourcePage(MEALTIME._id)

    store.setGetter('getCollectionSources', [HACKERTUBE])
    await flushPromises()

    expect(wrapper.find('.message').text()).toContain('not followed')
  })

  it('waits for the datastore before saying anything', async () => {
    store.setGetter('getCollectionsReady', false)
    store.setGetter('getCollectionSources', [])

    const { wrapper } = await openSourcePage(MEALTIME._id)

    expect(wrapper.findComponent(FtLoader).exists()).toBe(true)
    expect(wrapper.find('.message').exists()).toBe(false)
  })

  it('keeps the width of its wall apart from Collections\' and from other sources\'', async () => {
    sessionStorage.setItem('collectionsLimit', '1')
    sessionStorage.setItem(`collectionsLimit:${HACKERTUBE._id}`, '1')

    const { wrapper } = await openSourcePage(MEALTIME._id)

    expect(listed(wrapper)).toHaveLength(2)
  })
})
