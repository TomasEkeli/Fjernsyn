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
        <!-- The old header keeps the button on an error page only for a
             channel the active profile is subscribed to (ChannelDetails) -->
        <LayerSubscribeButton
          v-if="isSubscribedInActiveProfile(loadError.channel.id)"
          :channel="loadError.channel"
        />
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
              <!-- YouTube's actions are the old header's (ChannelDetails); a
                   PeerTube channel's link is shared as the watch page shares
                   a video's (LayerVideoInfo), and SponsorBlock is YouTube's -->
              <template v-if="isYouTube">
                <FtSponsorBlockExcludeChannelButton
                  :channel-id="channel.id"
                  :channel-name="channel.name"
                />
                <FtShareButton
                  v-if="!hideSharingActions"
                  :id="channel.id"
                  share-target-type="Channel"
                  class="shareIcon"
                />
              </template>
              <template v-else-if="!hideSharingActions && shareUrl">
                <FtIconButton
                  :title="t('PeerTube.Watch.Copy link')"
                  :icon="['fas', 'copy']"
                  theme="secondary"
                  class="copyLinkButton"
                  @click="copyLink"
                />
                <FtIconButton
                  :title="t('PeerTube.Watch.Open in browser')"
                  :icon="['fas', 'globe']"
                  theme="secondary"
                  class="openLinkButton"
                  @click="openLink"
                />
              </template>
              <LayerSubscribeButton
                :channel="channel"
                @subscribed="writeSubscriptionCacheOnSubscribe"
              />
            </div>
          </div>
          <div class="infoTabs">
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
            <!-- Search within the channel, where it has search, as in the old header (ChannelDetails) -->
            <FtInput
              v-if="showSearchBar"
              ref="searchBar"
              :placeholder="t('Channel.Search Channel')"
              :action-button-label="t('Search Bar.Search')"
              :value="searchQuery"
              :show-clear-text-button="true"
              class="channelSearch"
              :maxlength="255"
              @click="searchChannel"
            />
          </div>
        </div>
      </FtCard>
      <!-- A YouTube channel's description is on its about tab, as in the old view -->
      <LayerVideoDescription
        v-if="!isYouTube"
        :description="channel.description ?? ''"
        :kind="channel.descriptionKind"
        :base-url="channel.host ? `https://${channel.host}` : ''"
        class="card"
      />
      <FtCard class="card">
        <!-- One list per tab: the videos, shorts and live, the playlists, releases, podcasts and courses, the posts, the search results; and YouTube's about -->
        <div
          :id="`${currentTab}Panel`"
          role="tabpanel"
          :aria-labelledby="currentTabInfo.search ? null : `${currentTab}Tab`"
        >
          <LayerChannelAbout
            v-if="currentTabInfo.about"
            :description="channel.description ?? ''"
            :tags="channel.tags ?? []"
            :joined="channel.joined"
            :view-count="channel.viewCount"
            :video-count="channel.videoCount"
            :location="channel.location"
            :featured-channels="channel.featuredChannels ?? []"
          />
          <template v-else>
            <div
              v-if="showDensitySwitch || viewAllRoute || currentSortedList"
              class="select-container"
            >
              <!-- The old view's rule: not on a tab without a card grid (the
                   about tab, the posts, and PeerTube's playlists, a list of
                   their own), where the switch would visibly do nothing -->
              <FtDensitySwitch
                v-if="showDensitySwitch"
                class="channelDensity"
              />
              <FtButton
                v-if="viewAllRoute"
                class="viewAllButton"
                :label="t('Channel.View All')"
                @click="router.push(viewAllRoute)"
              />
              <!-- Not where the layer answered another sort than the one asked: the tab offers no choice -->
              <FtSelect
                v-if="currentSortedList?.isSortOffered.value"
                v-show="currentItems.length > 1 || currentSortedList.cursor.value !== null || currentSortedList.sort.value !== 'newest'"
                :value="currentSortedList.sort.value"
                :select-names="currentSortedList.sortNames.value"
                :select-values="currentSortedList.sorts.value"
                :placeholder="t('Global.Sort By')"
                :icon="getIconForSortPreference(currentSortedList.sort.value)"
                @change="currentSortedList.changeSort"
              />
            </div>
            <!-- A PeerTube playlist links to its instance; a YouTube playlist
                 opens on the app's own playlist page, through the existing
                 card, and a short is `type: 'shortVideo'`, which the card badges.
                 Posts are `type: 'community'`, which the list renders with the
                 existing post component, always as a list, as the old view
                 forces them -->
            <LayerPlaylistList
              v-if="currentTabInfo.playlists && !isYouTube"
              :playlists="currentList.items.value"
            />
            <FtElementList
              v-else
              :data="currentItems"
              :use-channels-hidden-preference="false"
              :display="currentTabInfo.posts ? 'list' : ''"
            />
            <p
              v-if="isFinishedAndEmpty(currentList, currentItems)"
              class="message"
            >
              {{ currentTabInfo.empty }}
            </p>
          </template>
        </div>
        <FtLoader v-if="currentList?.loading.value" />
        <div
          v-else-if="currentList?.error.value"
          class="pageError"
        >
          <p class="message">
            {{ listErrorMessage(currentList.error.value).text }}
          </p>
          <FtButton
            v-if="listErrorMessage(currentList.error.value).retryable"
            :label="t('Video.Try Again')"
            :icon="['fas', 'sync']"
            class="retryButton"
            @click="currentList.load"
          />
        </div>
        <FtAutoLoadNextPageWrapper
          v-else-if="currentList && hasMore(currentList)"
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
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

import FtAgeRestricted from '../../components/FtAgeRestricted/FtAgeRestricted.vue'
import FtAutoLoadNextPageWrapper from '../../components/FtAutoLoadNextPageWrapper.vue'
import FtButton from '../../components/FtButton/FtButton.vue'
import FtCard from '../../components/ft-card/ft-card.vue'
import FtDensitySwitch from '../../components/FtDensitySwitch/FtDensitySwitch.vue'
import FtElementList from '../../components/FtElementList/FtElementList.vue'
import FtIconButton from '../../components/FtIconButton/FtIconButton.vue'
import FtInput from '../../components/FtInput/FtInput.vue'
import FtLoader from '../../components/FtLoader/FtLoader.vue'
import FtSelect from '../../components/FtSelect/FtSelect.vue'
import FtShareButton from '../../components/FtShareButton/FtShareButton.vue'
import FtSponsorBlockExcludeChannelButton from '../../components/FtSponsorBlockExcludeChannelButton/FtSponsorBlockExcludeChannelButton.vue'
import LayerChannelAbout from '../../components/LayerChannelAbout/LayerChannelAbout.vue'
import LayerPlaylistList from '../../components/LayerPlaylistList/LayerPlaylistList.vue'
import LayerSubscribeButton from '../../components/LayerSubscribeButton/LayerSubscribeButton.vue'
import LayerVideoDescription from '../../components/LayerVideoDescription/LayerVideoDescription.vue'

import store from '../../store/index'
import {
  copyToClipboard,
  ctrlFHandler,
  formatNumber,
  getChannelPlaylistId,
  getIconForSortPreference,
  openExternalLink,
} from '../../helpers/utils'
import { PLATFORM_YOUTUBE, isYouTubeChannelRef, parseChannelHandle, platformOf } from '../../platform/refs'
import { subscriptionCacheEntries } from '../../platform/subscriptionCache'
import { usePlatformLayer } from '../../platform/vue'

/** The sorts the layer takes for a channel's videos, newest (its default) first */
const VIDEO_SORTS = ['newest', 'popular', 'oldest']

/** The sorts the layer takes for a YouTube channel's own playlists, newest (its default) first */
const PLAYLIST_SORTS = ['newest', 'last']

/** The tabs where the old view offers View All, each to the uploads playlist of its kind */
const VIEW_ALL_TABS = ['videos', 'shorts', 'live']

/**
 * The lists a YouTube channel's page writes into the subscription cache, as
 * the old view does, by the tab's name: the store action and its payload's key
 */
const SUBSCRIPTION_CACHE_LISTS = {
  videos: { action: 'updateSubscriptionVideosCacheByChannel', key: 'videos' },
  live: { action: 'updateSubscriptionLiveCacheByChannel', key: 'videos' },
  community: { action: 'updateSubscriptionPostsCacheByChannel', key: 'posts' },
}

const layer = usePlatformLayer()
const route = useRoute()
const router = useRouter()
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
const hideSharingActions = computed(() => store.getters.getHideSharingActions)
const showFamilyFriendlyOnly = computed(() => store.getters.getShowFamilyFriendlyOnly)

/** The channel ref the route names */
const channelRef = computed(() => route.params[refParam])

/**
 * The YouTube channel link the route holds (`?url=`, the old view's, from
 * the app's link handling), `''` for none: a link by name, resolved before
 * anything is loaded. Only on YouTube's route.
 */
const channelUrl = computed(() => {
  const value = refParam === 'id' ? route.query.url : undefined
  return typeof value === 'string' ? value : ''
})

const isLoading = ref(true)
/** @type {import('vue').ShallowRef<import('../../platform/shapes').ChannelDetails | null>} */
const channel = shallowRef(null)
/** @type {import('vue').ShallowRef<{ kind?: string, reason?: string | null, host?: string | null, channel?: import('../../platform/shapes').ChannelSummary } | null>} */
const loadError = shallowRef(null)

const isYouTube = computed(() => channel.value
  ? platformOf(channel.value) === PLATFORM_YOUTUBE
  : channelUrl.value !== '' || isYouTubeChannelRef(channelRef.value))

/** YouTube's own rating, against the setting, as the old view checks it; PeerTube's channels have none */
const isFamilyFriendlyGated = computed(() => showFamilyFriendlyOnly.value === true && channel.value?.isFamilyFriendly === false)

const hideChannelShorts = computed(() => store.getters.getHideChannelShorts)
const hideLiveStreams = computed(() => store.getters.getHideLiveStreams)
const hideChannelReleases = computed(() => store.getters.getHideChannelReleases)
const hideChannelPodcasts = computed(() => store.getters.getHideChannelPodcasts)
const hideChannelCourses = computed(() => store.getters.getHideChannelCourses)
const hideChannelCommunity = computed(() => store.getters.getHideChannelCommunity)
const hideChannelPlaylists = computed(() => store.getters.getHideChannelPlaylists)

/** The search within the channel the route holds (`?searchQueryText=`, the old view's), `''` for none */
const searchQuery = computed(() => {
  const value = route.query.searchQueryText
  return typeof value === 'string' ? value : ''
})

/** The search box, where the old view has it: a YouTube channel that can be searched */
const showSearchBar = computed(() => isYouTube.value && channel.value?.hasSearch === true)

/**
 * The tabs this view has, in the old view's order, by the names of
 * `ChannelDetails.tabs`. Each has its list in `lists`. `named` is a tab only
 * a channel whose `tabs` names it has; `hidden` is the user's setting
 * against it; `empty` what its list says when the channel has nothing in it;
 * `playlists` a tab listing playlists; `posts` the posts tab, a list layout
 * whatever the density setting; `about` YouTube's about tab, which every
 * YouTube channel has, as in the old view, and which lists nothing; `search`
 * the results of a search within the channel, which has no tab of its own in
 * the tab row, as in the old view, and is shown while the route holds one.
 */
const tabs = computed(() => [
  { name: 'videos', label: t('Channel.Videos.Videos'), empty: t('Channel.Videos.This channel does not currently have any videos') },
  { name: 'shorts', label: t('Global.Shorts'), empty: t('Channel.Shorts.This channel does not currently have any shorts'), named: true, hidden: hideChannelShorts.value },
  { name: 'live', label: t('Channel.Live.Live'), empty: t('Channel.Live.This channel does not currently have any live streams'), named: true, hidden: hideLiveStreams.value },
  { name: 'releases', label: t('Channel.Releases.Releases'), empty: t('Channel.Releases.This channel does not currently have any releases'), named: true, hidden: hideChannelReleases.value, playlists: true },
  { name: 'podcasts', label: t('Channel.Podcasts.Podcasts'), empty: t('Channel.Podcasts.This channel does not currently have any podcasts'), named: true, hidden: hideChannelPodcasts.value, playlists: true },
  { name: 'courses', label: t('Channel.Courses.Courses'), empty: t('Channel.Courses.This channel does not currently have any courses'), named: true, hidden: hideChannelCourses.value, playlists: true },
  // The setting is the old YouTube view's; PeerTube's channel page never read it
  { name: 'playlists', label: t('Channel.Playlists.Playlists'), empty: t('Channel.Playlists.This channel does not currently have any playlists'), hidden: hideChannelPlaylists.value && isYouTube.value, playlists: true },
  { name: 'community', label: t('Global.Posts'), empty: t('Channel.Posts.This channel currently does not have any posts'), named: true, hidden: hideChannelCommunity.value, posts: true },
  { name: 'about', label: t('Channel.About.About'), about: true },
  { name: 'search', empty: t('Channel.Your search results have returned 0 results'), search: true },
])

/**
 * The tabs the channel has and the user does not hide: a tab its `tabs` does
 * not name is not shown, and PeerTube, which names none, has those every
 * channel has (not shorts, live, releases, podcasts, courses or posts). A
 * PeerTube channel has no about tab: its description is above the tabs. The
 * first stands in for none.
 */
const visibleTabs = computed(() => {
  const named = channel.value?.tabs
  const shown = tabs.value.filter((tab) => {
    if (tab.search) {
      return false
    }

    if (tab.about) {
      return isYouTube.value
    }

    return !tab.hidden && (Array.isArray(named) ? named.includes(tab.name) : !tab.named)
  })

  return shown.length > 0 ? shown : tabs.value.slice(0, 1)
})

/**
 * The tab the route names, else the first shown, as the old view falls back.
 * The search results where the route holds a search of a channel that can be
 * searched.
 */
const currentTab = computed(() => {
  if (route.params.currentTab === 'search' && searchQuery.value !== '' && showSearchBar.value) {
    return 'search'
  }

  const names = visibleTabs.value.map(tab => tab.name)
  return names.includes(route.params.currentTab) ? route.params.currentTab : names[0]
})

const currentTabInfo = computed(() => tabs.value.find(tab => tab.name === currentTab.value))

/**
 * The video sorts the channel offers: an artist topic channel has no oldest
 * first, which the layer refuses, so the old view offers newest and popular
 */
const videoSorts = computed(() => channel.value?.isArtistTopicChannel ? VIDEO_SORTS.slice(0, 2) : VIDEO_SORTS)

const videoSortNames = computed(() => [
  t('Channel.Videos.Sort Types.Newest'),
  t('Channel.Videos.Sort Types.Most Popular'),
  t('Channel.Videos.Sort Types.Oldest'),
].slice(0, videoSorts.value.length))

const playlistSorts = computed(() => PLAYLIST_SORTS)

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
 * @param {import('vue').ComputedRef<readonly string[]>} sorts
 * @param {import('vue').ComputedRef<string[]>} sortNames
 * @param {(sort: string, cursor: unknown) => Promise<import('../../platform/shapes').Page<any>>} fetchPage
 * @param {(page: import('../../platform/shapes').Page<any>, sort: string) => void} [onFirstPage]
 *   sees the first page with the sort it is in
 */
function createSortedList(sorts, sortNames, fetchPage, onFirstPage) {
  const sort = ref(sorts.value[0])
  const isSortOffered = ref(true)

  const list = createPagedList(
    cursor => fetchPage(sort.value, cursor),
    (page) => {
      if (page.sort !== undefined && page.sort !== sort.value) {
        isSortOffered.value = false
        sort.value = page.sort
      }

      onFirstPage?.(page, sort.value)
    }
  )

  /** @param {string} value */
  function changeSort(value) {
    if (value === sort.value || !sorts.value.includes(value)) {
      return
    }

    sort.value = value
    list.reset()
    list.load()
  }

  function reset() {
    sort.value = sorts.value[0]
    isSortOffered.value = true
    list.reset()
  }

  return { ...list, sorts, sortNames, sort, isSortOffered, changeSort, reset }
}

/** @param {'videos' | 'shorts' | 'live'} kind */
function createVideoList(kind) {
  return createSortedList(
    videoSorts,
    videoSortNames,
    (sort, cursor) => layer.listChannelVideos(channel.value.id, { kind, sort, cursor }),
    (page, sort) => writeFirstPageToSubscriptionCache(kind, page, sort)
  )
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
  playlists: createSortedList(playlistSorts, playlistSortNames, (sort, cursor) =>
    layer.listChannelPlaylists(channel.value.id, { kind: 'playlists', sort, cursor })),
}

/** Each tab's list, by the tab's name */
const lists = {
  ...sortedLists,
  releases: createPlaylistList('releases'),
  podcasts: createPlaylistList('podcasts'),
  courses: createPlaylistList('courses'),
  // YouTube's community posts, in its one order
  community: createPagedList(
    cursor => layer.listChannelPosts(channel.value.id, { cursor }),
    page => writeFirstPageToSubscriptionCache('community', page, 'newest')
  ),
  // The search the route holds; a later page keeps the query of the first
  search: createPagedList(cursor => layer.searchChannel(channel.value.id, searchQuery.value, { cursor })),
}

/** The current tab's list; none on the about tab */
const currentList = computed(() => lists[currentTab.value] ?? null)

/** The current list's items: the search's playlists are hidden with the playlists, as in the old view */
const currentItems = computed(() => {
  const items = currentList.value?.items.value ?? []
  return currentTab.value === 'search' && hideChannelPlaylists.value ? items.filter(item => item.type !== 'playlist') : items
})

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

/**
 * Whether the tab lists cards in the density setting's layout, so that the
 * density switch shows: not the about tab, not the posts (always a list), not
 * a PeerTube channel's playlists (a list of their own)
 */
const showDensitySwitch = computed(() => {
  const tab = currentTabInfo.value
  return !tab.about && !tab.posts && !(tab.playlists && !isYouTube.value)
})

/**
 * View All, as the old view offers it: on a YouTube channel's videos, shorts
 * and live, newest or popular, when there is more than one card or more to
 * come, to the uploads playlist of that kind and sort. `null` where it is not
 * offered.
 */
const viewAllRoute = computed(() => {
  const tab = currentTab.value

  if (!isYouTube.value || !VIEW_ALL_TABS.includes(tab)) {
    return null
  }

  const list = sortedLists[tab]
  const sort = list.sort.value

  if ((sort !== 'newest' && sort !== 'popular') || !(hasMore(list) || currentItems.value.length > 1)) {
    return null
  }

  return `/playlist/${getChannelPlaylistId(channel.value.id, tab, sort)}`
})

/** A PeerTube channel's canonical URL on its origin, to share and open */
const shareUrl = computed(() => channel.value?.url || (channel.value ? layer.describe(channel.value).shareUrl : null))

function copyLink() {
  copyToClipboard(shareUrl.value, { messageOnSuccess: t('PeerTube.Watch.Link copied') })
}

function openLink() {
  openExternalLink(shareUrl.value)
}

/** @param {ReturnType<typeof createPagedList>} list */
function hasMore(list) {
  return list.loaded.value && list.cursor.value !== null
}

/**
 * @param {ReturnType<typeof createPagedList>} list
 * @param {unknown[]} [items] what is shown of it
 */
function isFinishedAndEmpty(list, items = list.items.value) {
  return list.loaded.value && list.cursor.value === null && items.length === 0
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

/**
 * A list's error. A search refused as `invalid` is a channel that cannot be
 * searched, in the old view's words, not one that does not exist.
 *
 * @param {{ kind?: string, reason?: string | null, host?: string | null }} error
 * @returns {{ text: string, retryable: boolean }}
 */
function listErrorMessage(error) {
  if (currentTab.value === 'search' && error.kind === 'invalid') {
    return { text: t('Channel.This channel does not allow searching'), retryable: false }
  }

  return errorMessage(error)
}

/**
 * Searches the channel for the query typed in the box, in the route, so
 * that a reload or a link lands on the same results; the old view replaces
 * the route as this does. The same search again is asked afresh.
 *
 * @param {string} query
 */
function searchChannel(query) {
  if (typeof query !== 'string' || query.trim() === '') {
    return
  }

  if (query === searchQuery.value && currentTab.value === 'search') {
    lists.search.reset()
    loadCurrentTab()
    return
  }

  router.replace({ ...tabRoute('search'), query: { searchQueryText: query } })
}

const searchBar = useTemplateRef('searchBar')

/**
 * Ctrl+F (Cmd+F) to the search box, as on the old page
 *
 * @param {KeyboardEvent} event
 */
function keyboardShortcutHandler(event) {
  ctrlFHandler(event, searchBar.value)
}

/**
 * A list's first page, unless it is loaded, loading or failed, or the
 * channel is not shown
 *
 * @param {ReturnType<typeof createPagedList> | null} list
 */
function loadFirstPage(list) {
  if (list !== null && channel.value !== null && !isFamilyFriendlyGated.value && !list.loaded.value && !list.loading.value && !list.error.value) {
    list.load()
  }
}

/** The current tab's first page; none where the tab lists nothing */
function loadCurrentTab() {
  loadFirstPage(currentList.value)
}

// ---------------------------------------------------------------------------
// What a YouTube channel's page writes, as the old view does (spec, "Phase 3
// decisions", C9): the subscription's name and avatar, and its videos, live
// and posts into the subscription cache. A PeerTube channel's page writes
// neither.
// ---------------------------------------------------------------------------

/** The cached lists a subscription asked to be written whatever their first page holds */
const subscribeWrites = new Set()

/** Whether a profile is subscribed to the channel */
function isSubscribedInAnyProfile() {
  return store.getters.getSubscribedChannelIdSet.has(channel.value.id)
}

/**
 * Whether the active profile is subscribed to the channel, as the old view's
 * `isSubscribed`
 *
 * @param {string} id
 */
function isSubscribedInActiveProfile(id) {
  return store.getters.getActiveProfile.subscriptions.some(subscription => subscription.id === id)
}

/** @param {string} tab */
function isTabShown(tab) {
  return visibleTabs.value.some(shown => shown.name === tab)
}

/**
 * Writes a list into the subscription cache for the channel, as the feed's
 * own fetchers write it (`platform/subscriptionCache.js`)
 *
 * @param {keyof typeof SUBSCRIPTION_CACHE_LISTS} tab
 * @param {object[]} items
 */
function writeSubscriptionCache(tab, items) {
  const { action, key } = SUBSCRIPTION_CACHE_LISTS[tab]
  store.dispatch(action, { channelId: channel.value.id, [key]: subscriptionCacheEntries(items) })
}

/**
 * A first page of the videos, live or posts, into the subscription cache
 * where the old view writes it: newest first, holding something, for a
 * channel a profile is subscribed to. A later page, another sort, or the
 * shorts (whose dates the tab lacks), never.
 *
 * @param {string} tab
 * @param {import('../../platform/shapes').Page<any>} page
 * @param {string} sort the sort the page is in
 */
function writeFirstPageToSubscriptionCache(tab, page, sort) {
  const subscribing = subscribeWrites.delete(tab)

  if (!Object.hasOwn(SUBSCRIPTION_CACHE_LISTS, tab) || !isYouTube.value || channel.value === null || sort !== 'newest') {
    return
  }

  if (subscribing || (page.items.length > 0 && isSubscribedInAnyProfile())) {
    writeSubscriptionCache(tab, page.items)
  }
}

/**
 * The old view loads every tab with the channel, and so writes a subscribed
 * channel's videos, live and posts however it is opened. This page loads a
 * tab when it is shown, so for a subscribed channel it loads those three
 * too, where the channel has them and they are not hidden, as the old view
 * would.
 */
function loadSubscriptionCacheLists() {
  if (!isYouTube.value || channel.value === null || !isSubscribedInAnyProfile()) {
    return
  }

  for (const tab of Object.keys(SUBSCRIPTION_CACHE_LISTS)) {
    if (isTabShown(tab)) {
      loadFirstPage(lists[tab])
    }
  }
}

/**
 * On subscribing, as the old view's `handleSubscription`: each list loaded
 * newest first is written as it stands (even empty), and one not loaded yet
 * is loaded and written when it answers, so the feed has the channel at
 * once.
 */
function writeSubscriptionCacheOnSubscribe() {
  if (!isYouTube.value || channel.value === null) {
    return
  }

  for (const tab of Object.keys(SUBSCRIPTION_CACHE_LISTS)) {
    const list = lists[tab]

    if (list.loaded.value) {
      if ((sortedLists[tab]?.sort.value ?? 'newest') === 'newest') {
        writeSubscriptionCache(tab, list.items.value)
      }
    } else if (isTabShown(tab)) {
      subscribeWrites.add(tab)
      loadFirstPage(list)
    }
  }
}

/**
 * The subscription's name and avatar, as the old view refreshes them on
 * every load, the age-gated channel's from its refusal. A name or avatar
 * the channel does not have leaves the stored one.
 *
 * @param {{ id: string, name?: string, thumbnail?: string }} shown
 */
function updateSubscriptionDetails(shown) {
  store.dispatch('updateSubscriptionDetails', {
    channelThumbnailUrl: shown.thumbnail || null,
    channelName: shown.name || null,
    channelId: shown.id,
  })
}

/**
 * The route's channel link, resolved to its `UC` ref, and the route replaced
 * with that channel's on the same tab, as the old view does: so back and
 * forward land on the resolved route and never resolve again. The old view
 * keeps no other query. The route change loads the channel. A link that
 * resolves to no channel says so, as a channel that does not exist.
 *
 * @param {number} thisLoad
 */
async function resolveChannelUrl(thisLoad) {
  try {
    const id = await layer.resolveChannel(channelUrl.value)

    if (thisLoad !== loadsStarted) {
      return
    }

    const tab = route.params.currentTab
    router.replace({ path: tab ? `/channel/${id}/${tab}` : `/channel/${id}` })
  } catch (error) {
    if (thisLoad !== loadsStarted) {
      return
    }

    if (!error?.kind) {
      console.error(error)
    }

    loadError.value = error ?? {}
    isLoading.value = false
  }
}

async function load() {
  const thisLoad = ++loadsStarted

  isLoading.value = true
  channel.value = null
  loadError.value = null
  subscribeWrites.clear()

  for (const list of Object.values(lists)) {
    list.reset()
  }

  if (channelUrl.value !== '') {
    await resolveChannelUrl(thisLoad)
    return
  }

  try {
    const details = await layer.getChannel(channelRef.value)

    if (thisLoad !== loadsStarted) {
      return
    }

    channel.value = details
    store.commit('setAppTitle', details.name)

    if (platformOf(details) === PLATFORM_YOUTUBE) {
      updateSubscriptionDetails(details)
    }
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

    // YouTube's age gate, whose name and avatar the old view stores too
    if (error?.channel && isYouTubeChannelRef(channelRef.value)) {
      updateSubscriptionDetails({ ...error.channel, id: error.channel.id || channelRef.value })
    }
  } finally {
    if (thisLoad === loadsStarted) {
      isLoading.value = false
    }
  }

  loadCurrentTab()
  loadSubscriptionCacheLists()
}

// The router reuses this view for another channel, another link to resolve
// (or the one just resolved), or another search of it
watch([channelRef, channelUrl, searchQuery], ([ref, url, query], [previousRef, previousUrl, previousQuery]) => {
  if (!isOnThisView()) {
    return
  }

  if (ref !== previousRef || url !== previousUrl) {
    load()
  } else if (query !== previousQuery) {
    lists.search.reset()
    loadCurrentTab()
  }
})

watch([currentTab, isFamilyFriendlyGated], () => {
  if (isOnThisView()) {
    loadCurrentTab()
  }
})

onMounted(() => {
  document.addEventListener('keydown', keyboardShortcutHandler)
  load()
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', keyboardShortcutHandler)
})
</script>

<style scoped src="./LayerChannel.css" />
