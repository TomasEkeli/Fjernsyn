<template>
  <FtSettingsSection
    :title="t('PeerTube.Settings.PeerTube Settings')"
  >
    <FtFlexBox class="searchSourceRow">
      <FtInput
        class="searchSource"
        :placeholder="t('PeerTube.Settings.Search source')"
        :show-action-button="false"
        :show-label="true"
        :value="sourceText"
        @input="handleInput"
        @click="saveSearchSource"
        @blur="saveSearchSource"
      />
      <FtButton
        class="resetSearchSource"
        :label="t('PeerTube.Settings.Reset to SepiaSearch')"
        @click="resetSearchSource"
      />
    </FtFlexBox>
    <p
      v-if="problem"
      class="invalidSource"
      role="alert"
    >
      {{ problemMessage }}
    </p>
    <p class="hint">
      {{ t('PeerTube.Settings.Search source hint') }}
    </p>
    <FtFlexBox>
      <FtToggleSwitch
        :label="t('PeerTube.Settings.Show NSFW content')"
        compact
        :default-value="showNsfw"
        :tooltip="t('PeerTube.Settings.Show NSFW content Tooltip')"
        @change="handleShowNsfw"
      />
    </FtFlexBox>
  </FtSettingsSection>
</template>

<script setup>
// The PeerTube settings: where PeerTube search goes, and whether NSFW content
// is shown. Both are store settings; the platform layer is rebuilt from them
// when they change (platform/vue.js). The settings page shows this section
// only while PeerTube is switched on (./section.js).

import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import FtButton from '../FtButton/FtButton.vue'
import FtFlexBox from '../ft-flex-box/ft-flex-box.vue'
import FtInput from '../FtInput/FtInput.vue'
import FtSettingsSection from '../FtSettingsSection/FtSettingsSection.vue'
import FtToggleSwitch from '../FtToggleSwitch/FtToggleSwitch.vue'

import store from '../../store/index'
import { DEFAULT_SEARCH_SOURCE, checkSearchSource } from './searchSource'

const { t } = useI18n()

/** @type {import('vue').ComputedRef<string>} */
const searchSource = computed(() => store.getters.getPeerTubeSearchSource)

/** @type {import('vue').ComputedRef<boolean>} */
const showNsfw = computed(() => store.getters.getPeerTubeShowNsfw)

/** What the field holds, typed or saved */
const sourceText = ref(searchSource.value)
/** What is wrong with the source typed, until one is saved: `{ problem, host? }` or null */
const problem = ref(null)

const problemMessage = computed(() => {
  if (problem.value?.problem === 'neverPeerTube') {
    return t('PeerTube.Settings.Search source not PeerTube', { host: problem.value.host })
  }

  return t('PeerTube.Settings.Search source invalid')
})

watch(searchSource, (value) => {
  sourceText.value = value
  problem.value = null
})

/**
 * @param {string} text
 */
function handleInput(text) {
  sourceText.value = text
}

/**
 * Saves the source typed, on Enter or on leaving the field, if it is one the
 * layer can search and not the one already set.
 *
 * @param {string} [text]
 */
function saveSearchSource(text = sourceText.value) {
  sourceText.value = text
  const checked = checkSearchSource(text)

  if (checked.source === null) {
    problem.value = { problem: checked.problem, host: checked.host }
    return
  }

  const { source } = checked
  problem.value = null
  sourceText.value = source

  if (source !== searchSource.value) {
    store.dispatch('updatePeerTubeSearchSource', source)
  }
}

function resetSearchSource() {
  sourceText.value = DEFAULT_SEARCH_SOURCE
  problem.value = null

  if (searchSource.value !== DEFAULT_SEARCH_SOURCE) {
    store.dispatch('updatePeerTubeSearchSource', DEFAULT_SEARCH_SOURCE)
  }
}

/**
 * @param {boolean} value
 */
function handleShowNsfw(value) {
  store.dispatch('updatePeerTubeShowNsfw', value)
}
</script>

<style scoped src="./PeerTubeSettings.css" />
