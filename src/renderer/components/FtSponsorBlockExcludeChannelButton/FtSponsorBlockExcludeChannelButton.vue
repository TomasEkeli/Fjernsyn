<template>
  <FtIconButton
    v-if="visible"
    :title="title"
    :icon="excluded ? ['fas', PAID_ICON] : ['fas', MONEY_OFF_ICON]"
    :theme="excluded ? 'base' : 'primary'"
    @click="toggle"
  />
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import FtIconButton from '../FtIconButton/FtIconButton.vue'

import store from '../../store/index'
import { library } from '../../fontawesome-minimal'
import { PlayerIcons } from '../../../constants'

import { materialSymbolIcon } from '../../helpers/materialSymbolIcon'
import {
  isSponsorBlockExcludedChannel,
  toggleSponsorBlockExcludedChannel
} from '../../helpers/sponsorblock'
import { showToast } from '../../helpers/utils'

// The player's own button for this switch draws Material Symbols, which Font
// Awesome does not have; these are the same two, so both buttons look alike.
// Adding a definition again replaces it with the same, so a remount is harmless
const PAID_ICON = 'fjernsyn-paid'
const MONEY_OFF_ICON = 'fjernsyn-money-off'

library.add(
  materialSymbolIcon(PAID_ICON, PlayerIcons.PAID_FILLED),
  materialSymbolIcon(MONEY_OFF_ICON, PlayerIcons.MONEY_OFF_DEFAULT)
)

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

// How things are now, as the player's button and autoplay's say: an action
// ("never skip") read as easily as a state ("never skipped") the other way
const title = computed(() => {
  return excluded.value
    ? t('SponsorBlock.Not Skipped On This Channel')
    : t('SponsorBlock.Skipped On This Channel')
})

async function toggle() {
  const nowExcluded = await toggleSponsorBlockExcludedChannel(props.channelId, props.channelName)
  const channel = props.channelName || props.channelId

  showToast(
    nowExcluded
      ? t('SponsorBlock.Segments Will Be Marked Only', { channel })
      : t('SponsorBlock.Segments Will Be Skipped Again', { channel })
  )
}
</script>
