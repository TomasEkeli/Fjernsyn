<template>
  <FtCard
    v-if="!hideComments"
    class="card"
  >
    <h3
      v-if="!commentsEnabled"
      class="noCommentMsg"
    >
      {{ t('Comments.Comments are turned off') }}
    </h3>
    <template v-else>
      <h3
        v-if="loaded && showComments && comments.length > 0"
        class="commentsTitle"
      >
        {{ t('Comments.Comments') }}
        <span
          class="hideComments"
          role="button"
          tabindex="0"
          @click="showComments = false"
          @keydown.enter.space.prevent="showComments = false"
        >
          {{ t('Comments.Hide Comments') }}
        </span>
      </h3>
      <h4
        v-if="(!loaded && !isLoading && !failed && !autoLoad) || (loaded && !showComments)"
        class="getCommentsTitle"
        role="button"
        tabindex="0"
        @click="handleShowComments"
        @keydown.enter.space.prevent="handleShowComments"
      >
        {{ t('Comments.Click to View Comments') }}
      </h4>
      <template v-if="loaded && showComments">
        <LayerComment
          v-for="comment in comments"
          :key="comment.id"
          :comment="comment"
          :video-ref="videoRef"
          :base-url="baseUrl"
        />
        <h3
          v-if="comments.length === 0 && cursor === null"
          class="noCommentMsg"
        >
          {{ t('Comments.There are no comments available for this video') }}
        </h3>
        <h4
          v-if="cursor !== null && !isLoading && !failed"
          class="getMoreComments"
          role="button"
          tabindex="0"
          @click="loadMore"
          @keydown.enter.space.prevent="loadMore"
        >
          {{ t('Comments.Load More Comments') }}
        </h4>
      </template>
      <div
        v-if="failed"
        class="commentsError"
      >
        <p>{{ t('PeerTube.Comments.Could not load') }}</p>
        <FtButton
          :label="t('Video.Try Again')"
          :icon="['fas', 'sync']"
          @click="loadMore"
        />
      </div>
      <FtLoader v-if="isLoading" />
      <!-- Watched for coming into view, to load by itself -->
      <div v-observe-visibility="observeVisibilityOptions" />
    </template>
  </FtCard>
</template>

<script setup>
// The comments on the layer's watch page, from the layer's comment
// operations. Nothing is asked of the instance until the viewer asks, or,
// with comments loading automatically, until the section comes into view,
// as upstream's CommentSection does.

import { computed, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

import FtButton from '../FtButton/FtButton.vue'
import FtCard from '../ft-card/ft-card.vue'
import FtLoader from '../FtLoader/FtLoader.vue'
import LayerComment from './LayerComment.vue'

import store from '../../store/index'
import { usePlatformLayer } from '../../platform/vue'

const props = defineProps({
  /**
   * The video, as the layer names it; handed back unchanged
   * @type {import('vue').PropType<import('../../platform/shapes').VideoRef>}
   */
  videoRef: {
    type: [Object, String],
    required: true
  },
  /** From the video's details: `false` says so and asks for nothing */
  commentsEnabled: {
    type: Boolean,
    default: true
  },
  /** The instance the comments come from (`https://{host}`), for relative links */
  baseUrl: {
    type: String,
    default: ''
  },
})

const { t } = useI18n()
const layer = usePlatformLayer()

const hideComments = computed(() => store.getters.getHideComments)
const autoLoad = computed(() => store.getters.getCommentAutoLoadEnabled)
const autoLoadMore = computed(() => store.getters.getGeneralAutoLoadMorePaginatedItemsEnabled)

/** @type {import('vue').ShallowRef<import('../../platform/shapes').Comment[]>} */
const comments = shallowRef([])
/** Where the next page starts; `null` at the end */
const cursor = shallowRef(null)
const loaded = ref(false)
const isLoading = ref(false)
const failed = ref(false)
const showComments = ref(true)

const observeVisibilityOptions = computed(() => {
  if (!autoLoad.value && !autoLoadMore.value) {
    return false
  }

  return {
    /**
     * @param {boolean} isVisible
     */
    callback: (isVisible) => {
      if (!isVisible || isLoading.value || failed.value) {
        return
      }

      if (!loaded.value) {
        if (autoLoad.value) {
          loadMore()
        }
      } else if (autoLoadMore.value && showComments.value && cursor.value !== null) {
        loadMore()
      }
    },
    once: false,
  }
})

function handleShowComments() {
  if (loaded.value) {
    showComments.value = true
  } else {
    loadMore()
  }
}

/** The first page, the next one, or again the one that failed */
async function loadMore() {
  if (isLoading.value) {
    return
  }

  isLoading.value = true
  failed.value = false

  try {
    const page = await layer.getComments(props.videoRef, { cursor: cursor.value })

    comments.value = [...comments.value, ...page.items]
    cursor.value = page.cursor ?? null
    loaded.value = true
    showComments.value = true
  } catch (error) {
    if (!error?.kind) {
      console.error(error)
    }

    failed.value = true
  } finally {
    isLoading.value = false
  }
}
</script>

<style scoped src="./LayerComments.css" />
