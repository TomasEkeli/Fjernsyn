<template>
  <FtIconButton
    v-if="visible"
    :title="title"
    :icon="['fas', 'eye-slash']"
    :theme="excluded ? 'base' : 'primary'"
    @click="toggle"
  />
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import FtIconButton from '../FtIconButton/FtIconButton.vue'

import store from '../../store/index'

import {
  isSponsorBlockExcludedChannel,
  toggleSponsorBlockExcludedChannel
} from '../../helpers/sponsorblock'
import { showToast } from '../../helpers/utils'

const props = defineProps({
  channelId: {
    type: String,
    required: true
  },
  channelName: {
    type: String,
    default: ''
  }
})

const { t } = useI18n()

/** @type {import('vue').ComputedRef<boolean>} */
const useSponsorBlock = computed(() => store.getters.getUseSponsorBlock)

// Nothing to say about skipping when nothing is skipping, and nothing to store
// an entry under until we know whose channel this is.
const visible = computed(() => useSponsorBlock.value && props.channelId !== '')

const excluded = computed(() => isSponsorBlockExcludedChannel(props.channelId))

// The same words as the entry in a video's menu, which does the same thing
const title = computed(() => {
  return excluded.value
    ? t('Video.Enable SponsorBlock on Channel')
    : t('Video.Disable SponsorBlock on Channel')
})

async function toggle() {
  const nowExcluded = await toggleSponsorBlockExcludedChannel(props.channelId, props.channelName)
  const channel = props.channelName || props.channelId

  showToast(
    nowExcluded
      ? t('SponsorBlock Disabled on Channel', { channel })
      : t('SponsorBlock Enabled on Channel', { channel })
  )
}
</script>
