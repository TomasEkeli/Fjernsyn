<!--
  How a profile's picture is chosen: the letter it always had, a symbol typed
  or pasted in, an icon from Font Awesome's solid set, or an image from a
  local file, and nothing from anywhere else. It says what was chosen with
  `pick`, null for the letter, and saves nothing itself: the profile editor
  keeps the choice until the profile is saved, the palette's menu saves it at
  once.

  Choosing a kind shows its panel, and nothing is picked until something is
  chosen in it. The icons are loaded the first time the Icon panel opens.

  From the keyboard, in the kinds and in the icon grid alike, the arrow keys
  move the focus and choose nothing, Home and End go to the first and last,
  and Enter or Space chooses. In the grid Up and Down move by a row; Down from
  the search field goes to the grid, and Up from its first row back.
-->
<template>
  <div class="profilePicturePicker">
    <!-- Not native radios, which choose as the arrow keys reach them, and
         wrap round: arrowing past Letter would remove the picture -->
    <div
      ref="kindGroup"
      class="kinds"
      role="radiogroup"
      tabindex="-1"
      :aria-label="t('Profile.Picture Kinds')"
      @keydown="onKindKeydown"
    >
      <button
        v-for="(option, index) in kindOptions"
        :key="option.value"
        type="button"
        role="radio"
        class="kind"
        :data-kind="option.value"
        :aria-checked="kind === option.value ? 'true' : 'false'"
        :tabindex="index === kindFocusIndex ? 0 : -1"
        @click="chooseKind(option.value, index)"
      >
        {{ option.label }}
      </button>
    </div>
    <div
      v-if="kind === 'symbol'"
      class="panel"
    >
      <input
        class="field symbolField"
        type="text"
        dir="auto"
        :value="symbolText"
        :placeholder="t('Profile.Symbol Placeholder')"
        :aria-label="t('Profile.Symbol Placeholder')"
        @focus="onSymbolFocus"
        @mouseup="onSymbolMouseUp"
        @blur="selectedOnFocus = false"
        @input="onSymbolInput"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
      >
    </div>
    <div
      v-else-if="kind === 'icon'"
      class="panel iconPanel"
    >
      <input
        ref="iconSearch"
        v-model="query"
        class="field"
        type="search"
        :placeholder="t('Profile.Search Icons')"
        :aria-label="t('Profile.Search Icons')"
        @keydown.down.prevent="focusIcon(focusIndex)"
      >
      <p
        v-if="icons === null"
        class="message"
      >
        {{ iconsFailed ? t('Profile.Icons Could Not Load') : t('Profile.Loading Icons') }}
      </p>
      <p
        v-else-if="matches.length === 0"
        class="message"
      >
        {{ t('Profile.No Icons Found', { query }) }}
      </p>
      <div
        v-else
        ref="iconGrid"
        class="iconGrid"
        role="radiogroup"
        tabindex="-1"
        :aria-label="t('Profile.Picture Icon')"
        @keydown="onGridKeydown"
      >
        <button
          v-for="(icon, index) in matches"
          :key="icon.name"
          type="button"
          role="radio"
          class="iconCell"
          :aria-checked="icon.name === currentIconName ? 'true' : 'false'"
          :aria-label="icon.name"
          :title="icon.name"
          :tabindex="index === focusIndex ? 0 : -1"
          @click="pickIcon(icon, index)"
        >
          <svg
            class="iconSvg"
            :viewBox="`0 0 ${icon.width} ${icon.height}`"
            aria-hidden="true"
            focusable="false"
          >
            <path
              fill="currentColor"
              :d="icon.path"
            />
          </svg>
        </button>
      </div>
    </div>
    <div
      v-else-if="kind === 'image'"
      class="panel"
    >
      <FtButton
        :label="t('Profile.Choose Image')"
        :disabled="readingImage"
        @click="chooseFile"
      />
      <!-- The system's own file dialog, for a local file and nothing else -->
      <input
        ref="fileInput"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        tabindex="-1"
        :aria-label="t('Profile.Choose Image')"
        @change="onFileChosen"
      >
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import FtButton from '../FtButton/FtButton.vue'

import { firstSymbol, searchIcons, validProfilePicture } from '../../helpers/profilePictures'
import { showToast } from '../../helpers/utils'
import { loadIcons } from './icons'
import { pictureFromFile } from './pictureFromFile'

/** @import { PickerIcon, ProfilePicture } from '../../helpers/profilePictures' */

/** Icons per row of the grid; the width in ProfilePicturePicker.css follows it */
const COLUMNS = 10

const KINDS = ['letter', 'symbol', 'icon', 'image']

const props = defineProps({
  /**
   * The picture now, from readProfilePicture, or null for the letter
   * @type {import('vue').PropType<ProfilePicture | null>}
   */
  picture: {
    type: Object,
    default: null
  }
})

const emit = defineEmits(['pick'])

const { locale, t } = useI18n()

const kindOptions = computed(() => [
  { value: 'letter', label: t('Profile.Picture Letter') },
  { value: 'symbol', label: t('Profile.Picture Symbol') },
  { value: 'icon', label: t('Profile.Picture Icon') },
  { value: 'image', label: t('Profile.Picture Image') }
])

/** @type {import('vue').Ref<'letter' | 'symbol' | 'icon' | 'image'>} */
const kind = ref(KINDS.includes(props.picture?.kind) ? props.picture.kind : 'letter')

/** The one kind Tab reaches, and where the arrow keys move from: the checked one to begin with */
const kindFocusIndex = ref(KINDS.indexOf(kind.value))

const kindGroup = useTemplateRef('kindGroup')

/**
 * @param {'letter' | 'symbol' | 'icon' | 'image'} value
 * @param {number} index
 */
function chooseKind(value, index) {
  kindFocusIndex.value = index
  kind.value = value

  if (value === 'letter') {
    emit('pick', null)
  }
}

/**
 * Moves the focus along the kinds, and chooses nothing: Enter or Space does,
 * as they click the button.
 * @param {KeyboardEvent} event
 */
function onKindKeydown(event) {
  const forward = getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1
  let next

  switch (event.key) {
    case 'ArrowRight':
      next = kindFocusIndex.value + forward
      break
    case 'ArrowDown':
      next = kindFocusIndex.value + 1
      break
    case 'ArrowLeft':
      next = kindFocusIndex.value - forward
      break
    case 'ArrowUp':
      next = kindFocusIndex.value - 1
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = KINDS.length - 1
      break
    default:
      return
  }

  event.preventDefault()

  if (next >= 0 && next < KINDS.length) {
    kindFocusIndex.value = next
    kindGroup.value?.children[next]?.focus()
  }
}

// Symbol

/** The picture's symbol, if it is one: a symbol given up since is not shown as if it were still chosen */
const currentSymbol = () => props.picture?.kind === 'symbol' ? props.picture.text : ''

const symbolText = ref(currentSymbol())

watch(kind, (value) => {
  if (value === 'symbol') {
    symbolText.value = currentSymbol()
  }
})

/** An input method editor mid-composition fires `input` too, with text that is not finished */
let composing = false

/**
 * Selected when the field takes the focus, so that what is typed or pasted
 * replaces the symbol rather than being cut off after it.
 */
const selectedOnFocus = ref(false)

/**
 * @param {FocusEvent} event
 */
function onSymbolFocus(event) {
  event.target.select()
  selectedOnFocus.value = true
}

/**
 * The click that focused the field would otherwise put the caret where it
 * landed, undoing the selection.
 * @param {MouseEvent} event
 */
function onSymbolMouseUp(event) {
  if (selectedOnFocus.value) {
    event.preventDefault()
    selectedOnFocus.value = false
  }
}

/**
 * @param {HTMLInputElement} field
 */
function takeSymbol(field) {
  const symbol = firstSymbol(field.value, locale.value)

  field.value = symbol
  symbolText.value = symbol

  const picture = validProfilePicture({ kind: 'symbol', text: symbol })

  if (picture !== null) {
    emit('pick', picture)
  }
}

/**
 * @param {InputEvent} event
 */
function onSymbolInput(event) {
  selectedOnFocus.value = false

  if (composing || event.isComposing) { return }

  takeSymbol(event.target)
}

function onCompositionStart() {
  composing = true
}

/**
 * @param {CompositionEvent} event
 */
function onCompositionEnd(event) {
  composing = false
  takeSymbol(event.target)
}

// Icon

/** @type {import('vue').ShallowRef<PickerIcon[] | null>} */
const icons = shallowRef(null)
const iconsFailed = ref(false)

async function openIcons() {
  if (icons.value !== null) { return }

  iconsFailed.value = false

  try {
    icons.value = await loadIcons()
  } catch (error) {
    console.error(error)
    iconsFailed.value = true
  }
}

watch(kind, (value) => {
  if (value === 'icon') {
    openIcons()
  }
}, { immediate: true })

const query = ref('')

const matches = computed(() => icons.value === null ? [] : searchIcons(icons.value, query.value))

const currentIconName = computed(() => props.picture?.kind === 'icon' ? props.picture.name : null)

/** The one icon Tab reaches, and where the arrow keys move from: the checked one, or else the first */
const focusIndex = ref(0)

watch(matches, (list) => {
  const checked = list.findIndex(icon => icon.name === currentIconName.value)

  focusIndex.value = checked === -1 ? 0 : checked
}, { immediate: true })

const iconGrid = useTemplateRef('iconGrid')
const iconSearch = useTemplateRef('iconSearch')

/**
 * @param {number} index
 */
function focusIcon(index) {
  const cell = iconGrid.value?.children[index]

  if (cell instanceof HTMLElement) {
    focusIndex.value = index
    cell.focus()
  }
}

/**
 * @param {KeyboardEvent} event
 */
function onGridKeydown(event) {
  // Left and Right are sides of the screen, and the grid runs the other way
  // in a right-to-left layout
  const forward = getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1
  const last = matches.value.length - 1
  let next

  switch (event.key) {
    case 'ArrowRight':
      next = focusIndex.value + forward
      break
    case 'ArrowLeft':
      next = focusIndex.value - forward
      break
    case 'ArrowDown':
      next = focusIndex.value + COLUMNS
      break
    case 'ArrowUp':
      if (focusIndex.value < COLUMNS) {
        event.preventDefault()
        iconSearch.value?.focus()
        return
      }

      next = focusIndex.value - COLUMNS
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = last
      break
    default:
      return
  }

  event.preventDefault()

  if (next >= 0 && next <= last) {
    focusIcon(next)
  }
}

/**
 * @param {PickerIcon} icon
 * @param {number} index
 */
function pickIcon({ name, width, height, path }, index) {
  focusIndex.value = index
  emit('pick', { kind: 'icon', name, width, height, path })
}

// Image

const fileInput = useTemplateRef('fileInput')
const readingImage = ref(false)

function chooseFile() {
  fileInput.value?.click()
}

/**
 * @param {Event} event
 */
async function onFileChosen(event) {
  /** @type {HTMLInputElement} */
  const input = event.target
  const file = input.files?.[0]

  // Emptied, so that choosing the same file again is a change too
  input.value = ''

  if (!file) { return }

  readingImage.value = true

  let picture = null

  try {
    picture = await pictureFromFile(file)
  } catch (error) {
    console.error(error)
  } finally {
    readingImage.value = false
  }

  if (picture === null) {
    showToast(t('Profile.Image Unusable'))
    return
  }

  emit('pick', picture)
}

/**
 * Where the focus goes when the picker is opened: the kind checked now.
 */
async function focus() {
  await nextTick()
  kindGroup.value?.children[kindFocusIndex.value]?.focus()
}

defineExpose({ focus })
</script>

<style scoped src="./ProfilePicturePicker.css" />
