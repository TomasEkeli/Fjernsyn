<template>
  <div>
    <FtCard class="card">
      <div class="headingRow">
        <h2>
          <FontAwesomeIcon
            :icon="['fas', 'search']"
            class="headingIcon"
          />
          {{ t('PeerTube.Search.Results for', { query, host: sourceHost }) }}
        </h2>
        <FtDensitySwitch />
      </div>
      <nav
        class="tabs"
        role="tablist"
        :aria-label="t('Search Filters.Type.Type')"
      >
        <RouterLink
          v-for="tab in tabs"
          :id="`${tab.type}Tab`"
          :key="tab.type"
          :to="typeRoute(tab.type)"
          replace
          class="tab"
          :class="{ selectedTab: searchType === tab.type }"
          role="tab"
          :aria-selected="searchType === tab.type"
          aria-controls="resultsPanel"
        >
          {{ tab.label }}
        </RouterLink>
      </nav>
      <div
        id="resultsPanel"
        role="tabpanel"
        :aria-labelledby="`${searchType}Tab`"
      >
        <FtElementList :data="items" />
        <p
          v-if="isFinishedAndEmpty"
          class="message"
        >
          {{ t('PeerTube.Search.No results', { query }) }}
        </p>
      </div>
      <FtLoader v-if="loading" />
      <div
        v-else-if="error"
        class="pageError"
      >
        <p class="message">
          {{ errorMessage(error) }}
        </p>
        <FtButton
          :label="t('Video.Try Again')"
          :icon="['fas', 'sync']"
          class="retryButton"
          @click="load"
        />
      </div>
      <FtAutoLoadNextPageWrapper
        v-else-if="hasMore && !autoLoadPaused"
        @load-next-page="load"
      >
        <div
          class="getNextPage"
          role="button"
          tabindex="0"
          @click="load"
          @keydown.enter.space.prevent="load"
        >
          <FontAwesomeIcon :icon="['fas', 'search']" /> {{ t('Search Filters.Fetch more results') }}
        </div>
      </FtAutoLoadNextPageWrapper>
      <!-- Pages keep coming back empty (all NSFW, say): no more requests until asked -->
      <div
        v-else-if="hasMore"
        class="getNextPage"
        role="button"
        tabindex="0"
        @click="load"
        @keydown.enter.space.prevent="load"
      >
        <FontAwesomeIcon :icon="['fas', 'search']" /> {{ t('Search Filters.Fetch more results') }}
      </div>
    </FtCard>
  </div>
</template>

<script setup>
// The platform layer's search view. Platform-neutral: it talks only to the
// injected layer and hands the results (video summaries and channel list
// items, platform/shapes.js) to the shared list as they come. The route
// carries the query and, in its query, the type (`video`, the default, or
// `channel`); a search runs when the route changes, that is on submit, never
// as the reader types. NSFW results are the layer's to filter.
// Upstream's SearchPage (views/SearchPage) is the model for the layout; it is
// not edited beyond its link here.

import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'

import FtAutoLoadNextPageWrapper from '../../components/FtAutoLoadNextPageWrapper.vue'
import FtButton from '../../components/FtButton/FtButton.vue'
import FtCard from '../../components/ft-card/ft-card.vue'
import FtDensitySwitch from '../../components/FtDensitySwitch/FtDensitySwitch.vue'
import FtElementList from '../../components/FtElementList/FtElementList.vue'
import FtLoader from '../../components/FtLoader/FtLoader.vue'

import store from '../../store/index'
import { usePlatformLayer } from '../../platform/vue'

/** The types the layer searches, the default first */
const SEARCH_TYPES = ['video', 'channel']

/**
 * Empty pages in a row (each with a cursor) after which more results are
 * loaded only when asked, so that a search whose every result is filtered out
 * does not chain requests while the end of the list stays in view
 */
const MAX_EMPTY_AUTO_LOADS = 3

const layer = usePlatformLayer()
const route = useRoute()
const { t } = useI18n()

// The route this view serves, so that its watcher ignores the navigation away
const viewRouteName = route.name

const query = computed(() => String(route.params.query ?? '').trim())
const searchType = computed(() => SEARCH_TYPES.includes(route.query.type) ? route.query.type : SEARCH_TYPES[0])

/** The search source as set, and its host for the heading */
const source = computed(() => layer.config?.peertubeSearchSource ?? '')
const sourceHost = computed(() => {
  try {
    return new URL(source.value).hostname || source.value
  } catch {
    return source.value
  }
})

const tabs = computed(() => [
  { type: 'video', label: t('Search Filters.Type.Videos') },
  { type: 'channel', label: t('Search Filters.Type.Channels') },
])

/** @type {import('vue').ShallowRef<object[]>} */
const items = shallowRef([])
const cursor = shallowRef(null)
/** Whether the first page has been answered */
const loaded = ref(false)
const loading = ref(false)
/** @type {import('vue').ShallowRef<{ kind?: string, host?: string | null } | null>} */
const error = shallowRef(null)

/** Pages answered empty in a row */
const emptyPagesInARow = ref(0)

/** Tells the search in hand apart from the ones it replaced */
let generation = 0

const hasMore = computed(() => loaded.value && cursor.value !== null)
const autoLoadPaused = computed(() => emptyPagesInARow.value >= MAX_EMPTY_AUTO_LOADS)
const isFinishedAndEmpty = computed(() => loaded.value && cursor.value === null && items.value.length === 0)

/**
 * @param {string} type
 */
function typeRoute(type) {
  return {
    name: viewRouteName,
    params: { query: route.params.query },
    query: type === SEARCH_TYPES[0] ? {} : { type },
  }
}

/**
 * @param {{ kind?: string, host?: string | null }} err
 * @returns {string}
 */
function errorMessage(err) {
  const host = err.host ?? sourceHost.value

  switch (err.kind) {
    case 'unavailable':
      return t('PeerTube.Search.Unavailable', { host })
    case 'rateLimited':
      return t('PeerTube.Search.Rate limited', { host })
    case 'invalid':
    case 'notFound':
      return t('PeerTube.Search.Invalid source', { source: source.value })
    default:
      return t('PeerTube.Search.Could not search')
  }
}

/**
 * The first page, or the next one; again after an error, the same one. The
 * cursor is the layer's and handed back unchanged; `null` after the first
 * page is the end. An empty page with a cursor is not the end (filtering can
 * empty a page), but after `MAX_EMPTY_AUTO_LOADS` of them in a row the next
 * comes only by the button.
 */
async function load() {
  if (loading.value || (loaded.value && cursor.value === null)) {
    return
  }

  const thisGeneration = generation
  const isNext = loaded.value
  loading.value = true
  error.value = null

  try {
    const page = await layer.search(query.value, { type: searchType.value, cursor: isNext ? cursor.value : null })

    if (thisGeneration !== generation) {
      return
    }

    items.value = isNext ? [...items.value, ...page.items] : page.items
    cursor.value = page.cursor ?? null
    loaded.value = true
    emptyPagesInARow.value = page.items.length === 0 ? emptyPagesInARow.value + 1 : 0
  } catch (err) {
    if (thisGeneration !== generation) {
      return
    }

    if (!err?.kind) {
      console.error(err)
    }

    error.value = err ?? {}
  } finally {
    if (thisGeneration === generation) {
      loading.value = false
    }
  }
}

/** Forgets the results, and any answer still coming, and searches afresh */
function search() {
  generation++
  items.value = []
  cursor.value = null
  loaded.value = false
  emptyPagesInARow.value = 0
  loading.value = false
  error.value = null

  store.commit('setAppTitle', query.value)
  load()
}

// The router reuses this view for another query or type
watch([query, searchType], () => {
  if (route.name === viewRouteName) {
    search()
  }
})

onMounted(search)
</script>

<style scoped src="./LayerSearch.css" />
