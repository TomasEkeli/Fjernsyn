<!--
  How a profile's picture is chosen: a character, which is the profile's
  initial until another is typed or pasted in, an icon from Font Awesome's
  solid set, or an image from a local file, and nothing from anywhere else.
  It says what was chosen with `pick`, null for the initial, and saves
  nothing itself: the profile editor keeps the choice until the profile is
  saved, the palette's menu saves it at once.

  `pick` also says whether the choice is done. Typing a character, pressing
  Enter in its field, and picking an icon or an image are. Going back to
  Character from another kind applies the character in the field, usually
  the initial, and is not done, so that the palette's menu stays open for one
  to be typed. Choosing Icon or Image picks nothing until something is chosen
  in its panel. The icons are loaded the first time the Icon panel opens.

  From the keyboard, in the kinds and in the icon grid alike, the arrow keys
  move the focus and choose nothing, Home and End go to the first and last,
  and Enter or Space chooses. In the grid Up and Down move by a row; Down from
  the search field goes to the grid, and Up from its first row back.
-->
<template>
  <div class="profilePicturePicker">
    <!-- Not native radios, which choose as the arrow keys reach them, and
         wrap round: arrowing through the kinds would apply the initial -->
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
      v-if="kind === 'character'"
      ref="panel"
      class="panel"
    >
      <input
        class="field characterField"
        type="text"
        dir="auto"
        :value="characterText"
        :placeholder="t('Profile.Character Placeholder')"
        :aria-label="t('Profile.Character Placeholder')"
        @focus="onCharacterFocus"
        @mouseup="onCharacterMouseUp"
        @blur="onCharacterBlur"
        @input="onCharacterInput"
        @keydown.enter.prevent="onCharacterEnter"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
      >
    </div>
    <div
      v-else-if="kind === 'icon'"
      ref="panel"
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
      ref="panel"
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

import { firstSymbol, sameProfilePicture, searchIcons, validProfilePicture } from '../../helpers/profilePictures'
import { showToast } from '../../helpers/utils'
import { loadIcons } from './icons'
import { pictureFromFile } from './pictureFromFile'

/** @import { PickerIcon, ProfilePicture } from '../../helpers/profilePictures' */

/** Icons per row of the grid; the width in ProfilePicturePicker.css follows it */
const COLUMNS = 10

const KINDS = ['character', 'icon', 'image']

const props = defineProps({
  /**
   * The picture now, from readProfilePicture, or null for the initial
   * @type {import('vue').PropType<ProfilePicture | null>}
   */
  picture: {
    type: Object,
    default: null
  },
  /** The profile's initial, which is its character while it has no picture */
  initial: {
    type: String,
    default: ''
  }
})

/**
 * `pick`: the picture chosen, or null for the initial, and whether choosing
 * is done
 */
const emit = defineEmits(['pick'])

const { locale, t } = useI18n()

const kindOptions = computed(() => [
  { value: 'character', label: t('Profile.Picture Character') },
  { value: 'icon', label: t('Profile.Picture Icon') },
  { value: 'image', label: t('Profile.Picture Image') }
])

/** @type {import('vue').Ref<'character' | 'icon' | 'image'>} */
const kind = ref(props.picture?.kind === 'icon' || props.picture?.kind === 'image' ? props.picture.kind : 'character')

/** The one kind Tab reaches, and where the arrow keys move from: the checked one to begin with */
const kindFocusIndex = ref(KINDS.indexOf(kind.value))

const kindGroup = useTemplateRef('kindGroup')
const panel = useTemplateRef('panel')

/**
 * Shows the kind's panel, with the focus in it. Back to Character from
 * another kind, its character is applied at once, but not as done.
 * @param {'character' | 'icon' | 'image'} value
 * @param {number} index
 */
async function chooseKind(value, index) {
  const changed = kind.value !== value

  kindFocusIndex.value = index
  kind.value = value

  if (value === 'character' && changed) {
    const picture = characterPicture(characterText.value)

    if (picture !== undefined && !sameProfilePicture(picture, props.picture)) {
      emit('pick', picture, false)
    }
  }

  await nextTick()
  panel.value?.querySelector('input, button')?.focus()
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

// Character

/**
 * What the field shows: the profile's symbol, or else its initial, which it
 * follows as the name changes. A symbol given up since is not shown as if it
 * were still chosen.
 */
const characterText = computed(() => props.picture?.kind === 'symbol' ? props.picture.text : props.initial)

/**
 * The picture a character in the field stands for. The initial, or nothing,
 * is no picture, so that the bubble goes on following the name.
 * @param {string} text one grapheme, or ''
 * @returns {ProfilePicture | null | undefined} undefined for one that cannot be stored
 */
function characterPicture(text) {
  if (text === '' || text === props.initial) {
    return null
  }

  return validProfilePicture({ kind: 'symbol', text }) ?? undefined
}

/** An input method editor mid-composition fires `input` too, with text that is not finished */
let composing = false

/**
 * Selected when the field takes the focus, so that what is typed or pasted
 * replaces the character rather than being cut off after it.
 */
const selectedOnFocus = ref(false)

/**
 * @param {FocusEvent} event
 */
function onCharacterFocus(event) {
  event.target.select()
  selectedOnFocus.value = true
}

/**
 * The click that focused the field would otherwise put the caret where it
 * landed, undoing the selection.
 * @param {MouseEvent} event
 */
function onCharacterMouseUp(event) {
  if (selectedOnFocus.value) {
    event.preventDefault()
    selectedOnFocus.value = false
  }
}

/**
 * Left empty, the field shows the character it stands for again.
 * @param {FocusEvent} event
 */
function onCharacterBlur(event) {
  selectedOnFocus.value = false

  if (event.target.value.trim() === '') {
    event.target.value = characterText.value
  }
}

/**
 * Cuts the field to its first character, and picks that as done. An empty
 * field picks nothing, as it is on its way to another character.
 * @param {HTMLInputElement} field
 */
function takeCharacter(field) {
  const text = firstSymbol(field.value, locale.value)

  field.value = text

  if (text === '') { return }

  const picture = characterPicture(text)

  if (picture !== undefined) {
    emit('pick', picture, true)
  }
}

/**
 * @param {InputEvent} event
 */
function onCharacterInput(event) {
  selectedOnFocus.value = false

  if (composing || event.isComposing) { return }

  takeCharacter(event.target)
}

/**
 * Picks what the field holds, as done: the way back to the initial from
 * another kind. An empty field is the initial.
 * @param {KeyboardEvent} event
 */
function onCharacterEnter(event) {
  if (composing || event.isComposing) { return }

  const field = event.target
  const text = firstSymbol(field.value, locale.value)
  const picture = characterPicture(text)

  field.value = text === '' ? props.initial : text

  if (picture !== undefined) {
    emit('pick', picture, true)
  }
}

function onCompositionStart() {
  composing = true
}

/**
 * @param {CompositionEvent} event
 */
function onCompositionEnd(event) {
  composing = false
  takeCharacter(event.target)
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
  emit('pick', { kind: 'icon', name, width, height, path }, true)
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

  emit('pick', picture, true)
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
