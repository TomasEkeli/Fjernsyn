<template>
  <div class="comment">
    <!-- The author's handle is an account, not a channel: nothing here links to it -->
    <img
      v-if="showAvatar"
      :src="comment.authorThumbnail"
      alt=""
      class="commentThumbnail"
    >
    <div
      v-else
      class="commentThumbnailHidden"
      dir="auto"
      aria-hidden="true"
    >
      {{ initial }}
    </div>
    <p class="commentAuthorWrapper">
      <span
        v-if="!comment.isDeleted && comment.author"
        class="commentAuthor"
        dir="auto"
        :title="comment.authorAccount || undefined"
      >{{ comment.author }}</span>
      <span
        v-if="relativeDate"
        class="commentDate"
        :title="exactDate"
      >{{ relativeDate }}</span>
    </p>
    <p
      v-if="comment.isDeleted"
      class="commentText commentDeleted"
    >
      {{ t('PeerTube.Comments.Deleted') }}
    </p>
    <!-- Federated from Mastodon and the like: cut down, then sanitised -->
    <!-- eslint-disable-next-line vuejs-accessibility/click-events-have-key-events -->
    <div
      v-else-if="comment.textKind === 'html'"
      v-safer-html.lenient="html"
      class="commentText commentHtml"
      dir="auto"
      @click="forwardClickToLink"
      @auxclick="forwardClickToLink"
    />
    <LayerMarkdown
      v-else
      class="commentText"
      :source="comment.text"
      :base-url="baseUrl"
    />
    <p
      v-if="comment.replyCount > 0"
      class="commentActions"
    >
      <span
        v-if="!repliesLoading || repliesLoaded"
        class="commentMoreReplies"
        role="button"
        tabindex="0"
        @click="toggleReplies"
        @keydown.enter.space.prevent="toggleReplies"
      >{{ toggleText }}</span>
      <span
        v-else
        class="commentLoadingMoreReplies"
      >{{ t('Comments.Loading replies') }}</span>
    </p>
    <div
      v-if="showReplies"
      class="commentReplies"
    >
      <LayerComment
        v-for="reply in replies"
        :key="reply.id"
        :comment="reply"
        :video-ref="videoRef"
        :base-url="baseUrl"
      />
      <div
        v-if="repliesCursor !== null && !repliesLoading && !repliesFailed"
        class="showMoreReplies"
        role="button"
        tabindex="0"
        @click="loadReplies"
        @keydown.enter.space.prevent="loadReplies"
      >
        {{ t('Comments.Show More Replies') }}
      </div>
      <div
        v-else-if="repliesLoading"
        class="loadingMoreReplies"
      >
        {{ t('Comments.Loading replies') }}
      </div>
    </div>
    <div
      v-if="repliesFailed"
      class="commentRepliesError"
    >
      <p>{{ t('PeerTube.Comments.Could not load replies') }}</p>
      <FtButton
        :label="t('Video.Try Again')"
        :icon="['fas', 'sync']"
        @click="loadReplies"
      />
    </div>
  </div>
</template>

<script setup>
import { computed, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

import FtButton from '../FtButton/FtButton.vue'
import LayerMarkdown from '../LayerMarkdown/LayerMarkdown.vue'

import store from '../../store/index'
import { vSaferHtml } from '../../directives/vSaferHtml'
import { getLocalesWithFallback, getRelativeTimeFromDate } from '../../helpers/utils'
import { usePlatformLayer } from '../../platform/vue'
import { cleanCommentHtml, forwardClickToLink } from './commentHtml'

const props = defineProps({
  /**
   * @type {import('vue').PropType<import('../../platform/shapes').Comment>}
   */
  comment: {
    type: Object,
    required: true
  },
  /**
   * The video the comment is on, as the layer names it; handed back unchanged
   * @type {import('vue').PropType<import('../../platform/shapes').VideoRef>}
   */
  videoRef: {
    type: [Object, String],
    required: true
  },
  /** The instance the comment came from (`https://{host}`), for relative links */
  baseUrl: {
    type: String,
    default: ''
  },
})

const { locale, t } = useI18n()
const layer = usePlatformLayer()

const hideCommentPhotos = computed(() => store.getters.getHideCommentPhotos)

const showAvatar = computed(() => !hideCommentPhotos.value && !props.comment.isDeleted && !!props.comment.authorThumbnail)

const initial = computed(() => (props.comment.isDeleted ? '' : Array.from(props.comment.author ?? '')[0] ?? ''))

/** Whether the comment has a date: the layer gives `0` when it has none, which is no date, not 1970 */
const hasDate = computed(() => Number.isFinite(props.comment.createdAt) && props.comment.createdAt > 0)

const relativeDate = computed(() => (hasDate.value ? getRelativeTimeFromDate(props.comment.createdAt) : ''))

const exactDate = computed(() => {
  if (!hasDate.value) {
    return undefined
  }

  return new Intl.DateTimeFormat(getLocalesWithFallback(locale.value), { dateStyle: 'medium', timeStyle: 'short' })
    .format(props.comment.createdAt)
})

const html = computed(() => cleanCommentHtml(props.comment.text, props.baseUrl))

const showReplies = ref(false)
const repliesLoading = ref(false)
const repliesFailed = ref(false)
/** @type {import('vue').ShallowRef<import('../../platform/shapes').Comment[]>} */
const replies = shallowRef([])
/** Whether a page of replies has come, so that the toggle only hides and shows */
const repliesLoaded = ref(false)
/** Where the next page of replies starts; `null` once they are all here */
const repliesCursor = shallowRef(null)

const toggleText = computed(() => {
  const replyCount = props.comment.replyCount

  return showReplies.value
    ? t('Comments.Hide Replies', replyCount)
    : t('Comments.View {replyCount} replies', { replyCount }, replyCount)
})

function toggleReplies() {
  if (repliesLoaded.value) {
    showReplies.value = !showReplies.value
  } else {
    loadReplies()
  }
}

/** The first page of replies, or the next one */
async function loadReplies() {
  if (repliesLoading.value) {
    return
  }

  repliesLoading.value = true
  repliesFailed.value = false

  try {
    const page = await layer.getCommentReplies(props.videoRef, props.comment, { cursor: repliesCursor.value })

    replies.value = [...replies.value, ...page.items]
    repliesCursor.value = page.cursor ?? null
    repliesLoaded.value = true
    showReplies.value = true
  } catch (error) {
    if (!error?.kind) {
      console.error(error)
    }

    repliesFailed.value = true
  } finally {
    repliesLoading.value = false
  }
}
</script>

<style scoped src="./LayerComment.css" />
