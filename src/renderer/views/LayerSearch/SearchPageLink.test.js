// The "Search PeerTube" link on upstream's search results page
// (views/SearchPage/SearchPage.vue), the one hook the layer's search view has
// there. Tested here, beside the view it leads to, so that upstream's
// directory gains no file; the page itself is mounted, with YouTube search
// answering nothing.

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { RouterView } from 'vue-router'

import { getLocalSearchResults } from '../../helpers/api/local'
import { isPeerTubeEnabled } from '../../platform/vue'
import store from '../../store/index'
import { createTestI18n } from '../../testing/i18n'
import { createTestRouter } from '../../testing/router'
import SearchPage from '../SearchPage/SearchPage.vue'

vi.mock('../../components/FtElementList/FtElementList.vue', async () => {
  const { defineComponent, h } = await import('vue')

  return {
    default: defineComponent({
      name: 'FtElementList',
      props: { data: { type: Array, required: true } },
      setup: () => () => h('ul'),
    }),
  }
})

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getSessionSearchHistory: [],
        getBackendPreference: 'local',
        getBackendFallback: false,
        getShowFamilyFriendlyOnly: false,
        getRememberSearchHistory: false,
        getSubscribedChannelIdSet: new Set(),
        getListDensity: 'standard',
        getGeneralAutoLoadMorePaginatedItemsEnabled: false,
      },
    }),
  }
})

vi.mock('../../helpers/api/local', () => ({
  getLocalSearchResults: vi.fn(async () => ({ results: [], continuationData: null })),
  getLocalSearchContinuation: vi.fn(),
  extractLocalCacheableSearchContinuation: vi.fn(),
}))

vi.mock('../../helpers/api/invidious', () => ({
  getInvidiousSearchResults: vi.fn(),
}))

// helpers/utils imports the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

vi.mock('../../i18n/index', async () => {
  const { createTestI18n } = await import('../../testing/i18n')
  return { default: createTestI18n() }
})

vi.mock('../../platform/vue', async (importOriginal) => ({
  ...(await importOriginal()),
  isPeerTubeEnabled: vi.fn(() => false),
}))

const openPages = []

beforeEach(() => {
  isPeerTubeEnabled.mockReset().mockReturnValue(false)
  getLocalSearchResults.mockClear()
})

afterEach(() => {
  for (const wrapper of openPages.splice(0)) {
    wrapper.unmount()
  }
})

/**
 * @param {string} path
 */
async function openSearchResults(path) {
  const router = createTestRouter([
    { path: '/search/:query', name: 'search', component: SearchPage },
    { path: '/peertube/search/:query', name: 'peertubeSearch' },
  ])
  await router.push(path)

  const wrapper = mount({ render: () => h(RouterView) }, {
    global: {
      plugins: [createTestI18n(), router, store],
      directives: { 'observe-visibility': {} },
    },
  })
  openPages.push(wrapper)
  await flushPromises()

  return { wrapper, router }
}

function peerTubeLink(wrapper) {
  return wrapper.find('.peerTubeSearchLink')
}

describe('the search results page, for PeerTube', () => {
  it('has no PeerTube link while PeerTube is switched off', async () => {
    const { wrapper } = await openSearchResults('/search/blender')

    expect(wrapper.find('h2').text()).toBe('Search Results')
    expect(peerTubeLink(wrapper).exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Search PeerTube')
  })

  it('links to the PeerTube search for the same query while PeerTube is on', async () => {
    isPeerTubeEnabled.mockReturnValue(true)
    const { wrapper, router } = await openSearchResults('/search/blender%20tutorials?type=video')

    expect(peerTubeLink(wrapper).text()).toBe('Search PeerTube')

    await peerTubeLink(wrapper).trigger('click')
    await flushPromises()

    const { name, params, query } = router.currentRoute.value
    expect(name).toBe('peertubeSearch')
    expect(params).toEqual({ query: 'blender tutorials' })
    expect(query).toEqual({})
  })

  it('searches YouTube as before, either way', async () => {
    isPeerTubeEnabled.mockReturnValue(true)
    await openSearchResults('/search/blender')

    expect(getLocalSearchResults).toHaveBeenCalledTimes(1)
    expect(getLocalSearchResults.mock.calls[0][0]).toBe('blender')
  })
})
