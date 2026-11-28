// The view a route location renders, for a view that has to tell its own
// routes from others by what they render: the layer's watch view serves both
// `/watch/:id` and the PeerTube watch route, and keeps the player and the
// playlist panel as a playlist crosses between them.
//
// This was the surface switch's `routeView` (ADR-0014), which asked the switch
// which of two views it had picked for the location. Every YouTube surface has
// since left the switch (ADR-0018), so a route's component is the view, and
// the question is a lookup.

/**
 * @param {import('vue-router').RouteLocationNormalized} location
 * @returns {import('vue').Component | undefined}
 */
export function routeView(location) {
  return location.matched.at(-1)?.components?.default
}
