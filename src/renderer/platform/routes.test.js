import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'

import { showToast } from '../helpers/utils'
import { createFakeStore } from '../testing/store'
import { createTestRouter } from '../testing/router'
import { peerTubeRouteGuard, peerTubeRoutes } from './routes.js'
import { installPlatformLayer } from './vue.js'

vi.mock('./index.js', () => ({ createPlatformLayer: () => ({}) }))

vi.mock('../helpers/utils', () => ({
  showToast: vi.fn(),
  getVideoParamsFromUrl: () => ({ videoId: null, timestamp: null, playlistId: null }),
}))

// The views are under test beside themselves; here they only need to exist
vi.mock('../views/LayerWatch/LayerWatch.vue', () => ({ default: { name: 'LayerWatch', render: () => null } }))
vi.mock('../views/LayerChannel/LayerChannel.vue', () => ({ default: { name: 'LayerChannel', render: () => null } }))

vi.mock('../i18n/index', async () => {
  const { createTestI18n } = await import('../testing/i18n')
  return { default: createTestI18n() }
})

const SWITCHED_OFF = 'PeerTube is switched off. Switch it on in Experimental settings.'

let store

beforeEach(() => {
  showToast.mockClear()
  store = createFakeStore({ getters: { getEnablePeerTube: false } })
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
    expect(matched[0].components.default.name).toBe('LayerWatch')
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
