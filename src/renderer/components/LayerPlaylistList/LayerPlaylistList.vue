<template>
  <ul class="layerPlaylistList">
    <li
      v-for="playlist in playlists"
      :key="`${playlist.platform ?? 'youtube'}-${playlist.playlistId}`"
      class="layerPlaylist"
    >
      <!--
        The app opens external links (App.vue `handleLinkClick`, which honours
        the external link setting) only for clicks whose target is the link
        itself, so a click on the thumbnail or title inside it is handed to
        the link. The keyboard reaches the link directly.
      -->
      <!-- eslint-disable-next-line vuejs-accessibility/click-events-have-key-events -->
      <a
        :href="linkOf(playlist)"
        :title="linkOf(playlist) ? t('PeerTube.Channel.Playlist opens in browser', { host: playlist.host }) : undefined"
        class="playlistLink"
        @click="handleClick"
      >
        <img
          v-if="playlist.thumbnail && !thumbnailsHidden"
          :src="playlist.thumbnail"
          class="playlistThumbnail"
          alt=""
        >
        <span
          v-else
          class="playlistThumbnail placeholder"
        >
          <FontAwesomeIcon :icon="['fas', 'list']" />
        </span>
        <span
          class="playlistTitle"
          dir="auto"
        >{{ playlist.title }}</span>
      </a>
      <span
        v-if="playlist.videoCount != null"
        class="videoCount"
      >
        {{ t('Global.Counts.Video Count', { count: formatNumber(playlist.videoCount) }, playlist.videoCount) }}
      </span>
    </li>
  </ul>
</template>

<script setup>
// A channel's playlists, as the layer lists them (PlaylistSummary): title,
// thumbnail and video count, each linking to the playlist's canonical page on
// its own platform. The layer has no playlist page yet, so the link leaves
// the app; `FtListPlaylist` is not used because it routes to YouTube's.

import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import store from '../../store/index'
import { formatNumber } from '../../helpers/utils'

defineProps({
  /** @type {import('vue').PropType<import('../../platform/shapes').PlaylistSummary[]>} */
  playlists: {
    type: Array,
    required: true
  },
})

const { t } = useI18n()

const thumbnailsHidden = computed(() => store.getters.getThumbnailPreference === 'hidden')

/**
 * The playlist's URL, only where it is https and on the playlist's own host:
 * an instance names the URL, and a link must not leave for anywhere else.
 *
 * @param {import('../../platform/shapes').PlaylistSummary} playlist
 * @returns {string | undefined} `undefined` for no link
 */
function linkOf({ url, host }) {
  if (typeof url !== 'string' || typeof host !== 'string' || host === '') {
    return undefined
  }

  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === host ? parsed.href : undefined
  } catch {
    return undefined
  }
}

/**
 * @param {MouseEvent} event
 */
function handleClick(event) {
  const link = event.currentTarget

  if (event.target !== link) {
    event.preventDefault()
    event.stopPropagation()
    link.click()
  }
}
</script>

<style scoped src="./LayerPlaylistList.css" />
