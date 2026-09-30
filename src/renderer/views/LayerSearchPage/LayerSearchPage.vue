<template>
  <div>
    <FtCard class="card">
      <div class="headingRow">
        <h2>
          <FontAwesomeIcon
            :icon="['fas', 'search']"
            class="headingIcon"
          />
          {{ t('Layer Search.Results for', { query: query.text }) }}
        </h2>
        <FtDensitySwitch />
      </div>
      <nav
        v-if="peertubeEnabled"
        class="tabs"
        role="tablist"
        :aria-label="t('Layer Search.Scope.Scope')"
      >
        <button
          v-for="scope in SCOPES"
          :id="`${scope}ScopeTab`"
          :key="scope"
          type="button"
          class="tab"
          :class="{ selectedTab: query.scope === scope }"
          role="tab"
          :aria-selected="query.scope === scope"
          @click="changeScope(scope)"
        >
          {{ scopeLabel(t, scope) }}
        </button>
      </nav>
      <div
        v-if="query.scope === 'peertube'"
        class="sourceRow"
      >
        <label class="sourceLabel">
          {{ t('Layer Search.Source.Source') }}
          <select
            class="sourceSelect"
            :value="sourceValue"
            @change="chooseSource($event.target.value)"
          >
            <option value="">
              {{ t('Layer Search.Source.Search source', { host: searchSourceHost }) }}
            </option>
            <optgroup
              v-if="followedInstances.length > 0"
              :label="t('Layer Search.Source.Followed')"
            >
              <option
                v-for="host in followedInstances"
                :key="`followed-${host}`"
                :value="host"
              >
                {{ host }}
              </option>
            </optgroup>
            <optgroup
              v-if="recent.length > 0"
              :label="t('Layer Search.Source.Recent')"
            >
              <option
                v-for="host in recent"
                :key="`recent-${host}`"
                :value="host"
              >
                {{ host }}
              </option>
            </optgroup>
            <option
              v-if="query.instance !== null && !followedInstances.includes(query.instance) && !recent.includes(query.instance)"
              :value="query.instance"
            >
              {{ query.instance }}
            </option>
            <option value="*other">
              {{ t('Layer Search.Source.Other') }}
            </option>
          </select>
        </label>
        <form
          v-if="typingInstance"
          class="otherInstance"
          @submit.prevent="searchTypedInstance"
        >
          <input
            v-model="typedInstance"
            class="otherInstanceInput"
            type="text"
            :placeholder="t('Layer Search.Source.Other placeholder')"
            :aria-label="t('Layer Search.Source.Other')"
          >
          <button
            type="submit"
            class="otherInstanceSearch"
            :disabled="validHost(typedInstance) === null"
          >
            {{ t('Layer Search.Source.Search instance') }}
          </button>
        </form>
      </div>
      <LayerSearchChips
        class="chips"
        :parameters="query"
        :muted="muted"
        :peertube-enabled="peertubeEnabled"
        :locale="locale"
        @update="changeParameters"
      >
        <template #end>
          <button
            v-if="!plain"
            type="button"
            class="endAction clearFilters"
            :title="t('Layer Search.Clear tooltip')"
            @click="clearFilters"
          >
            {{ t('Layer Search.Clear') }}
          </button>
          <button
            v-else-if="remembered !== null"
            type="button"
            class="endAction applyLastFilters"
            @click="applyLastFilters"
          >
            {{ t('Layer Search.Apply last filters', { filters: rememberedWords }) }}
          </button>
        </template>
      </LayerSearchChips>
      <section
        v-for="platform in shownPlatforms"
        :key="platform"
        class="resultsSection"
        :class="`${platform}Section`"
      >
        <header
          v-if="isAll"
          class="sectionHeaderRow"
        >
          <h3 class="sectionHeading">
            <button
              type="button"
              class="sectionHeader"
              :title="t('Layer Search.Narrow to', { platform: platformName(t, platform) })"
              @click="changeScope(platform)"
            >
              {{ sectionHeading(t, platform) }}
              <FontAwesomeIcon :icon="['fas', 'angle-right']" />
            </button>
          </h3>
          <p
            v-if="unappliedWords(platform) !== ''"
            class="notApplied"
          >
            {{ t('Layer Search.Not applied here', { platform: platformName(t, platform), filters: unappliedWords(platform) }) }}
          </p>
        </header>
        <FtElementList :data="sectionOf(platform).items" />
        <p
          v-if="isFinishedAndEmpty(platform)"
          class="message"
        >
          {{ t('Layer Search.No results') }}
        </p>
        <FtLoader v-if="sectionOf(platform).loading" />
        <div
          v-else-if="sectionOf(platform).error"
          class="sectionError"
        >
          <p class="message">
            {{ errorMessage(platform, sectionOf(platform).error) }}
          </p>
          <FtButton
            :label="t('Video.Try Again')"
            :icon="['fas', 'sync']"
            class="retryButton"
            @click="load(platform)"
          />
        </div>
        <FtAutoLoadNextPageWrapper
          v-else-if="hasMore(platform) && !isAll && !autoLoadPaused(platform)"
          @load-next-page="load(platform)"
        >
          <div
            class="getNextPage"
            role="button"
            tabindex="0"
            @click="load(platform)"
            @keydown.enter.space.prevent="load(platform)"
          >
            <FontAwesomeIcon :icon="['fas', 'search']" /> {{ t('Search Filters.Fetch more results') }}
          </div>
        </FtAutoLoadNextPageWrapper>
        <div
          v-else-if="hasMore(platform)"
          class="getNextPage"
          role="button"
          tabindex="0"
          @click="load(platform)"
          @keydown.enter.space.prevent="load(platform)"
        >
          <FontAwesomeIcon :icon="['fas', 'search']" /> {{ t('Search Filters.Fetch more results') }}
        </div>
      </section>
    </FtCard>
  </div>
</template>

<script setup>
// The search page on the platform layer, behind the search surface switch
// (`enableLayerSearch`; platform/routes.js `searchSurface`). The route is the
// whole search (platform/search/query.js): its text, its scope and its
// filters. Every change on the page (a scope tab, a chip, `Clear`, `Apply last
// filters`, a section header) is a push of the new query, so the back button
// walks through them; loading more is not. A search runs when the route
// changes, never as the reader types.
//
// The remembered set is written here, through the store: a change that leaves
// the query filtered makes it the remembered set and latches it; removing the
// last filter (or `Clear`) unlatches it and leaves it as it was. A plain
// search changes nothing.
//
// In the All scope each platform has its own section, paged on its own, with
// its own error: one failing leaves the other. See .scratch/search-ux/spec.md.

import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, onMounted, shallowReactive, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

import FtAutoLoadNextPageWrapper from '../../components/FtAutoLoadNextPageWrapper.vue'
import FtButton from '../../components/FtButton/FtButton.vue'
import FtCard from '../../components/ft-card/ft-card.vue'
import FtDensitySwitch from '../../components/FtDensitySwitch/FtDensitySwitch.vue'
import FtElementList from '../../components/FtElementList/FtElementList.vue'
import FtLoader from '../../components/FtLoader/FtLoader.vue'
import LayerSearchChips from '../../components/LayerSearchChips/LayerSearchChips.vue'

import store from '../../store/index'
import { showToast } from '../../helpers/utils'
import { SEARCH_CHAR_LIMIT } from '../../../constants'
import { usePlatformLayer } from '../../platform/vue'
import { appliedFilters, platformsOf } from '../../platform/search/capabilities'
import { platformName, scopeLabel, sectionHeading } from '../../platform/search/labels'
import { languageName } from '../../platform/search/languages'
import {
  FILTER_NAMES,
  SCOPES,
  SCOPE_ALL,
  cleared,
  defaults,
  describe,
  isPlain,
  isSet,
  normalise,
  parameters,
  parse,
  readRemembered,
  routeKey,
  sameParameters,
  toRoute,
  validHost,
  withText,
} from '../../platform/search/query'
import { recall, recentInstances, remember, rememberInstance } from './resultsCache'

/**
 * Empty pages in a row (each with a cursor) after which more results are
 * loaded only when asked, as on the PeerTube search view
 */
const MAX_EMPTY_AUTO_LOADS = 3

const layer = usePlatformLayer()
const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()

/** @type {import('vue').ComputedRef<boolean>} */
const peertubeEnabled = computed(() => store.getters.getEnablePeerTube === true)
const defaultScope = computed(() => store.getters.getDefaultSearchScope)
const latched = computed(() => store.getters.getSearchLatched === true)

const query = computed(() => parse(route.query, route.params.query, {
  defaultScope: defaultScope.value,
  peertubeEnabled: peertubeEnabled.value,
}))

const plain = computed(() => isPlain(query.value))
const isAll = computed(() => query.value.scope === SCOPE_ALL)

const remembered = computed(() => readRemembered(store.getters.getSearchRememberedParameters, { peertubeEnabled: peertubeEnabled.value }))

/**
 * @param {import('../../platform/search/query').SearchParameters} params
 */
function words(params, options = {}) {
  return describe(params, t, { languageName, ...options })
}

const rememberedWords = computed(() => remembered.value === null ? '' : words(remembered.value))

// The results, one section per platform in scope

/**
 * @typedef {object} SectionState
 * @property {object[]} items
 * @property {unknown} cursor never made reactive: a Local cursor is a youtubei.js instance
 * @property {boolean} loaded whether the first page has been answered
 * @property {boolean} loading
 * @property {any} error
 * @property {string[] | null} applied as the layer reported it
 * @property {number} emptyPagesInARow
 */

/** @returns {SectionState} */
function freshSection(snapshot = {}) {
  return shallowReactive({
    items: [],
    cursor: null,
    loaded: false,
    loading: false,
    error: null,
    applied: null,
    emptyPagesInARow: 0,
    ...snapshot,
  })
}

/** @type {import('vue').ShallowRef<Record<string, SectionState>>} */
const sections = shallowRef({})

/** The platforms whose sections are shown */
const shownPlatforms = computed(() => platformsOf(query.value.scope).filter(platform => platform in sections.value))

/**
 * @param {string} platform
 * @returns {SectionState}
 */
function sectionOf(platform) {
  return sections.value[platform] ?? freshSection()
}

/** @param {string} platform */
function hasMore(platform) {
  const section = sectionOf(platform)
  return section.loaded && section.cursor !== null
}

/** @param {string} platform */
function autoLoadPaused(platform) {
  return sectionOf(platform).emptyPagesInARow >= MAX_EMPTY_AUTO_LOADS
}

/** @param {string} platform */
function isFinishedAndEmpty(platform) {
  const section = sectionOf(platform)
  return section.loaded && !section.loading && !section.error && section.cursor === null && section.items.length === 0
}

/**
 * The set filters a platform did not apply, as the layer said, or as the
 * capability table says until it has.
 *
 * @param {string} platform
 * @returns {string[]}
 */
function unapplied(platform) {
  const applied = sectionOf(platform).applied ?? appliedFilters(/** @type {any} */ (platform), query.value)
  return FILTER_NAMES.filter(name => isSet(query.value, name) && !applied.includes(name))
}

/** Filter name to the platforms in scope that did not apply it, for the chips */
const muted = computed(() => {
  /** @type {Record<string, string[]>} */
  const result = {}

  for (const platform of platformsOf(query.value.scope)) {
    for (const name of unapplied(platform)) {
      result[name] = [...(result[name] ?? []), platform]
    }
  }

  return result
})

/**
 * The words for what a section did not apply, or `''`.
 *
 * @param {string} platform
 */
function unappliedWords(platform) {
  const names = unapplied(platform)

  if (names.length === 0) {
    return ''
  }

  const only = { ...defaults(query.value.scope) }
  for (const name of names) {
    only[name] = query.value[name]
  }

  return words(only, { withScope: false })
}

/** The search in hand, told apart from the ones it replaced */
let generation = 0

function saveSnapshot() {
  const snapshot = {}

  for (const [platform, section] of Object.entries(sections.value)) {
    if (section.loading) {
      return
    }

    snapshot[platform] = {
      items: section.items,
      cursor: section.cursor,
      loaded: section.loaded,
      error: section.error,
      applied: section.applied,
      emptyPagesInARow: section.emptyPagesInARow,
    }
  }

  remember(routeKey(query.value), snapshot)
}

/**
 * @param {SectionState} section
 * @param {any} page a page, or the error the platform answered
 * @param {boolean} isNext
 */
function takePage(section, page, isNext) {
  if (!Array.isArray(page?.items)) {
    if (!page?.kind) {
      console.error(page)
    }

    section.error = page ?? {}
    return
  }

  section.items = isNext ? [...section.items, ...page.items] : page.items
  section.cursor = page.cursor ?? null
  section.applied = Array.isArray(page.applied) ? page.applied : null
  section.loaded = true
  section.emptyPagesInARow = page.items.length === 0 ? section.emptyPagesInARow + 1 : 0
}

/**
 * The first page of one section, or its next; again after an error, the same
 * one.
 *
 * @param {string} platform
 */
async function load(platform) {
  const section = sections.value[platform]

  if (!section || section.loading || (section.loaded && section.cursor === null)) {
    return
  }

  const thisGeneration = generation
  const isNext = section.loaded
  section.loading = true
  section.error = null

  try {
    const page = await layer.searchQuery({ ...query.value, scope: platform }, { cursor: isNext ? section.cursor : null })

    if (thisGeneration === generation) {
      takePage(section, page, isNext)
    }
  } catch (err) {
    if (thisGeneration === generation) {
      takePage(section, err, isNext)
    }
  } finally {
    if (thisGeneration === generation) {
      section.loading = false
      saveSnapshot()
    }
  }
}

/** Both sections' first pages, in one call to the layer */
async function loadAll() {
  const thisGeneration = generation
  const current = sections.value

  for (const section of Object.values(current)) {
    section.loading = true
  }

  let answer = null
  let failure = null

  try {
    answer = await layer.searchQuery(query.value)
  } catch (err) {
    failure = err
  }

  if (thisGeneration !== generation) {
    return
  }

  for (const [platform, section] of Object.entries(current)) {
    takePage(section, failure ?? answer?.sections?.[platform], false)
    section.loading = false
  }

  saveSnapshot()
}

function search() {
  generation++

  const text = query.value.text
  store.commit('setAppTitle', text)

  if (text.length > SEARCH_CHAR_LIMIT) {
    console.warn(`Search character limit is: ${SEARCH_CHAR_LIMIT}`)
    showToast(t('Search character limit', { searchCharacterLimit: SEARCH_CHAR_LIMIT }))
    sections.value = {}
    return
  }

  if (store.getters.getRememberSearchHistory && text !== '') {
    store.dispatch('updateSearchHistoryEntry', { _id: text, lastUpdatedAt: Date.now() })
  }

  if (query.value.instance !== null) {
    rememberInstance(query.value.instance)
  }

  const platforms = platformsOf(query.value.scope)
  const snapshot = recall(routeKey(query.value))

  if (snapshot && platforms.every(platform => platform in snapshot)) {
    sections.value = Object.fromEntries(platforms.map(platform => [platform, freshSection(snapshot[platform])]))
    return
  }

  sections.value = Object.fromEntries(platforms.map(platform => [platform, freshSection()]))

  if (isAll.value) {
    loadAll()
  } else {
    load(platforms[0])
  }
}

// Changing the search: always a new route, and the remembered set follows

/**
 * @param {import('../../platform/search/query').SearchQuery} next
 */
function go(next) {
  const nextQuery = normalise(next)
  const wasPlain = plain.value

  router.push(toRoute(nextQuery))

  if (!isPlain(nextQuery)) {
    const params = parameters(nextQuery)

    if (!sameParameters(params, remembered.value)) {
      store.dispatch('updateSearchRememberedParameters', params)
    }

    if (!latched.value) {
      store.dispatch('updateSearchLatched', true)
    }
  } else if (!wasPlain && latched.value) {
    store.dispatch('updateSearchLatched', false)
  }
}

/**
 * @param {string} scope
 */
function changeScope(scope) {
  if (scope !== query.value.scope) {
    go({ ...query.value, scope })
  }
}

/**
 * @param {import('../../platform/search/query').SearchParameters} params
 */
function changeParameters(params) {
  go(withText(params, query.value.text))
}

function clearFilters() {
  const next = cleared(query.value)
  router.push(toRoute(next))

  if (latched.value) {
    store.dispatch('updateSearchLatched', false)
  }
}

function applyLastFilters() {
  if (remembered.value !== null) {
    go(withText(remembered.value, query.value.text))
  }
}

// The source row, in the PeerTube scope

const searchSourceHost = computed(() => {
  const source = layer.config?.peertubeSearchSource ?? ''
  try {
    return new URL(source).hostname || source
  } catch {
    return source
  }
})

/** The hosts the PeerTube channels followed live on */
const followedInstances = computed(() => {
  const profiles = store.getters.getProfileList ?? []
  const all = profiles.find(profile => profile?._id === 'allChannels') ?? profiles[0]
  const hosts = new Set()

  for (const channel of all?.subscriptions ?? []) {
    if (channel?.platform === 'peertube' && typeof channel.host === 'string') {
      hosts.add(channel.host)
    }
  }

  return [...hosts].sort()
})

const recent = shallowRef(recentInstances())

const typingInstance = shallowRef(false)
const typedInstance = shallowRef('')

const sourceValue = computed(() => typingInstance.value ? '*other' : query.value.instance ?? '')

/**
 * @param {string} value
 */
function chooseSource(value) {
  if (value === '*other') {
    typingInstance.value = true
    return
  }

  typingInstance.value = false
  go({ ...query.value, instance: value === '' ? null : value })
}

function searchTypedInstance() {
  const host = validHost(typedInstance.value)

  if (host !== null) {
    typingInstance.value = false
    typedInstance.value = ''
    go({ ...query.value, instance: host })
  }
}

/**
 * @param {string} platform
 * @param {{ kind?: string, host?: string | null }} err
 * @returns {string}
 */
function errorMessage(platform, err) {
  if (platform !== 'peertube') {
    return t('Layer Search.YouTube failed')
  }

  const host = err.host ?? query.value.instance ?? searchSourceHost.value

  switch (err.kind) {
    case 'unavailable':
      return t('PeerTube.Search.Unavailable', { host })
    case 'rateLimited':
      return t('PeerTube.Search.Rate limited', { host })
    case 'invalid':
    case 'notFound':
      return t('PeerTube.Search.Invalid source', { source: query.value.instance ?? layer.config?.peertubeSearchSource ?? '' })
    default:
      return t('PeerTube.Search.Could not search')
  }
}

watch(() => routeKey(query.value), () => {
  if (route.path.startsWith('/search/')) {
    search()
    recent.value = recentInstances()
  }
})

onMounted(() => {
  search()
  recent.value = recentInstances()
})
</script>

<style scoped src="./LayerSearchPage.css" />
