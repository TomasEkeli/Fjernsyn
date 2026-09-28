<template>
  <div
    class="bubblePadding"
    tabindex="0"
    role="button"
    :aria-labelledby="id"
    @click="click"
    @keydown.space.enter.prevent="click"
  >
    <div
      class="bubble"
      :style="bubble.style"
    >
      <div
        class="initial"
        dir="auto"
      >
        {{ bubble.text }}
      </div>
    </div>
    <div
      :id="id"
      class="profileName"
      dir="auto"
    >
      {{ translatedProfileName }}
    </div>
  </div>
</template>

<script setup>
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'

import { getFirstCharacter } from '../../helpers/strings'
import { profileBubble } from '../../helpers/profilePictures'

const props = defineProps({
  profileName: {
    type: String,
    required: true
  },
  isMainProfile: {
    type: Boolean,
    required: true
  },
  backgroundColor: {
    type: String,
    required: true
  },
  textColor: {
    type: String,
    required: true
  },
  // Fjernsyn: the profile's picture, from readProfilePicture, drawn in place
  // of the initial; callers that pass none get the initial as before
  picture: {
    type: Object,
    default: null
  }
})

const { locale, t } = useI18n()

const id = useId()

const translatedProfileName = computed(() => {
  return props.isMainProfile ? t('Profile.All Channels') : props.profileName
})

const profileInitial = computed(() => {
  return props.profileName
    ? getFirstCharacter(translatedProfileName.value, locale.value)
    : ''
})

const bubble = computed(() => profileBubble(props.picture, {
  bgColor: props.backgroundColor,
  textColor: props.textColor,
  initial: profileInitial.value
}))

const emit = defineEmits(['click'])

function click() {
  emit('click')
}
</script>

<style scoped src="./FtProfileBubble.css" />
