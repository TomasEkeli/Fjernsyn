import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'

import { openInternalPath, showToast } from '../../helpers/utils'
import { openPeerTubeEntry } from '../../platform/entryPoints'
import store from '../../store/index'
import { installPlatformLayer } from '../../platform/vue.js'
import { mountWithApp } from '../../testing/mount'
import { createTestRouter } from '../../testing/router'
import TopNav from './TopNav.vue'

// Only the fork's hook in `goToSearch` is under test here: the search bar
// hands its text to the PeerTube entry point first, and to the YouTube parser
// only when that hands it back

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getLandingPage: 'subscriptions',
        getSearchSettings: { prioritize: 'relevance', time: '', type: 'all', duration: '', features: [] },
        getLatestMatchingSearchHistoryNames: () => [],
        getLatestSearchHistoryNames: [],
        getEnablePeerTube: false,
        getEnableLayerSearch: false,
        getDefaultSearchScope: 'youtube',
        getSearchRememberedParameters: null,
        getSearchLatched: false,
        getRememberSearchHistory: false,
        getSearchFilterValueChanged: false,
      },
    }),
  }
})

vi.mock('../../platform/entryPoints', () => ({ openPeerTubeEntry: vi.fn() }))

vi.mock('../../helpers/utils', async (importOriginal) => ({
  ...await importOriginal(),
  openInternalPath: vi.fn(),
  showToast: vi.fn(),
}))

const searchInput = vi.hoisted(() => ({ setText: null }))

vi.mock('../../helpers/api/local', () => ({
  clearLocalSearchSuggestionsSession: vi.fn(),
  getLocalClip: vi.fn(),
  getLocalSearchSuggestions: vi.fn(),
}))

vi.mock('../../helpers/api/invidious', () => ({
  getClipInvidious: vi.fn(),
  getInvidiousSearchSuggestions: vi.fn(),
}))

const FtInputStub = defineComponent({
  name: 'FtInput',
  setup(_props, { expose }) {
    searchInput.setText = vi.fn()
    expose({ blur: vi.fn(), setText: searchInput.setText })
    return () => h('input', { class: 'searchInput' })
  },
})

const STUBS = {
  FtInput: FtInputStub,
  FtProfileSelector: true,
  FtIconButton: true,
  FtYtDlpDownloads: true,
  FontAwesomeIcon: true,
}

async function mountTopNav() {
  const router = createTestRouter([{ path: '/subscriptions', meta: { title: 'Subscriptions' } }])
  await router.push('/subscriptions')

  const wrapper = mountWithApp(TopNav, { store, router, stubs: STUBS })
  await flushPromises()
  return wrapper
}

/** @param {import('@vue/test-utils').VueWrapper} wrapper */
async function search(wrapper, text, { shiftKey = false, ctrlKey = false } = {}) {
  wrapper.findComponent({ name: 'FtInput' }).vm.$emit('click', text, { event: { shiftKey, ctrlKey } })
  await flushPromises()
}

const youtubeUrlInfoRequests = () => store.dispatched.filter(({ type }) => type === 'getYoutubeUrlInfo')

beforeEach(() => {
  window.ftElectron = {
    getNavigationHistory: vi.fn(async () => [{ label: '', active: true }]),
    handleUpdateSearchInputText: vi.fn(),
  }
  store.dispatched.length = 0
  store.setGetter('getEnablePeerTube', false)
  store.setGetter('getEnableLayerSearch', false)
  store.setGetter('getSearchRememberedParameters', null)
  store.setGetter('getSearchLatched', false)
  store.setGetter('getRememberSearchHistory', false)
  openInternalPath.mockClear()
  showToast.mockClear()
  openPeerTubeEntry.mockReset()

  youtubeUrlInfo = { urlType: 'video', videoId: 'dQw4w9WgXcQ' }
})

// The YouTube parser's answer to `getYoutubeUrlInfo`, per test
let youtubeUrlInfo

const recordingDispatch = store.dispatch
store.dispatch = (type, payload) => {
  const result = recordingDispatch(type, payload)
  return type === 'getYoutubeUrlInfo' ? Promise.resolve(youtubeUrlInfo) : result
}

afterEach(() => {
  delete window.ftElectron
  vi.unstubAllGlobals()
})

describe('the search bar', () => {
  it('opens what the PeerTube entry point opened, and does not ask the YouTube parser', async () => {
    openPeerTubeEntry.mockResolvedValue('opened')
    const wrapper = await mountTopNav()

    await search(wrapper, 'https://video.blender.org/w/9c9de5e8-0a1e-484a-b099-e80766180a6d', { shiftKey: true })

    expect(openPeerTubeEntry).toHaveBeenCalledWith('https://video.blender.org/w/9c9de5e8-0a1e-484a-b099-e80766180a6d', {
      doCreateNewWindow: true,
      searchQueryText: 'https://video.blender.org/w/9c9de5e8-0a1e-484a-b099-e80766180a6d',
    })
    expect(youtubeUrlInfoRequests()).toEqual([])
  })

  it('stops when the PeerTube entry point stopped, searching nothing', async () => {
    openPeerTubeEntry.mockResolvedValue('stopped')
    const wrapper = await mountTopNav()

    await search(wrapper, 'https://down.example/w/9c9de5e8-0a1e-484a-b099-e80766180a6d')

    expect(youtubeUrlInfoRequests()).toEqual([])
    expect(openInternalPath).not.toHaveBeenCalled()
  })

  it('goes on to the YouTube parser, as before, when the PeerTube entry point hands the text back', async () => {
    openPeerTubeEntry.mockResolvedValue(null)
    const wrapper = await mountTopNav()

    await search(wrapper, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')

    expect(youtubeUrlInfoRequests()).toEqual([{ type: 'getYoutubeUrlInfo', payload: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }])
    expect(openInternalPath).toHaveBeenCalledWith({
      path: '/watch/dQw4w9WgXcQ',
      query: {},
      doCreateNewWindow: false,
      searchQueryText: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    })
  })

  it('clears the search bar when the PeerTube page opened in a new window', async () => {
    openPeerTubeEntry.mockResolvedValue('opened')
    const wrapper = await mountTopNav()

    await search(wrapper, 'blender_studio@video.blender.org', { shiftKey: true })

    expect(searchInput.setText).toHaveBeenCalledWith('')
  })

  it.each([
    ['opened in this window', 'opened', false],
    ['stopped', 'stopped', true],
  ])('leaves the search bar as it is when the PeerTube entry point %s', async (_what, outcome, shiftKey) => {
    openPeerTubeEntry.mockResolvedValue(outcome)
    const wrapper = await mountTopNav()

    await search(wrapper, 'blender_studio@video.blender.org', { shiftKey })

    expect(searchInput.setText).not.toHaveBeenCalled()
  })
})

// Through the real entry point and the real layer, with only the network faked
describe('the search bar, with PeerTube on', () => {
  const EMAIL = 'jane.doe@example.com'

  beforeEach(async () => {
    const { openPeerTubeEntry: realOpenPeerTubeEntry } = await vi.importActual('../../platform/entryPoints')
    openPeerTubeEntry.mockImplementation(realOpenPeerTubeEntry)
    store.setGetter('getEnablePeerTube', true)
    // Only its `provide` is used; nothing here reads the provided layer
    installPlatformLayer({ provide: () => {} }, store)
    youtubeUrlInfo = { urlType: 'invalid_url' }
  })

  const searchFor = text => ({
    path: `/search/${encodeURIComponent(text)}`,
    query: { prioritize: 'relevance', time: '', type: 'all', duration: '', features: [] },
    doCreateNewWindow: false,
    searchQueryText: text,
  })

  it.each([
    ['cannot be reached', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['is failing', async () => new Response('', { status: 503 })],
    ['refuses', async () => new Response('', { status: 403 })],
    ['is rate limiting', async () => new Response('', { status: 429, headers: { 'Retry-After': '5' } })],
    ['is not PeerTube', async () => new Response('<html></html>', { status: 404 })],
  ])('searches YouTube for an email address whose host %s, saying nothing', async (_what, answer) => {
    const fetch = vi.fn(answer)
    vi.stubGlobal('fetch', fetch)
    const wrapper = await mountTopNav()

    await search(wrapper, EMAIL)

    expect(fetch).toHaveBeenCalledOnce()
    expect(youtubeUrlInfoRequests()).toEqual([{ type: 'getYoutubeUrlInfo', payload: EMAIL }])
    expect(openInternalPath).toHaveBeenCalledWith(searchFor(EMAIL))
    expect(showToast).not.toHaveBeenCalled()
  })

  it('stops, with a toast, on a PeerTube URL whose host cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))
    const wrapper = await mountTopNav()

    await search(wrapper, 'https://down.example/w/9c9de5e8-0a1e-484a-b099-e80766180a6d')

    expect(youtubeUrlInfoRequests()).toEqual([])
    expect(openInternalPath).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledOnce()
  })
})

describe('the search bar, with the layer\'s search page on', () => {
  const remembered = { scope: 'youtube', sort: 'views', time: 'week' }

  beforeEach(() => {
    store.setGetter('getEnableLayerSearch', true)
    openPeerTubeEntry.mockResolvedValue(null)
    youtubeUrlInfo = { urlType: 'invalid_url' }
  })

  it('shows the pill in place of the filter button, once something is remembered', async () => {
    let wrapper = await mountTopNav()
    expect(wrapper.find('.navFilterButton').exists()).toBe(false)
    expect(wrapper.find('.searchPill').exists()).toBe(false)

    store.setGetter('getSearchRememberedParameters', remembered)
    wrapper = await mountTopNav()

    expect(wrapper.find('.searchPill .pillWords').text()).toBe('YouTube · most viewed · this week')
  })

  it('searches the text without filters, in the default scope, while the pill is not lit', async () => {
    store.setGetter('getSearchRememberedParameters', remembered)
    const wrapper = await mountTopNav()

    await search(wrapper, 'blender')

    expect(openInternalPath).toHaveBeenCalledWith({
      path: '/search/blender',
      query: { scope: 'youtube' },
      doCreateNewWindow: false,
      searchQueryText: 'blender',
    })
  })

  it('searches with the remembered set while the pill is lit', async () => {
    store.setGetter('getSearchRememberedParameters', remembered)
    store.setGetter('getSearchLatched', true)
    const wrapper = await mountTopNav()

    await search(wrapper, 'blender')

    expect(openInternalPath.mock.calls[0][0].query).toEqual({ scope: 'youtube', sort: 'views', time: 'week' })
  })

  it('runs the opposite of the pill on Ctrl+Enter, this once, and leaves the pill as it was', async () => {
    store.setGetter('getSearchRememberedParameters', remembered)
    store.setGetter('getSearchLatched', true)
    const wrapper = await mountTopNav()

    await search(wrapper, 'blender', { ctrlKey: true })

    expect(openInternalPath.mock.calls[0][0].query).toEqual({ scope: 'youtube' })
    expect(store.dispatched.filter(({ type }) => type === 'updateSearchLatched')).toEqual([])
  })

  it('keeps Shift for a new window', async () => {
    const wrapper = await mountTopNav()

    await search(wrapper, 'blender', { shiftKey: true })

    expect(openInternalPath.mock.calls[0][0]).toMatchObject({ path: '/search/blender', doCreateNewWindow: true })
  })

  it('reads operators out of the text, and makes what they set the remembered set', async () => {
    store.setGetter('getRememberSearchHistory', true)
    const wrapper = await mountTopNav()

    await search(wrapper, 'blender sort:views time:year')

    expect(openInternalPath.mock.calls[0][0]).toMatchObject({
      path: '/search/blender',
      query: { scope: 'youtube', sort: 'views', time: 'year' },
      searchQueryText: 'blender sort:views time:year',
    })
    expect(store.dispatched).toContainEqual({
      type: 'updateSearchRememberedParameters',
      payload: expect.objectContaining({ scope: 'youtube', sort: 'views', time: 'year' }),
    })
    expect(store.dispatched).toContainEqual({ type: 'updateSearchLatched', payload: true })
    expect(store.dispatched).toContainEqual({ type: 'updateSearchHistoryEntry', payload: expect.objectContaining({ _id: 'blender sort:views time:year' }) })
  })

  it('still opens a YouTube URL as before', async () => {
    youtubeUrlInfo = { urlType: 'video', videoId: 'dQw4w9WgXcQ' }
    const wrapper = await mountTopNav()

    await search(wrapper, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')

    expect(openInternalPath.mock.calls[0][0].path).toBe('/watch/dQw4w9WgXcQ')
  })
})
