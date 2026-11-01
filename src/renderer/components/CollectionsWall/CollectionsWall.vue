<template>
  <div>
    <slot name="header" />
    <div
      class="controlRow"
      :class="{ withoutChips: sourceId !== null }"
    >
      <div
        v-if="sourceId === null"
        class="chipRow"
        role="group"
        :aria-label="$t('Collections.Sources Shown')"
      >
        <FtToggleChip
          v-for="source in chips"
          :key="source._id"
          :label="source.name"
          :pressed="shownSources.has(source._id)"
          @toggle="toggleSource(source._id)"
        />
      </div>
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
      <div class="pageControls">
        <FtToggleChip
          :label="$t('Watched Chip.Watched')"
          :icon="['fas', 'history']"
          :pressed="watchedShown"
          :title="$t('Watched Chip.Hint')"
          @toggle="toggleWatched"
        />
        <AiChip />
        <div class="picker">
          <label
            class="pickerLabel"
            :for="sortSelectId"
          >
            {{ $t('Collections.Sort By') }}
          </label>
          <select
            :id="sortSelectId"
            v-model="sort"
            class="pickerSelect sortSelect"
          >
            <option
              v-for="option in sortOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </div>
      </div>
    </div>
    <FtLoader
      v-if="!ready || loading"
    />
    <p
      v-else-if="noSourceShown"
      class="message"
    >
      {{ $t('Collections.No Sources Shown') }}
    </p>
    <p
      v-else-if="videos.length === 0"
      class="message"
    >
      {{ bundleFailed ? $t('Collections.Load Failed') : $t('Collections.Nothing Shared') }}
    </p>
    <p
      v-else-if="shownVideos.length === 0"
      class="message"
    >
      {{ aiHidEverything ? $t('AI Chip.All Hidden') : $t('Watched Chip.All Watched') }}
    </p>
    <FtElementList
      v-else
      :data="activeVideos"
      ai-wall
    />
    <FtAutoLoadNextPageWrapper
      v-if="ready && !loading && shownVideos.length > dataLimit"
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
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import AiChip from '../AiChip/AiChip.vue'
import FtAutoLoadNextPageWrapper from '../FtAutoLoadNextPageWrapper.vue'
import FtButton from '../FtButton/FtButton.vue'
import FtElementList from '../FtElementList/FtElementList.vue'
import FtFlexBox from '../ft-flex-box/ft-flex-box.vue'
import FtLoader from '../FtLoader/FtLoader.vue'
import FtRefreshWidget from '../FtRefreshWidget/FtRefreshWidget.vue'
import FtToggleChip from '../FtToggleChip/FtToggleChip.vue'

import store from '../../store/index'

import { collectionsCrawlProgress, startCollectionsCrawl } from '../../helpers/collections/crawlRunner'
import { detailsProgress } from '../../helpers/collections/details'
import { HACKERTUBE_SOURCE_ID } from '../../helpers/collections/hackertube'
import { collectionSortOf, wallVideos } from '../../helpers/collections/shares'
import { hiddenSourcesWith, shownSourceIds, sourcesByName } from '../../helpers/collections/sourceChips'
import { aiIsShown, withAiPreference } from '../../helpers/aiShown'
import { setWatchedShown, watchedIsShown, withWatchedPreference } from '../../helpers/watchedShown'
import { KeyboardShortcuts } from '../../../constants'

/**
 * The wall of a collection: Collections' wall of every followed source's
 * videos, or, given a source, that source's own page's wall of its videos
 * alone. One component, so that the two pages are the same wall with the
 * same toolbar, and differ only in which shares count: on a source's page
 * that source's, so that its votes and its dates are the ones that order it.
 *
 * It is a library rather than a stream: what a source has shared stays, and
 * the wall is in the order chosen, by default the votes the sources gave,
 * the most first.
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
 * The control row is the subscriptions page's and Explore's. On Collections
 * it starts with a chip per followed source, saying whose videos are on the
 * wall (helpers/collections/sourceChips.js); a source's page has none, as it
 * is one source's wall. Then the refresh widget, which says how fresh the
 * wall is, or what is being done to it, the refresh or the crawl, with how
 * far along it is. At the far end the Watched and AI pills, the same
 * settings as on every wall that has them, and the order the wall is in:
 * upvotes, shared on community, video published or views. Which shares count
 * for the order is which sources are shown: the chips' on Collections, the
 * source's own on its page (`collectionValues` in helpers/collections/
 * shares.js). The `header` slot comes above the row.
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
 * The chips: one per source followed, by name
 *
 * @type {import('vue').ComputedRef<import('../../helpers/collections/shares').Source[]>}
 */
const chips = computed(() => sourcesByName(store.getters.getCollectionSources))

/**
 * The sources whose shares count on this wall: the source's own on its page,
 * whatever its chip on Collections says; and on Collections every source
 * followed whose chip is on, so that a share of a source unfollowed while it
 * was being written never shows
 *
 * @type {import('vue').ComputedRef<Set<string>>}
 */
const shownSources = computed(() => {
  if (props.sourceId !== null) {
    return new Set([props.sourceId])
  }

  return shownSourceIds(store.getters.getCollectionSources, store.getters.getCollectionsSourcesHidden)
})

/**
 * @param {string} sourceId
 */
function toggleSource(sourceId) {
  const hidden = store.getters.getCollectionsSourcesHidden
  store.dispatch('updateCollectionsSourcesHidden', hiddenSourcesWith(hidden, sourceId, !shownSources.value.has(sourceId)))
}

/**
 * Whether every chip is off on Collections, with sources followed, which
 * "nothing shared" would explain wrongly
 *
 * @type {import('vue').ComputedRef<boolean>}
 */
const noSourceShown = computed(() => {
  return props.sourceId === null && store.getters.getCollectionSources.length > 0 && shownSources.value.size === 0
})

/**
 * The wall's order, kept as a setting, so that it is the same on Collections
 * and every source's page and outlasts a restart
 *
 * @type {import('vue').WritableComputedRef<import('../../helpers/collections/shares').CollectionSort>}
 */
const sort = computed({
  get: () => collectionSortOf(store.getters.getCollectionsSort),
  set: value => store.dispatch('updateCollectionsSort', value),
})

const sortSelectId = useId()

/**
 * The orders on offer, in the order the spec names them. Spelled out, as a
 * message's key may not be built
 *
 * @type {import('vue').ComputedRef<{ value: import('../../helpers/collections/shares').CollectionSort, label: string }[]>}
 */
const sortOptions = computed(() => [
  { value: 'published', label: t('Collections.Sorts.Published') },
  { value: 'shared', label: t('Collections.Sorts.Shared') },
  { value: 'views', label: t('Collections.Sorts.Views') },
  { value: 'votes', label: t('Collections.Sorts.Upvotes') },
])

/**
 * The wall of the sources shown, in the order chosen, before the pills
 *
 * @type {import('vue').ComputedRef<import('../../helpers/collections/shares').CollectionVideo[]>}
 */
const videos = computed(() => {
  return wallVideos(store.getters.getCollectionShares, store.getters.getCollectionVideos, {
    shown: shownSources.value,
    sort: sort.value,
  })
})

/**
 * Whether what has been watched stays on the wall: the same setting, and the
 * same pill, as on the subscriptions page and Explore
 * (helpers/watchedShown.js)
 *
 * @type {import('vue').ComputedRef<boolean>}
 */
const watchedShown = computed(() => watchedIsShown())

function toggleWatched() {
  setWatchedShown(!watchedIsShown())
}

/** @type {import('vue').ComputedRef<import('../../helpers/collections/shares').CollectionVideo[]>} */
const unwatchedVideos = computed(() => withWatchedPreference(videos.value))

/**
 * The wall as shown: less what has been watched, while the Watched pill is
 * off, and what is made with AI, while the AI pill is, taken out before the
 * wall is cut into pages, as on the subscriptions page, so that a page of
 * them does not stand empty while more is to be had below
 *
 * @type {import('vue').ComputedRef<import('../../helpers/collections/shares').CollectionVideo[]>}
 */
const shownVideos = computed(() => withAiPreference(unwatchedVideos.value))

/**
 * Whether the AI pill took out everything the Watched pill left, for the
 * empty wall to say so
 *
 * @type {import('vue').ComputedRef<boolean>}
 */
const aiHidEverything = computed(() => !aiIsShown() && unwatchedVideos.value.length > 0)

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
  return shownVideos.value.length <= dataLimit.value ? shownVideos.value : shownVideos.value.slice(0, dataLimit.value)
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
<style scoped src="../FtToggleChip/pickerSelect.css" />
<style scoped src="./CollectionsWall.css" />
