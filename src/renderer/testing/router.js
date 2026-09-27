import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

/** Rendered for any path no given route matches, so navigation always lands */
export const RouteStub = defineComponent({
  name: 'RouteStub',
  render: () => h('div', { class: 'routeStub' }),
})

/**
 * An in-memory router. Navigation to any path succeeds, landing on the given
 * route that matches or on a stub, so a test can assert where a component
 * sent the reader with `router.currentRoute.value` (its `name`, `path`,
 * `params` and `query`).
 *
 * Give the routes a view needs by name (for example
 * `{ path: '/peertube/watch/:host/:uuid', name: 'peertubeWatch' }`); a route
 * without a component gets the stub. Install the router as a global plugin;
 * navigation is asynchronous, so `await router.push(...)`, or after a click
 * `await flushPromises()` (from `@vue/test-utils`), before asserting.
 *
 * @param {import('vue-router').RouteRecordRaw[] | object[]} [routes]
 */
export function createTestRouter(routes = []) {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      ...routes.map(route => ({ component: RouteStub, ...route })),
      { path: '/:pathMatch(.*)*', name: 'testCatchAll', component: RouteStub },
    ],
  })
}
