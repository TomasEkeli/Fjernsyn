<template>
  <div
    v-if="enabled"
    class="liveChatOverlay"
    :class="{ quiet: !active || messages.length === 0 }"
    role="log"
    aria-live="off"
    :aria-label="t('Video.Live Chat')"
  >
    <div class="panel">
      <p
        v-for="message in messages"
        :key="message.id"
        class="message"
        :class="{ superChat: message.amount !== null }"
      >
        <time
          class="time"
          :datetime="chatTimeAttribute(message.timestamp)"
        >{{ formatChatTime(message.timestamp, timeLocales) }}</time>
        <bdi
          class="name"
          :class="{
            member: message.author.isMember,
            moderator: message.author.isModerator,
            owner: message.author.isOwner
          }"
        >{{ message.author.name }}</bdi>
        <span
          v-if="message.amount !== null"
          class="amount"
        >{{ message.amount }}</span>
        <bdi
          v-safer-html="message.message"
          class="text"
        />
      </p>
    </div>
  </div>
</template>

<script setup>
// The live chat over the video, for full window and fullscreen, where the side
// panel cannot be seen. It only reads: the chat is the side panel's
// (`WatchVideoLiveChat`), which starts the stream and stops it, and which is
// always there while this is. This listens to the same stream for as long as
// the player holds it, shown or not, so that switching it on shows what was
// said just before. Clicks pass through it to the video.

import { computed, onBeforeUnmount, shallowReactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { YTNodes } from 'youtubei.js'

import { vSaferHtml } from '../../directives/vSaferHtml.js'
import { getLocalesWithFallback } from '../../helpers/utils'
import { OVERLAY_QUIET_AFTER_MS, chatTimeAttribute, formatChatTime, parseOverlayChatItem } from '../../helpers/liveChat'

/** How many messages are kept: more than fit at the tallest */
const MAX_MESSAGES = 50

const props = defineProps({
  /** The chat's stream, as the side panel is handed it: youtubei.js's `LiveChat` */
  liveChat: {
    type: EventTarget,
    required: true
  },
  /** The channel streaming, whose messages are the owner's */
  channelId: {
    type: String,
    default: ''
  },
  enabled: {
    type: Boolean,
    default: false
  }
})

const { locale, t } = useI18n()

const timeLocales = computed(() => getLocalesWithFallback(locale.value))

/** @type {import('../../helpers/liveChat').OverlayChatMessage[]} */
const messages = shallowReactive([])

/** Whether something has been said lately, or the overlay was just switched on */
const active = ref(false)

/** @type {ReturnType<typeof setTimeout> | null} */
let quietTimeout = null

/** Brings the chat up, and fades it once nothing more is said for a while */
function wake() {
  active.value = true

  if (quietTimeout !== null) {
    clearTimeout(quietTimeout)
  }

  quietTimeout = setTimeout(() => {
    quietTimeout = null
    active.value = false
  }, OVERLAY_QUIET_AFTER_MS)
}

/**
 * @param {any} item a chat item youtubei.js parsed
 * @returns {boolean} whether it was a message
 */
function add(item) {
  const message = parseOverlayChatItem(item, props.channelId)

  if (message === null) {
    return false
  }

  messages.push(message)

  if (messages.length > MAX_MESSAGES) {
    messages.splice(0, messages.length - MAX_MESSAGES)
  }

  return true
}

/**
 * @param {import('youtubei.js/dist/src/parser/continuations').LiveChatContinuation} initialData
 */
function handleStart(initialData) {
  // what was said before the chat was opened, which is not news
  for (const { item } of initialData.actions.filterType(YTNodes.AddChatItemAction)) {
    add(item)
  }
}

/**
 * @param {import('youtubei.js/dist/src/parser/youtube/LiveChat').ChatAction} action
 */
function handleChatUpdate(action) {
  if (action.is(YTNodes.AddChatItemAction) && add(action.item)) {
    wake()
  }
}

watch(() => props.liveChat, (liveChat, _previous, onCleanup) => {
  messages.length = 0

  // A stand-in without youtubei.js's listeners has nothing to say
  if (typeof liveChat?.on !== 'function') {
    return
  }

  liveChat.on('start', handleStart)
  liveChat.on('chat-update', handleChatUpdate)

  onCleanup(() => {
    liveChat.off('start', handleStart)
    liveChat.off('chat-update', handleChatUpdate)
  })
}, { immediate: true })

// Switched on, it shows itself, to be seen to have come on, quiet or not
watch(() => props.enabled, (enabled) => {
  if (enabled) {
    wake()
  }
}, { immediate: true })

onBeforeUnmount(() => {
  if (quietTimeout !== null) {
    clearTimeout(quietTimeout)
    quietTimeout = null
  }
})
</script>

<style scoped src="./LiveChatOverlay.css" />
