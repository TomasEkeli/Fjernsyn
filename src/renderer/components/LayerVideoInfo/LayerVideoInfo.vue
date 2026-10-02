<template>
  <FtCard class="layerVideoInfo">
    <div>
      <h1
        class="videoTitle"
        dir="auto"
      >
        {{ video.title }}
      </h1>
      <!-- As WatchVideoInfo's; YouTube only, as PeerTube's details carry no `isUnlisted` -->
      <div
        v-if="video.isUnlisted"
        class="unlistedBadge"
      >
        {{ t('Video.Unlisted') }}
      </div>
    </div>
    <div class="videoMetrics">
      <div class="datePublishedAndViewCount">
        <template v-if="dateText">
          {{ publishedLabel }} {{ dateText }}
        </template>
        <template v-if="viewCountText">
          <span
            v-if="dateText"
            class="seperator"
          >• </span><span class="videoViews">{{ viewCountText }}</span>
        </template>
      </div>
      <div
        v-if="!hideVideoLikesAndDislikes && (video.likeCount != null || video.dislikeCount != null)"
        class="likeSection"
      >
        <span
          v-if="video.likeCount != null"
          class="likeCount"
          :title="t('PeerTube.Watch.Likes', { count: formatNumber(video.likeCount) }, video.likeCount)"
        >
          <FontAwesomeIcon :icon="['fas', 'thumbs-up']" /> {{ formatNumber(video.likeCount) }}
        </span>
        <span
          v-if="video.dislikeCount != null"
          class="likeCount"
          :title="t('PeerTube.Watch.Dislikes', { count: formatNumber(video.dislikeCount) }, video.dislikeCount)"
        >
          <FontAwesomeIcon :icon="['fas', 'thumbs-down']" /> {{ formatNumber(video.dislikeCount) }}
        </span>
      </div>
    </div>
    <div class="videoButtons">
      <div
        v-if="!hideUploader"
        class="profileRow"
      >
        <component
          :is="channelRoute ? 'RouterLink' : 'div'"
          :to="channelRoute ?? undefined"
          class="channelThumbnailLink"
        >
          <img
            v-if="video.authorThumbnail"
            :src="video.authorThumbnail"
            class="channelThumbnail"
            :class="{ initialCursor: !channelRoute }"
            alt=""
          >
        </component>
        <div>
          <component
            :is="channelRoute ? 'RouterLink' : 'span'"
            :to="channelRoute ?? undefined"
            class="channelName"
            :class="{ initialCursor: !channelRoute }"
            dir="auto"
          >
            {{ video.author }}
          </component>
          <!-- The subscribe button (ticket 08) goes in this slot -->
          <slot name="subscribe" />
        </div>
      </div>
      <div class="videoOptions">
        <FtIconButton
          v-if="showPlaylists"
          :title="t('User Playlists.Add to Playlist')"
          :icon="['fas', 'plus']"
          theme="base"
          @click="togglePlaylistPrompt"
        />
        <FtIconButton
          v-if="canSaveWatchedProgress && watchedProgressSavingInSemiAutoMode"
          :title="t('Video.Save Watched Progress')"
          :icon="['fas', 'bars-progress']"
          @click="emit('save-watched-progress')"
        />
        <!-- The view's own actions: audio only, and the download button for the video's platform -->
        <slot name="actions" />
        <FtIconButton
          v-if="USING_ELECTRON && externalPlayer && externalPlayerVideo"
          :title="t('Video.External Player.OpenInTemplate', { externalPlayer })"
          :icon="['fas', 'external-link-alt']"
          theme="secondary"
          class="externalPlayerButton"
          @click="openInExternalPlayer"
        />
        <template v-if="!hideSharingActions && shareUrl">
          <FtIconButton
            :title="t('PeerTube.Watch.Copy link')"
            :icon="['fas', 'copy']"
            theme="secondary"
            @click="copyLink"
          />
          <FtIconButton
            :title="t('PeerTube.Watch.Open in browser')"
            :icon="['fas', 'globe']"
            theme="secondary"
            @click="openLink"
          />
        </template>
      </div>
    </div>
    <dl
      v-if="facts.length > 0"
      class="videoFacts"
    >
      <div
        v-for="fact in facts"
        :key="fact.key"
        class="videoFact"
      >
        <dt>{{ fact.label }}</dt>
        <dd
          v-if="fact.key === 'tags'"
          class="videoTags"
        >
          <span
            v-for="tag in video.tags"
            :key="tag"
            class="videoTag"
            dir="auto"
          >{{ tag }}</span>
        </dd>
        <dd
          v-else
          dir="auto"
        >
          {{ fact.value }}
        </dd>
      </div>
    </dl>
  </FtCard>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'

import FtCard from '../ft-card/ft-card.vue'
import FtIconButton from '../FtIconButton/FtIconButton.vue'

import { toStoredPlainText } from '../LayerMarkdown/plainText'

import store from '../../store/index'
import { PLATFORM_YOUTUBE, platformOf } from '../../platform/refs'
import { usePlatformLayer } from '../../platform/vue'
import {
  copyToClipboard,
  formatNumber,
  formatScheduledTime,
  getLocalesWithFallback,
  openExternalLink,
} from '../../helpers/utils'

const props = defineProps({
  /**
   * The video's details, as the layer gives them
   * @type {import('vue').PropType<import('../../platform/shapes').VideoDetails>}
   */
  video: {
    type: Object,
    required: true
  },
  canSaveWatchedProgress: {
    type: Boolean,
    default: false
  },
  /**
   * Where playback is, in seconds, for the external player to start from
   * (as WatchVideoInfo's `getTimestamp`); without it, the beginning
   * @type {import('vue').PropType<(() => number | null) | null>}
   */
  getTimestamp: {
    type: Function,
    default: null
  },
})

const emit = defineEmits(['save-watched-progress', 'pause-player', 'opened-in-external-player'])

const USING_ELECTRON = process.env.IS_ELECTRON

const { locale, t } = useI18n()
const layer = usePlatformLayer()

const hideVideoViews = computed(() => store.getters.getHideVideoViews)
const hideVideoLikesAndDislikes = computed(() => store.getters.getHideVideoLikesAndDislikes)
const hideUploader = computed(() => store.getters.getHideUploader)
const hideSharingActions = computed(() => store.getters.getHideSharingActions)
const enableChannelLinks = computed(() => !store.getters.getDisableChannelLinks)
const showPlaylists = computed(() => !store.getters.getHidePlaylists && !props.video.isUpcoming)
const watchedProgressSavingInSemiAutoMode = computed(() => store.getters.getWatchedProgressSavingMode === 'semi-auto')
/** @type {import('vue').ComputedRef<string>} */
const externalPlayer = computed(() => store.getters.getExternalPlayer)
const defaultPlayback = computed(() => store.getters.getDefaultPlayback)

/** Where the channel's page is, as the layer says for the channel's platform */
const channelRoute = computed(() => {
  if (!enableChannelLinks.value) {
    return null
  }

  const { channel, platform, host, authorId } = props.video
  return layer.describe(channel ?? { type: 'channel', platform, host, id: authorId }).route
})

/** The canonical URL on the video's own platform, to share and open */
const shareUrl = computed(() => props.video.url || layer.describe(props.video).shareUrl)

/**
 * What names the video to the external player: a YouTube video by its id, as
 * WatchVideoInfo hands it, and a PeerTube one by its watch URL, which main
 * checks is one; `null` when there is no such URL, which main would refuse.
 *
 * @type {import('vue').ComputedRef<{ videoId: string } | { videoUrl: string } | null>}
 */
const externalPlayerVideo = computed(() => {
  const { video } = props

  if (platformOf(video) === PLATFORM_YOUTUBE) {
    return { videoId: video.videoId }
  }

  const videoUrl = layer.describe(video).externalPlayerUrl
  return videoUrl ? { videoUrl } : null
})

const publishedLabel = computed(() => {
  switch (props.video.liveStatus) {
    case 'live':
      return t('Video.Started streaming on')
    case 'ended':
      return t('Video.Streamed on')
    case 'waiting':
      return t('PeerTube.Watch.Scheduled for')
    default:
      return t('Video.Published on')
  }
})

const dateText = computed(() => {
  const { liveStatus, premiereDate, published } = props.video

  // A scheduled time is stated exactly, with the relative time beside it
  if (liveStatus === 'waiting') {
    return premiereDate ? formatScheduledTime(new Date(premiereDate).getTime()) : ''
  }

  if (typeof published !== 'number') {
    return ''
  }

  const formatter = new Intl.DateTimeFormat(getLocalesWithFallback(locale.value), { dateStyle: 'medium' })
  // No-break spaces, so the date wraps as one
  return formatter.format(published).replaceAll(' ', '\u00A0')
})

const viewCountText = computed(() => {
  const { viewCount } = props.video

  if (hideVideoViews.value || viewCount == null) {
    return ''
  }

  return t('Global.Counts.View Count', { count: formatNumber(viewCount) }, viewCount)
})

const facts = computed(() => {
  const { tags, category, licence, language } = props.video

  return [
    tags?.length > 0 ? { key: 'tags', label: t('PeerTube.Watch.Tags') } : null,
    category ? { key: 'category', label: t('PeerTube.Watch.Category'), value: category } : null,
    licence ? { key: 'licence', label: t('PeerTube.Watch.Licence'), value: licence } : null,
    language ? { key: 'language', label: t('PeerTube.Watch.Language'), value: language } : null,
  ].filter(fact => fact !== null)
})

function copyLink() {
  copyToClipboard(shareUrl.value, { messageOnSuccess: t('PeerTube.Watch.Link copied') })
}

function openLink() {
  openExternalLink(shareUrl.value)
}

/**
 * As WatchVideoInfo's `handleExternalPlayer`, less the playlist, which the
 * layer's watch view does not play yet. Marking the video watched, which
 * WatchVideoInfo does next, is the view's: it writes the history entries.
 */
function openInExternalPlayer() {
  emit('pause-player')

  window.ftElectron.openInExternalPlayer({
    ...externalPlayerVideo.value,
    startTime: props.getTimestamp?.() ?? 0,
    playbackRate: defaultPlayback.value,
  })

  emit('opened-in-external-player')
}

/**
 * The video as the playlists store it: the fields the Watch view's info
 * offers (WatchVideoInfo.vue `togglePlaylistPrompt`), plus what a record of
 * another platform needs to render and route without asking it again
 */
function togglePlaylistPrompt() {
  const { video } = props

  const videoData = {
    videoId: video.videoId,
    title: video.title,
    author: video.author,
    authorId: video.authorId,
    // Plain text: the old list card renders it as HTML
    description: toStoredPlainText(video.description),
    viewCount: video.viewCount,
    // As it is: a missing duration is how the card knows a live
    lengthSeconds: video.lengthSeconds,
    published: video.published,
    premiereDate: video.premiereDate,
    platform: video.platform,
    host: video.host,
    thumbnail: video.thumbnail,
  }

  store.dispatch('showAddToPlaylistPromptForManyVideos', { videos: [videoData] })
}

onMounted(() => {
  // As WatchVideoInfo does for YouTube: the player leaves this to the page
  if ('mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: props.video.title,
      artist: props.video.author,
      artwork: props.video.thumbnail
        ? [{ src: props.video.thumbnail, sizes: '128x128', type: 'img/png' }]
        : [],
    })
  }
})
</script>

<style scoped src="./LayerVideoInfo.css" />
