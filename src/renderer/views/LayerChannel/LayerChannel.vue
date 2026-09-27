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
                <p class="handle">
                  {{ channel.handle ?? channel.id }}
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
              v-for="tab in tabs"
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
        <div
          v-if="currentTab === 'videos'"
          id="videosPanel"
          role="tabpanel"
          aria-labelledby="videosTab"
        >
          <div class="select-container">
            <FtSelect
              v-show="videos.items.value.length > 1 || videos.cursor.value !== null || videoSort !== 'newest'"
              :value="videoSort"
              :select-names="videoSortNames"
              :select-values="VIDEO_SORTS"
              :placeholder="t('Global.Sort By')"
              :icon="getIconForSortPreference(videoSort)"
              @change="changeVideoSort"
            />
          </div>
          <FtElementList
            :data="videos.items.value"
            :use-channels-hidden-preference="false"
          />
          <p
            v-if="isFinishedAndEmpty(videos)"
            class="message"
          >
            {{ t('Channel.Videos.This channel does not currently have any videos') }}
          </p>
        </div>
        <div
          v-else
          id="playlistsPanel"
          role="tabpanel"
          aria-labelledby="playlistsTab"
        >
          <LayerPlaylistList :playlists="playlists.items.value" />
          <p
            v-if="isFinishedAndEmpty(playlists)"
            class="message"
          >
            {{ t('Channel.Playlists.This channel does not currently have any playlists') }}
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
// The platform layer's channel view. Platform-neutral: it talks only to the
// injected layer and reads only the common shapes (platform/shapes.js); the
// route names the channel by its ref. Upstream's Channel view
// (views/Channel) is the model for the layout; it is not edited.

import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'

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
import { parseChannelHandle } from '../../platform/refs'
import { usePlatformLayer } from '../../platform/vue'

/** The sorts the layer takes for a channel's videos, newest (its default) first */
const VIDEO_SORTS = ['newest', 'popular', 'oldest']

const layer = usePlatformLayer()
const route = useRoute()
const { t } = useI18n()

// The route this view serves, so that its watchers ignore the navigation away
const viewRouteName = route.name

const hideChannelSubscriptions = computed(() => store.getters.getHideChannelSubscriptions)

const handle = computed(() => route.params.handle)
const currentTab = computed(() => route.params.currentTab === 'playlists' ? 'playlists' : 'videos')

const isLoading = ref(true)
/** @type {import('vue').ShallowRef<import('../../platform/shapes').ChannelDetails | null>} */
const channel = shallowRef(null)
/** @type {import('vue').ShallowRef<{ kind?: string, host?: string | null } | null>} */
const loadError = shallowRef(null)

/** @type {import('vue').Ref<'newest' | 'popular' | 'oldest'>} */
const videoSort = ref('newest')

const tabs = computed(() => [
  { name: 'videos', label: t('Channel.Videos.Videos') },
  { name: 'playlists', label: t('Channel.Playlists.Playlists') },
])

const videoSortNames = computed(() => [
  t('Channel.Videos.Sort Types.Newest'),
  t('Channel.Videos.Sort Types.Most Popular'),
  t('Channel.Videos.Sort Types.Oldest'),
])

/** Tells a load apart from the one that replaced it */
let loadsStarted = 0

/**
 * One of the channel's lists, read a page at a time. The cursor is the
 * layer's and handed back unchanged; `null` after the first page is the end.
 * An empty page with a cursor is not the end (filtering can empty a page).
 * `reset` forgets the list, and any answer still coming for it.
 *
 * @template T
 * @param {(cursor: unknown) => Promise<import('../../platform/shapes').Page<T>>} fetchPage
 */
function createPagedList(fetchPage) {
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

const videos = createPagedList(cursor => layer.listChannelVideos(channel.value.id, { sort: videoSort.value, cursor }))
const playlists = createPagedList(cursor => layer.listChannelPlaylists(channel.value.id, { cursor }))

const currentList = computed(() => currentTab.value === 'playlists' ? playlists : videos)

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

  return t('PeerTube.Channel.Followers', { count: formatNumber(count) }, count)
})

/**
 * @param {string} tab
 */
function tabRoute(tab) {
  return { name: viewRouteName, params: { handle: handle.value, currentTab: tab } }
}

/**
 * @param {{ kind?: string, host?: string | null }} error
 * @returns {{ text: string, retryable: boolean }}
 */
function errorMessage(error) {
  const host = error.host ?? channel.value?.host ?? parseChannelHandle(handle.value)?.host ?? handle.value

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

/** The current tab's first page, unless it is loaded, loading or failed */
function loadCurrentTab() {
  const list = currentList.value

  if (channel.value !== null && !list.loaded.value && !list.loading.value && !list.error.value) {
    list.load()
  }
}

/**
 * @param {string} sort
 */
function changeVideoSort(sort) {
  if (sort === videoSort.value || !VIDEO_SORTS.includes(sort)) {
    return
  }

  videoSort.value = sort
  videos.reset()
  videos.load()
}

async function load() {
  const thisLoad = ++loadsStarted

  isLoading.value = true
  channel.value = null
  loadError.value = null
  videoSort.value = 'newest'
  videos.reset()
  playlists.reset()

  try {
    const details = await layer.getChannel(handle.value)

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
  } finally {
    if (thisLoad === loadsStarted) {
      isLoading.value = false
    }
  }

  loadCurrentTab()
}

// The router reuses this view for another channel
watch(handle, (value, previous) => {
  if (route.name === viewRouteName && value !== previous) {
    load()
  }
})

watch(currentTab, () => {
  if (route.name === viewRouteName) {
    loadCurrentTab()
  }
})

onMounted(load)
</script>

<style scoped src="./LayerChannel.css" />
