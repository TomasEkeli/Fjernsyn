import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { RouterView } from 'vue-router'

import { PlatformError } from '../../platform/errors'
import { appliedFilters } from '../../platform/search/capabilities'
import { defaults, parameters, parse } from '../../platform/search/query'
import { PLATFORM_LAYER_KEY } from '../../platform/vue'
import store from '../../store/index'
import { createTestI18n } from '../../testing/i18n'
import { createTestRouter } from '../../testing/router'
import LayerSearchPage from './LayerSearchPage.vue'
import { forgetAll } from './resultsCache'

// The cards are the shared components' own; here the list only shows what it was handed
vi.mock('../../components/FtElementList/FtElementList.vue', async () => {
  const { defineComponent, h } = await import('vue')

  return {
    default: defineComponent({
      name: 'FtElementList',
      props: {
        data: { type: Array, required: true },
      },
      setup: (props) => () => h('ul', { class: 'fakeElementList' }, props.data.map(item => h('li', {
        class: ['fakeCard', `${item.type}Card`],
      }, item.title ?? item.name))),
    }),
  }
})

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getListDensity: 'standard',
        getGeneralAutoLoadMorePaginatedItemsEnabled: false,
        getEnablePeerTube: true,
        getDefaultSearchScope: 'youtube',
        getSearchRememberedParameters: null,
        getSearchLatched: false,
        getRememberSearchHistory: true,
        getProfileList: [],
      },
    }),
  }
})

vi.mock('../../router/index', () => ({ default: {} }))

vi.mock('../../i18n/index', async () => {
  const { createTestI18n } = await import('../../testing/i18n')
  return { default: createTestI18n() }
})

vi.mock('../../helpers/utils', () => ({ showToast: vi.fn() }))

const youtubeVideo = (n) => ({ type: 'video', videoId: `yt${n}`, title: `YouTube ${n}` })
const peertubeVideo = (n) => ({ type: 'video', platform: 'peertube', host: 'tube.example', videoId: `pt${n}`, title: `PeerTube ${n}` })

/** What a platform answers a query with, as the layer would */
function page(platform, query, items, cursor = null) {
  return { items, cursor, applied: appliedFilters(platform, query) }
}

const layer = {
  searchQuery: vi.fn(),
  config: { peertubeSearchSource: 'https://sepiasearch.org' },
}

function answerEverything() {
  layer.searchQuery.mockReset().mockImplementation(async (query) => {
    if (query.scope === 'all') {
      return {
        sections: {
          youtube: page('youtube', query, [youtubeVideo(1)]),
          peertube: page('peertube', query, [peertubeVideo(1)]),
        },
      }
    }

    return query.scope === 'peertube'
      ? page('peertube', query, [peertubeVideo(1)])
      : page('youtube', query, [youtubeVideo(1), youtubeVideo(2)])
  })
}

beforeEach(() => {
  forgetAll()
  store.committed.length = 0
  store.dispatched.length = 0
  store.setGetter('getEnablePeerTube', true)
  store.setGetter('getDefaultSearchScope', 'youtube')
  store.setGetter('getSearchRememberedParameters', null)
  store.setGetter('getSearchLatched', false)
  store.setGetter('getProfileList', [])
  answerEverything()
})

const openPages = []

afterEach(() => {
  for (const wrapper of openPages.splice(0)) {
    wrapper.unmount()
  }
})

/**
 * @param {string} path
 */
async function openSearchPage(path) {
  const router = createTestRouter([{ path: '/search/:query', component: LayerSearchPage }])
  await router.push(path)

  const wrapper = mount({ render: () => h(RouterView) }, {
    global: {
      plugins: [createTestI18n(), router, store],
      provide: { [PLATFORM_LAYER_KEY]: layer },
      directives: { 'observe-visibility': {} },
    },
  })
  openPages.push(wrapper)
  await flushPromises()

  return { wrapper, router }
}

/** The query the route now holds, as the page reads it */
function routeQuery(router) {
  const { query, params } = router.currentRoute.value
  return parse(query, params.query, { peertubeEnabled: true })
}

function cards(wrapper, selector = '') {
  return wrapper.findAll(`${selector} .fakeCard`).map(card => card.text())
}

function dispatched(type) {
  return store.dispatched.filter(action => action.type === type).map(action => action.payload)
}

describe('the search page', () => {
  it('searches the query in the route, and shows what came back', async () => {
    const { wrapper } = await openSearchPage('/search/blender?scope=youtube')

    expect(layer.searchQuery).toHaveBeenCalledTimes(1)
    expect(layer.searchQuery).toHaveBeenCalledWith({ ...defaults('youtube'), text: 'blender' }, { cursor: null })
    expect(cards(wrapper)).toEqual(['YouTube 1', 'YouTube 2'])
    expect(wrapper.find('h2').text()).toBe('Results for “blender”')
  })

  it('titles the window and keeps the text in the search history', async () => {
    await openSearchPage('/search/blender?scope=youtube')

    expect(store.committed).toContainEqual({ type: 'setAppTitle', payload: 'blender' })
    expect(dispatched('updateSearchHistoryEntry')[0]).toMatchObject({ _id: 'blender' })
  })

  it('takes the default scope when the route names none', async () => {
    store.setGetter('getDefaultSearchScope', 'peertube')
    await openSearchPage('/search/blender')

    expect(layer.searchQuery.mock.calls[0][0].scope).toBe('peertube')
  })

  it('says so when nothing matches', async () => {
    layer.searchQuery.mockResolvedValue({ items: [], cursor: null, applied: [] })
    const { wrapper } = await openSearchPage('/search/blender?scope=youtube')

    expect(wrapper.text()).toContain('No results.')
  })

  it('pages on in a single scope, with the cursor it was given', async () => {
    layer.searchQuery
      .mockResolvedValueOnce({ items: [youtubeVideo(1)], cursor: { backend: 'local', continuation: 'c' }, applied: [] })
      .mockResolvedValueOnce({ items: [youtubeVideo(2)], cursor: null, applied: [] })
    const { wrapper } = await openSearchPage('/search/blender?scope=youtube')

    await wrapper.find('.getNextPage').trigger('click')
    await flushPromises()

    expect(layer.searchQuery).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'youtube' }), { cursor: { backend: 'local', continuation: 'c' } })
    expect(cards(wrapper)).toEqual(['YouTube 1', 'YouTube 2'])
    expect(wrapper.find('.getNextPage').exists()).toBe(false)
  })
})

describe('the scope tabs', () => {
  it('are there while PeerTube is on, the scope in the route selected', async () => {
    const { wrapper } = await openSearchPage('/search/blender?scope=peertube')

    expect(wrapper.findAll('.tab').map(tab => tab.text())).toEqual(['YouTube', 'PeerTube', 'All'])
    expect(wrapper.find('#peertubeScopeTab').classes()).toContain('selectedTab')
  })

  it('are not there while PeerTube is off, and every search is YouTube\'s', async () => {
    store.setGetter('getEnablePeerTube', false)
    const { wrapper } = await openSearchPage('/search/blender?scope=all&lang=no')

    expect(wrapper.find('.tabs').exists()).toBe(false)
    expect(layer.searchQuery).toHaveBeenCalledWith({ ...defaults('youtube'), text: 'blender' }, { cursor: null })
  })

  it('push the scope chosen, keeping the filters', async () => {
    const { wrapper, router } = await openSearchPage('/search/blender?scope=youtube&time=week')

    await wrapper.find('#allScopeTab').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query).toEqual({ scope: 'all', time: 'week' })
    expect(layer.searchQuery).toHaveBeenLastCalledWith({ ...defaults('all'), text: 'blender', time: 'week' })
  })

  it('write nothing for a plain search', async () => {
    const { wrapper } = await openSearchPage('/search/blender?scope=youtube')

    await wrapper.find('#peertubeScopeTab').trigger('click')
    await flushPromises()

    expect(store.dispatched.filter(action => action.type !== 'updateSearchHistoryEntry')).toEqual([])
  })
})

describe('the chips', () => {
  it('show the query\'s values', async () => {
    const { wrapper } = await openSearchPage('/search/blender?scope=peertube&sort=date&length=long&live=1')

    expect(wrapper.find('.sortChip select').element.value).toBe('date')
    expect(wrapper.find('.lengthChip select').element.value).toBe('long')
    expect(wrapper.find('.timeChip select').element.value).toBe('')
    expect(wrapper.find('.sortChip').classes()).toContain('set')
    expect(wrapper.find('.timeChip').classes()).not.toContain('set')
    expect(wrapper.find('.liveChip').classes()).toContain('set')
  })

  it('offer YouTube only what it has, and hide what it cannot honour', async () => {
    const { wrapper } = await openSearchPage('/search/blender?scope=youtube')

    expect(wrapper.findAll('.sortChip option').map(option => option.text())).toEqual(['Relevance', 'Most viewed'])
    expect(wrapper.find('.nsfwChip').exists()).toBe(false)
    expect(wrapper.find('.languageChip').exists()).toBe(false)
  })

  it('offer PeerTube its own', async () => {
    const { wrapper } = await openSearchPage('/search/blender?scope=peertube')

    expect(wrapper.findAll('.sortChip option').map(option => option.text())).toEqual(['Relevance', 'Newest', 'Most viewed', 'Trending'])
    expect(wrapper.find('.nsfwChip').exists()).toBe(true)
    expect(wrapper.find('.languageChip').exists()).toBe(true)
    expect(wrapper.findAll('.timeChip option').map(option => option.text())).toContain('Custom range…')
  })

  it('push the change, and make the result the remembered set, latched', async () => {
    const { wrapper, router } = await openSearchPage('/search/blender?scope=youtube')

    await wrapper.find('.sortChip select').setValue('views')
    await flushPromises()

    expect(router.currentRoute.value.query).toEqual({ scope: 'youtube', sort: 'views' })
    expect(layer.searchQuery).toHaveBeenLastCalledWith({ ...defaults('youtube'), text: 'blender', sort: 'views' }, { cursor: null })
    expect(dispatched('updateSearchRememberedParameters')).toEqual([{ ...defaults('youtube'), sort: 'views' }])
    expect(dispatched('updateSearchLatched')).toEqual([true])
  })

  it('unset a filter by its ×; the last one removed unlatches, and the set is left as it was', async () => {
    store.setGetter('getSearchLatched', true)
    store.setGetter('getSearchRememberedParameters', { ...defaults('youtube'), sort: 'views' })
    const { wrapper, router } = await openSearchPage('/search/blender?scope=youtube&sort=views')

    await wrapper.find('.sortChip .chipClear').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query).toEqual({ scope: 'youtube' })
    expect(dispatched('updateSearchRememberedParameters')).toEqual([])
    expect(dispatched('updateSearchLatched')).toEqual([false])
  })

  it('toggle live', async () => {
    const { wrapper, router } = await openSearchPage('/search/blender?scope=youtube')

    await wrapper.find('.liveButton').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query).toEqual({ scope: 'youtube', live: '1' })
  })

  it('show a set filter a platform cannot honour, muted, with the reason', async () => {
    const { wrapper } = await openSearchPage('/search/blender?scope=youtube&sort=trending')

    const chip = wrapper.find('.sortChip')
    expect(chip.find('select').element.value).toBe('trending')
    expect(chip.classes()).toContain('muted')
    expect(chip.attributes('title')).toBe('Not applied to YouTube')
  })

  it('choose languages from the list, the app\'s language first', async () => {
    const { wrapper, router } = await openSearchPage('/search/blender?scope=peertube')

    await wrapper.find('.languageButton').trigger('click')
    expect(wrapper.findAll('.languageOption')[0].text()).toBe('English')

    await wrapper.find('.languageFilter').setValue('norw')
    expect(wrapper.findAll('.languageOption').map(option => option.text())).toEqual(['Norwegian', 'Norwegian Bokmål', 'Norwegian Nynorsk'])

    await wrapper.findAll('.languageOption input')[0].trigger('change')
    await flushPromises()

    expect(router.currentRoute.value.query).toEqual({ scope: 'peertube', lang: 'no' })
    expect(wrapper.find('.languageButton').text()).toBe('Norwegian')
  })

  it('take a custom date range in the PeerTube scope', async () => {
    const { wrapper, router } = await openSearchPage('/search/blender?scope=peertube&time=week')

    await wrapper.find('.timeChip select').setValue('custom')
    await wrapper.find('.rangeAfter').setValue('2024-06-01')
    await wrapper.find('.rangeBefore').setValue('2024-06-30')
    await wrapper.find('.rangeApply').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query).toEqual({ scope: 'peertube', after: '2024-06-01', before: '2024-06-30' })
    expect(wrapper.find('.timeChip select').element.value).toBe('custom')
  })
})

describe('Clear and Apply last filters', () => {
  const remembered = { ...defaults('peertube'), sort: 'date', language: ['no'] }

  it('offer Clear on a filtered search: the same text and scope, unfiltered, unlatched, the set kept', async () => {
    store.setGetter('getSearchLatched', true)
    store.setGetter('getSearchRememberedParameters', remembered)
    const { wrapper, router } = await openSearchPage('/search/blender?scope=peertube&sort=date&lang=no')

    expect(wrapper.find('.applyLastFilters').exists()).toBe(false)
    await wrapper.find('.clearFilters').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query).toEqual({ scope: 'peertube' })
    expect(dispatched('updateSearchLatched')).toEqual([false])
    expect(dispatched('updateSearchRememberedParameters')).toEqual([])
  })

  it('offer the remembered set, in words, on a plain search, and apply it latched', async () => {
    store.setGetter('getSearchRememberedParameters', remembered)
    const { wrapper, router } = await openSearchPage('/search/krita?scope=youtube')

    expect(wrapper.find('.clearFilters').exists()).toBe(false)
    expect(wrapper.find('.applyLastFilters').text()).toBe('Apply last filters: PeerTube · newest · Norwegian')

    await wrapper.find('.applyLastFilters').trigger('click')
    await flushPromises()

    expect(routeQuery(router)).toEqual({ ...remembered, text: 'krita' })
    expect(dispatched('updateSearchLatched')).toEqual([true])
    expect(dispatched('updateSearchRememberedParameters')).toEqual([])
  })

  it('offer neither on a plain search with nothing remembered', async () => {
    const { wrapper } = await openSearchPage('/search/krita?scope=youtube')

    expect(wrapper.find('.clearFilters').exists()).toBe(false)
    expect(wrapper.find('.applyLastFilters').exists()).toBe(false)
  })
})

describe('the All scope', () => {
  it('shows a section per platform, asked in one call', async () => {
    const { wrapper } = await openSearchPage('/search/blender?scope=all')

    expect(layer.searchQuery).toHaveBeenCalledTimes(1)
    expect(layer.searchQuery).toHaveBeenCalledWith({ ...defaults('all'), text: 'blender' })
    expect(wrapper.findAll('.sectionHeader').map(header => header.text())).toEqual(['From YouTube', 'From PeerTube'])
    expect(cards(wrapper, '.youtubeSection')).toEqual(['YouTube 1'])
    expect(cards(wrapper, '.peertubeSection')).toEqual(['PeerTube 1'])
  })

  it('pages each section on its own, through its scope and cursor', async () => {
    layer.searchQuery.mockImplementationOnce(async (query) => ({
      sections: {
        youtube: page('youtube', query, [youtubeVideo(1)], { backend: 'invidious', page: 2 }),
        peertube: page('peertube', query, [peertubeVideo(1)], 30),
      },
    }))
    const { wrapper } = await openSearchPage('/search/blender?scope=all')
    layer.searchQuery.mockResolvedValueOnce({ items: [peertubeVideo(2)], cursor: null, applied: [] })

    await wrapper.find('.peertubeSection .getNextPage').trigger('click')
    await flushPromises()

    expect(layer.searchQuery).toHaveBeenLastCalledWith({ ...defaults('peertube'), text: 'blender' }, { cursor: 30 })
    expect(cards(wrapper, '.peertubeSection')).toEqual(['PeerTube 1', 'PeerTube 2'])
    expect(cards(wrapper, '.youtubeSection')).toEqual(['YouTube 1'])
    expect(wrapper.find('.youtubeSection .getNextPage').exists()).toBe(true)
  })

  it('shows one platform\'s failure in its section, beside the other\'s results, and tries it again', async () => {
    layer.searchQuery.mockImplementationOnce(async (query) => ({
      sections: {
        youtube: new PlatformError('unavailable', 'Innertube broke'),
        peertube: page('peertube', query, [peertubeVideo(1)]),
      },
    }))
    const { wrapper } = await openSearchPage('/search/blender?scope=all')

    expect(wrapper.find('.youtubeSection').text()).toContain('YouTube could not be searched.')
    expect(cards(wrapper, '.peertubeSection')).toEqual(['PeerTube 1'])

    await wrapper.find('.youtubeSection .retryButton').trigger('click')
    await flushPromises()

    expect(layer.searchQuery).toHaveBeenLastCalledWith({ ...defaults('youtube'), text: 'blender' }, { cursor: null })
    expect(cards(wrapper, '.youtubeSection')).toEqual(['YouTube 1', 'YouTube 2'])
  })

  it('says in a section\'s header what that platform did not apply, and mutes the chip', async () => {
    const { wrapper } = await openSearchPage('/search/blender?scope=all&sort=trending&lang=no')

    expect(wrapper.find('.youtubeSection .notApplied').text()).toBe('Not applied to YouTube: trending · Norwegian')
    expect(wrapper.find('.peertubeSection .notApplied').exists()).toBe(false)
    expect(wrapper.find('.sortChip').classes()).toContain('muted')
  })

  it('narrows to a platform from its header, filters intact', async () => {
    const { wrapper, router } = await openSearchPage('/search/blender?scope=all&time=week')

    await wrapper.findAll('.sectionHeader')[1].trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query).toEqual({ scope: 'peertube', time: 'week' })
    expect(dispatched('updateSearchRememberedParameters')).toEqual([{ ...defaults('peertube'), time: 'week' }])
  })
})

describe('the source row', () => {
  it('lists the search source, and the instances of followed channels', async () => {
    store.setGetter('getProfileList', [{
      _id: 'allChannels',
      subscriptions: [
        { id: 'a@tilvids.com', platform: 'peertube', host: 'tilvids.com' },
        { id: 'UCaaaaaaaaaaaaaaaaaaaaaa' },
        { id: 'b@video.blender.org', platform: 'peertube', host: 'video.blender.org' },
      ],
    }])
    const { wrapper, router } = await openSearchPage('/search/blender?scope=peertube')

    expect(wrapper.findAll('.sourceSelect option').map(option => option.text()))
      .toEqual(['sepiasearch.org (search source)', 'tilvids.com', 'video.blender.org', 'Another instance'])

    await wrapper.find('.sourceSelect').setValue('tilvids.com')
    await flushPromises()

    expect(router.currentRoute.value.query).toEqual({ scope: 'peertube', instance: 'tilvids.com' })
  })

  it('takes a typed instance', async () => {
    const { wrapper, router } = await openSearchPage('/search/blender?scope=peertube')

    await wrapper.find('.sourceSelect').setValue('*other')
    await wrapper.find('.otherInstanceInput').setValue('https://Tube.Example/')
    await wrapper.find('.otherInstance').trigger('submit')
    await flushPromises()

    expect(router.currentRoute.value.query).toEqual({ scope: 'peertube', instance: 'tube.example' })
  })

  it('is not there outside the PeerTube scope', async () => {
    const { wrapper } = await openSearchPage('/search/blender?scope=all')

    expect(wrapper.find('.sourceRow').exists()).toBe(false)
  })
})

describe('going back', () => {
  it('restores an earlier search from memory, without asking again', async () => {
    const { wrapper, router } = await openSearchPage('/search/blender?scope=youtube')

    await wrapper.find('.sortChip select').setValue('views')
    await flushPromises()
    expect(layer.searchQuery).toHaveBeenCalledTimes(2)

    router.back()
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 0))
    await flushPromises()

    expect(router.currentRoute.value.query).toEqual({ scope: 'youtube' })
    expect(layer.searchQuery).toHaveBeenCalledTimes(2)
    expect(cards(wrapper)).toEqual(['YouTube 1', 'YouTube 2'])
  })

  it('remembers what was set as the remembered set when a search was changed, and not before', async () => {
    const { wrapper } = await openSearchPage('/search/blender?scope=peertube&sort=date')

    expect(dispatched('updateSearchRememberedParameters')).toEqual([])

    await wrapper.find('.timeChip select').setValue('year')
    await flushPromises()

    expect(dispatched('updateSearchRememberedParameters')).toEqual([parameters({ ...defaults('peertube'), sort: 'date', time: 'year', text: '' })])
  })
})
