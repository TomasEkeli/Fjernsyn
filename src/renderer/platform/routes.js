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
 * - `/peertube/channel/:handle/:currentTab?`, name `peertubeChannel`, the
 *   handle `name@host`, the tab `videos` (the default) or `playlists`: the
 *   layer's channel view
 * - `/peertube/search/:query`, name `peertubeSearch`, query `type`, `video`
 *   (the default) or `channel`: a redirect to `/search/:query` in scope
 *   `peertube`, with its type, so links to it keep working
 *
 * And upstream's `/search/:query` renders `LayerSearchPage`, the layer's
 * search page, directly: search has left its surface switch (ADR-0018), and
 * upstream's search page stays in the tree, unrouted.
 *
 * The views are imported statically, as `router/index.js` imports upstream's.
 * A view reaches the router again through `helpers/utils`, which is the same
 * cycle every upstream view closes, and harmless for the same reason: nothing
 * on it reads the router while the modules are still being evaluated.
 */

import LayerChannel from '../views/LayerChannel/LayerChannel.vue'
import LayerSearch from '../views/LayerSearch/LayerSearch.vue'
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

/**
 * `beforeEnter` for the PeerTube search route: the same search on the search
 * page, in scope PeerTube.
 *
 * @param {import('vue-router').RouteLocationNormalized} to
 * @returns {Promise<boolean | import('vue-router').RouteLocationRaw>}
 */
export async function peerTubeSearchGuard(to) {
  const allowed = await peerTubeRouteGuard()

  if (!allowed) {
    return false
  }

  const query = { scope: 'peertube' }

  if (to.query.type === 'channel') {
    query.type = 'channel'
  }

  return { path: `/search/${encodeURIComponent(String(to.params.query ?? ''))}`, query, replace: true }
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
  {
    path: '/peertube/channel/:handle/:currentTab?',
    name: 'peertubeChannel',
    meta: {
      title: 'Channel'
    },
    beforeEnter: peerTubeRouteGuard,
    component: LayerChannel
  },
  {
    path: '/peertube/search/:query',
    name: 'peertubeSearch',
    meta: {
      title: 'Search Results'
    },
    beforeEnter: peerTubeSearchGuard,
    component: LayerSearch
  },
]
