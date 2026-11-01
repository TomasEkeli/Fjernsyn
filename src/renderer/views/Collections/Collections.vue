<template>
  <div>
    <FtCard class="card">
      <h2 class="visuallyHidden">
        {{ $t('Collections.Collections') }}
      </h2>
      <I18nT
        keypath="Collections.HackerTube Credit"
        tag="p"
        class="credit"
        scope="global"
      >
        <template
          v-for="link in CREDIT_LINKS"
          :key="link.slot"
          #[link.slot]
        >
          <a :href="link.href">{{ link.name }}</a>
        </template>
      </I18nT>
      <FtLoader
        v-if="!ready || loading"
      />
      <p
        v-else-if="videos.length === 0"
        class="message"
      >
        {{ loadFailed ? $t('Collections.Load Failed') : $t('Collections.Nothing Shared') }}
      </p>
      <FtElementList
        v-else
        :data="activeVideos"
        ai-wall
      />
      <FtAutoLoadNextPageWrapper
        v-if="ready && !loading && videos.length > dataLimit"
        @load-next-page="increaseLimit"
      >
        <FtFlexBox>
          <FtButton
            :label="$t('Collections.Load More')"
            background-color="var(--primary-color)"
            text-color="var(--text-with-main-color)"
            @click="increaseLimit"
          />
        </FtFlexBox>
      </FtAutoLoadNextPageWrapper>
    </FtCard>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { Translation as I18nT } from 'vue-i18n'

import FtAutoLoadNextPageWrapper from '../../components/FtAutoLoadNextPageWrapper.vue'
import FtButton from '../../components/FtButton/FtButton.vue'
import FtCard from '../../components/ft-card/ft-card.vue'
import FtElementList from '../../components/FtElementList/FtElementList.vue'
import FtFlexBox from '../../components/ft-flex-box/ft-flex-box.vue'
import FtLoader from '../../components/FtLoader/FtLoader.vue'

import store from '../../store/index'

import { wallVideos } from '../../helpers/collections/shares'

/**
 * Collections: one wall of the videos the followed sources have shared, as
 * the subscriptions page is one wall of the channels followed.
 *
 * It is a library rather than a stream: what a source has shared stays, and
 * the wall is in the order of the votes the sources gave, the most first.
 * The cards are the ordinary ones, so every card action works here as on any
 * other wall, and a video opens on the ordinary watch page.
 *
 * The first open follows HackerTube and loads the copy of its data the app
 * ships with (store/modules/collections.js); after that the page only reads.
 */

/**
 * What HackerTube's licence (ODC-By 1.0) asks to be credited, by the names
 * they go by, which are not translated
 */
const CREDIT_LINKS = [
  { slot: 'hackertube', name: 'HackerTube', href: 'https://hackertube.org' },
  { slot: 'dataset', name: 'open-index/hacker-news', href: 'https://huggingface.co/datasets/open-index/hacker-news' },
  { slot: 'licence', name: 'ODC-By 1.0', href: 'https://opendatacommons.org/licenses/by/1-0/' },
]

/** @type {import('vue').ComputedRef<boolean>} */
const ready = computed(() => store.getters.getCollectionsReady)

/** @type {import('vue').ComputedRef<boolean>} */
const loading = computed(() => store.getters.getCollectionsLoading)

/** @type {import('vue').ComputedRef<boolean>} */
const loadFailed = computed(() => store.getters.getCollectionsLoadFailed)

/**
 * Every followed source's shares count. Only the shares of a followed source
 * are kept, so that is all of them.
 *
 * @type {import('vue').ComputedRef<import('../../helpers/collections/shares').CollectionVideo[]>}
 */
const videos = computed(() => wallVideos(store.getters.getCollectionShares))

/*
 * The window onto the wall, as on the subscriptions page: a hundred cards,
 * and a hundred more each time the reader asks, by the button or by reaching
 * it when the auto-load-next-page setting is on. Session storage, so that
 * coming back to the page mid-session reopens the window as wide as it was.
 */
const PAGE_SIZE = 100

const savedLimit = sessionStorage.getItem('collectionsLimit')

const dataLimit = ref(savedLimit !== null ? parseInt(savedLimit) : PAGE_SIZE)

/** @type {import('vue').ComputedRef<import('../../helpers/collections/shares').CollectionVideo[]>} */
const activeVideos = computed(() => {
  return videos.value.length <= dataLimit.value ? videos.value : videos.value.slice(0, dataLimit.value)
})

function increaseLimit() {
  dataLimit.value += PAGE_SIZE
  sessionStorage.setItem('collectionsLimit', dataLimit.value.toFixed(0))
}

// Once the datastore has loaded, which on a page opened at startup is a
// moment after the page is
watch(ready, (isReady) => {
  if (isReady) {
    store.dispatch('openCollections')
  }
}, { immediate: true })
</script>

<style scoped src="./Collections.css" />
