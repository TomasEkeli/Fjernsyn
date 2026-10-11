<template>
  <FtCard
    v-if="hasDescription || hasDisclosures"
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
      v-if="hasDescription"
      ref="descriptionContainer"
      class="description"
      @click="expandWithClick"
    >
      <LayerMarkdown
        v-if="kind === 'markdown'"
        :source="description"
        :base-url="baseUrl"
      />
      <!-- YouTube's markup, sanitised, its timestamps seeking, as WatchVideoDescription shows it -->
      <FtTimestampCatcher
        v-else-if="kind === 'html'"
        :input-html="description"
        :link-tab-index="showFullDescription ? '0' : '-1'"
        @timestamp-event="emit('timestamp-event', $event)"
      />
      <p
        v-else
        class="plainDescription"
        dir="auto"
      >
        {{ description }}
      </p>
    </div>
    <!-- As WatchVideoDescription's: YouTube's "How this was made", in its own words -->
    <div
      v-if="hasDisclosures && showFullDescription"
      class="contentDisclosureSection"
    >
      <div class="contentDisclosureTitle">
        {{ t('Video.How this was made') }}
      </div>
      <div
        v-for="(item, index) in contentDisclosures"
        :key="index"
        class="contentDisclosureItem"
      >
        <div
          class="contentDisclosureHeader"
          dir="auto"
        >
          {{ item.label }}
        </div>
        <!-- With YouTube's link to its help page on what the disclosure means -->
        <div
          v-if="item.description || item.link"
          class="contentDisclosureBody"
          dir="auto"
        >
          {{ item.description }}
          <a
            v-if="item.link"
            :href="item.link.url"
            target="_blank"
            rel="noopener noreferrer"
          >{{ item.link.text }}</a>
        </div>
        <div
          v-if="item.attribution"
          class="contentDisclosureAttribution"
          dir="auto"
        >
          {{ item.attribution }}
        </div>
      </div>
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
import FtTimestampCatcher from '../FtTimestampCatcher.vue'
import LayerMarkdown from '../LayerMarkdown/LayerMarkdown.vue'

// A video's description, collapsed to a few lines until asked for, as
// WatchVideoDescription shows YouTube's. Markdown (PeerTube) goes through
// LayerMarkdown; markup (YouTube) through the sanitising directive, with its
// timestamps made links that seek; plain text is shown as text.

const props = defineProps({
  description: {
    type: String,
    default: ''
  },
  /** `'markdown'`, `'html'` or `'plain'`, as the layer says */
  kind: {
    type: String,
    default: 'plain'
  },
  /** The instance the description came from, for relative links */
  baseUrl: {
    type: String,
    default: ''
  },
  /**
   * YouTube's "How this was made" items, shown under the description when it
   * is expanded; `null` for none, and for every other platform
   * @type {import('vue').PropType<import('../../platform/shapes').ContentDisclosure[] | null>}
   */
  contentDisclosures: {
    type: Array,
    default: null
  },
})

const emit = defineEmits(['timestamp-event'])

const { t } = useI18n()

const descriptionContainer = useTemplateRef('descriptionContainer')
const showFullDescription = ref(false)
const showControls = ref(false)

const hasDescription = computed(() => props.description.trim() !== '')

const hasDisclosures = computed(() => (props.contentDisclosures?.length ?? 0) > 0)

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
