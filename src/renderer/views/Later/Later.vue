<template>
  <div class="laterPage">
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
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import FtCard from '../../components/ft-card/ft-card.vue'
import FtFlexBox from '../../components/ft-flex-box/ft-flex-box.vue'
import FtElementList from '../../components/FtElementList/FtElementList.vue'
import FtListVideoNumbered from '../../components/FtListVideoNumbered/FtListVideoNumbered.vue'
import AutoScrollWrapper from '../../components/AutoScrollWrapper/AutoScrollWrapper.vue'

import store from '../../store/index'
import { throttle } from '../../helpers/utils'

/**
 * The Later page: the Later list's queued items, in their order, moved and
 * removed as a playlist's are. The rows are the playlist rows, given no
 * playlist: `laterRow` turns on their move and remove controls, and their
 * events come here, to the Later store, so nothing on this page writes to
 * `playlists.db`, and no link carries a `playlistId`.
 */

const { t } = useI18n()

/** @type {import('vue').ComputedRef<'grid' | 'list'>} */
const listType = computed(() => store.getters.getListType)

/**
 * The rows' data: the items, with the row id the drag and the move events
 * carry, which is the item's own `_id`.
 */
const queued = computed(() => store.getters.getLaterQueued.map(item => ({
  ...item,
  type: 'video',
  playlistItemId: item._id,
})))

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
