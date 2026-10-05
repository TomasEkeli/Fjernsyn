<!--
  The armed items, as a schedule is read: at a glance, for whether something
  is coming up soon. So what leads every line is how far off it is, ticking
  with the page's clock, and everything else is there to say what it is.

  Not shown at all when nothing is armed: an empty schedule says nothing that
  the calendar buttons do not. Folded, it is one line, and that line still
  answers the glance with how far off the next one is. Open, one line per
  item, and only the soonest few until asked for the rest, so that the queue
  under it, which is what the page is for, stays in view.

  Whether it is folded is remembered, as the Subscriptions shelf's is.
-->
<template>
  <section
    v-if="items.length > 0"
    class="laterSchedule"
  >
    <button
      class="scheduleHeader"
      type="button"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <FontAwesomeIcon
        class="scheduleIcon"
        :icon="['fas', 'calendar-check']"
        aria-hidden="true"
      />
      <span class="scheduleTitle">{{ t('Later.Scheduled') }}</span>
      <span class="scheduleCount">{{ items.length }}</span>
      <span
        v-if="!expanded && next"
        class="scheduleNext"
      >
        {{ t('Later.Next', { distance: distanceLabel(next) }) }}
        <span
          v-if="stateOf(next) !== 'waiting'"
          class="scheduleState"
          :class="stateOf(next)"
        >{{ stateLabel(stateOf(next)) }}</span>
      </span>
      <FontAwesomeIcon
        class="scheduleChevron"
        :icon="expanded ? ['fas', 'angle-up'] : ['fas', 'angle-down']"
        aria-hidden="true"
      />
    </button>
    <template v-if="expanded">
      <ol class="scheduleRows">
        <li
          v-for="item in shown"
          :key="item._id"
          class="scheduleRow"
          :class="stateOf(item)"
        >
          <span class="scheduleDistance">{{ distanceLabel(item) }}</span>
          <span class="scheduleWhat">
            <RouterLink
              class="scheduleVideo"
              :to="`/watch/${item.videoId}`"
              :title="item.title"
            >{{ item.title }}</RouterLink>
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
          </span>
          <span class="scheduleWhen">
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
      <button
        v-if="items.length > SHOWN_FOLDED"
        class="scheduleMore"
        type="button"
        @click="showAll = !showAll"
      >
        {{ showAll ? t('Later.Show fewer') : t('Later.Show more', { count: items.length - SHOWN_FOLDED }) }}
      </button>
    </template>
  </section>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import FtIconButton from '../FtIconButton/FtIconButton.vue'

import store from '../../store/index'
import { formatScheduledDate } from '../../helpers/utils'
import { distanceTo, laterStateAt } from '../../helpers/later'

/** How many of the soonest are shown before the rest are asked for */
const SHOWN_FOLDED = 3

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

/** @type {import('vue').WritableComputedRef<boolean>} */
const expanded = computed({
  get: () => store.getters.getLaterScheduleExpanded,
  set: (value) => store.dispatch('updateLaterScheduleExpanded', value)
})

/** Not remembered: wanting all of them is a moment's, not a standing choice */
const showAll = ref(false)

const shown = computed(() => showAll.value ? props.items : props.items.slice(0, SHOWN_FOLDED))

/**
 * The one the folded line speaks of: the soonest still to come or under way.
 * One that did not start is behind it, not next.
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
