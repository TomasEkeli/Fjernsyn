<template>
  <div>
    <slot name="header" />
    <div class="controlRow">
      <div class="refreshCell">
        <FtRefreshWidget
          :disable-refresh="!canRefresh"
          :last-refresh-at="lastRefreshAt"
          :title="title"
          :activity-label="activityLabel"
          :activity-progress="activityProgress"
          @click="refresh"
        />
        <p
          v-if="failedSourceNames !== ''"
          class="refreshFailed"
          role="status"
        >
          {{ $t('Collections.Refresh Failed', { sources: failedSourceNames }) }}
        </p>
      </div>
    </div>
    <FtLoader
      v-if="!ready || loading"
    />
    <p
      v-else-if="videos.length === 0"
      class="message"
    >
      {{ bundleFailed ? $t('Collections.Load Failed') : $t('Collections.Nothing Shared') }}
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
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import FtAutoLoadNextPageWrapper from '../FtAutoLoadNextPageWrapper.vue'
import FtButton from '../FtButton/FtButton.vue'
import FtElementList from '../FtElementList/FtElementList.vue'
import FtFlexBox from '../ft-flex-box/ft-flex-box.vue'
import FtLoader from '../FtLoader/FtLoader.vue'
import FtRefreshWidget from '../FtRefreshWidget/FtRefreshWidget.vue'

import store from '../../store/index'

import { collectionsCrawlProgress, startCollectionsCrawl } from '../../helpers/collections/crawlRunner'
import { detailsProgress } from '../../helpers/collections/details'
import { HACKERTUBE_SOURCE_ID } from '../../helpers/collections/hackertube'
import { wallVideos } from '../../helpers/collections/shares'
import { KeyboardShortcuts } from '../../../constants'

/**
 * The wall of a collection: Collections' wall of every followed source's
 * videos, or, given a source, that source's own page's wall of its videos
 * alone. One component, so that the two pages are the same wall with the
 * same toolbar, and differ only in which shares count: on a source's page
 * that source's, so that its votes and its dates are the ones that order it.
 *
 * It is a library rather than a stream: what a source has shared stays, and
 * the wall is in the order of the votes the sources gave, the most first.
 * The cards are the ordinary ones, so every card action works here as on any
 * other wall, and a video opens on the ordinary watch page.
 *
 * Opening it, on either page, opens Collections: the first open follows the
 * starter set, once per installation (applyCollectionsStarterSet,
 * helpers/collections/starterSet.js), and while HackerTube is followed loads
 * the copy of its data the app ships with (store/modules/collections.js). Every open then
 * refreshes, when the last refresh was more than an hour ago, asking each
 * followed source what it shares now (helpers/collections/refresh.js); the
 * refresh button and R or F5 refresh at any time, every source, whichever
 * page it is pressed on. Beside it the crawl starts, which fetches each
 * video's own details in the background (helpers/collections/crawl.js); as
 * they come in, the cards show duration, views and date, and link to their
 * channel.
 *
 * The control row is the subscriptions page's and Explore's: the refresh
 * widget says how fresh the wall is, or what is being done to it, the refresh
 * or the crawl, with how far along it is. The `header` slot comes above it.
 */

const props = defineProps({
  /** The source whose wall this is; none for Collections' wall of every source */
  sourceId: {
    type: String,
    default: null,
  },
  /** What the refresh widget calls the page */
  title: {
    type: String,
    required: true,
  },
})

const { t } = useI18n()

/** @type {import('vue').ComputedRef<boolean>} */
const ready = computed(() => store.getters.getCollectionsReady)

/** @type {import('vue').ComputedRef<boolean>} */
const loading = computed(() => store.getters.getCollectionsLoading)

/** @type {import('vue').ComputedRef<boolean>} */
const loadFailed = computed(() => store.getters.getCollectionsLoadFailed)

/**
 * Whether to say the bundle could not be loaded: on the walls its videos are
 * on, Collections' and HackerTube's own, and not on another source's, which
 * has nothing to do with it
 *
 * @type {import('vue').ComputedRef<boolean>}
 */
const bundleFailed = computed(() => {
  return loadFailed.value && (props.sourceId === null || props.sourceId === HACKERTUBE_SOURCE_ID)
})

/**
 * The shares that count on this wall: the source's own on its page, and on
 * Collections those of every source followed, which, as unfollowing removes
 * a source's shares, is all of them but any of a source unfollowed while
 * they were being written
 *
 * @type {import('vue').ComputedRef<import('../../helpers/collections/shares').Share[]>}
 */
const shares = computed(() => {
  const all = store.getters.getCollectionShares

  if (props.sourceId !== null) {
    return all.filter(share => share.sourceId === props.sourceId)
  }

  const followed = new Set(store.getters.getCollectionSources.map(source => source._id))
  return all.filter(share => followed.has(share.sourceId))
})

/** @type {import('vue').ComputedRef<import('../../helpers/collections/shares').CollectionVideo[]>} */
const videos = computed(() => wallVideos(shares.value, store.getters.getCollectionVideos))

/** @type {import('vue').ComputedRef<boolean>} */
const refreshing = computed(() => store.getters.getCollectionsRefreshing)

/** @type {import('vue').ComputedRef<boolean>} */
const canRefresh = computed(() => {
  return ready.value && !loading.value && !refreshing.value && !store.getters.getCollectionsGrabFailed
})

/**
 * When every followed source was last refreshed by, kept on their records,
 * so it holds across restarts
 *
 * @type {import('vue').ComputedRef<number | null>}
 */
const lastRefreshAt = computed(() => store.getters.getCollectionsLastRefreshAt)

/**
 * The sources whose last refresh failed, by name, which kept everything they
 * had; empty when none did
 *
 * @type {import('vue').ComputedRef<string>}
 */
const failedSourceNames = computed(() => {
  return store.getters.getCollectionsRefreshFailures.map(source => source.name).join(', ')
})

/** @type {import('vue').ComputedRef<'running' | 'paused' | null>} */
const crawlShown = computed(() => {
  const state = collectionsCrawlProgress.state
  return state === 'running' || state === 'paused' ? state : null
})

/**
 * What is being done to the wall, in the widget in place of its age: the
 * refresh, or else the crawl while it is under way. Without figures, as on
 * the subscriptions page: the bar says how far along.
 *
 * @type {import('vue').ComputedRef<string>}
 */
const activityLabel = computed(() => {
  if (refreshing.value) { return t('Collections.Refreshing') }
  if (crawlShown.value === 'running') { return t('Collections.Crawl Progress') }
  if (crawlShown.value === 'paused') { return t('Collections.Crawl Paused') }
  return ''
})

/**
 * How far along that is, from 0 to 1: of the sources being asked, or of the
 * videos of every source, how many have their details. Null when there is
 * no honest answer, as for a refresh of a single source.
 *
 * @type {import('vue').ComputedRef<number | null>}
 */
const activityProgress = computed(() => {
  if (refreshing.value) {
    const { done, total } = store.getters.getCollectionsRefreshProgress
    return total > 1 ? done / total : null
  }

  if (crawlShown.value !== null) {
    // Counted over the shares, without building the wall again
    const { done, total } = detailsProgress(store.getters.getCollectionShares, store.getters.getCollectionVideos, Date.now())
    return total > 0 ? done / total : null
  }

  return null
})

function refresh() {
  if (canRefresh.value) {
    store.dispatch('refreshCollections')
  }
}

/**
 * R and F5 refresh, as on the subscriptions page and Explore
 *
 * @param {KeyboardEvent} event
 */
function keyboardShortcutHandler(event) {
  if (document.activeElement?.classList.contains('ft-input')) {
    return
  }

  // Avoid handling events due to user holding a key (not released)
  if (event.repeat) { return }

  switch (event.key.toLowerCase()) {
    case 'f5':
    case KeyboardShortcuts.APP.SITUATIONAL.REFRESH:
      refresh()
      break
  }
}

onMounted(() => {
  document.addEventListener('keydown', keyboardShortcutHandler)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', keyboardShortcutHandler)
})

/*
 * The window onto the wall, as on the subscriptions page: a hundred cards,
 * and a hundred more each time the reader asks, by the button or by reaching
 * it when the auto-load-next-page setting is on. Session storage, so that
 * coming back to the page mid-session reopens the window as wide as it was;
 * each source's page has its own.
 */
const PAGE_SIZE = 100

const limitKey = props.sourceId === null ? 'collectionsLimit' : `collectionsLimit:${props.sourceId}`

// Anything but a whole number of at least one is taken as never widened
const savedLimit = parseInt(sessionStorage.getItem(limitKey) ?? '')

const dataLimit = ref(Number.isInteger(savedLimit) && savedLimit > 0 ? savedLimit : PAGE_SIZE)

/** @type {import('vue').ComputedRef<import('../../helpers/collections/shares').CollectionVideo[]>} */
const activeVideos = computed(() => {
  return videos.value.length <= dataLimit.value ? videos.value : videos.value.slice(0, dataLimit.value)
})

function increaseLimit() {
  dataLimit.value += PAGE_SIZE
  sessionStorage.setItem(limitKey, dataLimit.value.toFixed(0))
}

/** Whether this page's open has run, which loads the bundle the first time */
const opened = ref(false)

// Once the datastore has loaded, which on a page opened at startup is a
// moment after the page is: the bundle, the first time; then a refresh, if
// one is due, which the crawl does not wait for, as it starts again by
// itself on the shares the refresh brings
watch(ready, async (isReady) => {
  if (isReady && !opened.value) {
    await store.dispatch('openCollections')
    opened.value = true

    store.dispatch('refreshCollectionsIfDue').catch((error) => {
      console.error('Collections: the refresh on open failed', error)
    })
  }
}, { immediate: true })

// The crawl, once the page is open and there are videos: at once, or when a
// refresh brings the videos a failed bundle load could not. It fetches the
// details of every source's videos, whichever page started it.
watch(() => opened.value && !loadFailed.value && store.getters.getCollectionShares.length > 0, (canCrawl) => {
  if (canCrawl) {
    startCollectionsCrawl()
  }
}, { immediate: true })
</script>

<style scoped src="../FtToggleChip/chipRow.css" />
<style scoped src="./CollectionsWall.css" />
