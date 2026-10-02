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
  </div>
</template>

<script setup>
// A YouTube channel's about tab on the layer's channel page, as upstream's
// ChannelAbout shows it, in its styles: the description with its links made
// links, and the tags each a search for it. The description is the layer's
// plain text: escaped, then autolinked as the old view does, then sanitised,
// so nothing in the text itself is ever read as markup. The tags search as a
// search for the tag typed alone in the search box would, on the layer's
// search page; with the search bar hidden they are only words, as in the old
// tab.

import autolinker from 'autolinker'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { layerTagSearchRoute } from '../LayerSearchPill/searchBox'
import { vSaferHtml } from '../../directives/vSaferHtml.js'

import store from '../../store/index'
import { escapeHTML } from '../../helpers/utils'

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
})

const { t } = useI18n()

const hideSearchBar = computed(() => store.getters.getHideSearchBar)

const linkedDescription = computed(() => {
  const text = props.description.trim()
  return text === '' ? '' : autolinker.link(escapeHTML(text))
})
</script>

<style scoped src="../ChannelAbout/ChannelAbout.css" />
