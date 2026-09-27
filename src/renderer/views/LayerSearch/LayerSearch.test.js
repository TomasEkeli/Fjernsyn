import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { RouterView } from 'vue-router'

import { PlatformError } from '../../platform/errors'
import { PLATFORM_LAYER_KEY } from '../../platform/vue'
import store from '../../store/index'
import { createTestI18n } from '../../testing/i18n'
import { createTestRouter } from '../../testing/router'
import LayerSearch from './LayerSearch.vue'

// The cards are the shared components' own (and under test with them); here
// the list only has to show what the view handed it, and as which kind
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
      },
    }),
  }
})

// helpers/utils imports the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

vi.mock('../../i18n/index', async () => {
  const { createTestI18n } = await import('../../testing/i18n')
  return { default: createTestI18n() }
})

const SOURCE = 'https://sepiasearch.org'
const QUERY = 'blender'

/** A card-ready video summary, as the layer returns them */
function video(n) {
  const host = 'video.blender.org'

  return {
    type: 'video',
    platform: 'peertube',
    host,
    videoId: `b29290cc-dc51-4a12-bcb2-${String(n).padStart(12, '0')}`,
    title: `Video ${n}`,
    author: 'Blender',
    authorId: `blender@${host}`,
    thumbnail: `https://${host}/lazy-static/thumbnails/${n}.jpg`,
    lengthSeconds: 60,
    published: Date.UTC(2024, 0, n),
    viewCount: n * 100,
    liveNow: false,
    isUpcoming: false,
    nsfw: false,
  }
}

/** A channel search result, as the layer returns them */
function channel(n) {
  const host = 'tube.example'

  return {
    type: 'channel',
    dataSource: 'local',
    platform: 'peertube',
    host,
    id: `channel${n}@${host}`,
    name: `Channel ${n}`,
    thumbnail: '',
    handle: `channel${n}@${host}`,
    subscribers: '12 followers',
    descriptionShort: '',
  }
}

const layer = {
  search: vi.fn(),
  config: { peertubeSearchSource: SOURCE },
}

beforeEach(() => {
  store.committed.length = 0
  store.dispatched.length = 0
  layer.config = { peertubeSearchSource: SOURCE }
  layer.search.mockReset().mockImplementation(async (_query, { type }) => ({
    items: type === 'channel' ? [channel(1), channel(2)] : [video(1), video(2)],
    cursor: null,
  }))
})

const openPages = []

afterEach(() => {
  for (const wrapper of openPages.splice(0)) {
    wrapper.unmount()
  }
})

/**
 * Opens the search page as the app would host it: in a router view, with the
 * layer provided
 *
 * @param {string} [path]
 */
async function openSearchPage(path = `/peertube/search/${QUERY}`) {
  const router = createTestRouter([
    { path: '/peertube/search/:query', name: 'peertubeSearch', component: LayerSearch },
  ])
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

function cardTitles(wrapper) {
  return wrapper.findAll('.fakeCard').map(card => card.text())
}

function fetchMore(wrapper) {
  return wrapper.find('.getNextPage')
}

/**
 * A promise the test settles, for a request still in flight
 */
function deferred() {
  let settle
  const promise = new Promise((resolve) => { settle = resolve })
  return { promise, resolve: (value) => settle(value) }
}

describe('the layer search page', () => {
  it('searches for the videos matching the query in the route', async () => {
    const { wrapper } = await openSearchPage()

    expect(layer.search).toHaveBeenCalledTimes(1)
    expect(layer.search).toHaveBeenCalledWith(QUERY, { type: 'video', cursor: null })
    expect(wrapper.findAll('.videoCard').map(card => card.text())).toEqual(['Video 1', 'Video 2'])
  })

  it('hands the cards the results as the layer gave them', async () => {
    const { wrapper } = await openSearchPage()

    expect(wrapper.findComponent({ name: 'FtElementList' }).props('data')).toEqual([video(1), video(2)])
  })

  it('names the query and the search source it asked', async () => {
    const { wrapper } = await openSearchPage('/peertube/search/blender%20tutorials')

    expect(wrapper.find('h2').text()).toBe('PeerTube results for “blender tutorials” via sepiasearch.org')
    expect(layer.search).toHaveBeenCalledWith('blender tutorials', { type: 'video', cursor: null })
  })

  it('titles the window with the query', async () => {
    await openSearchPage()

    expect(store.committed).toContainEqual({ type: 'setAppTitle', payload: QUERY })
  })

  it('searches again, afresh, for a new query', async () => {
    const { wrapper, router } = await openSearchPage()
    layer.search.mockResolvedValue({ items: [video(9)], cursor: null })

    await router.push('/peertube/search/krita')
    await flushPromises()

    expect(layer.search).toHaveBeenLastCalledWith('krita', { type: 'video', cursor: null })
    expect(cardTitles(wrapper)).toEqual(['Video 9'])
  })

  it('says so when nothing matches', async () => {
    layer.search.mockResolvedValue({ items: [], cursor: null })
    const { wrapper } = await openSearchPage()

    expect(wrapper.text()).toContain('No results for “blender”.')
    expect(fetchMore(wrapper).exists()).toBe(false)
  })
})

describe('more results', () => {
  it('are appended, for the same query and type, until the cursor is null', async () => {
    layer.search
      .mockResolvedValueOnce({ items: [video(1), video(2)], cursor: 2 })
      .mockResolvedValueOnce({ items: [video(3)], cursor: null })
    const { wrapper } = await openSearchPage()

    await fetchMore(wrapper).trigger('click')
    await flushPromises()

    expect(layer.search).toHaveBeenLastCalledWith(QUERY, { type: 'video', cursor: 2 })
    expect(cardTitles(wrapper)).toEqual(['Video 1', 'Video 2', 'Video 3'])
    expect(fetchMore(wrapper).exists()).toBe(false)
  })

  it('load when the end of the list scrolls into view', async () => {
    layer.search
      .mockResolvedValueOnce({ items: [video(1)], cursor: 1 })
      .mockResolvedValueOnce({ items: [video(2)], cursor: null })
    const { wrapper } = await openSearchPage()

    wrapper.findComponent({ name: 'FtAutoLoadNextPageWrapper' }).vm.$emit('load-next-page')
    await flushPromises()

    expect(cardTitles(wrapper)).toEqual(['Video 1', 'Video 2'])
  })

  it('keep coming past an empty page that has a cursor, which is not the end', async () => {
    layer.search
      .mockResolvedValueOnce({ items: [], cursor: 20 })
      .mockResolvedValueOnce({ items: [video(21)], cursor: null })
    const { wrapper } = await openSearchPage()

    expect(wrapper.text()).not.toContain('No results')

    await fetchMore(wrapper).trigger('click')
    await flushPromises()

    expect(layer.search).toHaveBeenLastCalledWith(QUERY, { type: 'video', cursor: 20 })
    expect(cardTitles(wrapper)).toEqual(['Video 21'])
  })
})

describe('automatic loading past empty pages', () => {
  function autoLoad(wrapper) {
    return wrapper.findComponent({ name: 'FtAutoLoadNextPageWrapper' })
  }

  it('stops after three empty pages in a row, and leaves the rest to the button', async () => {
    // Every result NSFW, say: each page filtered empty, and never the end
    let start = 0
    layer.search.mockImplementation(async () => ({ items: [], cursor: (start += 20) }))
    const { wrapper } = await openSearchPage()

    autoLoad(wrapper).vm.$emit('load-next-page')
    await flushPromises()
    autoLoad(wrapper).vm.$emit('load-next-page')
    await flushPromises()

    expect(layer.search).toHaveBeenCalledTimes(3)
    expect(autoLoad(wrapper).exists()).toBe(false)
    expect(fetchMore(wrapper).exists()).toBe(true)

    await fetchMore(wrapper).trigger('click')
    await flushPromises()

    expect(layer.search).toHaveBeenCalledTimes(4)
    expect(layer.search).toHaveBeenLastCalledWith(QUERY, { type: 'video', cursor: 60 })
    expect(autoLoad(wrapper).exists()).toBe(false)
  })

  it('loads automatically again once a page has results', async () => {
    layer.search
      .mockResolvedValueOnce({ items: [], cursor: 20 })
      .mockResolvedValueOnce({ items: [], cursor: 40 })
      .mockResolvedValueOnce({ items: [], cursor: 60 })
      .mockResolvedValueOnce({ items: [video(61)], cursor: 80 })
      .mockResolvedValueOnce({ items: [video(81)], cursor: null })
    const { wrapper } = await openSearchPage()

    autoLoad(wrapper).vm.$emit('load-next-page')
    await flushPromises()
    autoLoad(wrapper).vm.$emit('load-next-page')
    await flushPromises()
    await fetchMore(wrapper).trigger('click')
    await flushPromises()

    expect(autoLoad(wrapper).exists()).toBe(true)
    autoLoad(wrapper).vm.$emit('load-next-page')
    await flushPromises()

    expect(cardTitles(wrapper)).toEqual(['Video 61', 'Video 81'])
  })

  it('counts afresh for a new search', async () => {
    let start = 0
    layer.search.mockImplementation(async () => ({ items: [], cursor: (start += 20) }))
    const { wrapper, router } = await openSearchPage()

    autoLoad(wrapper).vm.$emit('load-next-page')
    await flushPromises()
    autoLoad(wrapper).vm.$emit('load-next-page')
    await flushPromises()
    expect(autoLoad(wrapper).exists()).toBe(false)

    await router.push('/peertube/search/other')
    await flushPromises()

    expect(autoLoad(wrapper).exists()).toBe(true)
  })
})

describe('the switch between videos and channels', () => {
  it('opens on the videos', async () => {
    const { wrapper } = await openSearchPage()

    expect(wrapper.find('#videoTab').classes()).toContain('selectedTab')
    expect(wrapper.find('#videoTab').text()).toBe('Videos')
    expect(wrapper.find('#channelTab').text()).toBe('Channels')
  })

  it('puts the channels in the route, and searches for channels', async () => {
    const { wrapper, router } = await openSearchPage()

    await wrapper.find('#channelTab').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.params).toEqual({ query: QUERY })
    expect(router.currentRoute.value.query).toEqual({ type: 'channel' })
    expect(layer.search).toHaveBeenLastCalledWith(QUERY, { type: 'channel', cursor: null })
    expect(wrapper.findAll('.channelCard').map(card => card.text())).toEqual(['Channel 1', 'Channel 2'])
    expect(wrapper.find('.videoCard').exists()).toBe(false)
    expect(wrapper.find('#channelTab').classes()).toContain('selectedTab')

    await wrapper.find('#videoTab').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query).toEqual({})
    expect(layer.search).toHaveBeenLastCalledWith(QUERY, { type: 'video', cursor: null })
    expect(cardTitles(wrapper)).toEqual(['Video 1', 'Video 2'])
  })

  it('opens on the channels when the route names them', async () => {
    const { wrapper } = await openSearchPage(`/peertube/search/${QUERY}?type=channel`)

    expect(layer.search).toHaveBeenCalledTimes(1)
    expect(layer.search).toHaveBeenCalledWith(QUERY, { type: 'channel', cursor: null })
    expect(cardTitles(wrapper)).toEqual(['Channel 1', 'Channel 2'])
  })

  it('reads an unknown type as the videos', async () => {
    await openSearchPage(`/peertube/search/${QUERY}?type=playlist`)

    expect(layer.search).toHaveBeenCalledWith(QUERY, { type: 'video', cursor: null })
  })

  it('ignores the answer for a type that has since been switched away from', async () => {
    const { wrapper } = await openSearchPage()
    const slow = deferred()
    layer.search.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ items: [video(7)], cursor: null })

    await wrapper.find('#channelTab').trigger('click')
    await flushPromises()
    await wrapper.find('#videoTab').trigger('click')
    await flushPromises()
    slow.resolve({ items: [channel(5)], cursor: null })
    await flushPromises()

    expect(cardTitles(wrapper)).toEqual(['Video 7'])
  })
})

describe('when the search fails', () => {
  it.each([
    ['unavailable', 'Could not reach sepiasearch.org.'],
    ['rateLimited', 'sepiasearch.org is limiting requests, try again in a moment.'],
    ['invalid', 'Fjernsyn cannot search https://sepiasearch.org. Check the search source in the PeerTube settings.'],
    ['notFound', 'Fjernsyn cannot search https://sepiasearch.org. Check the search source in the PeerTube settings.'],
  ])('a search the layer answers %s for says so, and offers to try again', async (kind, message) => {
    layer.search.mockRejectedValue(new PlatformError(kind, kind, { host: 'sepiasearch.org' }))
    const { wrapper } = await openSearchPage()

    expect(wrapper.text()).toContain(message)
    expect(wrapper.find('.retryButton').exists()).toBe(true)
  })

  it('says it could not search for anything else', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    layer.search.mockRejectedValue(new TypeError('boom'))

    try {
      const { wrapper } = await openSearchPage()
      expect(wrapper.text()).toContain('The search could not be completed.')
      expect(wrapper.find('.retryButton').exists()).toBe(true)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('names an invalid search source as it is set', async () => {
    layer.config = { peertubeSearchSource: 'http://index.example' }
    layer.search.mockRejectedValue(new PlatformError('invalid', 'not a source'))
    const { wrapper } = await openSearchPage()

    expect(wrapper.text()).toContain('Fjernsyn cannot search http://index.example.')
  })

  it('tries again when asked, and shows the results', async () => {
    layer.search.mockRejectedValueOnce(new PlatformError('unavailable', 'down', { host: 'sepiasearch.org' }))
    const { wrapper } = await openSearchPage()

    await wrapper.find('.retryButton').trigger('click')
    await flushPromises()

    expect(layer.search).toHaveBeenLastCalledWith(QUERY, { type: 'video', cursor: null })
    expect(cardTitles(wrapper)).toEqual(['Video 1', 'Video 2'])
    expect(wrapper.find('.retryButton').exists()).toBe(false)
  })

  it('keeps what it has when a later page fails, and tries that page again', async () => {
    layer.search
      .mockResolvedValueOnce({ items: [video(1)], cursor: 1 })
      .mockRejectedValueOnce(new PlatformError('rateLimited', 'slow down', { host: 'sepiasearch.org' }))
      .mockResolvedValueOnce({ items: [video(2)], cursor: null })
    const { wrapper } = await openSearchPage()

    await fetchMore(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('sepiasearch.org is limiting requests')
    expect(cardTitles(wrapper)).toEqual(['Video 1'])

    await wrapper.find('.retryButton').trigger('click')
    await flushPromises()

    expect(layer.search).toHaveBeenLastCalledWith(QUERY, { type: 'video', cursor: 1 })
    expect(cardTitles(wrapper)).toEqual(['Video 1', 'Video 2'])
  })
})
