<template>
  <FtCard
    class="relative watchVideoRecommendations"
  >
    <div class="VideoRecommendationsTopBar">
      <h3>
        {{ $t("Up Next") }}
      </h3>
    </div>
    <FtListVideoLazy
      v-for="video in data"
      :key="video.videoId"
      :data="video"
      appearance="recommendation"
      force-list-type="list"
      :use-channels-hidden-preference="true"
      :look-up-ai-label="lookUpAiLabel"
      @pause-player="pausePlayer"
    />
  </FtCard>
</template>

<script setup>

import FtCard from '../ft-card/ft-card.vue'
import FtListVideoLazy from '../FtListVideoLazy.vue'

defineProps({
  data: {
    type: Array,
    required: true
  },
  // Fjernsyn: whether the cards ask whether their videos were made with AI
  // (FtListVideo); the layer's watch view opts in, upstream's Watch does not
  lookUpAiLabel: {
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
