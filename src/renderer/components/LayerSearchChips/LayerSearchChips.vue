<template>
  <div
    class="chipBar"
    role="group"
    :aria-label="t('Search Filters.Search Filters')"
  >
    <span
      v-if="withScope"
      class="chip set scopeChip"
    >
      <select
        class="chipSelect"
        :aria-label="t('Layer Search.Scope.Scope')"
        :value="current.scope"
        @change="change('scope', $event.target.value)"
      >
        <option
          v-for="scopeOption in scopes"
          :key="scopeOption"
          :value="scopeOption"
        >
          {{ scopeLabel(t, scopeOption) }}
        </option>
      </select>
    </span>
    <span
      v-for="chip in selectChips"
      :key="chip.name"
      class="chip"
      :class="[`${chip.name}Chip`, { set: chip.set, muted: chip.mutedBy.length > 0 }]"
      :title="chip.tooltip"
    >
      <select
        class="chipSelect"
        :aria-label="chip.label"
        :value="chip.value"
        @change="chip.choose($event.target.value)"
      >
        <option
          v-for="option in chip.options"
          :key="option.value"
          :value="option.value"
        >
          {{ option.label }}
        </option>
      </select>
      <button
        v-if="chip.set"
        type="button"
        class="chipClear"
        :aria-label="t('Layer Search.Remove filter')"
        :title="t('Layer Search.Remove filter')"
        @click="chip.clear()"
      >
        <FontAwesomeIcon :icon="['fas', 'times']" />
      </button>
    </span>
    <span
      v-if="showRange"
      class="chip rangeChip"
      :class="{ set: current.after !== null || current.before !== null, muted: mutedBy('after').length > 0 || mutedBy('before').length > 0 }"
      :title="mutedTooltip([...mutedBy('after'), ...mutedBy('before')])"
    >
      <label class="rangeLabel">
        {{ t('Layer Search.Chips.After') }}
        <input
          v-model="rangeAfter"
          type="date"
          class="rangeInput rangeAfter"
        >
      </label>
      <label class="rangeLabel">
        {{ t('Layer Search.Chips.Before') }}
        <input
          v-model="rangeBefore"
          type="date"
          class="rangeInput rangeBefore"
        >
      </label>
      <button
        type="button"
        class="rangeApply"
        :disabled="rangeAfter === '' && rangeBefore === ''"
        @click="applyRange"
      >
        {{ t('Layer Search.Chips.Apply range') }}
      </button>
      <button
        v-if="current.after !== null || current.before !== null"
        type="button"
        class="chipClear"
        :aria-label="t('Layer Search.Remove filter')"
        :title="t('Layer Search.Remove filter')"
        @click="clearRange"
      >
        <FontAwesomeIcon :icon="['fas', 'times']" />
      </button>
    </span>
    <span
      v-if="showLanguage"
      ref="languageChip"
      class="chip languageChip"
      :class="{ set: current.language.length > 0, muted: mutedBy('language').length > 0 }"
      :title="mutedTooltip(mutedBy('language'))"
    >
      <button
        type="button"
        class="chipButton languageButton"
        :aria-expanded="languageOpen"
        aria-haspopup="true"
        @click="languageOpen = !languageOpen"
      >
        {{ languageText }}
        <FontAwesomeIcon :icon="['fas', 'angle-down']" />
      </button>
      <button
        v-if="current.language.length > 0"
        type="button"
        class="chipClear"
        :aria-label="t('Layer Search.Remove filter')"
        :title="t('Layer Search.Remove filter')"
        @click="clear('language')"
      >
        <FontAwesomeIcon :icon="['fas', 'times']" />
      </button>
      <div
        v-if="languageOpen"
        class="languagePanel"
        @keydown.esc="languageOpen = false"
      >
        <input
          v-model="languageFilter"
          type="search"
          class="languageFilter"
          :placeholder="t('Layer Search.Chips.Find language')"
          :aria-label="t('Layer Search.Chips.Find language')"
        >
        <ul class="languageOptions">
          <li
            v-for="language in shownLanguages"
            :key="language.code"
          >
            <label class="languageOption">
              <input
                type="checkbox"
                :value="language.code"
                :checked="current.language.includes(language.code)"
                @change="toggleLanguage(language.code)"
              >
              {{ language.name }}
            </label>
          </li>
        </ul>
      </div>
    </span>
    <span
      class="chip liveChip"
      :class="{ set: current.live, muted: mutedBy('live').length > 0 }"
      :title="mutedTooltip(mutedBy('live'))"
    >
      <button
        type="button"
        class="chipButton liveButton"
        :aria-pressed="current.live"
        @click="change('live', !current.live)"
      >
        {{ t('Layer Search.Chips.Live') }}
      </button>
    </span>
    <slot name="end" />
  </div>
</template>

<script setup>
// The chip bar: one control per search filter, parameters in and parameters
// out. It never navigates or stores anything; the parent decides where a
// change goes (the route on the results page, the remembered set in the
// pill). Which chips and values it offers follows the capability table
// (platform/search/capabilities.js): a chip no platform in scope can honour is
// hidden while unset, and a set chip is always shown, muted where the parent
// says a platform did not apply it.

import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { offeredIn, optionsFor } from '../../platform/search/capabilities'
import { languageList, languageName } from '../../platform/search/languages'
import {
  LENGTHS,
  SCOPES,
  SCOPE_PEERTUBE,
  SCOPE_YOUTUBE,
  TIMES,
  normalise,
  withParameter,
  withoutFilter,
} from '../../platform/search/query'
import {
  lengthLabel,
  nsfwLabel,
  platformName,
  scopeLabel,
  sortLabel,
  timeLabel,
  typeLabel,
} from '../../platform/search/labels'

const props = defineProps({
  /** The parameters shown: a query, or a set of parameters */
  parameters: {
    type: Object,
    required: true,
  },
  /** Filter name to the platforms that did not apply it */
  muted: {
    type: Object,
    default: () => ({}),
  },
  /** Whether the scope is a chip too (the pill); the results page has tabs */
  withScope: {
    type: Boolean,
    default: false,
  },
  /** Whether PeerTube is on, so its scopes are offered */
  peertubeEnabled: {
    type: Boolean,
    default: false,
  },
  /** The locale, whose language is first in the language list */
  locale: {
    type: String,
    default: 'en-US',
  },
})

const emit = defineEmits(['update'])

const { t } = useI18n()

const current = computed(() => normalise(props.parameters))
const scope = computed(() => current.value.scope)

const scopes = computed(() => props.peertubeEnabled ? SCOPES : [SCOPE_YOUTUBE])

/**
 * @param {string} name
 * @returns {string[]}
 */
function mutedBy(name) {
  return Array.isArray(props.muted[name]) ? props.muted[name] : []
}

/**
 * @param {string[]} platforms
 * @returns {string | undefined}
 */
function mutedTooltip(platforms) {
  if (platforms.length === 0) {
    return undefined
  }

  return platforms.map(platform => t('Layer Search.Not applied', { platform: platformName(t, platform) })).join('\n')
}

/**
 * @param {string} name
 * @param {unknown} value
 */
function change(name, value) {
  emit('update', withParameter(current.value, name, value))
}

/**
 * @param {string} name
 */
function clear(name) {
  emit('update', withoutFilter(current.value, name))
}

// The custom range: shown while chosen, or while the query holds dates
const rangeChosen = ref(false)
const rangeAfter = ref('')
const rangeBefore = ref('')

const hasRange = computed(() => current.value.after !== null || current.value.before !== null)
const rangeOffered = computed(() => scope.value === SCOPE_PEERTUBE && current.value.type !== 'channel')
const showRange = computed(() => hasRange.value || (rangeChosen.value && rangeOffered.value))

watch(() => [current.value.after, current.value.before], ([after, before]) => {
  rangeAfter.value = after ?? ''
  rangeBefore.value = before ?? ''
  if (after === null && before === null) {
    rangeChosen.value = false
  }
}, { immediate: true })

function applyRange() {
  emit('update', normalise({
    ...current.value,
    time: null,
    after: rangeAfter.value || null,
    before: rangeBefore.value || null,
  }))
}

function clearRange() {
  rangeChosen.value = false
  emit('update', normalise({ ...current.value, after: null, before: null }))
}

/**
 * One `<select>` chip.
 *
 * @param {object} chip
 * @param {string} chip.name the filter
 * @param {string} chip.label for assistive technology
 * @param {(string | null)[]} chip.values the values offered, `null` (unset) first
 * @param {(value: string | null) => string} chip.labelOf
 * @param {(value: any) => string} [chip.toOption] the value as an option's
 * @param {(option: string) => unknown} [chip.fromOption]
 */
function selectChip({ name, label, values, labelOf, toOption = value => value ?? '', fromOption = option => option === '' ? null : option }) {
  const value = current.value[name]
  const set = value !== null
  const shown = set && !values.includes(value) ? [...values, value] : values
  const platforms = mutedBy(name)

  return {
    name,
    label,
    set,
    value: toOption(value),
    options: shown.map(option => ({ value: toOption(option), label: labelOf(option) })),
    mutedBy: platforms,
    tooltip: mutedTooltip(platforms),
    choose: (option) => change(name, fromOption(option)),
    clear: () => clear(name),
  }
}

const selectChips = computed(() => {
  const chips = []
  const q = current.value

  chips.push(selectChip({
    name: 'sort',
    label: t('Layer Search.Chips.Sort'),
    values: optionsFor('sort', scope.value),
    labelOf: value => sortLabel(t, value),
  }))

  if (q.type !== 'channel' || q.time !== null) {
    const timeChip = selectChip({
      name: 'time',
      label: t('Layer Search.Chips.Time'),
      values: [null, ...TIMES],
      labelOf: value => timeLabel(t, value),
    })

    if (rangeOffered.value) {
      timeChip.options.push({ value: 'custom', label: t('Layer Search.Chips.Custom range') })

      if (hasRange.value || rangeChosen.value) {
        timeChip.value = 'custom'
        timeChip.set = hasRange.value
      }

      timeChip.choose = (option) => {
        if (option === 'custom') {
          rangeChosen.value = true
        } else {
          rangeChosen.value = false
          change('time', option === '' ? null : option)
        }
      }
    }

    chips.push(timeChip)
  }

  chips.push(selectChip({
    name: 'type',
    label: t('Layer Search.Chips.Type'),
    values: optionsFor('type', scope.value),
    labelOf: value => typeLabel(t, value),
  }))

  if ((q.type !== 'channel' && q.type !== 'shorts') || q.length !== null) {
    chips.push(selectChip({
      name: 'length',
      label: t('Layer Search.Chips.Length'),
      values: [null, ...LENGTHS],
      labelOf: value => lengthLabel(t, value),
    }))
  }

  if (q.nsfw !== null || (offeredIn('nsfw', scope.value) && q.type !== 'channel')) {
    chips.push(selectChip({
      name: 'nsfw',
      label: t('Layer Search.Chips.NSFW'),
      values: [null, true, false],
      labelOf: value => nsfwLabel(t, value),
      toOption: value => value === true ? 'shown' : value === false ? 'hidden' : '',
      fromOption: option => option === 'shown' ? true : option === 'hidden' ? false : null,
    }))
  }

  return chips
})

// Languages: a searchable list, the locale's language first
const languageOpen = ref(false)
const languageFilter = ref('')
const languageChip = useTemplateRef('languageChip')

const showLanguage = computed(() => {
  return current.value.language.length > 0 || (offeredIn('language', scope.value) && current.value.type !== 'channel')
})

const allLanguages = computed(() => languageList(props.locale))

const shownLanguages = computed(() => {
  const filter = languageFilter.value.trim().toLowerCase()
  const chosen = current.value.language
  const list = filter === ''
    ? allLanguages.value
    : allLanguages.value.filter(language => language.name.toLowerCase().includes(filter) || language.code.toLowerCase() === filter)

  // What is chosen stays at the top, so it can be unchosen
  return [
    ...list.filter(language => chosen.includes(language.code)),
    ...list.filter(language => !chosen.includes(language.code)),
  ]
})

const languageText = computed(() => {
  const chosen = current.value.language
  return chosen.length === 0 ? t('Layer Search.Chips.Language') : chosen.map(languageName).join(', ')
})

/**
 * @param {string} code
 */
function toggleLanguage(code) {
  const chosen = current.value.language
  change('language', chosen.includes(code) ? chosen.filter(item => item !== code) : [...chosen, code])
}

/**
 * @param {Event} event
 */
function closeLanguageOutside(event) {
  if (languageOpen.value && languageChip.value && !languageChip.value.contains(/** @type {Node} */ (event.target))) {
    languageOpen.value = false
  }
}

onMounted(() => document.addEventListener('mousedown', closeLanguageOutside))
onBeforeUnmount(() => document.removeEventListener('mousedown', closeLanguageOutside))
</script>

<style scoped src="./LayerSearchChips.css" />
