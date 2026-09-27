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
  // Empty until the views arrive; each later ticket's route is covered here
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
