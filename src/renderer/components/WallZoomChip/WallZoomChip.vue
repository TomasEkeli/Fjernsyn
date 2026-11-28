<!--
  How big a tile on the wall is. One setting behind every wall, as the Watched
  and AI pills are, so the size the reader picks here is the size everywhere.

  It is a pill for the look of the row it sits in, but it is a disclosure and
  not a toggle, so it is its own button wearing FtToggleChip's stylesheet
  rather than the component: a toggle says `aria-pressed`, and what this says
  is `aria-expanded`.

  Dragging shows its result immediately by writing the wall's custom property
  straight onto the body, and only saves when the handle is let go. The two
  agree because the setting's side effect writes the same property, so the
  preview is overwritten with an identical value rather than fighting it. A
  drag that is abandoned without a `change` leaves the preview in place until
  the next load, which is the one case where the two differ, and it is the
  behaviour a reader would expect from letting go outside the slider anyway.
-->
<template>
  <div
    class="wallZoom"
    @focusout="handleFocusOut"
  >
    <button
      ref="trigger"
      class="chip"
      :class="{ chipPressed: open }"
      type="button"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :title="t('Zoom Chip.Hint')"
      @click="toggle"
    >
      <FontAwesomeIcon
        class="chipIcon"
        :icon="['fas', 'expand']"
        aria-hidden="true"
      />
      {{ t('Zoom Chip.Zoom', { value: shown }) }}
    </button>
    <div
      v-if="open"
      ref="panel"
      class="panel"
      tabindex="-1"
      role="dialog"
      :aria-label="t('Zoom Chip.Zoom', { value: shown })"
      @keydown.esc.stop="close"
    >
      <FtSlider
        :label="t('Zoom Chip.Tile Size')"
        :default-value="zoom"
        :min-value="WALL_TILE_ZOOM.MIN"
        :max-value="WALL_TILE_ZOOM.MAX"
        :step="WALL_TILE_ZOOM.STEP"
        value-extension="%"
        @input="preview"
        @change="save"
      />
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'

import store from '../../store/index'
import FtSlider from '../FtSlider/FtSlider.vue'
import { WALL_TILE_ZOOM } from '../../../constants'

const { t } = useI18n()

const open = ref(false)
const trigger = useTemplateRef('trigger')
const panel = useTemplateRef('panel')

const zoom = computed(() => store.getters.getWallTileZoom)

// What the pill reads. The saved value, except while the handle is moving,
// when it is the value under the handle: a pill that still said 100% over a
// wall that had visibly changed would look broken. Cleared on release, so the
// saved value takes over again and there is only ever one source of truth at
// rest.
const dragging = ref(null)
const shown = computed(() => dragging.value ?? zoom.value)

function toggle() {
  open.value = !open.value

  if (open.value) {
    nextTick(() => panel.value?.focus())
  }
}

function close() {
  open.value = false
  trigger.value?.focus()
}

// The whole control is one focus scope, so focus leaving it closes the panel.
// `relatedTarget` is null when focus goes nowhere, as it does on a click into
// dead space, and that counts as leaving.
function handleFocusOut(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) {
    open.value = false
  }
}

function preview(value) {
  dragging.value = value
  document.body.style.setProperty('--ft-wall-zoom', value / 100)
}

function save(value) {
  dragging.value = null
  store.dispatch('updateWallTileZoom', value)
}
</script>

<style scoped src="../FtToggleChip/FtToggleChip.css" />
<style scoped src="./WallZoomChip.css" />
