<!--
  A profile's picture, chosen next to its bubble on the Channels page: the
  picker, in a menu placed and closed as the colour grid is. Picking is the
  change; there is nothing to confirm. A pick that is done closes it, and one
  that is not, going back to Character, leaves it open for a character to be
  typed.

  Escape, tabbing out of it, a click outside it or a scroll under it closes
  it. A scroll inside it, the icon grid's, does not. Nor does the system's
  file dialog opening, which takes the focus nowhere on the page.
-->
<template>
  <Teleport to=".app">
    <div
      ref="menu"
      class="pictureMenu"
      role="dialog"
      tabindex="-1"
      :aria-label="label"
      :style="position"
      @keydown.stop="handleKeydown"
      @focusout="handleFocusOut"
      @contextmenu.prevent
    >
      <ProfilePicturePicker
        ref="picker"
        :picture="current"
        :initial="initial"
        @pick="choose"
      />
    </div>
  </Teleport>
</template>

<script setup>
import { onMounted, useTemplateRef } from 'vue'

import ProfilePicturePicker from '../ProfilePicturePicker/ProfilePicturePicker.vue'

import { useAnchoredOverlay } from '../../composables/useAnchoredOverlay'

/** How big it expects to be: the picker with its icon grid, and the padding */
const WIDTH = 372
const HEIGHT = 340

const props = defineProps({
  /** The menu's name, for a screen reader */
  label: {
    type: String,
    required: true
  },
  /**
   * The profile's picture now, or null for its letter
   * @type {import('vue').PropType<import('../../helpers/profilePictures').ProfilePicture | null>}
   */
  current: {
    type: Object,
    default: null
  },
  /** The profile's initial, its character while it has no picture */
  initial: {
    type: String,
    default: ''
  },
  /** @type {import('vue').PropType<{ rect: DOMRect } | { x: number, y: number }>} */
  anchor: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['choose', 'close'])

const menu = useTemplateRef('menu')
const picker = useTemplateRef('picker')

const { position } = useAnchoredOverlay({
  element: menu,
  anchor: () => props.anchor,
  height: () => HEIGHT,
  width: () => WIDTH,
  onClose: () => emit('close', false)
})

/**
 * What Tab and Shift+Tab reach inside it. Of each group of radios, the
 * picker leaves only one in the tab order.
 * @returns {HTMLElement[]}
 */
function tabStops() {
  /** @type {NodeListOf<HTMLElement>} */
  const candidates = menu.value?.querySelectorAll('input, button, [tabindex]') ?? []

  return [...candidates].filter(element => element.tabIndex >= 0 && !element.hasAttribute('disabled'))
}

/**
 * @param {KeyboardEvent} event
 */
function handleKeydown(event) {
  if (event.isComposing) { return }

  if (event.key === 'Escape') {
    // Handled here, so the page does not also take it as clearing the selection
    event.preventDefault()
    emit('close', true)
    return
  }

  // Out of the last stop, or back out of the first: the menu is the last
  // thing on the page, so nothing useful is next, and the bubble is
  if (event.key === 'Tab') {
    const stops = tabStops()
    const edge = event.shiftKey ? stops[0] : stops.at(-1)

    if (edge === undefined || document.activeElement === edge) {
      event.preventDefault()
      emit('close', true)
    }
  }
}

/**
 * Closes when the focus goes somewhere else on the page. Not when it goes
 * nowhere on the page, which is what the system's file dialog opening looks
 * like: closing then would take the file input away under the dialog.
 * @param {FocusEvent} event
 */
function handleFocusOut(event) {
  const next = event.relatedTarget

  if (next !== null && !menu.value?.contains(next)) {
    emit('close', false)
  }
}

/**
 * @param {import('../../helpers/profilePictures').ProfilePicture | null} picture
 * @param {boolean} done
 */
function choose(picture, done) {
  // The choice first: whoever opened the menu may forget what it was for
  // once it is closed
  emit('choose', picture)

  if (done) {
    emit('close', true)
  }
}

onMounted(() => {
  picker.value?.focus()
})
</script>

<style scoped src="./ChannelsOverviewPictureMenu.css" />
