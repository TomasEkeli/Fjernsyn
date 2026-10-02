// A surface switch (ADR-0014, ADR-0018): the component a route renders in
// place of a surface's view, choosing between upstream's view and the platform
// layer's from one experimental setting. The old view is not edited; while the
// setting is off it renders exactly as it did, and it stays in the tree,
// shadowed, while the setting is on. Changing the setting swaps the view in
// place.
//
//   component: surfaceSwitch({ name: 'ChannelSurface', getter: 'getEnableLayerSurfaces', off: Channel, on: LayerChannel })
//
// Attributes are passed through to whichever view renders.

import { computed, defineComponent, h } from 'vue'

import store from '../../store/index'

/**
 * @param {object} options
 * @param {string} options.name the component's name, for devtools and tests
 * @param {string} options.getter the store getter of the switch, true for the layer's view
 * @param {import('vue').Component} options.off upstream's view
 * @param {import('vue').Component} options.on the layer's view
 */
export function surfaceSwitch({ name, getter, off, on }) {
  return defineComponent({
    name,
    inheritAttrs: false,
    setup(_props, { attrs }) {
      const isOn = computed(() => store.getters[getter] === true)

      return () => h(isOn.value ? on : off, attrs)
    },
  })
}
