<template>
  <div class="communitiesWall">
    <slot name="header" />
    <div
      class="controlRow"
      :class="{ withoutChips: !chipsShown }"
    >
      <div
        v-if="chipsShown"
        class="chipRow"
        role="group"
        :aria-label="$t('Communities.Sources Shown')"
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
          {{ $t('Communities.Refresh Failed', { sources: failedSourceNames }) }}
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
            {{ $t('Communities.Sort By') }}
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
          <button
            type="button"
            class="sortDirection"
            :aria-label="sortDirectionLabel"
            :title="sortDirectionLabel"
            @click="descending = !descending"
          >
            <FontAwesomeIcon
              :icon="['fas', descending ? 'arrow-down' : 'arrow-up']"
              fixed-width
            />
          </button>
        </div>
        <div
          v-if="categoryShown"
          class="picker"
        >
          <label
            class="pickerLabel"
            :for="categorySelectId"
          >
            {{ $t('Communities.Category') }}
          </label>
          <select
            :id="categorySelectId"
            v-model="category"
            class="pickerSelect categorySelect"
          >
            <option value="">
              {{ $t('Communities.All Categories') }}
            </option>
            <optgroup
              v-for="area in categoryGroups"
              :key="area.id"
              :label="area.name"
            >
              <option
                v-for="option in area.categories"
                :key="option.id"
                :value="option.id"
              >
                {{ option.name }}
              </option>
            </optgroup>
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
      {{ $t('Communities.No Sources Shown') }}
    </p>
    <p
      v-else-if="videos.length === 0"
      class="message"
    >
      {{ bundleFailed ? $t('Communities.Load Failed') : $t('Communities.Nothing Shared') }}
    </p>
    <p
      v-else-if="categoryVideos.length === 0"
      class="message"
    >
      {{ $t('Communities.Nothing In Category') }}
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
          :label="$t('Communities.Load More')"
          background-color="var(--primary-color)"
          text-color="var(--text-with-main-color)"
          @click="increaseLimit"
        />
      </FtFlexBox>
    </FtAutoLoadNextPageWrapper>
  </div>
</template>

<script setup>
import { computed, h, onBeforeUnmount, onMounted, provide, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'

import AiChip from '../AiChip/AiChip.vue'
import CommunitiesVoteBadge from '../CommunitiesVoteBadge/CommunitiesVoteBadge.vue'
import FtAutoLoadNextPageWrapper from '../FtAutoLoadNextPageWrapper.vue'
import FtButton from '../FtButton/FtButton.vue'
import FtElementList from '../FtElementList/FtElementList.vue'
import FtFlexBox from '../ft-flex-box/ft-flex-box.vue'
import FtLoader from '../FtLoader/FtLoader.vue'
import FtRefreshWidget from '../FtRefreshWidget/FtRefreshWidget.vue'
import FtToggleChip from '../FtToggleChip/FtToggleChip.vue'

import store from '../../store/index'

import { communitiesCrawlProgress, startCommunitiesCrawl } from '../../helpers/communities/crawlRunner'
import { detailsProgress } from '../../helpers/communities/details'
import { categoryAreas, categoryOf, withCategory } from '../../helpers/communities/category'
import { HACKERTUBE_SOURCE_ID } from '../../helpers/communities/hackertube'
import { shippedHackerTubeTaxonomy } from '../../helpers/communities/hackertubeBundle'
import { communitySortOf, wallVideos } from '../../helpers/communities/shares'
import { hiddenSourcesWith, shownSourceIds, sourcesByName } from '../../helpers/communities/sourceChips'
import { aiIsShown, withAiPreference } from '../../helpers/aiShown'
import { setWatchedShown, watchedIsShown, withWatchedPreference } from '../../helpers/watchedShown'
import { THUMBNAIL_BADGE } from '../../helpers/thumbnailBadge'
import { KeyboardShortcuts } from '../../../constants'

/**
 * The wall of a community: Communities' wall of every followed source's
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
 * Opening it, on either page, opens Communities: the first open follows the
 * starter set, once per installation (applyCommunitiesStarterSet,
 * helpers/communities/starterSet.js), and while HackerTube is followed loads
 * the copy of its data the app ships with (store/modules/communities.js). Every open then
 * refreshes, when the last refresh was more than an hour ago, asking each
 * followed source what it shares now (helpers/communities/refresh.js); the
 * refresh button and R or F5 refresh at any time, every source, whichever
 * page it is pressed on. Beside it the crawl starts, which fetches each
 * video's own details in the background (helpers/communities/crawl.js); as
 * they come in, the cards show duration, views and date, and link to their
 * channel.
 *
 * The control row is the subscriptions page's and Explore's. On Communities
 * it starts with a chip per followed source, saying whose videos are on the
 * wall (helpers/communities/sourceChips.js); a source's page has none, as it
 * is one source's wall. Then the refresh widget, which says how fresh the
 * wall is, or what is being done to it, the refresh or the crawl, with how
 * far along it is. At the far end the Watched and AI pills, the same
 * settings as on every wall that has them, and the order the wall is in:
 * upvotes, shared on community, video published or views, with a button
 * beside it that reverses it. Which shares count
 * for the order is which sources are shown: the chips' on Communities, the
 * source's own on its page (`communityValues` in helpers/communities/
 * shares.js). Last, on HackerTube's own page only, one of HackerTube's
 * categories, which leaves only the videos HackerTube put in it
 * (helpers/communities/category.js); Communities has none, and ignores a
 * choice made there. The `header` slot comes above the row.
 *
 * Each card carries the vote badge, the votes that order the wall, quietly
 * at the top left of its thumbnail.
 */

const props = defineProps({
  /** The source whose wall this is; none for Communities' wall of every source */
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

/**
 * The vote badge on every card of this wall, told whose page it is on, which
 * decides what hovering it shows (components/CommunitiesVoteBadge). Cards
 * draw what a wall provides (helpers/thumbnailBadge.js), so that nothing
 * between here and them has to hand it down, and no other wall has one.
 *
 * @param {{ video: object }} badgeProps
 */
function VoteBadge(badgeProps) {
  return h(CommunitiesVoteBadge, { video: badgeProps.video, sourceId: props.sourceId })
}
VoteBadge.props = ['video']

provide(THUMBNAIL_BADGE, VoteBadge)

/** @type {import('vue').ComputedRef<boolean>} */
const ready = computed(() => store.getters.getCommunitiesReady)

/** @type {import('vue').ComputedRef<boolean>} */
const loading = computed(() => store.getters.getCommunitiesLoading)

/** @type {import('vue').ComputedRef<boolean>} */
const loadFailed = computed(() => store.getters.getCommunitiesLoadFailed)

/**
 * Whether to say the bundle could not be loaded: on the walls its videos are
 * on, Communities' and HackerTube's own, and not on another source's, which
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
 * @type {import('vue').ComputedRef<import('../../helpers/communities/shares').Source[]>}
 */
const chips = computed(() => sourcesByName(store.getters.getCommunitySources))

/**
 * Whether the row has chips: on Communities, with any source followed; a
 * source's page is one source's wall, and has none
 *
 * @type {import('vue').ComputedRef<boolean>}
 */
const chipsShown = computed(() => props.sourceId === null && chips.value.length > 0)

/**
 * The sources whose shares count on this wall: the source's own on its page,
 * whatever its chip on Communities says; and on Communities every source
 * followed whose chip is on, so that a share of a source unfollowed while it
 * was being written never shows
 *
 * @type {import('vue').ComputedRef<Set<string>>}
 */
const shownSources = computed(() => {
  if (props.sourceId !== null) {
    return new Set([props.sourceId])
  }

  return shownSourceIds(store.getters.getCommunitySources, store.getters.getCommunitiesSourcesHidden)
})

/**
 * @param {string} sourceId
 */
function toggleSource(sourceId) {
  const hidden = store.getters.getCommunitiesSourcesHidden
  store.dispatch('updateCommunitiesSourcesHidden', hiddenSourcesWith(hidden, sourceId, !shownSources.value.has(sourceId)))
    .catch((error) => {
      console.error(`Communities: could not keep the chip of ${sourceId}`, error)
    })
}

/**
 * Whether every chip is off on Communities, with sources followed, which
 * "nothing shared" would explain wrongly
 *
 * @type {import('vue').ComputedRef<boolean>}
 */
const noSourceShown = computed(() => {
  return props.sourceId === null && store.getters.getCommunitySources.length > 0 && shownSources.value.size === 0
})

/**
 * The wall's order, kept as a setting, so that it is the same on Communities
 * and every source's page and outlasts a restart
 *
 * @type {import('vue').WritableComputedRef<import('../../helpers/communities/shares').CommunitySort>}
 */
const sort = computed({
  get: () => communitySortOf(store.getters.getCommunitiesSort),
  set: (value) => {
    store.dispatch('updateCommunitiesSort', value).catch((error) => {
      console.error('Communities: could not keep the order of the wall', error)
    })
  },
})

const sortSelectId = useId()

/**
 * Whether the wall's order is descending, the most or the newest first, or
 * reversed; a setting as the order is. Anything but false is descending
 *
 * @type {import('vue').WritableComputedRef<boolean>}
 */
const descending = computed({
  get: () => store.getters.getCommunitiesSortDescending !== false,
  set: (value) => {
    store.dispatch('updateCommunitiesSortDescending', value).catch((error) => {
      console.error('Communities: could not keep the direction of the wall\'s order', error)
    })
  },
})

/**
 * The direction button's name, which says the direction the wall is in
 *
 * @type {import('vue').ComputedRef<string>}
 */
const sortDirectionLabel = computed(() => {
  return descending.value ? t('Communities.Sort Descending') : t('Communities.Sort Ascending')
})

/**
 * The orders on offer, in the order the spec names them. Spelled out, as a
 * message's key may not be built
 *
 * @type {import('vue').ComputedRef<{ value: import('../../helpers/communities/shares').CommunitySort, label: string }[]>}
 */
const sortOptions = computed(() => [
  { value: 'published', label: t('Communities.Sorts.Published') },
  { value: 'shared', label: t('Communities.Sorts.Shared') },
  { value: 'views', label: t('Communities.Sorts.Views') },
  { value: 'votes', label: t('Communities.Sorts.Upvotes') },
])

/**
 * The wall of the sources shown, in the order chosen, before the pills
 *
 * @type {import('vue').ComputedRef<import('../../helpers/communities/shares').CommunityVideo[]>}
 */
const videos = computed(() => {
  return wallVideos(store.getters.getCommunityShares, store.getters.getCommunityVideos, {
    shown: shownSources.value,
    sort: sort.value,
    descending: descending.value,
    // As every PeerTube wall: what its uploader marked NSFW only when asked for
    showNsfw: store.getters.getPeerTubeShowNsfw,
  })
})

/**
 * HackerTube's taxonomy: the one kept with its data, or for an installation
 * that loaded its data before that was kept, the shipped bundle's
 *
 * @type {import('vue').Ref<import('../../helpers/communities/hackertube').HackerTubeTaxonomy | null>}
 */
const shippedTaxonomy = ref(null)

/** @type {import('vue').ComputedRef<import('../../helpers/communities/hackertube').HackerTubeTaxonomy | null>} */
const taxonomy = computed(() => {
  return store.getters.getCommunitySourceData(HACKERTUBE_SOURCE_ID)?.taxonomy ?? shippedTaxonomy.value
})

/** @type {import('vue').ComputedRef<import('../../helpers/communities/hackertube').HackerTubeTaxonomy['areas']>} */
const categoryGroups = computed(() => categoryAreas(taxonomy.value))

/**
 * Whether this is HackerTube's own page, followed, the one wall with the
 * category select: on Communities, where its videos are among every other
 * source's, it would take too much room for what it does
 *
 * @type {import('vue').ComputedRef<boolean>}
 */
const hackerTubeShown = computed(() => {
  return props.sourceId === HACKERTUBE_SOURCE_ID &&
    store.getters.getCommunitySources.some(source => source._id === HACKERTUBE_SOURCE_ID)
})

watch(() => hackerTubeShown.value && taxonomy.value === null, (wanted) => {
  if (wanted) {
    shippedHackerTubeTaxonomy().then((shipped) => {
      shippedTaxonomy.value = shipped
    }, (error) => {
      console.error('Communities: could not read the categories of the HackerTube bundle', error)
    })
  }
}, { immediate: true })

/** @type {import('vue').ComputedRef<boolean>} */
const categoryShown = computed(() => hackerTubeShown.value && categoryGroups.value.length > 0)

const CATEGORY_KEY = 'communitiesCategory'

/**
 * The category chosen on HackerTube's page, for the session; '' is all
 */
const chosenCategory = ref(sessionStorage.getItem(CATEGORY_KEY) ?? '')

/**
 * The select's value: the category chosen while the taxonomy has it, else
 * all
 *
 * @type {import('vue').WritableComputedRef<string>}
 */
const category = computed({
  get: () => categoryOf(chosenCategory.value, taxonomy.value) ?? '',
  set: (value) => {
    chosenCategory.value = value
    if (value === '') {
      sessionStorage.removeItem(CATEGORY_KEY)
    } else {
      sessionStorage.setItem(CATEGORY_KEY, value)
    }
  },
})

const categorySelectId = useId()

/**
 * The wall in the category chosen, while its select is shown: elsewhere,
 * Communities included, the choice waits, and the wall is whole
 *
 * @type {import('vue').ComputedRef<import('../../helpers/communities/shares').CommunityVideo[]>}
 */
const categoryVideos = computed(() => {
  const chosen = categoryShown.value ? categoryOf(chosenCategory.value, taxonomy.value) : null
  return withCategory(videos.value, store.getters.getCommunityShares, chosen)
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

/** @type {import('vue').ComputedRef<import('../../helpers/communities/shares').CommunityVideo[]>} */
const unwatchedVideos = computed(() => withWatchedPreference(categoryVideos.value))

/**
 * The wall as shown: less what has been watched, while the Watched pill is
 * off, and what is made with AI, while the AI pill is, taken out before the
 * wall is cut into pages, as on the subscriptions page, so that a page of
 * them does not stand empty while more is to be had below
 *
 * @type {import('vue').ComputedRef<import('../../helpers/communities/shares').CommunityVideo[]>}
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
const refreshing = computed(() => store.getters.getCommunitiesRefreshing)

/** @type {import('vue').ComputedRef<boolean>} */
const canRefresh = computed(() => {
  return ready.value && !loading.value && !refreshing.value && !store.getters.getCommunitiesGrabFailed
})

/**
 * When every followed source was last refreshed by, kept on their records,
 * so it holds across restarts
 *
 * @type {import('vue').ComputedRef<number | null>}
 */
const lastRefreshAt = computed(() => store.getters.getCommunitiesLastRefreshAt)

/**
 * The sources whose last refresh failed, by name, which kept everything they
 * had; empty when none did
 *
 * @type {import('vue').ComputedRef<string>}
 */
const failedSourceNames = computed(() => {
  return store.getters.getCommunitiesRefreshFailures.map(source => source.name).join(', ')
})

/** @type {import('vue').ComputedRef<'running' | 'paused' | null>} */
const crawlShown = computed(() => {
  const state = communitiesCrawlProgress.state
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
  if (refreshing.value) { return t('Communities.Refreshing') }
  if (crawlShown.value === 'running') { return t('Communities.Crawl Progress') }
  if (crawlShown.value === 'paused') { return t('Communities.Crawl Paused') }
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
    const { done, total } = store.getters.getCommunitiesRefreshProgress
    return total > 1 ? done / total : null
  }

  if (crawlShown.value !== null) {
    // Counted over the shares, without building the wall again
    const { done, total } = detailsProgress(store.getters.getCommunityShares, store.getters.getCommunityVideos, Date.now())
    return total > 0 ? done / total : null
  }

  return null
})

function refresh() {
  if (canRefresh.value) {
    store.dispatch('refreshCommunities')
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

const limitKey = props.sourceId === null ? 'communitiesLimit' : `communitiesLimit:${props.sourceId}`

// Anything but a whole number of at least one is taken as never widened
const savedLimit = parseInt(sessionStorage.getItem(limitKey) ?? '')

const dataLimit = ref(Number.isInteger(savedLimit) && savedLimit > 0 ? savedLimit : PAGE_SIZE)

/** @type {import('vue').ComputedRef<import('../../helpers/communities/shares').CommunityVideo[]>} */
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
    await store.dispatch('openCommunities')
    opened.value = true

    store.dispatch('refreshCommunitiesIfDue').catch((error) => {
      console.error('Communities: the refresh on open failed', error)
    })
  }
}, { immediate: true })

// The crawl, once the page is open and there are videos: at once, or when a
// refresh brings the videos a failed bundle load could not. It fetches the
// details of every source's videos, whichever page started it.
watch(() => opened.value && !loadFailed.value && store.getters.getCommunityShares.length > 0, (canCrawl) => {
  if (canCrawl) {
    startCommunitiesCrawl()
  }
}, { immediate: true })
</script>

<style scoped src="../FtToggleChip/chipRow.css" />
<style scoped src="../FtToggleChip/pickerSelect.css" />
<style scoped src="./CommunitiesWall.css" />
