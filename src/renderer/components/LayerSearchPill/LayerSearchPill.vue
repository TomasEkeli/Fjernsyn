<template>
  <div
    v-if="remembered !== null"
    ref="pill"
    class="searchPill"
    :class="{ lit: latched }"
  >
    <button
      type="button"
      class="pillToggle"
      :aria-pressed="latched"
      :title="latched ? t('Layer Search.Pill.Lit', { filters: words }) : t('Layer Search.Pill.Unlit', { filters: words })"
      @click="toggle"
    >
      <FontAwesomeIcon
        class="pillIcon"
        :icon="['fas', 'filter']"
      />
      <span class="pillWords">{{ words }}</span>
    </button>
    <button
      type="button"
      class="pillExpand"
      :aria-expanded="expanded"
      :aria-label="t('Layer Search.Pill.Edit')"
      :title="t('Layer Search.Pill.Edit')"
      @click="expanded = !expanded"
    >
      <FontAwesomeIcon :icon="['fas', 'angle-down']" />
    </button>
    <div
      v-if="expanded"
      class="pillPanel"
      @keydown.esc="expanded = false"
    >
      <LayerSearchChips
        :parameters="remembered"
        with-scope
        :peertube-enabled="peertubeEnabled"
        :locale="locale"
        @update="edit"
      />
    </div>
  </div>
</template>

<script setup>
// The pill beside the search box, in place of the filter button while the
// layer's search page is on: the remembered set in words, lit while the next
// search from the box gets it (`searchLatched`). A click toggles it. The caret
// opens the chip bar on the set itself, so it can be changed before a search;
// a change latches it, and one that leaves nothing set forgets it, which
// hides the pill. Hidden while nothing is remembered.

import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'

import LayerSearchChips from '../LayerSearchChips/LayerSearchChips.vue'

import store from '../../store/index'
import { languageName } from '../../platform/search/languages'
import { describe, isPlain, parameters, readRemembered } from '../../platform/search/query'

const { t, locale } = useI18n()

/** @type {import('vue').ComputedRef<boolean>} */
const peertubeEnabled = computed(() => store.getters.getEnablePeerTube === true)
/** @type {import('vue').ComputedRef<boolean>} */
const latched = computed(() => store.getters.getSearchLatched === true)

const remembered = computed(() => readRemembered(store.getters.getSearchRememberedParameters, { peertubeEnabled: peertubeEnabled.value }))

const words = computed(() => remembered.value === null ? '' : describe(remembered.value, t, { languageName }))

const expanded = ref(false)
const pill = useTemplateRef('pill')

function toggle() {
  store.dispatch('updateSearchLatched', !latched.value)
}

/**
 * @param {import('../../platform/search/query').SearchParameters} params
 */
function edit(params) {
  if (isPlain(params)) {
    expanded.value = false
    store.dispatch('updateSearchRememberedParameters', null)
    store.dispatch('updateSearchLatched', false)
    return
  }

  store.dispatch('updateSearchRememberedParameters', parameters(params))

  if (!latched.value) {
    store.dispatch('updateSearchLatched', true)
  }
}

/**
 * @param {Event} event
 */
function closeOutside(event) {
  if (expanded.value && pill.value && !pill.value.contains(/** @type {Node} */ (event.target))) {
    expanded.value = false
  }
}

onMounted(() => document.addEventListener('mousedown', closeOutside))
onBeforeUnmount(() => document.removeEventListener('mousedown', closeOutside))
</script>

<style scoped src="./LayerSearchPill.css" />
