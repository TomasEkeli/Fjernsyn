/**
 * The PeerTube routes, spread into the app's routes by `router/index.js`.
 *
 * They exist only while PeerTube is switched on: each carries
 * `peerTubeRouteGuard`, which refuses the navigation with a message while the
 * experimental setting is off. Stored PeerTube records still render in lists
 * either way; only these pages are unreachable.
 *
 * The views arrive in later tickets, each adding its route here with the
 * guard, at these paths (hash router; see `.scratch/platform-layer/design.md`):
 *
 * - `/peertube/watch/:host/:uuid`, name `peertubeWatch`, query `timestamp`
 *   as for YouTube
 * - `/peertube/channel/:handle/:currentTab?`, name `peertubeChannel`
 * - `/peertube/search/:query`, name `peertubeSearch`
 */

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
export const peerTubeRoutes = []
