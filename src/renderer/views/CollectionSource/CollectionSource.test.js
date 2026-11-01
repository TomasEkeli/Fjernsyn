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
import CollectionsVoteBadge from '../../components/CollectionsVoteBadge/CollectionsVoteBadge.vue'
import { ThumbnailBadgeProbe } from '../../testing/thumbnailBadgeProbe'
import { shippedHackerTubeTaxonomy } from '../../helpers/collections/hackertubeBundle'

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
        getCollectionsSourcesHidden: [],
        getCollectionsSort: 'votes',
        getCollectionsSortDescending: true,
        getCollectionSource: () => undefined,
        getCollectionShare: () => undefined,
        getCollectionSourceData: () => undefined,
      },
    }),
  }
})

vi.mock('../../helpers/collections/hackertubeBundle', () => ({
  shippedHackerTubeTaxonomy: vi.fn(() => new Promise(() => {})),
}))

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
 * @param {import('vue').Component | true} [list] what stands in for the wall's list
 */
async function openSourcePage(sourceId, list = true) {
  const router = createTestRouter([
    { path: '/sources/:sourceId', name: 'collectionSource', component: CollectionSource },
    { path: '/sources', name: 'sources' },
  ])
  await router.push({ name: 'collectionSource', params: { sourceId } })

  const wrapper = mount({ render: () => h(RouterView) }, {
    global: {
      plugins: [createTestI18n(), router, store],
      stubs: { FtElementList: list },
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
    store.setGetter('getCollectionsLoadFailed', false)
    store.setGetter('getCollectionSources', [HACKERTUBE, MEALTIME])
    store.setGetter('getCollectionsSourcesHidden', [])
    store.setGetter('getCollectionsSort', 'votes')
    store.setGetter('getCollectionsSortDescending', true)
    store.setGetter('getCollectionShares', [
      share(HACKERTUBE, 'aaaaaaaaaaa', 20),
      share(MEALTIME, 'aaaaaaaaaaa', 100),
      share(MEALTIME, 'bbbbbbbbbbb', 3),
      share(HACKERTUBE, 'ccccccccccc', 5),
    ])
  })

  afterEach(() => {
    store.setGetter('getCollectionSource', () => undefined)
    store.setGetter('getCollectionShare', () => undefined)
    store.setGetter('getCollectionSourceData', () => undefined)
  })

  it('has the category select on HackerTube\'s page, whatever its chip on Collections, and not on another source\'s', async () => {
    const taxonomy = { version: 'v', areas: [{ id: 'sci', name: 'Science', categories: [{ id: 'physics', name: 'Physics' }] }] }
    store.setGetter('getCollectionSourceData', id => id === HACKERTUBE._id ? { _id: id, generated: 'g', taxonomy } : undefined)
    store.setGetter('getCollectionsSourcesHidden', [HACKERTUBE._id])
    store.setGetter('getCollectionShares', [
      { ...share(HACKERTUBE, 'aaaaaaaaaaa', 20), categories: ['physics'] },
      share(HACKERTUBE, 'ccccccccccc', 5),
      share(MEALTIME, 'bbbbbbbbbbb', 3),
    ])

    const { wrapper } = await openSourcePage(HACKERTUBE._id)
    await wrapper.find('select.categorySelect').setValue('physics')
    expect(listed(wrapper).map(video => video.videoId)).toEqual(['aaaaaaaaaaa'])
    wrapper.unmount()

    const { wrapper: other } = await openSourcePage(MEALTIME._id)
    expect(other.find('select.categorySelect').exists()).toBe(false)
    expect(listed(other).map(video => video.videoId)).toEqual(['bbbbbbbbbbb'])
  })

  describe('HackerTube\'s category select', () => {
    const TAXONOMY = {
      version: 'v',
      areas: [
        { id: 'cs', name: 'Computing', categories: [{ id: 'compilers', name: 'Compilers' }, { id: 'databases', name: 'Databases' }] },
        { id: 'sci', name: 'Science', categories: [{ id: 'physics', name: 'Physics' }] },
      ],
    }

    beforeEach(() => {
      store.setGetter('getCollectionSourceData', id => id === HACKERTUBE._id ? { _id: id, generated: 'g', taxonomy: TAXONOMY } : undefined)
      store.setGetter('getCollectionShares', [
        { ...share(HACKERTUBE, 'aaaaaaaaaaa', 20), categories: ['compilers'] },
        { ...share(HACKERTUBE, 'ccccccccccc', 5), categories: ['physics'] },
      ])
    })

    /** @param {import('@vue/test-utils').VueWrapper} wrapper */
    const select = wrapper => wrapper.find('select.categorySelect')

    it('lists HackerTube\'s categories by name, grouped by area, after All, which is chosen', async () => {
      const { wrapper } = await openSourcePage(HACKERTUBE._id)

      expect(select(wrapper).findAll('optgroup').map(group => [group.attributes('label'), group.findAll('option').map(option => option.text())])).toEqual([
        ['Computing', ['Compilers', 'Databases']],
        ['Science', ['Physics']],
      ])
      expect(select(wrapper).find('option').text()).toBe('All')
      expect(select(wrapper).element.value).toBe('')
      expect(wrapper.find(`label[for="${select(wrapper).attributes('id')}"]`).text()).toBe('Category')
    })

    it('keeps the choice for the session, and clears it on All', async () => {
      const { wrapper } = await openSourcePage(HACKERTUBE._id)
      await select(wrapper).setValue('physics')
      expect(sessionStorage.getItem('collectionsCategory')).toBe('physics')
      wrapper.unmount()

      const { wrapper: again } = await openSourcePage(HACKERTUBE._id)
      expect(select(again).element.value).toBe('physics')
      expect(listed(again).map(video => video.videoId)).toEqual(['ccccccccccc'])

      await select(again).setValue('')
      expect(listed(again).map(video => video.videoId)).toEqual(['aaaaaaaaaaa', 'ccccccccccc'])
      expect(sessionStorage.getItem('collectionsCategory')).toBeNull()
    })

    it('says so when nothing is in the category', async () => {
      const { wrapper } = await openSourcePage(HACKERTUBE._id)
      await select(wrapper).setValue('databases')

      expect(wrapper.find('.message').text()).toBe('Nothing here is in this category.')
    })

    it('takes a choice the taxonomy no longer has for All', async () => {
      sessionStorage.setItem('collectionsCategory', 'gone')
      const { wrapper } = await openSourcePage(HACKERTUBE._id)

      expect(select(wrapper).element.value).toBe('')
      expect(listed(wrapper)).toHaveLength(2)
    })

    it('lists the shipped bundle\'s categories where none are kept', async () => {
      store.setGetter('getCollectionSourceData', () => undefined)
      vi.mocked(shippedHackerTubeTaxonomy).mockResolvedValueOnce(TAXONOMY)

      const { wrapper } = await openSourcePage(HACKERTUBE._id)

      expect(shippedHackerTubeTaxonomy).toHaveBeenCalled()
      expect(select(wrapper).findAll('optgroup')).toHaveLength(2)
    })
  })

  it('gives every card the vote badge of this source\'s share alone: its votes, and on hover its why and its discussion', async () => {
    const shares = [
      { ...share(MEALTIME, 'aaaaaaaaaaa', 100), why: 'Worth a lunch', discussionUrl: 'https://lemmy.cafe/post/1' },
      share(HACKERTUBE, 'aaaaaaaaaaa', 20),
    ]
    store.setGetter('getCollectionShares', shares)
    store.setGetter('getCollectionSource', id => [HACKERTUBE, MEALTIME].find(source => source._id === id))
    store.setGetter('getCollectionShare', id => shares.find(each => each._id === id))

    const { wrapper } = await openSourcePage(MEALTIME._id, ThumbnailBadgeProbe)

    expect(wrapper.findAllComponents(CollectionsVoteBadge).map(badge => badge.props('sourceId'))).toEqual([MEALTIME._id])
    expect(wrapper.find('button.votes').text()).toBe('▲ 100')
    await wrapper.find('.collectionsVoteBadge').trigger('pointerenter')
    expect(wrapper.find('.why').text()).toBe('Worth a lunch')
    expect(wrapper.find('a.discussion').attributes('href')).toBe('https://lemmy.cafe/post/1')
    expect(wrapper.find('.sources').exists()).toBe(false)
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

  it('says the bundle could not be loaded only on HackerTube\'s page, whose videos it is', async () => {
    store.setGetter('getCollectionsLoadFailed', true)
    store.setGetter('getCollectionShares', [])

    const hackerTube = await openSourcePage(HACKERTUBE._id)
    expect(hackerTube.wrapper.find('.message').text()).toContain('could not be loaded')

    const community = await openSourcePage(MEALTIME._id)
    expect(community.wrapper.find('.message').text()).toBe('Nothing has been shared here yet.')
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

  it('has the toolbar of Collections without the source chips: the refresh, the pills and the sort', async () => {
    const { wrapper } = await openSourcePage(MEALTIME._id)

    expect(wrapper.find('.chipRow').exists()).toBe(false)
    expect(wrapper.find('.controlRow').classes()).toContain('withoutChips')
    expect(wrapper.find('.pageControls').text()).toContain('Watched')
    expect(wrapper.find('.pageControls').text()).toContain('AI')
    expect(wrapper.find('select.sortSelect').element.value).toBe('votes')
  })

  it('shows its videos even with its chip off on Collections', async () => {
    store.setGetter('getCollectionsSourcesHidden', [MEALTIME._id])

    const { wrapper } = await openSourcePage(MEALTIME._id)

    expect(listed(wrapper).map(video => video.videoId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb'])
  })

  it('is in the order chosen by its own shares\' dates, not another source\'s', async () => {
    store.setGetter('getCollectionsSort', 'shared')
    store.setGetter('getCollectionShares', [
      { ...share(MEALTIME, 'aaaaaaaaaaa', 1), sharedAt: 10 },
      { ...share(HACKERTUBE, 'aaaaaaaaaaa', 1), sharedAt: 99 },
      { ...share(MEALTIME, 'bbbbbbbbbbb', 1), sharedAt: 20 },
    ])

    const { wrapper } = await openSourcePage(MEALTIME._id)

    expect(listed(wrapper).map(video => [video.videoId, video.collection.sharedAt])).toEqual([
      ['bbbbbbbbbbb', 20],
      ['aaaaaaaaaaa', 10],
    ])
  })
})
