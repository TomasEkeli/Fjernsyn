/**
 * Whether a route path is a watch page, of any platform: YouTube's
 * `/watch/:id` or PeerTube's `/peertube/watch/:host/:uuid`.
 *
 * Kept free of imports, as the player and App.vue both read it and the
 * platform routes module would pull the views in with it.
 *
 * @param {string | null | undefined} path
 * @returns {boolean}
 */
export function isWatchPath(path) {
  return typeof path === 'string' && (path.startsWith('/watch/') || path.startsWith('/peertube/watch/'))
}
