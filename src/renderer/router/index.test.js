import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { RouterView } from 'vue-router'

import store from '../store/index'
import router from './index'

// Every view the router imports, as a stub that says which it is
const view = vi.hoisted(() => (name) => ({ default: { name, render: () => null } }))

vi.mock('../views/Subscriptions/Subscriptions.vue', () => view('Subscriptions'))
vi.mock('../views/ChannelsOverview/ChannelsOverview.vue', () => view('ChannelsOverview'))
vi.mock('../views/ProfileSettings/ProfileSettings.vue', () => view('ProfileSettings'))
vi.mock('../views/Explore/Explore.vue', () => view('Explore'))
vi.mock('../views/Popular/Popular.vue', () => view('Popular'))
vi.mock('../views/UserPlaylists/UserPlaylists.vue', () => view('UserPlaylists'))
vi.mock('../views/History/History.vue', () => view('History'))
vi.mock('../views/Settings/Settings.vue', () => view('Settings'))
vi.mock('../views/About/About.vue', () => view('About'))
vi.mock('../views/Playlist/Playlist.vue', () => view('Playlist'))
vi.mock('../views/Channel/Channel.vue', () => view('Channel'))
vi.mock('../views/Watch/Watch.vue', () => view('Watch'))
vi.mock('../views/Hashtag/Hashtag.vue', () => view('Hashtag'))
vi.mock('../views/Post.vue', () => view('Post'))
vi.mock('../views/LayerChannel/LayerChannel.vue', () => view('LayerChannel'))
vi.mock('../views/LayerSearch/LayerSearch.vue', () => view('LayerSearch'))
vi.mock('../views/LayerWatch/LayerWatch.vue', () => view('LayerWatch'))
vi.mock('../views/LayerSearchPage/LayerSearchPage.vue', () => ({
  default: { name: 'LayerSearchPage', render: () => h('p', { class: 'layerSearchPage' }) },
}))

// The surface switch (ADR-0018) reads its setting from the store module
vi.mock('../store/index', async () => {
  const { createFakeStore } = await import('../testing/store')
  return { default: createFakeStore({ getters: { getEnableLayerSurfaces: false } }) }
})

beforeEach(() => {
  store.setGetter('getEnableLayerSurfaces', false)
})

/**
 * The app's router at a path, in a router view
 *
 * @param {string} path
 */
async function open(path) {
  await router.push(path)
  const wrapper = mount({ render: () => h(RouterView) }, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

/**
 * The view the router view renders, by name
 *
 * @param {import('@vue/test-utils').VueWrapper} wrapper
 * @param {string[]} names the views that could be rendered
 */
function rendered(wrapper, names) {
  return names.filter(name => wrapper.findComponent({ name }).exists())
}

describe('the search route', () => {
  it('renders the layer\'s search page, with no setting involved', async () => {
    const wrapper = await open('/search/blender?scope=youtube')

    const { params, query, matched } = router.currentRoute.value
    expect(params).toEqual({ query: 'blender' })
    expect(query).toEqual({ scope: 'youtube' })
    expect(matched[0].meta.title).toBe('Search Results')
    expect(wrapper.find('.layerSearchPage').exists()).toBe(true)
  })
})

describe('the channel route, on the surface switch', () => {
  const CHANNEL_VIEWS = ['Channel', 'LayerChannel']

  const paths = [
    ['without a tab', '/channel/UCX6OQ3DkcsbYNE6H8uQQuVA', { id: 'UCX6OQ3DkcsbYNE6H8uQQuVA' }, {}],
    ['with a tab', '/channel/UCX6OQ3DkcsbYNE6H8uQQuVA/playlists', { id: 'UCX6OQ3DkcsbYNE6H8uQQuVA', currentTab: 'playlists' }, {}],
    [
      'with a channel link to resolve',
      '/channel/@MrBeast?url=https%3A%2F%2Fwww.youtube.com%2F%40MrBeast',
      { id: '@MrBeast' },
      { url: 'https://www.youtube.com/@MrBeast' },
    ],
    [
      'with a tab and a channel link to resolve',
      '/channel/@MrBeast/videos?url=https%3A%2F%2Fwww.youtube.com%2F%40MrBeast%2Fvideos',
      { id: '@MrBeast', currentTab: 'videos' },
      { url: 'https://www.youtube.com/@MrBeast/videos' },
    ],
  ]

  it.each(paths)('renders upstream\'s channel view while the switch is off, %s', async (_what, path, params, query) => {
    const wrapper = await open(path)

    expect(router.currentRoute.value.params).toEqual(params)
    expect(router.currentRoute.value.query).toEqual(query)
    expect(router.currentRoute.value.matched[0].meta.title).toBe('Channel')
    expect(rendered(wrapper, CHANNEL_VIEWS)).toEqual(['Channel'])
  })

  it.each(paths)('renders the layer\'s channel view while the switch is on, %s', async (_what, path, params, query) => {
    store.setGetter('getEnableLayerSurfaces', true)
    const wrapper = await open(path)

    expect(router.currentRoute.value.params).toEqual(params)
    expect(router.currentRoute.value.query).toEqual(query)
    expect(router.currentRoute.value.matched[0].meta.title).toBe('Channel')
    expect(rendered(wrapper, CHANNEL_VIEWS)).toEqual(['LayerChannel'])
  })
})
