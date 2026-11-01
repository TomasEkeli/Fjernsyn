<template>
  <div
    v-if="votes !== null"
    class="collectionsVoteBadge"
    :class="{ dismissed }"
    @pointerenter="onPointerEnter"
    @mouseleave="onPointerLeave"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
    @keydown.esc="onEscape"
  >
    <button
      ref="button"
      type="button"
      class="votes"
      :aria-label="t('Collections.Vote Badge.Votes Label', { votes: formattedVotes })"
      :aria-describedby="popoverId"
      :aria-expanded="sourceId === null ? undefined : String(shown)"
    >
      <I18nT
        keypath="Collections.Vote Badge.Votes"
        scope="global"
      >
        <template #arrow>
          <span aria-hidden="true">{{ t('Collections.Vote Badge.Arrow') }}</span>
        </template>
        <template #votes>
          <span>{{ formattedVotes }}</span>
        </template>
      </I18nT>
    </button>
    <!-- Always there, empty until first opened, so that aria-describedby
         resolves while a wall of cards renders no popover it has not shown -->
    <div
      :id="popoverId"
      class="popover"
      :role="sourceId === null ? 'tooltip' : undefined"
    >
      <ul
        v-if="opened && sourceId === null"
        class="sources"
      >
        <li
          v-for="row in sourceRows"
          :key="row.sourceId"
          class="source"
        >
          <span class="sourceName">{{ row.name }}</span>
          <I18nT
            v-if="row.votes !== null"
            keypath="Collections.Vote Badge.Votes"
            tag="span"
            class="sourceVotes"
            scope="global"
          >
            <template #arrow>
              <span aria-hidden="true">{{ t('Collections.Vote Badge.Arrow') }}</span>
            </template>
            <template #votes>
              <span>{{ format(row.votes) }}</span>
            </template>
          </I18nT>
        </li>
      </ul>
      <template v-else-if="opened && context !== null">
        <!-- The why is the source's own text: interpolated, never read as HTML -->
        <p
          v-if="context.why !== null"
          class="why"
        >
          {{ context.why }}
        </p>
        <p class="facts">
          <I18nT
            v-if="context.votes !== null"
            keypath="Collections.Vote Badge.Votes"
            tag="span"
            class="shareVotes"
            scope="global"
          >
            <template #arrow>
              <span aria-hidden="true">{{ t('Collections.Vote Badge.Arrow') }}</span>
            </template>
            <template #votes>
              <span>{{ format(context.votes) }}</span>
            </template>
          </I18nT>
          <span
            v-if="dateText !== ''"
            class="shareDate"
          >{{ t('Collections.Vote Badge.Shared', { date: dateText }) }}</span>
        </p>
        <!-- Text alone in the link: App.vue opens an external link by the
             click's target being the <a> itself -->
        <a
          v-if="link !== null"
          class="discussion"
          :href="link"
        >{{ t('Collections.Vote Badge.Discussion') }}</a>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, useId, useTemplateRef } from 'vue'
import { Translation as I18nT, useI18n } from 'vue-i18n'

import store from '../../store/index'

import {
  badgeVotes,
  discussionLink,
  formatVotes,
  shareContext,
  shareDateText,
  votesBySource,
} from '../../helpers/collections/voteBadge'

/**
 * The vote badge on a collections wall's card: the video's votes, summed over
 * the shares of the sources shown, the number the upvotes sort orders the wall
 * by, quietly at the top left of the thumbnail. Drawn by FtListVideo where the
 * wall provides it (helpers/thumbnailBadge.js); a video with no votes from the
 * shown sources has none.
 *
 * Hovering it, or focusing it from the keyboard, shows on Collections the
 * sources that shared the video and each one's votes, and nothing else; on a
 * source's page that source's own share: why it was shared, when, its votes,
 * and a link to the discussion, which opens as every external link does
 * (App.vue). Escape puts it away until the pointer or the focus leaves.
 *
 * What it says is worked out in helpers/collections/voteBadge.js.
 */

const props = defineProps({
  /** The card's video, a wall video with what its shares say under `collection` */
  video: {
    type: Object,
    required: true,
  },
  /** The source whose page the wall is; none on Collections */
  sourceId: {
    type: String,
    default: null,
  },
})

const { locale, t } = useI18n()

const popoverId = useId()

/** @type {import('vue').Ref<HTMLButtonElement | null>} */
const button = useTemplateRef('button')

/** Put away by Escape, until the pointer or the focus leaves */
const dismissed = ref(false)

/** Hovered or focused once: what it shows is only rendered from then on */
const opened = ref(false)

const hovered = ref(false)
const focused = ref(false)

/** Whether what hovering or focusing it shows is shown, for aria-expanded */
const shown = computed(() => (hovered.value || focused.value) && !dismissed.value)

function onPointerEnter() {
  opened.value = true
  hovered.value = true
}

function onPointerLeave() {
  hovered.value = false
  dismissed.value = false
}

function onFocusIn() {
  opened.value = true
  focused.value = true
}

/** @param {FocusEvent} event */
function onFocusOut(event) {
  if (!(event.currentTarget instanceof Node) || !event.currentTarget.contains(/** @type {Node | null} */ (event.relatedTarget))) {
    focused.value = false
    dismissed.value = false
  }
}

/**
 * Escape from the discussion link first takes the focus back to the badge, so
 * that putting the popover away does not hide the element that has the focus
 *
 * @param {KeyboardEvent} event
 */
function onEscape(event) {
  if (button.value !== null && event.target !== button.value) {
    button.value.focus()
  }
  dismissed.value = true
}

/** @type {import('vue').ComputedRef<string[]>} */
const locales = computed(() => [locale.value, 'en'])

/** @type {import('vue').ComputedRef<number | null>} */
const votes = computed(() => badgeVotes(props.video))

/**
 * @param {number} value
 * @returns {string}
 */
function format(value) {
  return formatVotes(value, locales.value)
}

/** @type {import('vue').ComputedRef<string>} */
const formattedVotes = computed(() => votes.value === null ? '' : format(votes.value))

const lookups = {
  sourceFor: (id) => store.getters.getCollectionSource(id),
  shareFor: (id) => store.getters.getCollectionShare(id),
}

/** Collections' hover: each source that shared it, with its votes */
const sourceRows = computed(() => props.sourceId === null ? votesBySource(props.video, lookups, locales.value) : [])

/** A source's page's hover: its share of the video */
const context = computed(() => props.sourceId === null ? null : shareContext(props.video, props.sourceId, lookups))

/** @type {import('vue').ComputedRef<string>} */
const dateText = computed(() => {
  return context.value === null ? '' : shareDateText(context.value.sharedAt, context.value.kind, locales.value)
})

/** @type {import('vue').ComputedRef<string | null>} */
const link = computed(() => context.value === null ? null : discussionLink(context.value.discussionUrl))
</script>

<style scoped src="./CollectionsVoteBadge.css" />
<style src="./CollectionsVoteBadgeCard.css" />
