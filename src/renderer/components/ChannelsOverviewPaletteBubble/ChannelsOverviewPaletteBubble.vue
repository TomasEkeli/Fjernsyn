<!--
  One profile in the palette over the Channels overview. Clicking it opens or
  closes the profile's column; dropping channels on it files them into the
  profile without opening the column, and the bubble flashes to say they
  landed.

  Under the name, how many channels the profile has, and how many of those
  are shared with some other profile: the ones to sort out.

  Right-click it, or press the ContextMenu key or Shift+F10 on it, to rename
  it, change its colour or remove it. Renaming happens in place.

  It can be dragged along the palette to put the profile somewhere else in
  the order, or moved a place at a time with Ctrl+Shift+Left and Right.
-->
<template>
  <div
    ref="entry"
    class="paletteEntry"
    :class="{ dropTarget: dragOver, acknowledged, dragging, insertBefore, insertAfter }"
    :data-profile-id="profile._id"
    :style="{ '--profile-colour': profile.bgColor }"
    :title="editing ? null : tooltip"
    :draggable="editing ? 'false' : 'true'"
    v-on="dropHandlers"
    @dragstart="startDrag"
    @contextmenu="openMenu"
    @keydown="onKeydown"
  >
    <ChannelsOverviewProfileNameField
      v-if="editing"
      :initial-name="profile.name"
      :bg-color="profile.bgColor"
      :picture="picture"
      :label="t('Channels.Overview.Rename Profile')"
      @commit="(name, hadFocus) => finishRename(name, hadFocus)"
      @cancel="(hadFocus) => finishRename(null, hadFocus)"
    />
    <template v-else>
      <FtProfileBubble
        class="paletteBubble"
        :class="{ open }"
        :profile-name="profile.name"
        :is-main-profile="false"
        :background-color="profile.bgColor"
        :text-color="calculateColorLuminance(profile.bgColor)"
        :picture="picture"
        :aria-pressed="open ? 'true' : 'false'"
        @click="emit('toggle')"
      />
      <span
        v-if="matchCount !== null"
        class="badge matchBadge"
        :class="{ noMatches: matchCount === 0 }"
        :title="t('Channels.Overview.Profile Matches', { count: matchCount }, matchCount)"
      >
        {{ matchCount }}
      </span>
      <span
        class="counts"
        :class="{ open }"
        aria-hidden="true"
      >
        {{ channelCount }}
        <span
          v-if="duplicateCount > 0"
          class="sharedCount"
        >{{ t('Channels.Overview.Shared Count', { count: duplicateCount }) }}</span>
      </span>
    </template>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'

import FtProfileBubble from '../FtProfileBubble/FtProfileBubble.vue'
import ChannelsOverviewProfileNameField from '../ChannelsOverviewProfileNameField/ChannelsOverviewProfileNameField.vue'

import store from '../../store/index'
import { calculateColorLuminance } from '../../helpers/colors'
import { readProfilePicture } from '../../helpers/profilePictures'

import { useChannelDropTarget } from '../../composables/useChannelDropTarget'

const props = defineProps({
  /** @type {import('vue').PropType<import('../../helpers/channelsOverview').Profile>} */
  profile: {
    type: Object,
    required: true
  },
  open: {
    type: Boolean,
    default: false
  },
  /** How many of the profile's channels match the search, null while not searching */
  matchCount: {
    type: Number,
    default: null
  },
  /** How many channels the profile has */
  channelCount: {
    type: Number,
    default: 0
  },
  /** How many of the profile's channels are in some other profile too */
  duplicateCount: {
    type: Number,
    default: 0
  },
  /** Its name is being typed in place */
  editing: {
    type: Boolean,
    default: false
  },
  /** It is the bubble being dragged */
  dragging: {
    type: Boolean,
    default: false
  },
  /** A dragged bubble would land in front of it */
  insertBefore: {
    type: Boolean,
    default: false
  },
  /** A dragged bubble would land after it: it is the last */
  insertAfter: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['toggle', 'drop-channels', 'rename', 'menu', 'drag-profile', 'move'])

const { t } = useI18n()

/** Drawn in the bubble in place of the initial, if the profile has one */
const picture = computed(() => readProfilePicture(store.getters.getProfilePictures, props.profile._id))

/** The counts in words, for the tooltip and for a screen reader */
const summary = computed(() => {
  const channels = t('Channels.Overview.Profile Channels', { count: props.channelCount }, props.channelCount)

  if (props.duplicateCount === 0) { return `${props.profile.name}: ${channels}` }

  const shared = t('Channels.Overview.Profile Duplicates', { count: props.duplicateCount }, props.duplicateCount)

  return `${props.profile.name}: ${channels}. ${shared}`
})

const tooltip = computed(() => `${summary.value}\n${t('Channels.Overview.Reorder Hint')}`)

/**
 * @param {DragEvent} event
 */
function startDrag(event) {
  // Not while its name is being typed, so that text in the field can be selected
  if (props.editing) {
    event.preventDefault()
    return
  }

  emit('drag-profile', event)
}

const acknowledged = ref(false)
let acknowledgeTimeout = null

const { dragOver, handlers: dropHandlers } = useChannelDropTarget({
  onDrop: (dragged, copy) => {
    emit('drop-channels', dragged, copy)
    acknowledge()
  }
})

/** Replays the flash if a second drop lands while the first is still showing. */
function acknowledge() {
  clearTimeout(acknowledgeTimeout)
  acknowledged.value = false

  requestAnimationFrame(() => {
    acknowledged.value = true
    acknowledgeTimeout = setTimeout(() => { acknowledged.value = false }, 900)
  })
}

const entry = useTemplateRef('entry')

/**
 * At the pointer for a right-click; under the bubble when it came from the
 * keyboard, which has no pointer to speak of.
 * @param {MouseEvent} event
 */
function openMenu(event) {
  if (props.editing) { return }

  event.preventDefault()

  emit('menu', event.button === 2
    ? { x: event.clientX, y: event.clientY }
    : { rect: entry.value.getBoundingClientRect() })
}

/**
 * The ContextMenu key and Shift+F10 open the menu here as well as through the
 * contextmenu event, which not every platform fires for them. Opening it
 * twice opens the same menu in the same place.
 * @param {KeyboardEvent} event
 */
function onKeydown(event) {
  if (props.editing) { return }

  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault()
    emit('menu', { rect: entry.value.getBoundingClientRect() })
  }

  if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey &&
    (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault()
    // Which way on screen: the palette knows which way that is in the order
    emit('move', event.key === 'ArrowRight' ? 1 : -1)
  }
}

/**
 * @param {string | null} name null when it was given up
 * @param {boolean} hadFocus finished in the field, so the focus goes back to the bubble
 */
async function finishRename(name, hadFocus) {
  emit('rename', name)

  if (!hadFocus) { return }

  await nextTick()
  entry.value?.querySelector('[role="button"]')?.focus()
}

onBeforeUnmount(() => clearTimeout(acknowledgeTimeout))
</script>

<style scoped src="./ChannelsOverviewPaletteBubble.css" />
