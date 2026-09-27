<template>
  <FtCard
    v-if="hasDescription"
    class="videoDescription"
    :class="{ short: !showFullDescription }"
  >
    <span
      v-if="showControls && !showFullDescription"
      class="descriptionStatus"
      role="button"
      tabindex="0"
      @click="showFullDescription = true"
      @keydown.enter.space.prevent="showFullDescription = true"
    >
      {{ t('Description.Expand Description') }}
    </span>
    <!-- eslint-disable-next-line vuejs-accessibility/click-events-have-key-events -->
    <div
      ref="descriptionContainer"
      class="description"
      @click="expandWithClick"
    >
      <LayerMarkdown
        v-if="kind === 'markdown'"
        :source="description"
        :base-url="baseUrl"
      />
      <p
        v-else
        class="plainDescription"
        dir="auto"
      >
        {{ description }}
      </p>
    </div>
    <span
      v-if="showControls && showFullDescription"
      class="descriptionStatus"
      role="button"
      tabindex="0"
      @click="showFullDescription = false"
      @keydown.enter.space.prevent="showFullDescription = false"
    >
      {{ t('Description.Collapse Description') }}
    </span>
  </FtCard>
</template>

<script setup>
import { computed, onMounted, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'

import FtCard from '../ft-card/ft-card.vue'
import LayerMarkdown from '../LayerMarkdown/LayerMarkdown.vue'

// A video's description, collapsed to a few lines until asked for, as
// WatchVideoDescription shows YouTube's. Markdown (PeerTube) goes through
// LayerMarkdown; plain text is shown as text.

const props = defineProps({
  description: {
    type: String,
    default: ''
  },
  /** `'markdown'` or `'plain'`, as the layer says */
  kind: {
    type: String,
    default: 'plain'
  },
  /** The instance the description came from, for relative links */
  baseUrl: {
    type: String,
    default: ''
  },
})

const { t } = useI18n()

const descriptionContainer = useTemplateRef('descriptionContainer')
const showFullDescription = ref(false)
const showControls = ref(false)

const hasDescription = computed(() => props.description.trim() !== '')

/**
 * @param {MouseEvent} event
 */
function expandWithClick(event) {
  if (event.target.closest?.('a')) {
    return
  }

  showFullDescription.value = true
}

onMounted(() => {
  // Only a description that overflows its collapsed height gets the controls
  const element = descriptionContainer.value
  const isShort = !element || element.clientHeight >= element.scrollHeight
  showFullDescription.value = isShort
  showControls.value = !isShort
})
</script>

<style scoped src="./LayerVideoDescription.css" />
