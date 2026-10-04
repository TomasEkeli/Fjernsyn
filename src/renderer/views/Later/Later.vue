<template>
  <div
    class="laterPage"
    :class="{ grid: listType === 'grid' }"
  >
    <FtCard class="card">
      <h2>
        <FontAwesomeIcon
          :icon="['fas', 'calendar-check']"
          class="headingIcon"
        />
        {{ t('Later.Scheduled') }}
      </h2>
      <FtFlexBox
        v-if="armed.length === 0"
      >
        <p class="message">
          {{ t('Later.No scheduled') }}
        </p>
      </FtFlexBox>
      <div
        v-else
        class="armedItems"
      >
        <div
          v-for="item in armed"
          :key="item._id"
          class="armedItem"
        >
          <div class="armedHeader">
            <span class="armedTime">{{ scheduledTimeOf(item) }}</span>
            <span
              class="armedState"
              :class="stateOf(item)"
            >{{ stateLabel(stateOf(item)) }}</span>
            <span class="armedActions">
              <FtButton
                :label="t('Later.Disarm')"
                :icon="['fas', 'calendar-xmark']"
                background-color="var(--secondary-card-bg-color)"
                text-color="var(--primary-text-color)"
                class="armedAction disarmButton"
                @click="disarm(item._id)"
              />
              <FtButton
                :label="t('Later.Remove')"
                :icon="['fas', 'trash']"
                background-color="var(--secondary-card-bg-color)"
                text-color="var(--primary-text-color)"
                class="armedAction removeButton"
                @click="remove(null, item._id)"
              />
            </span>
          </div>
          <FtListVideo
            :data="item"
            appearance="result"
            force-list-type="list"
            :later-row="true"
          />
        </div>
      </div>
    </FtCard>
    <FtCard class="card">
      <h2>
        <FontAwesomeIcon
          :icon="['fas', 'clock']"
          class="headingIcon"
        />
        {{ t('Later.Watch later') }}
      </h2>
      <FtFlexBox
        v-if="queued.length === 0"
      >
        <p class="message">
          {{ t('Later.No queued') }}
        </p>
      </FtFlexBox>
      <AutoScrollWrapper
        v-else
        :hot-zone-enabled="isVideoDragging"
        :is-grid-mode="listType === 'grid'"
      >
        <FtElementList
          v-if="listType === 'grid'"
          :data="shownQueued"
          display="grid"
          :use-channels-hidden-preference="false"
          :use-hide-upcoming-premieres-preference="false"
          :hide-forbidden-titles="false"
          :can-move-video-up="true"
          :can-move-video-down="true"
          :playlist-items-length="shownQueued.length"
          :can-remove-from-playlist="true"
          :dragged-video="draggedVideo"
          :is-video-dragging="isVideoDragging"
          :video-dragging-possible="shownQueued.length >= 2"
          :later-row="true"
          @drag-video="setDraggedVideo"
          @drag-video-end="onDragVideoEnd"
          @move-dragged-video="moveDraggedVideoTemporarilyThrottled"
          @move-video-up="moveUp"
          @move-video-down="moveDown"
          @move-video-to-the-top="moveToTop"
          @move-video-to-the-bottom="moveToBottom"
          @remove-from-playlist="remove"
        />
        <TransitionGroup
          v-else
          name="laterItem"
          tag="span"
          class="laterItems"
        >
          <FtListVideoNumbered
            v-for="(item, index) in shownQueued"
            :key="item._id"
            class="laterItem"
            :data="item"
            :playlist-item-id="item.playlistItemId"
            appearance="result"
            :can-move-video-up="index > 0"
            :can-move-video-down="index < shownQueued.length - 1"
            :can-remove-from-playlist="true"
            :video-index="index"
            :initial-visible-state="index < 10"
            :dragged-video="draggedVideo"
            :is-sort-order-custom="true"
            :is-video-dragging="isVideoDragging"
            :later-row="true"
            @drag-video="setDraggedVideo"
            @drag-video-end="onDragVideoEnd"
            @move-dragged-video="moveDraggedVideoTemporarilyThrottled"
            @move-video-up="moveUp"
            @move-video-down="moveDown"
            @move-video-to-the-top="moveToTop"
            @move-video-to-the-bottom="moveToBottom"
            @remove-from-playlist="remove"
          />
        </TransitionGroup>
      </AutoScrollWrapper>
    </FtCard>
  </div>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import FtCard from '../../components/ft-card/ft-card.vue'
import FtFlexBox from '../../components/ft-flex-box/ft-flex-box.vue'
import FtButton from '../../components/FtButton/FtButton.vue'
import FtElementList from '../../components/FtElementList/FtElementList.vue'
import FtListVideo from '../../components/FtListVideo/FtListVideo.vue'
import FtListVideoNumbered from '../../components/FtListVideoNumbered/FtListVideoNumbered.vue'
import AutoScrollWrapper from '../../components/AutoScrollWrapper/AutoScrollWrapper.vue'

import store from '../../store/index'
import { formatScheduledTime, throttle } from '../../helpers/utils'
import { laterStateAt } from '../../helpers/later'

/**
 * The Later page: the armed items first, soonest first, each with its stated
 * time and its state; then the queued items, in their order, moved and
 * removed as a playlist's are. The rows are the playlist rows, given no
 * playlist: `laterRow` turns on their move and remove controls, and their
 * events come here, to the Later store, so nothing on this page writes to
 * `playlists.db`, and no link carries a `playlistId`.
 */

const { t } = useI18n()

/** @type {import('vue').ComputedRef<'grid' | 'list'>} */
const listType = computed(() => store.getters.getListType)

/** The clock the armed items' states are read from, moved on twice a minute */
const now = ref(Date.now())
const clock = setInterval(() => { now.value = Date.now() }, 30_000)
onBeforeUnmount(() => clearInterval(clock))

/**
 * What a row's card reads, from an item: the times as the card takes them,
 * and upcoming only while its time is ahead, so that a stream that has been
 * and gone is not still badged upcoming. A length the item does not know is
 * no length, rather than the card's sign of a live.
 * @param {import('../../helpers/later').LaterItem} item
 */
function cardData(item) {
  const at = item.alarm?.at ?? item.premiereDate
  const ahead = at != null && at > now.value

  return {
    ...item,
    type: 'video',
    lengthSeconds: item.lengthSeconds ?? 0,
    isUpcoming: ahead,
    premiereDate: ahead ? new Date(at) : undefined,
    // The row id the drag and the move events carry: the item's own `_id`
    playlistItemId: item._id,
  }
}

const armed = computed(() => store.getters.getLaterArmed.map(cardData))

const queued = computed(() => store.getters.getLaterQueued.map(cardData))

/** @param {{ alarm: { at: number } }} item */
function stateOf(item) {
  return laterStateAt(now.value, item.alarm.at)
}

/** @param {'waiting' | 'checking' | 'didNotStart'} state */
function stateLabel(state) {
  switch (state) {
    case 'waiting':
      return t('Later.State.Waiting')
    case 'checking':
      return t('Later.State.Checking')
    default:
      return t('Later.State.Did not start')
  }
}

/** @param {{ alarm: { at: number } }} item */
function scheduledTimeOf(item) {
  // Read with the clock, so the relative part moves on with it
  return now.value > 0 ? formatScheduledTime(item.alarm.at) : ''
}

/** @param {string} id */
function disarm(id) {
  store.dispatch('disarm', id)
}

/** @import { VideoData } from '../../helpers/dragAndDrop' */
/** @type {import('vue').Ref<VideoData>} */
const draggedVideo = ref({ videoId: null, playlistItemId: null })

/** The order shown while dragging, written only when the drag ends */
const tempQueued = ref(null)

const shownQueued = computed(() => tempQueued.value ?? queued.value)

const isVideoDragging = computed(() => draggedVideo.value.videoId != null && draggedVideo.value.playlistItemId != null)

/**
 * @param {string} id
 */
function indexOf(id) {
  return queued.value.findIndex(item => item._id === id)
}

/**
 * @param {string} id
 * @param {number} toIndex among the others
 */
function move(id, toIndex) {
  store.dispatch('moveLaterItem', { id, toIndex })
}

function moveUp(_videoId, id) {
  const index = indexOf(id)
  if (index > 0) { move(id, index - 1) }
}

function moveDown(_videoId, id) {
  const index = indexOf(id)
  if (index !== -1 && index < queued.value.length - 1) { move(id, index + 1) }
}

function moveToTop(_videoId, id) {
  move(id, 0)
}

function moveToBottom(_videoId, id) {
  move(id, queued.value.length - 1)
}

function remove(_videoId, id) {
  store.dispatch('removeFromLater', id)
}

/**
 * @param {VideoData} video
 */
function setDraggedVideo(video) {
  draggedVideo.value = video
}

function onDragVideoEnd() {
  const id = draggedVideo.value.playlistItemId

  if (tempQueued.value != null && id != null) {
    const toIndex = tempQueued.value.findIndex(item => item._id === id)

    if (toIndex !== -1) {
      move(id, toIndex)
    }
  }

  tempQueued.value = null
  setDraggedVideo({ videoId: null, playlistItemId: null })
}

/**
 * Shows the dragged row where it is dragged to, without writing.
 * @param {VideoData} over the row dragged over
 * @param {VideoData} dragged
 */
function moveDraggedVideoTemporarily(over, dragged) {
  const items = (tempQueued.value ?? queued.value).slice()

  const overIndex = items.findIndex(item => item._id === over.playlistItemId)
  const draggedIndex = items.findIndex(item => item._id === dragged.playlistItemId)

  if (overIndex === -1 || draggedIndex === -1) { return }

  const [moved] = items.splice(draggedIndex, 1)
  items.splice(overIndex, 0, moved)

  tempQueued.value = items
}

// As the Playlist view: once per 100ms, so rows do not swap back and forth
// during their transition
const moveDraggedVideoTemporarilyThrottled = throttle(moveDraggedVideoTemporarily, 100)
</script>

<style scoped src="./Later.css" />
