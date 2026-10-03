<template>
  <FtSettingsSection
    :title="$t('Settings.Experimental Settings.Experimental Settings')"
  >
    <p class="experimental-warning">
      {{ $t('Settings.Experimental Settings.Warning') }}
    </p>
    <FtFlexBox>
      <FtToggleSwitch
        tooltip-position="top"
        :label="$t('Settings.Experimental Settings.Replace HTTP Cache')"
        compact
        :default-value="replaceHttpCache"
        :disabled="replaceHttpCacheLoading"
        :tooltip="$t('Tooltips.Experimental Settings.Replace HTTP Cache')"
        @change="handleToggleReplaceHttpCache"
      />
      <FtToggleSwitch
        tooltip-position="top"
        :label="$t('Settings.Experimental Settings.Disable Hardware Acceleration')"
        compact
        :default-value="disableHardwareAcceleration"
        :disabled="disableHardwareAccelerationLoading"
        :tooltip="$t('Tooltips.Experimental Settings.Disable Hardware Acceleration')"
        @change="handleToggleDisableHardwareAcceleration"
      />
      <FtToggleSwitch
        v-if="supportsLocalApi"
        tooltip-position="top"
        :label="$t('Settings.Experimental Settings.Regulated Streaming')"
        compact
        :default-value="regulatedStreaming"
        :tooltip="$t('Tooltips.Experimental Settings.Regulated Streaming')"
        @change="handleRegulatedStreaming"
      />
      <FtToggleSwitch
        tooltip-position="top"
        :label="$t('PeerTube.Settings.Enable PeerTube')"
        compact
        :default-value="enablePeerTube"
        :tooltip="$t('PeerTube.Settings.Enable PeerTube Tooltip')"
        @change="handleEnablePeerTube"
      />
      <FtToggleSwitch
        tooltip-position="top"
        :label="$t('Layer Surfaces.Settings.Enable layer surfaces')"
        compact
        :default-value="enableLayerSurfaces"
        :tooltip="$t('Layer Surfaces.Settings.Enable layer surfaces Tooltip')"
        @change="handleEnableLayerSurfaces"
      />
    </FtFlexBox>
    <FtPrompt
      v-if="showRestartPrompt"
      :label="$t('Settings[\'The app needs to restart for changes to take effect. Restart and apply change?\']')"
      :option-names="[$t('Yes, Restart'), $t('Cancel')]"
      :option-values="['restart', 'cancel']"
      @click="handleRestartPrompt"
    />
  </FtSettingsSection>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'

import FtSettingsSection from '../FtSettingsSection/FtSettingsSection.vue'
import FtFlexBox from '../ft-flex-box/ft-flex-box.vue'
import FtToggleSwitch from '../FtToggleSwitch/FtToggleSwitch.vue'
import FtPrompt from '../FtPrompt/FtPrompt.vue'

import store from '../../store/index'

const replaceHttpCacheLoading = ref(true)
const replaceHttpCache = ref(false)
let replaceHttpCacheRunningState = null

const disableHardwareAccelerationLoading = ref(true)
const disableHardwareAcceleration = ref(false)
let disableHardwareAccelerationRunningState = null

const showRestartPrompt = ref(false)

/**
 * SABR is the local API's transport, so there is nothing here to regulate on a
 * build that cannot use it.
 */
const supportsLocalApi = process.env.SUPPORTS_LOCAL_API

/** @type {import('vue').ComputedRef<boolean>} */
const regulatedStreaming = computed(() => store.getters.getEnableRegulatedStreaming)

/**
 * @param {boolean} value
 */
function handleRegulatedStreaming(value) {
  store.dispatch('updateEnableRegulatedStreaming', value)
}

/** @type {import('vue').ComputedRef<boolean>} */
const enablePeerTube = computed(() => store.getters.getEnablePeerTube)

/**
 * @param {boolean} value
 */
function handleEnablePeerTube(value) {
  store.dispatch('updateEnablePeerTube', value)
}

/** @type {import('vue').ComputedRef<boolean>} */
const enableLayerSurfaces = computed(() => store.getters.getEnableLayerSurfaces)

/**
 * @param {boolean} value
 */
function handleEnableLayerSurfaces(value) {
  store.dispatch('updateEnableLayerSurfaces', value)
}

onMounted(async () => {
  if (process.env.IS_ELECTRON) {
    [replaceHttpCache.value, disableHardwareAcceleration.value] =
      [replaceHttpCacheRunningState, disableHardwareAccelerationRunningState] =
        await Promise.all([window.ftElectron.getReplaceHttpCache(), window.ftElectron.getDisableHardwareAcceleration()])
  }

  replaceHttpCacheLoading.value = false
  disableHardwareAccelerationLoading.value = false
})

/**
 * @param {boolean} value
 */
function handleToggleReplaceHttpCache(value) {
  replaceHttpCache.value = value
  showRestartPrompt.value = true
}

/**
 * @param {boolean} value
 */
function handleToggleDisableHardwareAcceleration(value) {
  disableHardwareAcceleration.value = value
  showRestartPrompt.value = true
}

/**
 * @param {'restart' | 'cancel' | null} value
 */
function handleRestartPrompt(value) {
  showRestartPrompt.value = false

  if (value === null || value === 'cancel') {
    replaceHttpCache.value = replaceHttpCacheRunningState
    disableHardwareAcceleration.value = disableHardwareAccelerationRunningState
    return
  }

  if (process.env.IS_ELECTRON) {
    if (replaceHttpCache.value !== replaceHttpCacheRunningState) {
      window.ftElectron.toggleReplaceHttpCache()
    } else if (disableHardwareAcceleration.value !== disableHardwareAccelerationRunningState) {
      window.ftElectron.toggleDisableHardwareAcceleration()
    }
  }
}
</script>

<style scoped src="./ExperimentalSettings.css" />
