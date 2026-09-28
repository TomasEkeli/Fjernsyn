<!--
  A profile's name being typed, in place of the name under its bubble in the
  palette: for a new profile, and for renaming one. Enter, or leaving the
  field, keeps the name; Escape gives it up. A name of nothing but spaces is
  no name, and gives it up too.

  Not an FtProfileBubble with a field in it: that is a button, which takes
  Space and Enter for itself, and a text field cannot sit inside a button. It
  is drawn to look the same instead.
-->
<template>
  <div
    class="nameField"
    :style="{ '--profile-colour': bgColor }"
  >
    <div
      class="bubble"
      :style="bubble.style"
      aria-hidden="true"
    >
      <div
        class="initial"
        dir="auto"
      >
        {{ bubble.text }}
      </div>
    </div>
    <input
      ref="input"
      v-model="name"
      class="nameInput"
      type="text"
      dir="auto"
      :aria-label="label"
      :placeholder="label"
      :disabled="disabled"
      @keydown.enter.prevent="finish(true)"
      @keydown.escape.prevent="finish(false)"
      @blur="onBlur"
    >
  </div>
</template>

<script setup>
import { computed, onMounted, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'

import { calculateColorLuminance } from '../../helpers/colors'
import { getFirstCharacter } from '../../helpers/strings'
import { profileBubble } from '../../helpers/profilePictures'

const props = defineProps({
  initialName: {
    type: String,
    default: ''
  },
  bgColor: {
    type: String,
    required: true
  },
  /** What the field is for, for a screen reader and as its placeholder */
  label: {
    type: String,
    required: true
  },
  disabled: {
    type: Boolean,
    default: false
  },
  /**
   * The profile's picture, drawn in place of the initial: a renamed
   * profile's, and none for a new one
   * @type {import('vue').PropType<import('../../helpers/profilePictures').ProfilePicture | null>}
   */
  picture: {
    type: Object,
    default: null
  }
})

const emit = defineEmits(['commit', 'cancel'])

const { locale } = useI18n()

const name = ref(props.initialName)
const input = useTemplateRef('input')

const textColor = computed(() => calculateColorLuminance(props.bgColor))

const initial = computed(() => {
  const trimmed = name.value.trim()

  return trimmed === '' ? '' : getFirstCharacter(trimmed, locale.value)
})

const bubble = computed(() => profileBubble(props.picture, {
  bgColor: props.bgColor,
  textColor: textColor.value,
  initial: initial.value
}))

/** Enter, and then the blur as the field goes away, would otherwise both finish it */
let finished = false

/**
 * @param {boolean} keep
 */
function finish(keep) {
  if (finished) { return }

  finished = true

  const trimmed = name.value.trim()
  const hadFocus = document.activeElement === input.value

  if (keep && trimmed !== '') {
    emit('commit', trimmed, hadFocus)
  } else {
    emit('cancel', hadFocus)
  }
}

/**
 * Not when the whole window loses the focus, to another application: the
 * field gets it back with the window, still being typed in.
 */
function onBlur() {
  if (!document.hasFocus()) { return }

  finish(true)
}

onMounted(() => {
  input.value?.focus()
  input.value?.select()
})
</script>

<style scoped src="./ChannelsOverviewProfileNameField.css" />
