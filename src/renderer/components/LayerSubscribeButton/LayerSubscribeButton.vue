<template>
  <FtSubscribeButton
    v-if="show"
    :channel-id="channel.id"
    :channel-name="channel.name ?? ''"
    :channel-thumbnail="thumbnail"
    :channel-platform-fields="platformFields"
  />
</template>

<script setup>
// The existing subscribe button, with its profile dropdown, for a channel as
// the layer gives it (a ChannelSummary or ChannelDetails). A channel of
// another platform than YouTube is stored with its `platform` and `host`
// beside the fields every stub has (spec, "Refs and stored shapes"); a
// YouTube one exactly as the old path stores it. Unsubscribing is the
// button's own, which removes the channel from every profile.

import { computed } from 'vue'

import FtSubscribeButton from '../FtSubscribeButton/FtSubscribeButton.vue'

import store from '../../store/index'
import { PLATFORM_PEERTUBE, PLATFORM_YOUTUBE, platformOf } from '../../platform/refs'
import { isPeerTubeEnabled } from '../../platform/vue'

const props = defineProps({
  /** @type {import('vue').PropType<import('../../platform/shapes').ChannelSummary>} */
  channel: {
    type: Object,
    required: true
  },
})

const hideUnsubscribeButton = computed(() => store.getters.getHideUnsubscribeButton)

// Subscribing to a PeerTube channel is an entry point, so it exists only
// while PeerTube is switched on
const show = computed(() => {
  const { id } = props.channel

  return !hideUnsubscribeButton.value &&
    typeof id === 'string' && id !== '' &&
    (platformOf(props.channel) !== PLATFORM_PEERTUBE || isPeerTubeEnabled())
})

// The profiles store reads the thumbnail as a string, so it is never null
const thumbnail = computed(() => typeof props.channel.thumbnail === 'string' ? props.channel.thumbnail : '')

const platformFields = computed(() => {
  const { platform, host } = props.channel

  return platformOf(props.channel) === PLATFORM_YOUTUBE ? null : { platform, host }
})
</script>
