<template>
  <div>
    <FtLoader
      v-if="isLoading"
      :fullscreen="true"
    />
    <FtCard
      v-else-if="loadError"
      class="card"
    >
      <!-- What the platform still shows of a channel it refuses (YouTube's age gate) -->
      <div
        v-if="loadError.channel"
        class="thumbnailContainer refusedChannel"
      >
        <img
          v-if="loadError.channel.thumbnail"
          :src="loadError.channel.thumbnail"
          class="avatar"
          alt=""
        >
        <FontAwesomeIcon
          v-else
          :icon="['fas', 'circle-user']"
          class="avatar"
        />
        <div class="lineContainer">
          <h1
            class="name"
            dir="auto"
          >
            {{ loadError.channel.name }}
          </h1>
        </div>
      </div>
      <p class="message">
        {{ errorMessage(loadError).text }}
      </p>
      <FtButton
        v-if="errorMessage(loadError).retryable"
        :label="t('Video.Try Again')"
        :icon="['fas', 'sync']"
        class="retryButton"
        @click="load"
      />
    </FtCard>
    <FtAgeRestricted
      v-else-if="channel && isFamilyFriendlyGated"
      class="ageRestricted"
      :is-channel="true"
    />
    <template v-else-if="channel">
      <FtCard class="card channelHeader">
        <img
          v-if="channel.banner"
          :src="channel.banner"
          class="banner"
          alt=""
        >
        <div class="infoContainer">
          <div class="info">
            <div class="thumbnailContainer">
              <img
                v-if="channel.avatarLarge"
                :src="channel.avatarLarge"
                class="avatar"
                alt=""
              >
              <FontAwesomeIcon
                v-else
                :icon="['fas', 'circle-user']"
                class="avatar"
              />
              <div class="lineContainer">
                <h1
                  class="name"
                  dir="auto"
                >
                  {{ channel.name }}
                </h1>
                <p
                  v-if="handleText"
                  class="handle"
                >
                  {{ handleText }}
                </p>
                <p
                  v-if="followerCountText"
                  class="followerCount"
                >
                  {{ followerCountText }}
                </p>
              </div>
            </div>
            <div class="infoActionsContainer">
              <LayerSubscribeButton :channel="channel" />
            </div>
          </div>
          <nav
            class="tabs"
            role="tablist"
            :aria-label="t('Channel.Channel Tabs')"
          >
            <RouterLink
              v-for="tab in visibleTabs"
              :id="`${tab.name}Tab`"
              :key="tab.name"
              :to="tabRoute(tab.name)"
              replace
              class="tab"
              :class="{ selectedTab: currentTab === tab.name }"
              role="tab"
              :aria-selected="currentTab === tab.name"
              :aria-controls="`${tab.name}Panel`"
            >
              {{ tab.label }}
            </RouterLink>
          </nav>
        </div>
      </FtCard>
      <LayerVideoDescription
        :description="channel.description ?? ''"
        :kind="channel.descriptionKind"
        :base-url="channel.host ? `https://${channel.host}` : ''"
        class="card"
      />
      <FtCard class="card">
        <!-- One list per tab: the videos, shorts and live, the playlists, releases, podcasts and courses -->
        <div
          :id="`${currentTab}Panel`"
          role="tabpanel"
          :aria-labelledby="`${currentTab}Tab`"
        >
          <div
            v-if="currentSortedList"
            class="select-container"
          >
            <!-- Not where the layer answered another sort than the one asked: the tab offers no choice -->
            <FtSelect
              v-if="currentSortedList.isSortOffered.value"
              v-show="currentSortedList.items.value.length > 1 || currentSortedList.cursor.value !== null || currentSortedList.sort.value !== 'newest'"
              :value="currentSortedList.sort.value"
              :select-names="currentSortedList.sortNames.value"
              :select-values="currentSortedList.sorts"
              :placeholder="t('Global.Sort By')"
              :icon="getIconForSortPreference(currentSortedList.sort.value)"
              @change="currentSortedList.changeSort"
            />
          </div>
          <!-- A PeerTube playlist links to its instance; a YouTube playlist
               opens on the app's own playlist page, through the existing
               card, and a short is `type: 'shortVideo'`, which the card badges -->
          <LayerPlaylistList
            v-if="currentTabInfo.playlists && !isYouTube"
            :playlists="currentList.items.value"
          />
          <FtElementList
            v-else
            :data="currentList.items.value"
            :use-channels-hidden-preference="false"
          />
          <p
            v-if="isFinishedAndEmpty(currentList)"
            class="message"
          >
            {{ currentTabInfo.empty }}
          </p>
        </div>
        <FtLoader v-if="currentList.loading.value" />
        <div
          v-else-if="currentList.error.value"
          class="pageError"
        >
          <p class="message">
            {{ errorMessage(currentList.error.value).text }}
          </p>
          <FtButton
            v-if="errorMessage(currentList.error.value).retryable"
            :label="t('Video.Try Again')"
            :icon="['fas', 'sync']"
            class="retryButton"
            @click="currentList.load"
          />
        </div>
        <FtAutoLoadNextPageWrapper
          v-else-if="hasMore(currentList)"
          @load-next-page="currentList.load"
        >
          <div
            class="getNextPage"
            role="button"
            tabindex="0"
            @click="currentList.load"
            @keydown.enter.space.prevent="currentList.load"
          >
            <FontAwesomeIcon :icon="['fas', 'search']" /> {{ t('Search Filters.Fetch more results') }}
          </div>
        </FtAutoLoadNextPageWrapper>
      </FtCard>
    </template>
  </div>
</template>

<script setup>
// The platform layer's channel view. It talks only to the injected layer and
// reads only the common shapes (platform/shapes.js); the route names the
// channel by its ref, as `:handle` (PeerTube's route) or `:id` (YouTube's,
// `/channel/:id/:currentTab?`). Where the platforms differ it is in the old
// views' own words: a YouTube channel reads as upstream's Channel view
// (views/Channel) does, which is the model for the layout and is not edited.

import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'

import FtAgeRestricted from '../../components/FtAgeRestricted/FtAgeRestricted.vue'
import FtAutoLoadNextPageWrapper from '../../components/FtAutoLoadNextPageWrapper.vue'
import FtButton from '../../components/FtButton/FtButton.vue'
import FtCard from '../../components/ft-card/ft-card.vue'
import FtElementList from '../../components/FtElementList/FtElementList.vue'
import FtLoader from '../../components/FtLoader/FtLoader.vue'
import FtSelect from '../../components/FtSelect/FtSelect.vue'
import LayerPlaylistList from '../../components/LayerPlaylistList/LayerPlaylistList.vue'
import LayerSubscribeButton from '../../components/LayerSubscribeButton/LayerSubscribeButton.vue'
import LayerVideoDescription from '../../components/LayerVideoDescription/LayerVideoDescription.vue'

import store from '../../store/index'
import { formatNumber, getIconForSortPreference } from '../../helpers/utils'
import { PLATFORM_YOUTUBE, isYouTubeChannelRef, parseChannelHandle, platformOf } from '../../platform/refs'
import { usePlatformLayer } from '../../platform/vue'

/** The sorts the layer takes for a channel's videos, newest (its default) first */
const VIDEO_SORTS = ['newest', 'popular', 'oldest']

/** The sorts the layer takes for a YouTube channel's own playlists, newest (its default) first */
const PLAYLIST_SORTS = ['newest', 'last']

const layer = usePlatformLayer()
const route = useRoute()
const { t } = useI18n()

// The route this view serves, so that its watchers ignore the navigation
// away. By its path, since YouTube's channel route has no name.
const viewRouteName = route.name
const viewRoutePath = route.matched.at(-1)?.path
const refParam = Object.hasOwn(route.params, 'handle') ? 'handle' : 'id'

function isOnThisView() {
  return route.matched.at(-1)?.path === viewRoutePath
}

const hideChannelSubscriptions = computed(() => store.getters.getHideChannelSubscriptions)
const showFamilyFriendlyOnly = computed(() => store.getters.getShowFamilyFriendlyOnly)

/** The channel ref the route names */
const channelRef = computed(() => route.params[refParam])

const isLoading = ref(true)
/** @type {import('vue').ShallowRef<import('../../platform/shapes').ChannelDetails | null>} */
const channel = shallowRef(null)
/** @type {import('vue').ShallowRef<{ kind?: string, reason?: string | null, host?: string | null, channel?: import('../../platform/shapes').ChannelSummary } | null>} */
const loadError = shallowRef(null)

const isYouTube = computed(() => channel.value
  ? platformOf(channel.value) === PLATFORM_YOUTUBE
  : isYouTubeChannelRef(channelRef.value))

/** YouTube's own rating, against the setting, as the old view checks it; PeerTube's channels have none */
const isFamilyFriendlyGated = computed(() => showFamilyFriendlyOnly.value === true && channel.value?.isFamilyFriendly === false)

const hideChannelShorts = computed(() => store.getters.getHideChannelShorts)
const hideLiveStreams = computed(() => store.getters.getHideLiveStreams)
const hideChannelReleases = computed(() => store.getters.getHideChannelReleases)
const hideChannelPodcasts = computed(() => store.getters.getHideChannelPodcasts)
const hideChannelCourses = computed(() => store.getters.getHideChannelCourses)

/**
 * The tabs this view has, in the old view's order, by the names of
 * `ChannelDetails.tabs`. Each has its list in `lists`. `named` is a tab only
 * a channel whose `tabs` names it has; `hidden` is the user's setting
 * against it; `empty` what its list says when the channel has nothing in it;
 * `playlists` a tab listing playlists.
 */
const tabs = computed(() => [
  { name: 'videos', label: t('Channel.Videos.Videos'), empty: t('Channel.Videos.This channel does not currently have any videos') },
  { name: 'shorts', label: t('Global.Shorts'), empty: t('Channel.Shorts.This channel does not currently have any shorts'), named: true, hidden: hideChannelShorts.value },
  { name: 'live', label: t('Channel.Live.Live'), empty: t('Channel.Live.This channel does not currently have any live streams'), named: true, hidden: hideLiveStreams.value },
  { name: 'releases', label: t('Channel.Releases.Releases'), empty: t('Channel.Releases.This channel does not currently have any releases'), named: true, hidden: hideChannelReleases.value, playlists: true },
  { name: 'podcasts', label: t('Channel.Podcasts.Podcasts'), empty: t('Channel.Podcasts.This channel does not currently have any podcasts'), named: true, hidden: hideChannelPodcasts.value, playlists: true },
  { name: 'courses', label: t('Channel.Courses.Courses'), empty: t('Channel.Courses.This channel does not currently have any courses'), named: true, hidden: hideChannelCourses.value, playlists: true },
  { name: 'playlists', label: t('Channel.Playlists.Playlists'), empty: t('Channel.Playlists.This channel does not currently have any playlists'), playlists: true },
])

/**
 * The tabs the channel has and the user does not hide: a tab its `tabs` does
 * not name is not shown, and PeerTube, which names none, has those every
 * channel has (not shorts or live). The first stands in for none.
 */
const visibleTabs = computed(() => {
  const named = channel.value?.tabs
  const shown = tabs.value.filter(tab => !tab.hidden && (Array.isArray(named) ? named.includes(tab.name) : !tab.named))

  return shown.length > 0 ? shown : tabs.value.slice(0, 1)
})

/** The tab the route names, else the first shown, as the old view falls back */
const currentTab = computed(() => {
  const names = visibleTabs.value.map(tab => tab.name)
  return names.includes(route.params.currentTab) ? route.params.currentTab : names[0]
})

const currentTabInfo = computed(() => tabs.value.find(tab => tab.name === currentTab.value))

const videoSortNames = computed(() => [
  t('Channel.Videos.Sort Types.Newest'),
  t('Channel.Videos.Sort Types.Most Popular'),
  t('Channel.Videos.Sort Types.Oldest'),
])

const playlistSortNames = computed(() => [
  t('Channel.Playlists.Sort Types.Newest'),
  t('Channel.Playlists.Sort Types.Last Video Added'),
])

/** Tells a load apart from the one that replaced it */
let loadsStarted = 0

/**
 * One of the channel's lists, read a page at a time. The cursor is the
 * layer's and handed back unchanged; `null` after the first page is the end.
 * An empty page with a cursor is not the end (filtering can empty a page).
 * `reset` forgets the list, and any answer still coming for it.
 * `onFirstPage` sees the first page of the current list as it is answered.
 *
 * @template T
 * @param {(cursor: unknown) => Promise<import('../../platform/shapes').Page<T>>} fetchPage
 * @param {(page: import('../../platform/shapes').Page<T>) => void} [onFirstPage]
 */
function createPagedList(fetchPage, onFirstPage) {
  /** @type {import('vue').ShallowRef<T[]>} */
  const items = shallowRef([])
  const cursor = shallowRef(null)
  /** Whether the first page has been answered */
  const loaded = ref(false)
  const loading = ref(false)
  const error = shallowRef(null)
  let generation = 0

  function reset() {
    generation++
    items.value = []
    cursor.value = null
    loaded.value = false
    loading.value = false
    error.value = null
  }

  /** The first page, or the next one; again after an error, the same one */
  async function load() {
    if (loading.value || (loaded.value && cursor.value === null)) {
      return
    }

    const thisGeneration = generation
    const isNext = loaded.value
    loading.value = true
    error.value = null

    try {
      const page = await fetchPage(isNext ? cursor.value : null)

      if (thisGeneration !== generation) {
        return
      }

      if (!isNext) {
        onFirstPage?.(page)
      }

      items.value = isNext ? [...items.value, ...page.items] : page.items
      cursor.value = page.cursor ?? null
      loaded.value = true
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

  return { items, cursor, loaded, loading, error, reset, load }
}

/**
 * One of the channel's lists in a sort of its own, newest (the first of
 * `sorts`) until another is chosen. Its sort select is offered until a first
 * page answers another sort than the one asked, which is a tab without that
 * filter (spec, "Phase 3 decisions", C1); the list is then in the sort the
 * layer applied, which the select would show. `reset` forgets the sort with
 * the list.
 *
 * @param {readonly string[]} sorts
 * @param {import('vue').ComputedRef<string[]>} sortNames
 * @param {(sort: string, cursor: unknown) => Promise<import('../../platform/shapes').Page<any>>} fetchPage
 */
function createSortedList(sorts, sortNames, fetchPage) {
  const sort = ref(sorts[0])
  const isSortOffered = ref(true)

  const list = createPagedList(
    cursor => fetchPage(sort.value, cursor),
    (page) => {
      if (page.sort !== undefined && page.sort !== sort.value) {
        isSortOffered.value = false
        sort.value = page.sort
      }
    }
  )

  /** @param {string} value */
  function changeSort(value) {
    if (value === sort.value || !sorts.includes(value)) {
      return
    }

    sort.value = value
    list.reset()
    list.load()
  }

  function reset() {
    sort.value = sorts[0]
    isSortOffered.value = true
    list.reset()
  }

  return { ...list, sorts, sortNames, sort, isSortOffered, changeSort, reset }
}

/** @param {'videos' | 'shorts' | 'live'} kind */
function createVideoList(kind) {
  return createSortedList(VIDEO_SORTS, videoSortNames, (sort, cursor) => layer.listChannelVideos(channel.value.id, { kind, sort, cursor }))
}

/** @param {'releases' | 'podcasts' | 'courses'} kind YouTube's tabs of playlists, which have one order */
function createPlaylistList(kind) {
  return createPagedList(cursor => layer.listChannelPlaylists(channel.value.id, { kind, cursor }))
}

/** The lists with a sort select, by the tab's name */
const sortedLists = {
  videos: createVideoList('videos'),
  shorts: createVideoList('shorts'),
  live: createVideoList('live'),
  // The channel's own playlists, newest or by the last video added (YouTube's)
  playlists: createSortedList(PLAYLIST_SORTS, playlistSortNames, (sort, cursor) =>
    layer.listChannelPlaylists(channel.value.id, { kind: 'playlists', sort, cursor })),
}

/** Each tab's list, by the tab's name */
const lists = {
  ...sortedLists,
  releases: createPlaylistList('releases'),
  podcasts: createPlaylistList('podcasts'),
  courses: createPlaylistList('courses'),
}

const currentList = computed(() => lists[currentTab.value])

/**
 * The current tab's list where it offers a sort, else `null`. A PeerTube
 * channel's playlists are in its own order: the playlist sort is YouTube's.
 */
const currentSortedList = computed(() => {
  if (currentTab.value === 'playlists' && !isYouTube.value) {
    return null
  }

  return sortedLists[currentTab.value] ?? null
})

/** @param {ReturnType<typeof createPagedList>} list */
function hasMore(list) {
  return list.loaded.value && list.cursor.value !== null
}

/** @param {ReturnType<typeof createPagedList>} list */
function isFinishedAndEmpty(list) {
  return list.loaded.value && list.cursor.value === null && list.items.value.length === 0
}

const followerCountText = computed(() => {
  const count = channel.value?.subscriberCount

  if (hideChannelSubscriptions.value || typeof count !== 'number') {
    return ''
  }

  // YouTube's in the old view's words (ChannelDetails.vue)
  return isYouTube.value
    ? t('Global.Counts.Subscriber Count', { count: formatNumber(count) }, count)
    : t('PeerTube.Channel.Followers', { count: formatNumber(count) }, count)
})

/** A PeerTube channel's ref is its handle; a YouTube channel without an `@handle` shows none */
const handleText = computed(() => channel.value?.handle ?? (isYouTube.value ? '' : channel.value?.id ?? ''))

/**
 * The same route, on another tab. By name where the route has one; YouTube's
 * has none, and vue-router resolves params alone against the current route.
 *
 * @param {string} tab
 */
function tabRoute(tab) {
  const params = { [refParam]: channelRef.value, currentTab: tab }
  return viewRouteName ? { name: viewRouteName, params } : { params }
}

/**
 * @param {{ kind?: string, reason?: string | null, host?: string | null }} error
 * @returns {{ text: string, retryable: boolean }}
 */
function errorMessage(error) {
  if (isYouTube.value) {
    return youTubeErrorMessage(error)
  }

  const host = error.host ?? channel.value?.host ?? parseChannelHandle(channelRef.value)?.host ?? channelRef.value

  switch (error.kind) {
    case 'notFound':
    case 'invalid':
      return { text: t('PeerTube.Channel.Not found', { host }), retryable: false }
    case 'unavailable':
      return { text: t('PeerTube.Channel.Unavailable', { host }), retryable: true }
    case 'rateLimited':
      return { text: t('PeerTube.Channel.Rate limited', { host }), retryable: true }
    default:
      return { text: t('PeerTube.Channel.Could not load'), retryable: true }
  }
}

/**
 * A YouTube channel's, in the old view's words where it has them. An age
 * gate is final: no backend can show the channel.
 *
 * @param {{ kind?: string, reason?: string | null }} error
 * @returns {{ text: string, retryable: boolean }}
 */
function youTubeErrorMessage(error) {
  if (error.kind === 'refused' && error.reason === 'ageRestricted') {
    return { text: t('Channel["This channel is age-restricted and currently cannot be viewed in FreeTube."]'), retryable: false }
  }

  if (error.kind === 'notFound' || error.kind === 'invalid') {
    return { text: t('Channel.This channel does not exist'), retryable: false }
  }

  return { text: t('PeerTube.Channel.Could not load'), retryable: true }
}

/** The current tab's first page, unless it is loaded, loading or failed, or the channel is not shown */
function loadCurrentTab() {
  const list = currentList.value

  if (channel.value !== null && !isFamilyFriendlyGated.value && !list.loaded.value && !list.loading.value && !list.error.value) {
    list.load()
  }
}

async function load() {
  const thisLoad = ++loadsStarted

  isLoading.value = true
  channel.value = null
  loadError.value = null

  for (const list of Object.values(lists)) {
    list.reset()
  }

  try {
    const details = await layer.getChannel(channelRef.value)

    if (thisLoad !== loadsStarted) {
      return
    }

    channel.value = details
    store.commit('setAppTitle', details.name)
  } catch (error) {
    if (thisLoad !== loadsStarted) {
      return
    }

    if (!error?.kind) {
      console.error(error)
    }

    loadError.value = error ?? {}

    if (error?.channel?.name) {
      store.commit('setAppTitle', error.channel.name)
    }
  } finally {
    if (thisLoad === loadsStarted) {
      isLoading.value = false
    }
  }

  loadCurrentTab()
}

// The router reuses this view for another channel
watch(channelRef, (value, previous) => {
  if (isOnThisView() && value !== previous) {
    load()
  }
})

watch([currentTab, isFamilyFriendlyGated], () => {
  if (isOnThisView()) {
    loadCurrentTab()
  }
})

onMounted(load)
</script>

<style scoped src="./LayerChannel.css" />
