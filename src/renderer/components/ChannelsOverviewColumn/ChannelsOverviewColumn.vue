<!--
  One column of the Channels overview: a profile's channels, the pool of
  channels no profile has claimed, or a proposed column, which suggests
  channels for a profile and is not one. A proposed column has a dashed
  border, a tick on its heading that accepts the whole suggestion, and a menu
  of what else can be done with it. Each of its channels has a tick and a
  cross of its own. A channel dropped on it joins the suggestion, and is
  filed nowhere until the suggestion is accepted.

  A column can hold a couple of thousand channels, and drawing them all at once
  is what made the old channel list slow to open. So it draws the first
  screenful and a little more, and each time the end of what it has drawn
  scrolls into view it draws the next batch. A new search starts it over. The marker at the end is keyed on
  how many are drawn, so a batch that still leaves the end in view triggers the
  next one as soon as it lands.
-->
<template>
  <section
    class="column"
    :class="{ pool: isPool, proposed, dropTarget: dragOver }"
    :style="proposed && backgroundColor ? { '--proposal-colour': backgroundColor } : null"
    :aria-labelledby="headingId"
    v-on="dropHandlers"
  >
    <header
      class="columnHeader"
      :style="isPool || !backgroundColor ? null : { background: backgroundColor, color: headerTextColor }"
    >
      <!-- A profile's heading makes it the active profile, the one the rest of the app shows -->
      <h3
        v-if="!isPool && !proposed"
        :id="headingId"
        class="activateHeading"
      >
        <button
          type="button"
          class="activateButton"
          :class="{ active }"
          :aria-pressed="active ? 'true' : 'false'"
          :title="active
            ? t('Channels.Overview.Active Profile', { profile: title })
            : t('Channels.Overview.Make Active Profile', { profile: title })"
          @click="emit('activate')"
        >
          <span
            class="columnTitle"
            dir="auto"
          >{{ title }}</span>
          <FontAwesomeIcon
            v-if="active"
            class="activeMark"
            :icon="['fas', 'user-check']"
            aria-hidden="true"
          />
          <span class="columnCount">
            {{ countLabel }}
          </span>
        </button>
      </h3>
      <template v-else>
        <h3
          :id="headingId"
          class="columnTitle"
          dir="auto"
        >
          {{ title }}
        </h3>
        <span class="columnCount">
          {{ countLabel }}
        </span>
      </template>
      <button
        v-if="proposed && acceptLabel !== ''"
        type="button"
        class="acceptAllButton"
        :title="acceptLabel"
        :aria-label="acceptLabel"
        @click="emit('accept-all')"
      >
        <FontAwesomeIcon :icon="['fas', 'check']" />
      </button>
      <span
        v-if="proposed && menuItems.length > 0"
        ref="proposalMenu"
        class="proposalMenu"
      >
        <ChannelsOverviewMenuButton
          :label="menuLabel"
          :items="menuItems"
          @choose="chooseFromMenu"
        >
          <FontAwesomeIcon :icon="['fas', 'ellipsis-vertical']" />
        </ChannelsOverviewMenuButton>
      </span>
      <!-- Anything else the page puts on the heading -->
      <slot name="header-actions" />
      <!-- What is shown: while searching, the matches -->
      <button
        v-if="channels.length > 0"
        type="button"
        class="selectAllButton"
        :aria-label="allShownSelected
          ? t('Channels.Overview.Select None In', { profile: title })
          : t('Channels.Overview.Select All In', { profile: title })"
        @click="allShownSelected ? emit('select-none') : emit('select-all')"
      >
        {{ allShownSelected ? t('Channels.Overview.Select None') : t('Channels.Overview.Select All') }}
      </button>
    </header>
    <div
      ref="body"
      class="columnBody"
    >
      <p
        v-if="channels.length === 0"
        class="emptyColumn"
      >
        {{ emptyLabel }}
      </p>
      <ChannelsOverviewTile
        v-for="channel in drawnChannels"
        :key="channel.id"
        :data-channel-id="channel.id"
        :channel="channel"
        :selected="selectedIds.has(channel.id)"
        :duplicate-profiles="duplicateProfiles.get(channel.id) ?? null"
        :callout="calloutColours.get(channel.id) ?? null"
        :badge="badges.get(channel.id) ?? null"
        :evidence="evidence.get(channel.id) ?? null"
        :probing="channel.id === probingId"
        :accept-label="proposed ? channelAcceptLabel : null"
        :reject-label="proposed ? channelRejectLabel : null"
        @accept="emit('accept-channel', channel)"
        @reject="emit('reject-channel', channel)"
        @thumbnail-error="emit('thumbnail-error', $event)"
        @drag-start="(event, channel) => emit('drag-start', event, channel)"
        @select="(extend) => emit('select', channel, extend)"
        @remove-here="emit('remove-here', channel)"
        @keep-here="emit('keep-here', channel)"
        @context-menu="(event, channel) => emit('context-menu', event, channel)"
      />
      <div
        v-if="drawnChannels.length < channels.length"
        :key="drawLimit"
        v-observe-visibility="{ callback: drawMore }"
        class="drawMore"
      />
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, ref, useId, useTemplateRef, watch } from 'vue'
import { ObserveVisibility as vObserveVisibility } from 'vue-observe-visibility'

import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { useI18n } from 'vue-i18n'

import ChannelsOverviewMenuButton from '../ChannelsOverviewMenuButton/ChannelsOverviewMenuButton.vue'
import ChannelsOverviewTile from '../ChannelsOverviewTile/ChannelsOverviewTile.vue'

import { useChannelDropTarget } from '../../composables/useChannelDropTarget'
import { calculateColorLuminance } from '../../helpers/colors'

const props = defineProps({
  title: {
    type: String,
    required: true
  },
  countLabel: {
    type: String,
    required: true
  },
  emptyLabel: {
    type: String,
    default: ''
  },
  backgroundColor: {
    type: String,
    default: null
  },
  isPool: {
    type: Boolean,
    default: false
  },
  /** Whether this is the active profile */
  active: {
    type: Boolean,
    default: false
  },
  /** @type {import('vue').PropType<import('../../helpers/channelsOverview').Channel[]>} */
  channels: {
    type: Array,
    required: true
  },
  /** Whether the next change to the channels is shown happening */
  animate: {
    type: Boolean,
    default: false
  },
  /**
   * Starts the column over from the top, drawing only the first rows, when it
   * changes: the search does this, as what was scrolled to is gone.
   */
  resetKey: {
    type: String,
    default: ''
  },
  /** @type {import('vue').PropType<Set<string>>} */
  selectedIds: {
    type: Set,
    default: () => new Set()
  },
  /**
   * For each channel in more than one profile, the names of its profiles
   * @type {import('vue').PropType<Map<string, string[]>>}
   */
  duplicateProfiles: {
    type: Map,
    default: () => new Map()
  },
  /**
   * The callout colour of each channel duplicated across the open columns
   * @type {import('vue').PropType<Map<string, number>>}
   */
  calloutColours: {
    type: Map,
    default: () => new Map()
  },
  /** A proposed column: a suggestion, not a profile */
  proposed: {
    type: Boolean,
    default: false
  },
  /**
   * What can be done with a proposed column's suggestion, for the menu on
   * its heading
   * @type {import('vue').PropType<import('../ChannelsOverviewMenu/ChannelsOverviewMenu.vue').MenuItem[]>}
   */
  menuItems: {
    type: Array,
    default: () => []
  },
  /** The menu's name, for its button's tooltip and a screen reader */
  menuLabel: {
    type: String,
    default: ''
  },
  /** The channel being probed now, anywhere, which shows it happening */
  probingId: {
    type: String,
    default: null
  },
  /** What the tick on a proposed column's heading does, to all of it */
  acceptLabel: {
    type: String,
    default: ''
  },
  /** What the tick on each of a proposed column's channels does */
  channelAcceptLabel: {
    type: String,
    default: ''
  },
  /** What the cross on each of a proposed column's channels does */
  channelRejectLabel: {
    type: String,
    default: ''
  },
  /**
   * For a suggested channel in some other profile now, which one
   * @type {import('vue').PropType<Map<string, { label: string, bgColor: string }>>}
   */
  badges: {
    type: Map,
    default: () => new Map()
  },
  /**
   * Why each channel of a proposed column is suggested, for its tooltip
   * @type {import('vue').PropType<Map<string, string>>}
   */
  evidence: {
    type: Map,
    default: () => new Map()
  }
})

const emit = defineEmits(['thumbnail-error', 'drag-start', 'drop-channels', 'select', 'remove-here', 'keep-here', 'select-all', 'select-none', 'context-menu', 'activate', 'menu', 'accept-all', 'accept-channel', 'reject-channel'])

const proposalMenu = useTemplateRef('proposalMenu')

/**
 * Hands the page the choice, and where the menu was, as one of the choices
 * opens a second menu in its place.
 * @param {string} value
 */
function chooseFromMenu(value) {
  const button = proposalMenu.value?.querySelector('button')

  emit('menu', value, button ? { rect: button.getBoundingClientRect() } : null)
}

const { t } = useI18n()

/**
 * Black or white, whichever reads on the profile's colour. Worked out here
 * instead of taken from the profile, whose stored text colour can be the
 * wrong one of the two.
 */
const headerTextColor = computed(() => props.backgroundColor ? calculateColorLuminance(props.backgroundColor) : null)

/** Whether everything shown is selected, when the button deselects instead */
const allShownSelected = computed(() => {
  return props.channels.length > 0 && props.channels.every(channel => props.selectedIds.has(channel.id))
})

const headingId = useId()

/** Rows drawn before any scrolling: a tall window's worth, with some to spare. */
const FIRST_BATCH = 60
const NEXT_BATCH = 80

const drawLimit = ref(FIRST_BATCH)

const drawnChannels = computed(() => props.channels.slice(0, drawLimit.value))

const body = useTemplateRef('body')

// Otherwise a search cleared after scrolling far down would draw every row
// scrolled past in one go, and on a column of thousands that is a long wait
watch(() => props.resetKey, () => {
  drawLimit.value = FIRST_BATCH

  if (body.value) {
    body.value.scrollTop = 0
  }
})

const { dragOver, handlers: dropHandlers } = useChannelDropTarget({
  onDrop: (dragged, copy) => emit('drop-channels', dragged, copy),
  // A copy into the pool means nothing: the pool is where no profile has it.
  // Nor into a suggestion, which files nothing yet.
  canCopy: () => !props.isPool && !props.proposed
})

/**
 * A change to the channels, seen happening, while `animate` says it is worth
 * watching: a channel leaving fades out where it was while the others close
 * up, and one arriving fades in where it lands once they have made room.
 * Drawing the next batch, or a search, just shows what it shows.
 *
 * Done by hand, as TransitionGroup measures each moved channel between moving
 * the ones before it, which makes the browser lay the page out again for
 * every one of them. Here every position is read in one go before the change
 * and one go after, and only for the channels in sight.
 */
watch(() => props.channels, () => {
  if (!props.animate || !body.value) { return }

  const container = body.value
  const top = container.scrollTop
  const bottom = top + container.clientHeight
  const inSight = (el) => el.offsetTop + el.offsetHeight > top && el.offsetTop < bottom

  const staying = new Set(props.channels.map(channel => channel.id))

  /** @type {Map<string, { left: number, top: number }>} */
  const before = new Map()
  const leaving = []

  for (const el of container.querySelectorAll(':scope > [data-channel-id]')) {
    if (!inSight(el)) { continue }

    const position = { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }
    before.set(el.dataset.channelId, position)

    if (!staying.has(el.dataset.channelId)) {
      leaving.push({ ghost: el.cloneNode(true), position, opacity: getComputedStyle(el).opacity })
    }
  }

  nextTick(() => playChange(container, before, leaving, inSight))
}, { flush: 'pre' })

const MOVE_MS = 150

/**
 * @param {HTMLElement} container
 * @param {Map<string, { left: number, top: number }>} before
 * @param {{ ghost: HTMLElement, position: { left: number, top: number, width: number, height: number }, opacity: string }[]} leaving
 * @param {(el: HTMLElement) => boolean} inSight
 */
function playChange(container, before, leaving, inSight) {
  // The ones leaving stand in where they were, as copies, and fade
  for (const { ghost, position, opacity } of leaving) {
    ghost.classList.add('leavingChannel')
    ghost.removeAttribute('data-channel-id')
    Object.assign(ghost.style, {
      left: `${position.left}px`,
      top: `${position.top}px`,
      width: `${position.width}px`,
      height: `${position.height}px`,
      opacity
    })
    container.appendChild(ghost)
    setTimeout(() => ghost.remove(), MOVE_MS + 50)
  }

  // Reads first, all of them, then the writes
  const moves = []
  const arriving = []

  for (const el of container.querySelectorAll(':scope > [data-channel-id]')) {
    const was = before.get(el.dataset.channelId)

    if (was === undefined) {
      if (inSight(el)) { arriving.push(el) }
      continue
    }

    const dx = was.left - el.offsetLeft
    const dy = was.top - el.offsetTop

    if (dx !== 0 || dy !== 0) {
      moves.push({ el, dx, dy })
    }
  }

  for (const { el, dx, dy } of moves) {
    el.style.transition = 'none'
    el.style.transform = `translate(${dx}px, ${dy}px)`
  }

  for (const el of arriving) {
    el.classList.add('arrivingChannel')
    setTimeout(() => el.classList.remove('arrivingChannel'), MOVE_MS * 2)
  }

  // One layout for the lot, with every channel back where it was
  forceLayout(container)

  for (const { el } of moves) {
    el.style.transition = `transform ${MOVE_MS}ms ease`
    el.style.transform = ''
    setTimeout(() => { el.style.transition = '' }, MOVE_MS)
  }

  for (const { ghost } of leaving) {
    ghost.style.opacity = '0'
  }
}

/**
 * @param {HTMLElement} el
 * @returns {number}
 */
function forceLayout(el) {
  return el.offsetHeight
}

/**
 * @param {boolean} isVisible
 */
function drawMore(isVisible) {
  if (isVisible) {
    drawLimit.value += NEXT_BATCH
  }
}
</script>

<style scoped src="./ChannelsOverviewColumn.css" />
