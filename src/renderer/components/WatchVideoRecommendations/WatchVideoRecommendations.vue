<template>
  <FtCard
    class="relative watchVideoRecommendations"
  >
    <div class="VideoRecommendationsTopBar">
      <h3>
        {{ $t("Up Next") }}
      </h3>
      <AiChip v-if="aiWall" />
    </div>
    <p
      v-if="aiWall && allHiddenAsAi(data)"
      class="aiAllHidden"
    >
      {{ $t('AI Chip.All Hidden') }}
    </p>
    <FtListVideoLazy
      v-for="video in data"
      :key="video.videoId"
      :data="video"
      appearance="recommendation"
      force-list-type="list"
      :use-channels-hidden-preference="true"
      :ai-wall="aiWall"
      @pause-player="pausePlayer"
    />
  </FtCard>
</template>

<script setup>

import AiChip from '../AiChip/AiChip.vue'
import FtCard from '../ft-card/ft-card.vue'
import FtListVideoLazy from '../FtListVideoLazy.vue'

import { allHiddenAsAi } from '../../helpers/aiShown'

defineProps({
  data: {
    type: Array,
    required: true
  },
  // Fjernsyn: one of the walls the AI pill governs (FtElementList's
  // `aiWall`), with the pill above the list. The layer's watch view opts
  // in; upstream's Watch does not, and is as it was
  aiWall: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['pause-player'])

function pausePlayer() {
  emit('pause-player')
}
</script>

<style scoped src="./WatchVideoRecommendations.css" />
