import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { RouterView } from 'vue-router'

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
vi.mock('../views/Hashtag/Hashtag.vue', () => view('Hashtag'))
vi.mock('../views/Post.vue', () => view('Post'))
vi.mock('../views/LayerChannel/LayerChannel.vue', () => view('LayerChannel'))
vi.mock('../views/LayerSearch/LayerSearch.vue', () => view('LayerSearch'))
vi.mock('../views/LayerWatch/LayerWatch.vue', () => view('LayerWatch'))
vi.mock('../views/LayerSearchPage/LayerSearchPage.vue', () => ({
  default: { name: 'LayerSearchPage', render: () => h('p', { class: 'layerSearchPage' }) },
}))

vi.mock('../store/index', async () => {
  const { createFakeStore } = await import('../testing/store')
  return { default: createFakeStore() }
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

describe('the channel route', () => {
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

  it.each(paths)('renders the layer\'s channel view, with no setting involved, %s', async (_what, path, params, query) => {
    const wrapper = await open(path)

    expect(router.currentRoute.value.params).toEqual(params)
    expect(router.currentRoute.value.query).toEqual(query)
    expect(router.currentRoute.value.matched[0].meta.title).toBe('Channel')
    expect(rendered(wrapper, ['Channel', 'LayerChannel'])).toEqual(['LayerChannel'])
  })
})

describe('the watch route', () => {
  const paths = [
    ['a video', '/watch/dQw4w9WgXcQ', {}],
    ['a video from a timestamp', '/watch/dQw4w9WgXcQ?timestamp=42', { timestamp: '42' }],
    [
      'a video in a YouTube playlist',
      '/watch/dQw4w9WgXcQ?playlistId=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI&playlistType=&timestamp=7',
      { playlistId: 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', playlistType: '', timestamp: '7' },
    ],
    [
      'a video in a user playlist',
      '/watch/dQw4w9WgXcQ?playlistId=mine&playlistType=user&playlistItemId=u1',
      { playlistId: 'mine', playlistType: 'user', playlistItemId: 'u1' },
    ],
  ]

  it.each(paths)('renders the layer\'s watch view, with no setting involved, for %s', async (_what, path, query) => {
    const wrapper = await open(path)

    expect(router.currentRoute.value.params).toEqual({ id: 'dQw4w9WgXcQ' })
    expect(router.currentRoute.value.query).toEqual(query)
    expect(router.currentRoute.value.matched[0].meta.title).toBe('Watch')
    expect(rendered(wrapper, ['Watch', 'LayerWatch'])).toEqual(['LayerWatch'])
  })
})
