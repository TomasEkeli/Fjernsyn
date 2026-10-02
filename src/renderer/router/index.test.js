import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { RouterView } from 'vue-router'

import router from './index'

// Every view the router imports, as a stub that says which it is. No store is
// mocked or installed: nothing on the route to a view reads a setting.
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

describe('the search route', () => {
  it('renders the layer\'s search page, with no setting involved', async () => {
    await router.push('/search/blender?scope=youtube')
    const wrapper = mount({ render: () => h(RouterView) }, { global: { plugins: [router] } })
    await flushPromises()

    const { params, query, matched } = router.currentRoute.value
    expect(params).toEqual({ query: 'blender' })
    expect(query).toEqual({ scope: 'youtube' })
    expect(matched[0].meta.title).toBe('Search Results')
    expect(wrapper.find('.layerSearchPage').exists()).toBe(true)
  })
})
