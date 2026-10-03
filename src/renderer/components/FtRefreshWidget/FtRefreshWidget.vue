<!--
  How old a stream is and the button that makes it new, as one small control.

  It used to be a strip pinned across the window under the top nav, which cost
  the grid below it a band of its own and said things at a length that band
  invited: "Subscriptions feed last updated: 27 minutes ago". The age is the
  only part anyone reads, so that is all it says now — "Fresh", "27 minutes
  ago" — and the sentence it used to be survives as the button group's tooltip,
  where a reader who wants to know which feed is meant can still find out.

  It goes in a row the page already has: no page grows a band of chrome to
  hold a control this small. The
  button leads and the age follows it, so that the button sits at a fixed
  distance from whatever is before it in the row — with the age first, every
  tick of the clock that changed its width moved the button.
-->
<template>
  <div
    class="refreshControl"
    :title="statusTitle"
  >
    <FtIconButton
      :disabled="disableRefresh"
      :icon="['fas', 'sync']"
      class="refreshButton"
      :title="refreshFeedButtonTitle"
      :size="12"
      theme="primary"
      @click="click"
    />
    <p
      v-if="statusLabel"
      class="statusLabel"
    >
      {{ statusLabel }}
    </p>
    <div
      v-if="activityLabel"
      class="activityProgressTrack"
      role="progressbar"
      :aria-label="activityLabel"
      :aria-valuenow="activityProgress === null ? undefined : Math.round(activityProgress * 100)"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <div
        class="activityProgressFill"
        :class="{ indeterminate: activityProgress === null }"
        :style="activityProgress === null ? undefined : { inlineSize: `${Math.round(activityProgress * 100)}%` }"
      />
    </div>
    <FtIconButton
      v-if="canStopActivity"
      :icon="['fas', 'xmark']"
      class="stopActivityButton"
      :title="t('Subscriptions.Stop Recovering')"
      :size="12"
      theme="secondary"
      @click="stopActivity"
    />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import FtIconButton from '../FtIconButton/FtIconButton.vue'

import { KeyboardShortcuts } from '../../../constants'
import { addKeyboardShortcutToActionTitle, getRelativeTimeFromDate } from '../../helpers/utils'

const props = defineProps({
  disableRefresh: {
    type: Boolean,
    default: false
  },
  /**
   * When the stream was last brought up to date, in epoch milliseconds, or null
   * if it never has been. Raw rather than formatted, because how long ago that
   * was is a question whose answer changes while nobody touches anything.
   */
  lastRefreshAt: {
    type: Number,
    default: null
  },
  title: {
    type: String,
    required: true
  },
  /**
   * Short description of background work in progress. Takes the place of the
   * last-updated time while set, since during a recovery that time is stale
   * anyway: the feed is in the middle of being completed.
   */
  activityLabel: {
    type: String,
    default: ''
  },
  /** How far along, 0 to 1, or null when there is no honest answer. */
  activityProgress: {
    type: Number,
    default: null
  },
  canStopActivity: {
    type: Boolean,
    default: false
  }
})

const { t } = useI18n()

/*
 * The age is read off the clock, so it has to be recomputed against a clock
 * that moves. Half a minute is fine for a label whose smallest step is a
 * minute, and the timer is the only thing here that costs anything while the
 * page sits idle.
 */
const now = ref(Date.now())
const clock = setInterval(() => { now.value = Date.now() }, 30_000)

onBeforeUnmount(() => clearInterval(clock))

const freshness = computed(() => {
  if (!props.lastRefreshAt) { return '' }

  // Anything under a minute is "you are looking at the latest", which is worth
  // saying as a state rather than as an age nobody counts in.
  if (now.value - props.lastRefreshAt < 60_000) { return t('Feed.Fresh') }

  return getRelativeTimeFromDate(props.lastRefreshAt, true)
})

const statusLabel = computed(() => props.activityLabel || freshness.value)

/** The sentence the strip used to spell out, kept where it costs no room. */
const statusTitle = computed(() => {
  if (props.activityLabel || !freshness.value) { return null }

  return t('Feed.Feed Last Updated', { feedName: props.title, date: freshness.value })
})

const refreshFeedButtonTitle = computed(() => {
  return addKeyboardShortcutToActionTitle(
    t('Feed.Refresh Feed', { subscriptionName: props.title }),
    KeyboardShortcuts.APP.SITUATIONAL.REFRESH
  )
})

const emit = defineEmits(['click', 'stop-activity'])

function click() {
  emit('click')
}

function stopActivity() {
  emit('stop-activity')
}
</script>

<style scoped lang="scss" src="./FtRefreshWidget.scss" />
