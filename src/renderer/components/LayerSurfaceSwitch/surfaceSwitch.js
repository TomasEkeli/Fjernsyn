// A surface switch (ADR-0014, ADR-0018): the component a route renders in
// place of a surface's view, choosing between upstream's view and the platform
// layer's from one experimental setting. The old view is not edited; while the
// setting is off it renders exactly as it did, and it stays in the tree,
// shadowed, while the setting is on. Changing the setting swaps the view in
// place.
//
//   component: surfaceSwitch({ name: 'ChannelSurface', getter: 'getEnableLayerSurfaces', off: Channel, on: LayerChannel })
//
// Attributes are passed through to whichever view renders. So are the view's
// in-component guards `beforeRouteLeave` and `beforeRouteUpdate` (the old
// watch view's saves the position and destroys the player as it is left):
// the router finds a route's guards on the component the route names, which
// is the switch. `beforeRouteEnter` is not, since no view of the switch's has
// one.
//
// A route only the layer serves (the PeerTube watch route) can render the same
// switch, so that the router keeps the layer's view as a playlist crosses
// between it and the YouTube route: `layerOnly` names it, and there the switch
// renders the layer's view whatever the setting.

import { computed, defineComponent, h } from 'vue'
import { useRoute } from 'vue-router'

import store from '../../store/index'

/** The switch's choice of view for a route location, on the component it returns */
const PICK = Symbol('surfaceSwitch.pick')

/**
 * @param {object} options
 * @param {string} options.name the component's name, for devtools and tests
 * @param {string} options.getter the store getter of the switch, true for the layer's view
 * @param {import('vue').Component} options.off upstream's view
 * @param {import('vue').Component} options.on the layer's view
 * @param {(location: import('vue-router').RouteLocationNormalized) => boolean} [options.layerOnly]
 *   whether a route the switch renders is one only the layer's view serves
 */
export function surfaceSwitch({ name, getter, off, on, layerOnly = () => false }) {
  /** @param {import('vue-router').RouteLocationNormalized} location */
  const pick = location => (store.getters[getter] === true || layerOnly(location) ? on : off)

  const component = defineComponent({
    name,
    beforeRouteUpdate(to, from) {
      return runViewGuard(this, 'beforeRouteUpdate', to, from)
    },
    beforeRouteLeave(to, from) {
      return runViewGuard(this, 'beforeRouteLeave', to, from)
    },
    inheritAttrs: false,
    setup(_props, { attrs }) {
      const route = useRoute()
      // Picked for the route while it renders this switch. A switch on its way
      // out (the app's out-in transition keeps it through its fade) keeps its
      // view rather than picking afresh for the route it is giving way to
      const view = computed(previous => (previous === undefined || rendersSwitch(route) ? pick(route) : previous))

      /** @param {import('vue-router').RouteLocationNormalized} location */
      function rendersSwitch(location) {
        return location.matched.some(record => record.components?.default === component)
      }

      return () => h(view.value, attrs)
    },
  })

  component[PICK] = pick
  return component
}

/**
 * The view a route location renders: the one its surface switch picks for it,
 * or the route's own component where it has no switch. For a view that has to
 * tell its own routes from others by what they render.
 *
 * @param {import('vue-router').RouteLocationNormalized} location
 * @returns {import('vue').Component | undefined}
 */
export function routeView(location) {
  const component = location.matched.at(-1)?.components?.default
  return component?.[PICK] ? component[PICK](location) : component
}

/**
 * Runs the rendered view's own in-component guard of a kind, as the router
 * would run it on the view: with the view as `this`, and with `next` where it
 * takes one. Resolves to what the guard decided, which the router reads as a
 * returned guard's answer.
 *
 * @param {import('vue').ComponentPublicInstance} surface the switch, as the router calls its guard
 * @param {'beforeRouteLeave' | 'beforeRouteUpdate'} kind
 * @param {import('vue-router').RouteLocationNormalized} to
 * @param {import('vue-router').RouteLocationNormalized} from
 */
function runViewGuard(surface, kind, to, from) {
  const view = surface.$.subTree?.component

  if (!view) {
    return true
  }

  const guard = (view.type.__vccOpts ?? view.type)[kind]

  if (typeof guard !== 'function') {
    return true
  }

  if (guard.length < 3) {
    return guard.call(view.proxy, to, from)
  }

  return new Promise((resolve, reject) => {
    try {
      Promise.resolve(guard.call(view.proxy, to, from, resolve)).catch(reject)
    } catch (error) {
      reject(error)
    }
  })
}
