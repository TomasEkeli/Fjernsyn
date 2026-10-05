<!--
  The armed items, as a schedule is read: at a glance, for whether something
  is coming up soon. So what leads is how far off it is, ticking with the
  page's clock, and everything else is there to say what it is.

  Kept out of the queue's way. Closed, it is a pill on the Watch later
  heading's line that already answers the glance: how many, and how far off
  the next one is. Open, a panel slides in from the right under it, over the
  queue, one item to a row, the soonest first. It is an overlay, so it is
  never left open: Escape, a click anywhere else, or the pill again closes it,
  and it is closed whenever the page is opened.

  Not shown at all when nothing is armed: an empty schedule says nothing that
  the calendar buttons do not.
-->
<template>
  <div
    v-if="items.length > 0"
    ref="root"
    class="laterSchedule"
  >
    <button
      class="schedulePill"
      type="button"
      :aria-expanded="open"
      :aria-controls="panelId"
      :title="t('Later.Scheduled')"
      @click="open = !open"
    >
      <FontAwesomeIcon
        class="scheduleIcon"
        :icon="['fas', 'calendar-check']"
        aria-hidden="true"
      />
      <span class="scheduleCount">{{ items.length }}</span>
      <span
        v-if="next"
        class="scheduleNext"
      >{{ t('Later.Next', { distance: distanceLabel(next) }) }}</span>
      <span
        v-if="next && stateOf(next) !== 'waiting'"
        class="scheduleState"
        :class="stateOf(next)"
      >{{ stateLabel(stateOf(next)) }}</span>
      <FontAwesomeIcon
        class="scheduleChevron"
        :icon="open ? ['fas', 'angle-up'] : ['fas', 'angle-down']"
        aria-hidden="true"
      />
    </button>
    <Transition name="schedulePanel">
      <section
        v-if="open"
        :id="panelId"
        class="schedulePanel"
        :aria-label="t('Later.Scheduled')"
      >
        <ol class="scheduleRows">
          <li
            v-for="item in items"
            :key="item._id"
            class="scheduleRow"
            :class="stateOf(item)"
          >
            <span class="scheduleDistance">{{ distanceLabel(item) }}</span>
            <RouterLink
              class="scheduleVideo"
              :to="`/watch/${item.videoId}`"
              :title="item.title"
            >
              {{ item.title }}
            </RouterLink>
            <span class="scheduleMeta">
              <template v-if="item.author">
                <RouterLink
                  v-if="!disableChannelLinks && item.authorId"
                  class="scheduleChannel scheduleChannelLink"
                  :to="`/channel/${item.authorId}`"
                >{{ item.author }}</RouterLink>
                <span
                  v-else
                  class="scheduleChannel"
                >{{ item.author }}</span>
              </template>
              <span
                v-if="stateOf(item) !== 'waiting'"
                class="scheduleState"
                :class="stateOf(item)"
              >{{ stateLabel(stateOf(item)) }}</span>
              <time
                class="scheduleAt"
                :datetime="new Date(item.alarm.at).toISOString()"
              >{{ formatScheduledDate(item.alarm.at) }}</time>
            </span>
            <span class="scheduleActions">
              <FtIconButton
                class="disarmButton"
                :title="t('Later.Disarm')"
                :icon="['fas', 'calendar-xmark']"
                :padding="6"
                :size="14"
                :use-shadow="false"
                @click="disarm(item._id)"
              />
              <FtIconButton
                class="removeButton"
                :title="t('Later.Remove')"
                :icon="['fas', 'trash']"
                :padding="6"
                :size="14"
                :use-shadow="false"
                @click="remove(item._id)"
              />
            </span>
          </li>
        </ol>
      </section>
    </Transition>
  </div>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, onBeforeUnmount, ref, useId, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import FtIconButton from '../FtIconButton/FtIconButton.vue'

import store from '../../store/index'
import { formatScheduledDate } from '../../helpers/utils'
import { distanceTo, laterStateAt } from '../../helpers/later'

const props = defineProps({
  /**
   * The armed items, soonest first, as the store gives them
   * @type {import('vue').PropType<import('../../helpers/later').LaterItem[]>}
   */
  items: {
    type: Array,
    required: true
  },
  /** The page's clock, ms: every distance and state is read from it */
  now: {
    type: Number,
    required: true
  }
})

const { t, locale } = useI18n()

const panelId = useId()

const root = useTemplateRef('root')

/** Not remembered: an overlay still open on the next visit is only in the way */
const open = ref(false)

/** Closes on a press anywhere but in the pill and the panel */
function onPointerDown(event) {
  if (root.value && !root.value.contains(event.target)) {
    open.value = false
  }
}

/** @param {KeyboardEvent} event */
function onKeyDown(event) {
  if (event.key === 'Escape') {
    open.value = false
    root.value?.querySelector('.schedulePill')?.focus()
  }
}

// Listened for only while open, so a closed schedule costs the page nothing
watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
  } else {
    stopListening()
  }
})

// The last armed item gone while open: nothing is left to close it from
watch(() => props.items.length, (length) => {
  if (length === 0) { open.value = false }
})

function stopListening() {
  document.removeEventListener('pointerdown', onPointerDown, true)
  document.removeEventListener('keydown', onKeyDown)
}

onBeforeUnmount(stopListening)

/**
 * The one the pill speaks of: the soonest still to come or under way. One
 * that did not start is behind it, not next.
 */
const next = computed(() => props.items.find(item => stateOf(item) !== 'didNotStart'))

const disableChannelLinks = computed(() => store.getters.getDisableChannelLinks)

const durationFormat = computed(() => new Intl.DurationFormat([locale.value, 'en'], { style: 'short' }))

/** @param {import('../../helpers/later').LaterItem} item */
function distanceLabel(item) {
  const { past, duration } = distanceTo(props.now, item.alarm.at)

  if (Object.keys(duration).length === 0) { return t('Later.Distance.Now') }

  const text = durationFormat.value.format(duration)

  return past ? t('Later.Distance.Ago', { duration: text }) : t('Later.Distance.In', { duration: text })
}

/** @param {import('../../helpers/later').LaterItem} item */
function stateOf(item) {
  if (store.getters.getLaterIsLiveQuiet(item._id)) { return 'live' }

  return laterStateAt(props.now, item.alarm.at)
}

/** @param {'live' | 'waiting' | 'checking' | 'didNotStart'} state */
function stateLabel(state) {
  switch (state) {
    case 'live':
      return t('Later.State.Live now')
    case 'waiting':
      return t('Later.State.Waiting')
    case 'checking':
      return t('Later.State.Checking')
    default:
      return t('Later.State.Did not start')
  }
}

/** @param {string} id */
function disarm(id) {
  store.dispatch('disarm', id)
}

/** @param {string} id */
function remove(id) {
  store.dispatch('removeFromLater', id)
}
</script>

<style scoped src="./LaterSchedule.css" />
