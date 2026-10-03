import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import { RouterView } from 'vue-router'

import { showToast } from '../helpers/utils'
import store from '../store/index'
import { createTestRouter } from '../testing/router'
import { routeView } from '../components/LayerSurfaceSwitch/surfaceSwitch'
import { WatchSurface, layerSurface, peerTubeRouteGuard, peerTubeRoutes } from './routes.js'
import { installPlatformLayer } from './vue.js'

vi.mock('./index.js', () => ({ createPlatformLayer: () => ({}) }))

vi.mock('../helpers/utils', () => ({
  showToast: vi.fn(),
  getVideoParamsFromUrl: () => ({ videoId: null, timestamp: null, playlistId: null }),
}))

// The views are under test beside themselves; here they only need to exist
vi.mock('../views/LayerWatch/LayerWatch.vue', () => ({ default: { name: 'LayerWatch', render: () => null } }))
vi.mock('../views/LayerChannel/LayerChannel.vue', () => ({ default: { name: 'LayerChannel', render: () => null } }))
vi.mock('../views/LayerSearch/LayerSearch.vue', () => ({ default: { name: 'LayerSearch', render: () => null } }))
// Upstream's views on the surface switch (tested through the router in router/index.test.js)
vi.mock('../views/Channel/Channel.vue', () => ({ default: { name: 'Channel', render: () => null } }))
vi.mock('../views/Watch/Watch.vue', () => ({ default: { name: 'Watch', render: () => null } }))

// The surface switch reads the store module; the guards read the store installed
vi.mock('../store/index', async () => {
  const { createFakeStore } = await import('../testing/store')
  return { default: createFakeStore({ getters: { getEnablePeerTube: false, getEnableLayerSurfaces: false } }) }
})

vi.mock('../i18n/index', async () => {
  const { createTestI18n } = await import('../testing/i18n')
  return { default: createTestI18n() }
})

const SWITCHED_OFF = 'PeerTube is switched off. Switch it on in Experimental settings.'

beforeEach(() => {
  showToast.mockClear()
  store.setGetter('getEnablePeerTube', false)
  store.setGetter('getEnableLayerSurfaces', false)
  installPlatformLayer(createApp({ render: () => null }), store)
})

/**
 * A path that matches the route, with every required parameter filled in and
 * every optional one left out
 *
 * @param {string} path
 */
function concretePath(path) {
  return path.replaceAll(/\/:\w+\?/g, '').replaceAll(/:\w+/g, 'x')
}

describe('the PeerTube route guard', () => {
  it('lets the navigation through while PeerTube is switched on', async () => {
    store.setGetter('getEnablePeerTube', true)

    expect(await peerTubeRouteGuard()).toBe(true)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('refuses the navigation, saying why, while PeerTube is switched off', async () => {
    expect(await peerTubeRouteGuard()).toBe(false)
    expect(showToast).toHaveBeenCalledWith(SWITCHED_OFF)
  })
})

describe('the PeerTube routes', () => {
  it('include the watch page, carrying the host and uuid', async () => {
    store.setGetter('getEnablePeerTube', true)
    const router = createTestRouter(peerTubeRoutes)

    await router.push('/peertube/watch/video.blender.org/b29290cc-dc51-4a12-bcb2-2aa5fece7605?timestamp=12')

    const { name, params, query, matched } = router.currentRoute.value
    expect(name).toBe('peertubeWatch')
    expect(params).toEqual({ host: 'video.blender.org', uuid: 'b29290cc-dc51-4a12-bcb2-2aa5fece7605' })
    expect(query).toEqual({ timestamp: '12' })
    expect(matched[0].meta.title).toBe('Watch')
    // The switch `/watch/:id` renders, so that the router keeps the view between the two
    expect(matched[0].components.default).toBe(WatchSurface)
  })

  it.each([false, true])('render the layer\'s watch view on the watch page whatever the surface switch (on: %s)', async (on) => {
    store.setGetter('getEnablePeerTube', true)
    store.setGetter('getEnableLayerSurfaces', on)
    const router = createTestRouter(peerTubeRoutes)
    await router.push('/peertube/watch/video.blender.org/b29290cc-dc51-4a12-bcb2-2aa5fece7605')

    const wrapper = mount({ render: () => h(RouterView) }, { global: { plugins: [router] } })
    await flushPromises()

    expect(wrapper.findComponent({ name: 'LayerWatch' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'Watch' }).exists()).toBe(false)
    expect(routeView(router.currentRoute.value).name).toBe('LayerWatch')
  })

  it('include the channel page, carrying the handle, on its videos unless a tab is named', async () => {
    store.setGetter('getEnablePeerTube', true)
    const router = createTestRouter(peerTubeRoutes)

    await router.push('/peertube/channel/blender@video.blender.org')

    const { name, params, matched } = router.currentRoute.value
    expect(name).toBe('peertubeChannel')
    expect(params).toEqual({ handle: 'blender@video.blender.org' })
    expect(matched[0].meta.title).toBe('Channel')
    expect(matched[0].components.default.name).toBe('LayerChannel')

    await router.push('/peertube/channel/blender@video.blender.org/playlists')

    expect(router.currentRoute.value.params).toEqual({ handle: 'blender@video.blender.org', currentTab: 'playlists' })
  })

  it('include the PeerTube search, which hands every search on to the search page (below)', () => {
    const route = peerTubeRoutes.find(({ name }) => name === 'peertubeSearch')

    expect(route.path).toBe('/peertube/search/:query')
    expect(route.meta.title).toBe('Search Results')
  })

  // Each later ticket's route is covered here too
  it('are each refused, saying why, while PeerTube is switched off', async () => {
    const router = createTestRouter([{ path: '/subscriptions', name: 'subscriptions' }, ...peerTubeRoutes])

    for (const route of peerTubeRoutes) {
      showToast.mockClear()
      await router.push('/subscriptions')

      await router.push(concretePath(route.path))

      expect(router.currentRoute.value.name, route.name).toBe('subscriptions')
      expect(showToast, route.name).toHaveBeenCalledWith(SWITCHED_OFF)
    }
  })
})

describe('a route on the surface switch', () => {
  const OldView = { name: 'OldView', render: () => h('p', { class: 'oldView' }) }
  const LayerView = { name: 'LayerView', render: () => h('p', { class: 'layerView' }) }

  async function openSurface() {
    const router = createTestRouter([{ path: '/surface/:id', component: layerSurface('TestSurface', OldView, LayerView) }])
    await router.push('/surface/x')
    const wrapper = mount({ render: () => h(RouterView) }, { global: { plugins: [router] } })
    await flushPromises()
    return wrapper
  }

  it('renders the old view while the switch is off', async () => {
    const wrapper = await openSurface()

    expect(wrapper.find('.oldView').exists()).toBe(true)
    expect(wrapper.find('.layerView').exists()).toBe(false)
  })

  it('renders the layer\'s view while the switch is on, and swaps in place when it changes', async () => {
    store.setGetter('getEnableLayerSurfaces', true)
    const wrapper = await openSurface()

    expect(wrapper.find('.layerView').exists()).toBe(true)
    expect(wrapper.find('.oldView').exists()).toBe(false)

    store.setGetter('getEnableLayerSurfaces', false)
    await flushPromises()

    expect(wrapper.find('.oldView').exists()).toBe(true)
    expect(wrapper.find('.layerView').exists()).toBe(false)

    store.setGetter('getEnableLayerSurfaces', true)
    await flushPromises()

    expect(wrapper.find('.layerView').exists()).toBe(true)
  })

  it('says which view a route renders: the one its switch picks, or its own component', async () => {
    const Elsewhere = { name: 'Elsewhere', render: () => null }
    const router = createTestRouter([
      { path: '/surface/:id', component: layerSurface('TestSurface', OldView, LayerView) },
      { path: '/elsewhere', component: Elsewhere },
    ])

    expect(routeView(router.resolve('/surface/x'))).toBe(OldView)
    store.setGetter('getEnableLayerSurfaces', true)
    expect(routeView(router.resolve('/surface/x'))).toBe(LayerView)
    expect(routeView(router.resolve('/elsewhere'))).toBe(Elsewhere)
  })

  describe('shared with a route only the layer serves', () => {
    async function openShared(path) {
      const surface = layerSurface('TestSurface', OldView, LayerView, { layerOnly: ({ name }) => name === 'layerOnly' })
      const router = createTestRouter([
        { path: '/surface/:id', component: surface },
        { path: '/layer/:id', name: 'layerOnly', component: surface },
      ])
      await router.push(path)
      const wrapper = mount({ render: () => h(RouterView) }, { global: { plugins: [router] } })
      await flushPromises()
      return { wrapper, router }
    }

    it('renders the layer\'s view there whatever the switch, and the old view on the switched route while it is off', async () => {
      const { wrapper, router } = await openShared('/layer/x')

      expect(wrapper.find('.layerView').exists()).toBe(true)
      expect(routeView(router.currentRoute.value)).toBe(LayerView)

      await router.push('/surface/x')
      await flushPromises()

      expect(wrapper.find('.oldView').exists()).toBe(true)
      expect(wrapper.find('.layerView').exists()).toBe(false)
    })

    it('keeps its view on the way out, as the app\'s out-in transition holds it, rather than picking for the route it gives way to', async () => {
      const surface = layerSurface('TestSurface', OldView, LayerView, { layerOnly: ({ name }) => name === 'layerOnly' })
      const router = createTestRouter([
        { path: '/layer/:id', name: 'layerOnly', component: surface },
        { path: '/elsewhere' },
      ])
      await router.push('/layer/x')
      // The switch alone, as the transition keeps it once the router view has moved on
      const wrapper = mount(surface, { global: { plugins: [router] } })
      await flushPromises()

      await router.push('/elsewhere')
      await flushPromises()

      expect(wrapper.find('.layerView').exists()).toBe(true)
      expect(wrapper.find('.oldView').exists()).toBe(false)
    })

    it('keeps the one layer view across the two routes while the switch is on', async () => {
      store.setGetter('getEnableLayerSurfaces', true)
      const { wrapper, router } = await openShared('/surface/x')
      const view = wrapper.findComponent(LayerView).vm.$

      await router.push('/layer/y')
      await flushPromises()

      expect(wrapper.findComponent(LayerView).vm.$).toBe(view)

      await router.push('/surface/z')
      await flushPromises()

      expect(wrapper.findComponent(LayerView).vm.$).toBe(view)
    })
  })

  describe('passing the view\'s own route guards on', () => {
    const calls = []

    // As upstream's watch view: a `beforeRouteLeave` that calls `next`, with the view as `this`
    const GuardedView = {
      name: 'GuardedView',
      data: () => ({ label: 'guarded' }),
      beforeRouteLeave(to, from, next) {
        calls.push(['leave', this.label, from.path, to.path])
        next(to.query.refuse === undefined)
      },
      beforeRouteUpdate(to, from) {
        calls.push(['update', this.label, from.path, to.path])
        return to.query.refuse === undefined
      },
      render: () => h('p', { class: 'guardedView' }),
    }

    async function openGuarded() {
      calls.length = 0
      const router = createTestRouter([
        { path: '/surface/:id', component: layerSurface('TestSurface', GuardedView, LayerView) },
        { path: '/elsewhere' },
      ])
      await router.push('/surface/x')
      const wrapper = mount({ render: () => h(RouterView) }, { global: { plugins: [router] } })
      await flushPromises()
      return { wrapper, router }
    }

    it('runs the view\'s beforeRouteLeave as the route is left, and lets it refuse', async () => {
      const { router } = await openGuarded()

      await router.push('/elsewhere?refuse')
      expect(router.currentRoute.value.path).toBe('/surface/x')

      await router.push('/elsewhere')
      expect(router.currentRoute.value.path).toBe('/elsewhere')
      expect(calls).toEqual([
        ['leave', 'guarded', '/surface/x', '/elsewhere'],
        ['leave', 'guarded', '/surface/x', '/elsewhere'],
      ])
    })

    it('runs the view\'s beforeRouteUpdate as the route changes its params, and lets it refuse', async () => {
      const { router } = await openGuarded()

      await router.push('/surface/y?refuse')
      expect(router.currentRoute.value.path).toBe('/surface/x')

      await router.push('/surface/y')
      expect(router.currentRoute.value.path).toBe('/surface/y')
      expect(calls).toEqual([
        ['update', 'guarded', '/surface/x', '/surface/y'],
        ['update', 'guarded', '/surface/x', '/surface/y'],
      ])
    })

    it('lets the navigation through where the view rendered has no guards', async () => {
      store.setGetter('getEnableLayerSurfaces', true)
      const { router } = await openGuarded()

      await router.push('/elsewhere')

      expect(router.currentRoute.value.path).toBe('/elsewhere')
      expect(calls).toEqual([])
    })
  })
})

describe('the PeerTube search route', () => {
  it('redirects to the search page in scope PeerTube, carrying the query and its type', async () => {
    store.setGetter('getEnablePeerTube', true)
    const router = createTestRouter([{ path: '/search/:query', name: 'search' }, ...peerTubeRoutes])

    await router.push('/peertube/search/blender%20tutorials?type=channel')

    const { path, params, query } = router.currentRoute.value
    expect(path).toBe('/search/blender%20tutorials')
    expect(params).toEqual({ query: 'blender tutorials' })
    expect(query).toEqual({ scope: 'peertube', type: 'channel' })
  })

  it('redirects a video search to the search page in scope PeerTube, with no type', async () => {
    store.setGetter('getEnablePeerTube', true)
    const router = createTestRouter([{ path: '/search/:query', name: 'search' }, ...peerTubeRoutes])

    await router.push('/peertube/search/blender')

    const { path, query } = router.currentRoute.value
    expect(path).toBe('/search/blender')
    expect(query).toEqual({ scope: 'peertube' })
  })

  it('is refused while PeerTube is off', async () => {
    const router = createTestRouter([{ path: '/subscriptions', name: 'subscriptions' }, ...peerTubeRoutes])
    await router.push('/subscriptions')

    await router.push('/peertube/search/blender')

    expect(router.currentRoute.value.name).toBe('subscriptions')
    expect(showToast).toHaveBeenCalledWith(SWITCHED_OFF)
  })
})
