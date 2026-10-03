<template>
  <div class="about">
    <template v-if="linkedDescription">
      <h2>{{ t('Channel.About.Channel Description') }}</h2>
      <div
        v-safer-html="linkedDescription"
        class="aboutInfo"
        dir="auto"
      />
    </template>
    <template v-if="joined != null || viewCount != null || videoCount != null || location">
      <h2>{{ t('Channel.About.Details') }}</h2>
      <table class="aboutDetails">
        <tr v-if="joined != null">
          <th scope="row">
            {{ t('Channel.About.Joined') }}
          </th>
          <td>{{ formattedJoined }}</td>
        </tr>
        <tr v-if="viewCount != null">
          <th scope="row">
            {{ t('Video.Views') }}
          </th>
          <td>{{ formatNumber(viewCount) }}</td>
        </tr>
        <tr v-if="videoCount != null">
          <th scope="row">
            {{ t('Global.Videos') }}
          </th>
          <td>{{ formatNumber(videoCount) }}</td>
        </tr>
        <tr v-if="location">
          <th scope="row">
            {{ t('Channel.About.Location') }}
          </th>
          <td dir="auto">
            {{ location }}
          </td>
        </tr>
      </table>
    </template>
    <template v-if="tags.length > 0">
      <h2>{{ t('Channel.About.Tags.Tags') }}</h2>
      <ul class="aboutTags">
        <li
          v-for="tag in tags"
          :key="tag"
          class="aboutTag"
          dir="auto"
        >
          <RouterLink
            v-if="!hideSearchBar"
            class="aboutTagLink"
            :title="t('Channel.About.Tags.Search for', { tag })"
            :to="layerTagSearchRoute(store, tag)"
          >
            {{ tag }}
          </RouterLink>
          <span
            v-else
            class="aboutTagLink"
          >
            {{ tag }}
          </span>
        </li>
      </ul>
    </template>
    <template v-if="!hideFeaturedChannels && featuredChannels.length > 0">
      <h2>{{ t('Channel.About.Featured Channels') }}</h2>
      <FtFlexBox>
        <FtChannelBubble
          v-for="featured in featuredChannels"
          :key="featured.id"
          :channel-id="featured.id"
          :channel-name="featured.name"
          :channel-thumbnail="featured.thumbnail || undefined"
        />
      </FtFlexBox>
    </template>
  </div>
</template>

<script setup>
// A YouTube channel's about tab on the layer's channel page, as upstream's
// ChannelAbout shows it, in its styles: the description with its links made
// links, the details (joined, views, videos, location) where the layer
// answered them, the tags each a search for it, and the featured channels
// unless hidden by their setting. The description is the layer's
// plain text: escaped, then autolinked as the old view does, then sanitised,
// so nothing in the text itself is ever read as markup. The tags search as a
// search for the tag typed alone in the search box would, on the layer's
// search page; with the search bar hidden they are only words, as in the old
// tab.

import autolinker from 'autolinker'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import FtChannelBubble from '../FtChannelBubble/FtChannelBubble.vue'
import FtFlexBox from '../ft-flex-box/ft-flex-box.vue'
import { layerTagSearchRoute } from '../LayerSearchPill/searchBox'
import { vSaferHtml } from '../../directives/vSaferHtml.js'

import store from '../../store/index'
import { escapeHTML, formatNumber, getLocalesWithFallback } from '../../helpers/utils'

const props = defineProps({
  /** The channel's description, as the layer gives it: plain text */
  description: {
    type: String,
    default: ''
  },
  tags: {
    type: Array,
    default: () => []
  },
  /** When the channel joined, ms since epoch; absent where the layer does not know */
  joined: {
    type: Number,
    default: null
  },
  viewCount: {
    type: Number,
    default: null
  },
  videoCount: {
    type: Number,
    default: null
  },
  location: {
    type: String,
    default: null
  },
  /** The channels it features, as channel summaries */
  featuredChannels: {
    type: Array,
    default: () => []
  },
})

const { t, locale } = useI18n()

const hideSearchBar = computed(() => store.getters.getHideSearchBar)
const hideFeaturedChannels = computed(() => store.getters.getHideFeaturedChannels)

const formattedJoined = computed(() => {
  return new Intl.DateTimeFormat(getLocalesWithFallback(locale.value), { dateStyle: 'long' }).format(props.joined)
})

const linkedDescription = computed(() => {
  const text = props.description.trim()
  return text === '' ? '' : autolinker.link(escapeHTML(text))
})
</script>

<style scoped src="../ChannelAbout/ChannelAbout.css" />
