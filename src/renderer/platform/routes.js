/**
 * The PeerTube routes, spread into the app's routes by `router/index.js`.
 *
 * They exist only while PeerTube is switched on: each carries
 * `peerTubeRouteGuard`, which refuses the navigation with a message while the
 * experimental setting is off. Stored PeerTube records still render in lists
 * either way; only these pages are unreachable.
 *
 * The routes, as each view arrives (hash router; see
 * `.scratch/platform-layer/design.md`):
 *
 * - `/peertube/watch/:host/:uuid`, name `peertubeWatch`, query `timestamp`
 *   as for YouTube: the layer's watch view
 * - `/peertube/channel/:handle/:currentTab?`, name `peertubeChannel` (to come)
 * - `/peertube/search/:query`, name `peertubeSearch` (to come)
 *
 * The views are imported statically, as `router/index.js` imports upstream's.
 * A view reaches the router again through `helpers/utils`, which is the same
 * cycle every upstream view closes, and harmless for the same reason: nothing
 * on it reads the router while the modules are still being evaluated.
 */

import LayerWatch from '../views/LayerWatch/LayerWatch.vue'

/**
 * `beforeEnter` for every PeerTube route.
 *
 * Its imports are loaded when it runs, not with this module: the router
 * imports this module, and `helpers/utils` (and through it the wiring) imports
 * the router, so a static import would close a cycle.
 *
 * @returns {Promise<boolean>} whether the navigation may go ahead
 */
export async function peerTubeRouteGuard() {
  const { isPeerTubeEnabled } = await import('./vue.js')

  if (isPeerTubeEnabled()) {
    return true
  }

  const [{ showToast }, { default: i18n }] = await Promise.all([
    import('../helpers/utils'),
    import('../i18n/index'),
  ])

  showToast(i18n.global.t('PeerTube.Switched off'))
  return false
}

/** @type {import('vue-router').RouteRecordRaw[]} */
export const peerTubeRoutes = [
  {
    path: '/peertube/watch/:host/:uuid',
    name: 'peertubeWatch',
    meta: {
      title: 'Watch'
    },
    beforeEnter: peerTubeRouteGuard,
    component: LayerWatch
  },
]
