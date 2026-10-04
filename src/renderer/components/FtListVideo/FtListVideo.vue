<template>
  <div
    class="ft-list-video ft-list-item"
    :class="{
      list: effectiveListTypeIsList,
      grid: !effectiveListTypeIsList,
      [appearance]: true,
      watched: addWatchedStyle,
      short: isShort
    }"
  >
    <div
      v-if="showGrabBar"
      class="grabBar"
      :class="{
        grabBarDisabled: !grabBarEnabled,
      }"
    >
      <FontAwesomeIcon
        :icon="['fas', 'fa-bars']"
      />
    </div>
    <div
      class="videoThumbnail"
      draggable="true"
      @dragstart="onDragStart"
    >
      <RouterLink
        class="thumbnailLink"
        tabindex="-1"
        :to="watchVideoRouterLink"
        @click="handleWatchPageLinkClick"
      >
        <img
          :src="thumbnail"
          class="thumbnailImage"
          :class="{ blur: blurThumbnails }"
          alt=""
          @error="onThumbnailError"
          @load="onThumbnailLoad"
        >
      </RouterLink>
      <div
        v-if="isLive || isUpcoming || isStation || (displayDuration !== '' && displayDuration !== '0:00')"
        class="videoDuration"
        :class="{
          live: (isLive || isStation ),
          upcoming: isUpcoming
        }"
      >
        <template v-if="isLive">
          <FontAwesomeIcon
            :icon="['fa', 'tower-broadcast']"
            class="liveIcon"
          />
          {{ isPremiere ? t("Video.Premiere") : t("Video.Live") }}
        </template>
        <template v-else-if="isUpcoming">
          {{ t("Video.Upcoming") }}
        </template>
        <template v-else-if="isStation">
          <FontAwesomeIcon
            :icon="['fa', 'tower-broadcast']"
            class="liveIcon"
          />
          {{ t("Video.Station") }}
        </template>
        <template v-else>
          {{ displayDuration }}
        </template>
      </div>
      <span
        class="playlistIcons"
        draggable="true"
        @dragstart="onDragStart"
      >
        <FtIconButton
          :title="markWatchedIconText"
          :icon="['fas', 'check']"
          class="markWatchedIcon"
          :theme="markWatchedIconTheme"
          :padding="playlistIconPadding"
          :size="playlistIconSize"
          @click="toggleWatched"
        />
        <FtIconButton
          v-if="showPlaylists"
          :title="t('User Playlists.Add to Playlist')"
          :icon="['fas', 'plus']"
          class="addToPlaylistIcon"
          :class="alwaysShowAddToPlaylistButton ? 'alwaysVisible' : ''"
          :padding="playlistIconPadding"
          :size="playlistIconSize"
          @click="togglePlaylistPrompt"
        />
        <FtIconButton
          v-if="isQuickBookmarkEnabled && quickBookmarkButtonEnabled"
          :title="quickBookmarkIconText"
          :icon="isInQuickBookmarkPlaylist ? ['fas', 'check'] : ['fas', 'bookmark']"
          class="quickBookmarkVideoIcon"
          :class="{
            bookmarked: isInQuickBookmarkPlaylist,
            alwaysVisible: alwaysShowAddToPlaylistButton,
          }"
          :theme="quickBookmarkIconTheme"
          :padding="playlistIconPadding"
          :size="playlistIconSize"
          @click="toggleQuickBookmarked"
        />
        <FtIconButton
          v-if="showLaterButton"
          :title="isInLater ? t('Later.Remove from Later') : t('Later.Add to Later')"
          :icon="isInLater ? ['fas', 'clock'] : ['far', 'clock']"
          class="laterIcon"
          :class="{ inLater: isInLater }"
          :theme="isInLater ? 'secondary' : 'base'"
          :padding="playlistIconPadding"
          :size="playlistIconSize"
          @click="toggleLater"
        />
        <FtIconButton
          v-if="showArmButton"
          :title="isArmed ? t('Later.Disarm') : t('Later.Arm')"
          :icon="isArmed ? ['fas', 'calendar-check'] : ['far', 'calendar-plus']"
          class="armIcon"
          :class="{ armed: isArmed }"
          :theme="isArmed ? 'secondary' : 'base'"
          :padding="playlistIconPadding"
          :size="playlistIconSize"
          @click="toggleArmed"
        />
        <FtIconButton
          v-if="canEditList && canMoveVideoUp"
          :title="t('User Playlists.Move Video Up')"
          :icon="effectiveListTypeIsList ? ['fas', 'arrow-up'] : ['fas', 'arrow-left']"
          class="upArrowIcon"
          :padding="playlistIconPadding"
          :size="playlistIconSize"
          @click="moveVideoUp"
        />
        <FtIconButton
          v-if="canEditList && canMoveVideoDown"
          :title="t('User Playlists.Move Video Down')"
          :icon="effectiveListTypeIsList ? ['fas', 'arrow-down'] : ['fas', 'arrow-right']"
          class="downArrowIcon"
          :padding="playlistIconPadding"
          :size="playlistIconSize"
          @click="moveVideoDown"
        />
        <FtIconButton
          v-if="canEditList && canRemoveFromPlaylist"
          :title="t('User Playlists.Remove from Playlist')"
          :icon="['fas', 'trash']"
          class="trashIcon"
          :padding="playlistIconPadding"
          :size="playlistIconSize"
          @click="removeFromPlaylist"
        />
      </span>
      <div
        v-if="addWatchedStyle"
        class="videoWatched"
      >
        {{ t("Video.Watched") }}
      </div>
      <div
        v-if="historyEntryExists"
        class="watchedProgressBar"
        :style="{ inlineSize: progressPercentage + '%' }"
      />
    </div>
    <div
      class="info"
      draggable="true"
      @dragstart="onDragStart"
    >
      <!--
        The marker shares the title's grid area rather than claiming a row of
        its own, so that the areas stay exactly as the shared card layout
        defines them: components that let a child auto-place into `.info`
        would have it land in a new row instead of where they left it.
      -->
      <div class="heading">
        <!-- The AI marker says how a video was made, not what kind it is, so
             it stands beside the kind marker rather than taking its place -->
        <div
          v-if="kind !== null || aiMark !== null"
          class="kindMarkers"
        >
          <FtKindMarker
            v-if="kind !== null"
            :kind="kind"
          />
          <FtKindMarker
            v-if="aiMark !== null"
            kind="ai"
            :title="aiMarkTooltip"
          />
        </div>
        <RouterLink
          class="title"
          :to="watchVideoRouterLink"
          @click="handleWatchPageLinkClick"
        >
          <h3
            class="h3Title"
            dir="auto"
          >
            {{ displayTitle }}
          </h3>
        </RouterLink>
      </div>
      <div class="infoLine">
        <component
          :is="disableChannelLinks ? 'span' : 'router-link'"
          v-if="channelId !== null"
          class="channelName"
          dir="auto"
          :to="platformCard?.channelRoute ?? `/channel/${channelId}`"
        >
          {{ channelName }}
        </component>
        <bdi v-else-if="channelName !== null">
          {{ channelName }}
        </bdi>
        <span
          v-if="!isLive && !isUpcoming && !isPremium && !isStation && !hideViews && viewCount != null"
          class="viewCount"
        >
          <template v-if="channelId !== null || channelName !== null"> • </template>
          {{ t('Global.Counts.View Count', { count: parsedViewCount }, viewCount) }}
        </span>
        <!--
          A live stream has no publish time worth showing: it is on now. A
          scheduled one does, and it is the whole point of the card, so an entry
          that is somehow both still shows when it starts — the same order of
          answers the kind marker gives.
        -->
        <span
          v-if="uploadedTime !== '' && (!isLive || isUpcoming) && !isStation"
          class="uploadedTime"
        > • {{ uploadedTime }}</span>
        <span
          v-if="(isLive || isStation) && !hideViews"
          class="viewCount"
        > • {{ t('Global.Counts.Watching Count', { count: parsedViewCount }, viewCount) }}</span>
      </div>
      <div
        v-if="is4k || hasCaptions || is8k || isNew || isVr180 || isVr360 || is3D"
        class="videoTagLine"
      >
        <div
          v-if="isNew"
          class="videoTag"
          :aria-label="t('Search Listing.Label.New')"
          role="img"
        >
          {{ t('Search Listing.Label.New') }}
        </div>
        <div
          v-if="is4k"
          class="videoTag"
          :aria-label="t('Search Listing.Label.4K')"
          role="img"
        >
          {{ t('Search Listing.Label.4K') }}
        </div>
        <div
          v-if="is8k"
          class="videoTag"
          :aria-label="t('Search Listing.Label.8K')"
          role="img"
        >
          {{ t('Search Listing.Label.8K') }}
        </div>
        <div
          v-if="isVr180"
          class="videoTag"
          :aria-label="t('Search Listing.Label.VR180')"
          role="img"
        >
          {{ t('Search Listing.Label.VR180') }}
        </div>
        <div
          v-if="isVr360"
          class="videoTag"
          :aria-label="t('Search Listing.Label.360 Video')"
          role="img"
        >
          {{ t('Search Listing.Label.360 Video') }}
        </div>
        <div
          v-if="is3D"
          class="videoTag"
          :aria-label="t('Search Listing.Label.3D')"
          role="img"
        >
          {{ t('Search Listing.Label.3D') }}
        </div>
        <div
          v-if="hasCaptions"
          class="videoTag"
          :aria-label="t('Search Listing.Label.Closed Captions')"
          role="img"
        >
          {{ t('Search Listing.Label.Subtitles') }}
        </div>
      </div>
      <div class="buttonStack">
        <FtIconButton
          class="optionsButton"
          :icon="['fas', 'ellipsis-v']"
          :title="t('Video.More Options')"
          theme="base-no-default"
          :size="16"
          :use-shadow="false"
          dropdown-position-x="left"
          :dropdown-options="dropdownOptions"
          @click="handleOptionsClick"
        />
        <button
          v-if="deArrowChangedContent || deArrowTogglePinned"
          :title="deArrowToggleTitle"
          class="optionsButton deArrowToggleButton"
          :class="{ alwaysVisible: deArrowTogglePinned }"
          @click="toggleDeArrow"
        >
          <FontAwesomeIcon
            class="deArrowToggleIcon"
            :icon="['far', 'dot-circle']"
          />
        </button>
      </div>
      <p
        v-if="showsDescriptionSlot"
        v-safer-html="descriptionSnippet"
        class="description"
        dir="auto"
      />
      <div
        v-if="effectiveListTypeIsList"
        class="restArea"
      >
        &nbsp;
      </div>
    </div>
  </div>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'

import FtIconButton from '../FtIconButton/FtIconButton.vue'
import FtKindMarker from '../FtKindMarker/FtKindMarker.vue'
import { vSaferHtml } from '../../directives/vSaferHtml.js'

import store from '../../store/index'

import {
  copyToClipboard,
  formatDurationAsTimestamp,
  formatNumber,
  formatScheduledTime,
  getRelativeTimeFromDate,
  openExternalLink,
  showToast,
  toDistractionFreeTitle,
  deepCopy,
  debounce
} from '../../helpers/utils.js'
import { deArrowData, deArrowThumbnail } from '../../helpers/sponsorblock.js'
import { wantAiVerdict } from '../../helpers/aiMarker/index.js'
import { aiMarkOf, isChannelMarkedAi, markChannelAi, unmarkChannelAi } from '../../helpers/aiShown.js'
import thumbnailPlaceholder from '../../assets/img/thumbnail_placeholder.svg'
import { cardShareOptions, describeCard, platformRecordFields, runCardShareOption } from '../../platform/cards'
import { subscriptionEntryIsUpcoming, subscriptionEntryScheduledAt } from '../../../subscriptionFeedMerge'

const props = defineProps({
  data: {
    type: Object,
    required: true
  },
  playlistId: {
    type: String,
    default: null
  },
  playlistType: {
    type: String,
    default: null
  },
  playlistItemId: {
    type: String,
    default: null
  },
  playlistIndex: {
    type: Number,
    default: null
  },
  playlistReverse: {
    type: Boolean,
    default: false
  },
  playlistShuffle: {
    type: Boolean,
    default: false
  },
  playlistLoop: {
    type: Boolean,
    default: false
  },
  forceListType: {
    type: String,
    default: null
  },
  appearance: {
    type: String,
    required: true
  },
  showVideoWithLastViewedPlaylist: {
    type: Boolean,
    default: false
  },
  alwaysShowAddToPlaylistButton: {
    type: Boolean,
    default: false,
  },
  quickBookmarkButtonEnabled: {
    type: Boolean,
    default: true,
  },
  canMoveVideoUp: {
    type: Boolean,
    default: false,
  },
  canMoveVideoDown: {
    type: Boolean,
    default: false,
  },
  canRemoveFromPlaylist: {
    type: Boolean,
    default: false,
  },
  layout: {
    type: String,
    default: 'list',
  },
  showGrabBar: {
    type: Boolean,
    default: false,
  },
  grabBarEnabled: {
    type: Boolean,
    default: false,
  },
  /**
   * Whether this card asks whether its video was made with AI, when it is not
   * known yet. Only the walls a viewer finds things on opt in (search,
   * subscriptions, a channel's pages and the related videos), and a card
   * mounts only once scrolled to, so only the cards on screen ask. Every
   * other card still shows the marker for a video already known.
   */
  lookUpAiLabel: {
    type: Boolean,
    default: false,
  },
  /**
   * A row of the Later page: ordered and removed as a playlist's rows are,
   * with no playlist behind it, and without the card's own Later buttons, as
   * the page has its own controls.
   */
  laterRow: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits([
  'move-video-down',
  'move-video-up',
  'move-video-to-the-top',
  'move-video-to-the-bottom',
  'pause-player',
  'remove-from-playlist'
])

const { locale, t } = useI18n()
const route = useRoute()

const id = ref('')
const title = ref('')
const channelName = ref(null)
const channelId = ref(null)
const viewCount = ref(0)
const parsedViewCount = ref('')
const uploadedTime = ref('')
const lengthSeconds = ref(0)
const duration = ref('')
const description = ref('')
const published = ref(undefined)
const isLive = ref(false)
const is4k = ref(false)
const is8k = ref(false)
const isNew = ref(false)
const isVr180 = ref(false)
const isVr360 = ref(false)
const is3D = ref(false)
const hasCaptions = ref(false)
const isUpcoming = ref(false)
const isStation = ref(false)
const isPremiere = ref(false)
const isPremium = ref(false)
const hideViews = ref(false)
const deArrowTogglePinned = ref(false)
const showDeArrowTitle = ref(false)
const showDeArrowThumbnail = ref(false)

const isShort = computed(() => props.data.type === 'shortVideo')

// Fjernsyn: a video of another platform (PeerTube) routes, thumbnails and shares as the platform layer says; null for YouTube
const platformCard = computed(() => describeCard(props.data, { query: watchPageLinkQuery.value }))

/**
 * The kind this card is marked as, or `null` when it is a plain video and so
 * carries no marker at all.
 *
 * A premiere is an upcoming thing before it is a live thing, and a short that
 * is somehow also live is a live stream first, so the order here is the order
 * of the answers.
 *
 * @type {import('vue').ComputedRef<'shorts' | 'live' | 'upcoming' | null>}
 */
const kind = computed(() => {
  if (isUpcoming.value) { return 'upcoming' }
  if (isLive.value) { return 'live' }
  if (isShort.value) { return 'shorts' }

  return null
})

/**
 * Why this card carries the AI marker, `declared` or `marked`, or `null` when
 * its video is not known to be made with AI (see helpers/aiShown.js).
 * Reactive to the verdicts, so the marker arrives when the lookup answers.
 *
 * @type {import('vue').ComputedRef<'declared' | 'marked' | null>}
 */
const aiMark = computed(() => aiMarkOf(props.data))

const aiMarkTooltip = computed(() => {
  return aiMark.value === 'marked'
    ? t('AI Marker.Marked')
    : t('AI Marker.Declared')
})

/** Called when the card goes, so a lookup nobody is waiting for is not made */
let releaseAiVerdict = () => {}

onMounted(() => {
  if (props.lookUpAiLabel) {
    releaseAiVerdict = wantAiVerdict(props.data)
  }
})

onBeforeUnmount(() => {
  releaseAiVerdict()
})

const historyEntry = computed(() => store.getters.getHistoryCacheById[id.value])

const historyEntryExists = computed(() => historyEntry.value !== undefined)

const watchProgress = computed(() => {
  if (!historyEntryExists.value || !watchedProgressSavingEnabled.value) {
    return 0
  }

  return historyEntry.value.watchProgress
})

/** @type {import('vue').ComputedRef<'grid' | 'list'>} */
const listType = computed(() => store.getters.getListType)

const effectiveListTypeIsList = computed(() => {
  return (listType.value === 'list' || props.forceListType === 'list') &&
    props.forceListType !== 'grid'
})

/**
 * The description this card shows, empty when it has none to show.
 *
 * A short is empty deliberately rather than by omission. The back-fill that
 * teaches an entry its description never runs for shorts, so on the
 * subscriptions feed a shorts card has nothing either way; showing one on the
 * surfaces where a backend happens to supply it would make the shorts that do
 * and the shorts that do not look like different kinds of thing.
 *
 * Read from the props rather than from the ref beside them, which is filled
 * once and never again: the whole point of reserving the space is that a
 * description can appear in a card that is already on screen, and it cannot do
 * that if the card stopped listening when it mounted.
 *
 * @type {import('vue').ComputedRef<string>}
 */
const descriptionSnippet = computed(() => {
  if (isShort.value) { return '' }

  return props.data.description ?? ''
})

/**
 * Whether the card carries a description slot at all.
 *
 * A list shows the snippet only when there is one, as it always has. A grid
 * card keeps the slot either way, empty when it has nothing: the description
 * arrives minutes after the card is on screen, and a card that grew at that
 * moment would push every card below it down the page. How tall the empty slot
 * is, and how it sits over the thumbnail, is decided in wall.css.
 *
 * The appearance keeps the slot away from the watch page's sidebar cards,
 * which is where the list rule has always kept the snippet too.
 *
 * @type {import('vue').ComputedRef<boolean>}
 */
const showsDescriptionSlot = computed(() => {
  if (props.appearance !== 'result') { return false }

  return !effectiveListTypeIsList.value || descriptionSnippet.value !== ''
})

/** @type {import('vue').ComputedRef<'' | 'start' | 'middle' | 'end' | 'hidden' | 'blur'>} */
const thumbnailPreference = computed(() => store.getters.getThumbnailPreference)

/** @type {import('vue').ComputedRef<boolean>} */
const blurThumbnails = computed(() => store.getters.getBlurThumbnails)

/** @type {import('vue').ComputedRef<'local' | 'invidious'>} */
const backendPreference = computed(() => store.getters.getBackendPreference)

/** @type {import('vue').ComputedRef<string>} */
const currentInvidiousInstanceUrl = computed(() => store.getters.getCurrentInvidiousInstanceUrl)

const showPlaylists = computed(() => !store.getters.getHidePlaylists)

const inHistory = computed(() => {
  // When in the history page, showing relative dates isn't very useful.
  // We want to show the exact date instead
  return route.name === 'history'
})

const inSubscriptions = computed(() => route.name === 'subscriptions' || route.name === 'default')

const inUserPlaylist = computed(() => playlistTypeFinal.value === 'user' || selectedUserPlaylist.value != null)

// The rows that can be moved and removed: a user playlist's, and the Later page's
const canEditList = computed(() => inUserPlaylist.value || props.laterRow)

/** @type {import('vue').ComputedRef<any>} */
const selectedUserPlaylist = computed(() => {
  if (playlistIdFinal.value == null || playlistIdFinal.value === '') { return null }

  return store.getters.getPlaylist(playlistIdFinal.value)
})

const progressPercentage = computed(() => {
  if (typeof lengthSeconds.value !== 'number' || lengthSeconds.value === 0) {
    return 0
  }

  const percentage = (Math.ceil(watchProgress.value) / lengthSeconds.value) * 100
  return Math.min(percentage, 100)
})

/** @type {import('vue').ComputedRef<any[]>} */
const hiddenChannels = computed(() => JSON.parse(store.getters.getChannelsHidden))

/** @type {import('vue').ComputedRef<boolean>} */
const useSponsorBlock = computed(() => store.getters.getUseSponsorBlock)

/** @type {import('vue').ComputedRef<any[]>} */
const sponsorBlockExcludedChannels = computed(() => JSON.parse(store.getters.getSponsorBlockExcludedChannels))

const playlistSharable = computed(() => {
  // `playlistId` can be undefined
  // User playlist ID should not be shared
  return playlistIdFinal.value && playlistIdFinal.value.length > 0 && !inUserPlaylist.value
})

/** @type {import('vue').ComputedRef<boolean>} */
const hideSharingActions = computed(() => store.getters.getHideSharingActions)

/** @type {import('vue').ComputedRef<boolean>} */
const showInvidiousShareOptions = computed(() => backendPreference.value === 'invidious' || store.getters.getBackendFallback)

const dropdownOptions = computed(() => {
  const options = [
    {
      label: historyEntryExists.value
        ? t('Video.Remove From History')
        : t('Video.Mark As Watched'),
      value: 'history'
    },
  ]
  if (canEditList.value) {
    if (props.canMoveVideoUp || props.canMoveVideoDown) {
      options.push({
        type: 'divider'
      })
    }
    if (props.canMoveVideoUp) {
      options.push({
        label: t('User Playlists.Move Video to the Top'),
        value: 'moveVideoTop'
      })
    }
    if (props.canMoveVideoDown) {
      options.push({
        label: t('User Playlists.Move Video to the Bottom'),
        value: 'moveVideoBottom'
      })
    }
  }
  if (!hideSharingActions.value && platformCard.value) {
    options.push(...cardShareOptions(platformCard.value, t))
  } else if (!hideSharingActions.value) {
    options.push(
      {
        type: 'divider'
      },
      {
        label: t('Video.Copy YouTube Link'),
        value: 'copyYoutube'
      },
      {
        label: t('Video.Copy YouTube Embedded Player Link'),
        value: 'copyYoutubeEmbed'
      },
      ...showInvidiousShareOptions.value
        ? [{
            label: t('Video.Copy Invidious Link'),
            value: 'copyInvidious'
          }]
        : [],
      {
        type: 'divider'
      },
      {
        label: t('Video.Open in YouTube'),
        value: 'openYoutube'
      },
      {
        label: t('Video.Open YouTube Embedded Player'),
        value: 'openYoutubeEmbed'
      },
      ...showInvidiousShareOptions.value
        ? [{
            label: t('Video.Open in Invidious'),
            value: 'openInvidious'
          }]
        : [],
    )
    if (channelId.value !== null) {
      options.push(
        {
          type: 'divider'
        },
        {
          label: t('Video.Copy YouTube Channel Link'),
          value: 'copyYoutubeChannel'
        },
        ...showInvidiousShareOptions.value
          ? [{
              label: t('Video.Copy Invidious Channel Link'),
              value: 'copyInvidiousChannel'
            }]
          : [],
        {
          type: 'divider'
        },
        {
          label: t('Video.Open Channel in YouTube'),
          value: 'openYoutubeChannel'
        },
        ...showInvidiousShareOptions.value
          ? [{
              label: t('Video.Open Channel in Invidious'),
              value: 'openInvidiousChannel'
            }]
          : [],
      )
    }
  }

  if (channelId.value !== null) {
    if (!inSubscriptions.value) {
      const channelShouldBeHidden = hiddenChannels.value.some(c => c.name === channelId.value)

      options.push(
        {
          type: 'divider'
        },

        channelShouldBeHidden
          ? {
              label: t('Video.Unhide Channel'),
              value: 'unhideChannel'
            }
          : {
              label: t('Video.Hide Channel'),
              value: 'hideChannel'
            }
      )
    }

    // Any YouTube channel, subscribed to or not: whether a channel's videos
    // are made with AI is not a question of whether it is followed
    if (!platformCard.value) {
      options.push(
        {
          type: 'divider'
        },

        isChannelMarkedAi(channelId.value)
          ? {
              label: t('Video.Unmark Channel as AI'),
              value: 'unmarkChannelAi'
            }
          : {
              label: t('Video.Mark Channel as AI'),
              value: 'markChannelAi'
            }
      )
    }

    if (useSponsorBlock.value && !platformCard.value) {
      const isSponsorBlockChannelExcluded = sponsorBlockExcludedChannels.value.some(c => c.name === channelId.value)

      options.push(
        {
          type: 'divider'
        },

        isSponsorBlockChannelExcluded
          ? {
              label: t('SponsorBlock.Resume Skipping On This Channel'),
              value: 'enableSponsorBlockOnChannel'
            }
          : {
              label: t('SponsorBlock.Never Skip On This Channel'),
              value: 'disableSponsorBlockOnChannel'
            }
      )
    }
  }

  return options
})

function getYoutubeEmbedUrl() {
  return `https://www.youtube-nocookie.com/embed/${id.value}`
}

function getYoutubeChannelUrl() {
  return `https://youtube.com/channel/${channelId.value}`
}

function getInvidiousUrl() {
  const videoUrl = `${currentInvidiousInstanceUrl.value}/watch?v=${id.value}`
  // `playlistId` can be undefined
  if (playlistSharable.value) {
    // `index` seems can be ignored
    return videoUrl + `&list=${playlistIdFinal.value}`
  }
  return videoUrl
}

function getInvidiousChannelUrl() {
  return `${currentInvidiousInstanceUrl.value}/channel/${channelId.value}`
}

/**
 * @param {string} option
 */
function handleOptionsClick(option) {
  if (platformCard.value && runCardShareOption(option, platformCard.value, t)) { return }

  switch (option) {
    case 'history':
      if (historyEntryExists.value) {
        removeFromWatched()
      } else {
        markAsWatched()
      }
      break
    case 'moveVideoTop':
      moveVideoToTheTop()
      break
    case 'moveVideoBottom':
      moveVideoToTheBottom()
      break
    case 'copyYoutube': {
      let videoUrl = `https://youtu.be/${id.value}`

      if (playlistSharable.value) {
        // `index` seems can be ignored
        videoUrl += `?list=${playlistIdFinal.value}`
      }

      copyToClipboard(videoUrl, { messageOnSuccess: t('Share.YouTube URL copied to clipboard') })
      break
    }
    case 'openYoutube': {
      let videoUrl = `https://www.youtube.com/watch?v=${id.value}`

      if (playlistSharable.value) {
        // `index` seems can be ignored
        videoUrl += `&list=${playlistIdFinal.value}`
      }

      openExternalLink(videoUrl)
      break
    }
    case 'copyYoutubeEmbed':
      copyToClipboard(getYoutubeEmbedUrl(), { messageOnSuccess: t('Share.YouTube Embed URL copied to clipboard') })
      break
    case 'openYoutubeEmbed':
      openExternalLink(getYoutubeEmbedUrl())
      break
    case 'copyInvidious':
      copyToClipboard(getInvidiousUrl(), { messageOnSuccess: t('Share.Invidious URL copied to clipboard') })
      break
    case 'openInvidious':
      openExternalLink(getInvidiousUrl())
      break
    case 'copyYoutubeChannel':
      copyToClipboard(getYoutubeChannelUrl(), { messageOnSuccess: t('Share.YouTube Channel URL copied to clipboard') })
      break
    case 'openYoutubeChannel':
      openExternalLink(getYoutubeChannelUrl())
      break
    case 'copyInvidiousChannel':
      copyToClipboard(getInvidiousChannelUrl(), { messageOnSuccess: t('Share.Invidious Channel URL copied to clipboard') })
      break
    case 'openInvidiousChannel':
      openExternalLink(getInvidiousChannelUrl())
      break
    case 'hideChannel':
      hideChannel(channelName.value, channelId.value)
      break
    case 'unhideChannel':
      unhideChannel(channelName.value, channelId.value)
      break
    case 'markChannelAi':
      markChannelAi(channelId.value, channelName.value)
      showToast(t('Channel Marked as AI', { channel: channelName.value }))
      break
    case 'unmarkChannelAi':
      unmarkChannelAi(channelId.value)
      showToast(t('Channel Unmarked as AI', { channel: channelName.value }))
      break
    case 'disableSponsorBlockOnChannel':
      disableSponsorBlockOnChannel(channelName.value, channelId.value)
      break
    case 'enableSponsorBlockOnChannel':
      enableSponsorBlockOnChannel(channelName.value, channelId.value)
      break
  }
}

/**
 * Whether this card is big enough to be worth the large thumbnail.
 *
 * A grid column stretches, so a card is not the wall's 610px minimum but
 * anything up to twice that and more, the page chrome gone, and a 320px image
 * spread over it is the soft, blocky thing it looks like. A list card's
 * thumbnail is 336px, which the small one fits.
 *
 * @type {import('vue').ComputedRef<boolean>}
 */
const wantsLargeThumbnail = computed(() => !effectiveListTypeIsList.value)

/**
 * Set when the large thumbnail did not arrive, so that the card can ask for
 * the small one instead.
 *
 * A video uploaded below 720p has no 1280px thumbnail — three of sixty in a
 * sample of a real subscription feed — and there is nothing to ask beforehand:
 * requesting it is the only way to find out. The card only ever holds one
 * video, so the answer holds for as long as the card does.
 */
const largeThumbnailMissing = ref(false)

/** Whether the URL the card is currently showing is the large thumbnail. */
const largeThumbnailRequested = computed(() => {
  if (thumbnailPreference.value === 'hidden') { return false }

  if (showDeArrowThumbnail.value && deArrowCache.value?.thumbnail != null) {
    return false
  }

  return wantsLargeThumbnail.value && !largeThumbnailMissing.value
})

/**
 * A missing large thumbnail does not fail, which is why this reads the size.
 *
 * Asked for a thumbnail a video has not got, i.ytimg.com answers 404 and sends
 * a 120x90 grey placeholder in the body anyway. A browser renders a 404 that
 * carries a decodable image, so the picture loads, no error is raised, and the
 * card stretches a 120px placeholder across 900px of column. The size it came
 * back at is the only honest answer: the real one is 1280 wide.
 *
 * @param {Event} event
 */
function onThumbnailLoad(event) {
  if (!largeThumbnailRequested.value) { return }

  if (event.target.naturalWidth < 640) {
    largeThumbnailMissing.value = true
  }
}

function onThumbnailError() {
  largeThumbnailMissing.value = true
}

const thumbnail = computed(() => {
  if (thumbnailPreference.value === 'hidden') {
    return thumbnailPlaceholder
  }

  if (platformCard.value) { return platformCard.value.thumbnail ?? thumbnailPlaceholder }

  if (showDeArrowThumbnail.value && deArrowCache.value?.thumbnail != null) {
    return deArrowCache.value.thumbnail
  }

  let baseUrl
  if (backendPreference.value === 'invidious') {
    baseUrl = currentInvidiousInstanceUrl.value
  } else {
    baseUrl = 'https://i.ytimg.com'
  }

  // The same four frames at two sizes: mq* is 320px wide, hq720* is 1280px.
  const large = largeThumbnailRequested.value

  switch (thumbnailPreference.value) {
    case 'start':
      return `${baseUrl}/vi/${id.value}/${large ? 'hq720_1' : 'mq1'}.jpg`
    case 'middle':
      return `${baseUrl}/vi/${id.value}/${large ? 'hq720_2' : 'mq2'}.jpg`
    case 'end':
      return `${baseUrl}/vi/${id.value}/${large ? 'hq720_3' : 'mq3'}.jpg`
    default:
      return `${baseUrl}/vi/${id.value}/${large ? 'hq720' : 'mqdefault'}.jpg`
  }
})

/** @type {import('vue').ComputedRef<boolean>} */
const hideVideoViews = computed(() => store.getters.getHideVideoViews)

const addWatchedStyle = computed(() => historyEntryExists.value && !inHistory.value)

/** @type {import('vue').ComputedRef<string>} */
const externalPlayer = computed(() => store.getters.getExternalPlayer)

/** @type {import('vue').ComputedRef<boolean>} */
const externalPlayerIsDefaultViewingMode = computed(() => {
  return process.env.IS_ELECTRON && externalPlayer.value !== '' && store.getters.getDefaultViewingMode === 'external_player'
})

/** @type {import('vue').ComputedRef<number>} */
const defaultPlayback = computed(() => store.getters.getDefaultPlayback)

const watchedProgressSavingEnabled = computed(() => {
  return ['auto', 'semi-auto'].includes(store.getters.getWatchedProgressSavingMode)
})

/** @type {import('vue').ComputedRef<boolean>} */
const rememberHistory = computed(() => store.getters.getRememberHistory)

/** @type {import('vue').ComputedRef<boolean>} */
const saveVideoHistoryWithLastViewedPlaylist = computed(() => store.getters.getSaveVideoHistoryWithLastViewedPlaylist)

/** @type {import('vue').ComputedRef<boolean>} */
const showDistractionFreeTitles = computed(() => store.getters.getShowDistractionFreeTitles)

/** @type {import('vue').ComputedRef<string>} */
const displayTitle = computed(() => {
  let title_
  if (showDeArrowTitle.value && deArrowCache.value?.title) {
    title_ = deArrowCache.value.title
  } else {
    title_ = title.value
  }

  if (showDistractionFreeTitles.value) {
    return toDistractionFreeTitle(title_)
  } else {
    return title_
  }
})

const displayDuration = computed(() => {
  if (useDeArrowTitles.value && (duration.value === '' || duration.value === '0:00') && deArrowCache.value?.videoDuration) {
    return formatDurationAsTimestamp(deArrowCache.value.videoDuration)
  }

  return duration.value
})

/** @type {import('vue').ComputedRef<{ playlistId: string | undefined, playlistType: string | undefined, playlistItemId: string | undefined } | undefined>} */
const playlistIdTypePairFinal = computed(() => {
  if (props.playlistId) {
    return {
      playlistId: props.playlistId,
      playlistType: props.playlistType,
      playlistItemId: props.playlistItemId,
    }
  }

  // Get playlist ID from history ONLY if option enabled
  if (!props.showVideoWithLastViewedPlaylist || !saveVideoHistoryWithLastViewedPlaylist.value) {
    return
  }

  return {
    playlistId: historyEntry.value?.lastViewedPlaylistId,
    playlistType: historyEntry.value?.lastViewedPlaylistType,
    playlistItemId: historyEntry.value?.lastViewedPlaylistItemId,
  }
})

const playlistIdFinal = computed(() => playlistIdTypePairFinal.value?.playlistId)
const playlistTypeFinal = computed(() => playlistIdTypePairFinal.value?.playlistType)
const playlistItemIdFinal = computed(() => playlistIdTypePairFinal.value?.playlistItemId)

const quickBookmarkPlaylist = computed(() => store.getters.getQuickBookmarkPlaylist)

const isQuickBookmarkEnabled = computed(() => quickBookmarkPlaylist.value != null)

/** @type {import('vue').ComputedRef<boolean>} */
const isInQuickBookmarkPlaylist = computed(() => {
  if (!isQuickBookmarkEnabled.value) { return false }

  // Accessing a ref has a negligible amount of overhead,
  // however as we know that some users have playlists that have more than 10k items in them
  // it adds up quickly, especially as there are usually lots of FtListVideo instances active at the same time.
  // So create a temporary variable outside of the array, so we only have to do it once.
  // Also the search is retriggered every time any playlist is modified.
  const id_ = id.value

  return quickBookmarkPlaylist.value.videos.some((video) => {
    return video.videoId === id_
  })
})

const quickBookmarkIconText = computed(() => {
  if (!isQuickBookmarkEnabled.value) { return '' }

  const translationProperties = {
    playlistName: quickBookmarkPlaylist.value.playlistName,
  }

  return isInQuickBookmarkPlaylist.value
    ? t('User Playlists.Remove from Favorites', translationProperties)
    : t('User Playlists.Add to Favorites', translationProperties)
})

const quickBookmarkIconTheme = computed(() => isInQuickBookmarkPlaylist.value ? 'base favorite' : 'base')

const markWatchedIconText = computed(() => {
  return historyEntryExists.value
    ? t('Video.Remove From History')
    : t('Video.Mark As Watched')
})

// A watched card is already dimmed and badged, so the filled state is here to
// say what the click will undo, not to announce that the video was watched.
const markWatchedIconTheme = computed(() => historyEntryExists.value ? 'primary' : 'base')

const playlistIconPadding = computed(() => props.appearance === 'watchPlaylistItem' ? 5 : 6)
const playlistIconSize = computed(() => props.appearance === 'watchPlaylistItem' ? 14 : 18)

const watchPageLinkQuery = computed(() => {
  const query = {}

  if (playlistIdFinal.value) {
    query.playlistId = playlistIdFinal.value
  }

  if (playlistTypeFinal.value) {
    query.playlistType = playlistTypeFinal.value
  }

  if (playlistItemIdFinal.value) {
    query.playlistItemId = playlistItemIdFinal.value
  }

  return query
})

const watchVideoRouterLink = computed(() => {
  // For `router-link` attribute `to`
  if (!externalPlayerIsDefaultViewingMode.value) {
    if (platformCard.value?.route) { return platformCard.value.route }

    return {
      path: `/watch/${id.value}`,
      query: watchPageLinkQuery.value,
    }
  } else {
    return {}
  }
})

/** @type {import('vue').ComputedRef<boolean>} */
const useDeArrowTitles = computed(() => store.getters.getUseDeArrowTitles)

/** @type {import('vue').ComputedRef<boolean>} */
const useDeArrowThumbnails = computed(() => store.getters.getUseDeArrowThumbnails)

const deArrowChangedContent = computed(() => {
  return (useDeArrowThumbnails.value && deArrowCache.value?.thumbnail) ||
      (useDeArrowTitles.value && deArrowCache.value?.title &&
        props.data.title.localeCompare(deArrowCache.value.title, undefined, { sensitivity: 'accent' }) !== 0)
})

const deArrowToggleTitle = computed(() => {
  return deArrowTogglePinned.value
    ? t('Video.DeArrow.Show Modified Details')
    : t('Video.DeArrow.Show Original Details')
})

const deArrowCache = computed(() => store.getters.getDeArrowCache[id.value])

const disableChannelLinks = computed(() => store.getters.getDisableChannelLinks)

function handleWatchPageLinkClick() {
  if (externalPlayerIsDefaultViewingMode.value) {
    handleExternalPlayer()
  }
}

async function fetchDeArrowThumbnail() {
  if (thumbnailPreference.value === 'hidden') { return }

  const videoId = id.value
  const thumbnail = await deArrowThumbnail(videoId, deArrowCache.value.thumbnailTimestamp)

  if (thumbnail) {
    const deArrowCacheClone = deepCopy(deArrowCache.value)
    deArrowCacheClone.thumbnail = thumbnail
    store.commit('addThumbnailToDeArrowCache', deArrowCacheClone)
  }
}

const debounceGetDeArrowThumbnail = debounce(fetchDeArrowThumbnail, 1000)

async function fetchDeArrowData() {
  const videoId = id.value
  const cacheData = { videoId, title: null, videoDuration: null, thumbnail: null, thumbnailTimestamp: null }

  const data = await deArrowData(videoId)

  if (Array.isArray(data?.titles) && data.titles.length > 0 && (data.titles[0].locked || data.titles[0].votes >= 0)) {
    // remove dearrow formatting markers https://github.com/ajayyy/DeArrow/blob/0da266485be902fe54259214c3cd7c942f2357c5/src/titles/titleFormatter.ts#L460
    cacheData.title = data.titles[0].title.replaceAll(/(^|\s)>(\S)/g, '$1$2').trim()
  }

  if (Array.isArray(data?.thumbnails) && data.thumbnails.length > 0 && (data.thumbnails[0].locked || data.thumbnails[0].votes >= 0)) {
    cacheData.thumbnailTimestamp = data.thumbnails[0].timestamp
  } else if (data?.videoDuration != null) {
    cacheData.thumbnailTimestamp = data.videoDuration * data.randomTime
  }

  cacheData.videoDuration = data?.videoDuration ? Math.floor(data.videoDuration) : null

  // Save data to cache whether data available or not to prevent duplicate requests
  store.commit('addVideoToDeArrowCache', cacheData)

  // fetch dearrow thumbnails if enabled
  if (showDeArrowThumbnail.value && deArrowCache.value?.thumbnail === null) {
    debounceGetDeArrowThumbnail()
  }
}

function toggleDeArrow() {
  if (!deArrowChangedContent.value) {
    return
  }

  deArrowTogglePinned.value = !deArrowTogglePinned.value

  if (useDeArrowTitles.value) {
    showDeArrowTitle.value = !showDeArrowTitle.value
  }

  if (useDeArrowThumbnails.value) {
    showDeArrowThumbnail.value = !showDeArrowThumbnail.value
  }
}

function handleExternalPlayer() {
  emit('pause-player')

  const payload = {
    videoId: id.value,
    playlistId: playlistIdFinal.value,
    startTime: watchProgress.value,
    playbackRate: defaultPlayback.value,
    playlistIndex: props.playlistIndex,
    playlistReverse: props.playlistReverse,
    playlistShuffle: props.playlistShuffle,
    playlistLoop: props.playlistLoop,
  }
  // Only play video in non playlist mode when user playlist detected
  if (inUserPlaylist.value || platformCard.value) {
    Object.assign(payload, {
      playlistId: null,
      playlistIndex: null,
      playlistReverse: null,
      playlistShuffle: null,
      playlistLoop: null,
    })
  }

  if (platformCard.value) { payload.videoUrl = platformCard.value.externalPlayerUrl }

  if (process.env.IS_ELECTRON) {
    window.ftElectron.openInExternalPlayer(payload)
  }

  if (rememberHistory.value) {
    markAsWatched()
  }
}

function parseVideoData() {
  id.value = props.data.videoId
  title.value = props.data.title

  channelName.value = props.data.author ?? null
  channelId.value = props.data.authorId ?? null

  if ((props.data.lengthSeconds === '' || props.data.lengthSeconds === '0:00') && historyEntryExists.value) {
    lengthSeconds.value = historyEntry.value.lengthSeconds
    duration.value = formatDurationAsTimestamp(historyEntry.value.lengthSeconds)
  } else {
    lengthSeconds.value = props.data.lengthSeconds
    duration.value = formatDurationAsTimestamp(props.data.lengthSeconds)
  }

  description.value = props.data.description
  isStation.value = props.data.isStation === true
  isPremiere.value = props.data.isPremiere === true
  isLive.value = !isStation.value && (props.data.liveNow || props.data.lengthSeconds === undefined)
  isUpcoming.value = props.data.isUpcoming || props.data.premiere
  is4k.value = props.data.is4k
  is8k.value = props.data.is8k
  isNew.value = props.data.isNew
  isVr180.value = props.data.isVr180
  isVr360.value = props.data.isVr360
  is3D.value = props.data.is3d
  hasCaptions.value = props.data.hasCaptions
  isPremium.value = props.data.premium || false
  viewCount.value = props.data.viewCount

  // A scheduled thing states its time and says how far off it is beside it,
  // where a published one says how long ago and nothing else. The difference is
  // that the past is over: "3 days ago" cannot become wrong, and "in 3 days"
  // does, on a card that reads its props once and never ticks. See
  // `formatScheduledTime`.
  if (props.data.premiereDate !== undefined) {
    let premiereDate = props.data.premiereDate

    // premiereDate will be a string when the subscriptions are restored from the cache
    if (typeof premiereDate === 'string') {
      premiereDate = new Date(premiereDate)
    }
    published.value = premiereDate.getTime()
    uploadedTime.value = formatScheduledTime(published.value)
  } else if (props.data.premiereTimestamp !== undefined) {
    published.value = props.data.premiereTimestamp * 1000
    uploadedTime.value = formatScheduledTime(published.value)
  } else if (typeof props.data.published === 'number' && !isLive.value && !isStation.value) {
    published.value = props.data.published

    if (inHistory.value) {
      uploadedTime.value = new Date(props.data.published).toLocaleDateString([locale.value, 'en'])
    } else {
      // Use 30 days per month, just like calculatePublishedDate
      uploadedTime.value = getRelativeTimeFromDate(props.data.published, false)
    }
  }

  if (hideVideoViews.value) {
    hideViews.value = true
  } else if (props.data.viewCount !== undefined && props.data.viewCount !== null) {
    parsedViewCount.value = formatNumber(props.data.viewCount)
  } else if (props.data.viewCountText !== undefined) {
    parsedViewCount.value = props.data.viewCountText.replace(' views', '')
  } else {
    hideViews.value = true
  }
}

function markAsWatched() {
  const videoData = {
    videoId: id.value,
    title: title.value,
    author: channelName.value,
    authorId: channelId.value,
    published: published.value,
    description: description.value,
    viewCount: viewCount.value,
    lengthSeconds: props.data.lengthSeconds,
    watchProgress: 0,
    timeWatched: Date.now(),
    isLive: false,
    isStation: false,
    isPremiere: false,
    type: 'video',
    // Fjernsyn: a PeerTube record keeps its platform, host and thumbnail, and a plain-text description; nothing for YouTube
    ...platformRecordFields(props.data, { description: description.value }),
  }

  store.dispatch('updateHistory', videoData)

  if (!historyEntryExists.value) {
    showToast(t('Video.Video has been marked as watched'))
  }
}

function removeFromWatched() {
  store.dispatch('removeFromHistory', id.value)

  showToast(t('Video.Video has been removed from your history'))
}

function toggleWatched() {
  if (historyEntryExists.value) {
    removeFromWatched()
  } else {
    markAsWatched()
  }
}

function moveVideoToTheTop() {
  emit('move-video-to-the-top', id.value, props.playlistItemId)
}

function moveVideoToTheBottom() {
  emit('move-video-to-the-bottom', id.value, props.playlistItemId)
}

function togglePlaylistPrompt() {
  const videoData = {
    videoId: id.value,
    title: title.value,
    author: channelName.value,
    authorId: channelId.value,
    description: description.value,
    viewCount: viewCount.value,
    lengthSeconds: props.data.lengthSeconds,
    published: published.value,
    premiereDate: props.data.premiereDate,
    premiereTimestamp: props.data.premiereTimestamp,
    ...platformRecordFields(props.data, { description: description.value }), // Fjernsyn: as in markAsWatched
  }

  store.dispatch('showAddToPlaylistPromptForManyVideos', { videos: [videoData] })
}

/**
 * @param {string} channelName
 * @param {string} channelId
 */
function hideChannel(channelName, channelId) {
  const newHiddenChannels = [...hiddenChannels.value, { name: channelId, preferredName: channelName }]

  store.dispatch('updateChannelsHidden', JSON.stringify(newHiddenChannels))

  showToast(t('Channel Hidden', { channel: channelName }))
}

/**
 * @param {string} channelName
 * @param {string} channelId
 */
function unhideChannel(channelName, channelId) {
  store.dispatch('updateChannelsHidden', JSON.stringify(hiddenChannels.value.filter(c => c.name !== channelId)))

  showToast(t('Channel Unhidden', { channel: channelName }))
}

/**
 * @param {string} channelName
 * @param {string} channelId
 */
function disableSponsorBlockOnChannel(channelName, channelId) {
  const newExcludedChannels = [...sponsorBlockExcludedChannels.value, { name: channelId, preferredName: channelName }]

  store.dispatch('updateSponsorBlockExcludedChannels', JSON.stringify(newExcludedChannels))

  showToast(t('SponsorBlock.Segments Will Be Marked Only', { channel: channelName }))
}

/**
 * @param {string} channelName
 * @param {string} channelId
 */
function enableSponsorBlockOnChannel(channelName, channelId) {
  store.dispatch('updateSponsorBlockExcludedChannels', JSON.stringify(sponsorBlockExcludedChannels.value.filter(c => c.name !== channelId)))

  showToast(t('SponsorBlock.Segments Will Be Skipped Again', { channel: channelName }))
}

function toggleQuickBookmarked() {
  if (!isQuickBookmarkEnabled.value) {
    // This should be prevented by UI
    return
  }

  if (isInQuickBookmarkPlaylist.value) {
    removeFromQuickBookmarkPlaylist()
  } else {
    addToQuickBookmarkPlaylist()
  }
}

function addToQuickBookmarkPlaylist() {
  const videoData = {
    videoId: id.value,
    title: title.value,
    author: channelName.value,
    authorId: channelId.value,
    lengthSeconds: props.data.lengthSeconds,
    published: published.value,
    premiereDate: props.data.premiereDate,
    premiereTimestamp: props.data.premiereTimestamp,
    ...platformRecordFields(props.data), // Fjernsyn: as in markAsWatched
  }

  store.dispatch('addVideo', {
    _id: quickBookmarkPlaylist.value._id,
    videoData,
  })

  // TODO: Maybe show playlist name
  showToast(t('Video.Video has been saved'))
}

function removeFromQuickBookmarkPlaylist() {
  store.dispatch('removeVideo', {
    _id: quickBookmarkPlaylist.value._id,
    // Remove all playlist items with same videoId
    videoId: id.value,
  })

  // TODO: Maybe show playlist name
  showToast(t('Video.Video has been removed from your saved list'))
}

// The Later list: YouTube only, and not on the Later page's own rows
const isInLater = computed(() => store.getters.getIsInLater(id.value))
const isArmed = computed(() => store.getters.getIsArmed(id.value))

const showLaterButton = computed(() => !props.laterRow && !platformCard.value)

/** The stated start, when the card is upcoming and it is still ahead */
const armableAt = computed(() => {
  if (!subscriptionEntryIsUpcoming(props.data)) { return null }

  return subscriptionEntryScheduledAt(props.data)
})

const showArmButton = computed(() => showLaterButton.value && (isArmed.value || armableAt.value != null))

function laterVideoData() {
  return {
    videoId: id.value,
    title: title.value,
    author: channelName.value,
    authorId: channelId.value,
    lengthSeconds: props.data.lengthSeconds,
    published: published.value,
    isUpcoming: isUpcoming.value === true,
    premiereDate: props.data.premiereDate,
    premiereTimestamp: props.data.premiereTimestamp,
  }
}

function toggleLater() {
  if (isInLater.value) {
    store.dispatch('removeFromLater', id.value)
  } else {
    store.dispatch('addToLater', laterVideoData())
  }
}

function toggleArmed() {
  if (isArmed.value) {
    store.dispatch('disarm', id.value)
  } else if (armableAt.value != null) {
    store.dispatch('arm', { video: laterVideoData(), at: armableAt.value })
  }
}

function moveVideoUp() {
  emit('move-video-up', id.value, props.playlistItemId)
}

function moveVideoDown() {
  emit('move-video-down', id.value, props.playlistItemId)
}

function removeFromPlaylist() {
  emit('remove-from-playlist', id.value, props.playlistItemId)
}

/**
 * @param {DragEvent} event
 */
function onDragStart(event) {
  // Prevent drag event except links
  if (event.target.tagName !== 'A') {
    event.preventDefault()
    event.stopPropagation()
  }
}

parseVideoData()

showDeArrowTitle.value = useDeArrowTitles.value && !platformCard.value
showDeArrowThumbnail.value = useDeArrowThumbnails.value && !platformCard.value

if ((showDeArrowTitle.value || showDeArrowThumbnail.value) && !deArrowCache.value) {
  fetchDeArrowData()
}

if (showDeArrowThumbnail.value && deArrowCache.value && deArrowCache.value.thumbnail == null) {
  debounceGetDeArrowThumbnail()
}
</script>

<style scoped src="./FtListVideo.scss" lang="scss" />
