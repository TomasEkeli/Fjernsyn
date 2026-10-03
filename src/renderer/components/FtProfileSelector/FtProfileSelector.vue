<template>
  <div>
    <!-- Fjernsyn: zap to the previous profile, wrapping around -->
    <button
      v-if="previousProfile"
      type="button"
      class="zapButton"
      :title="previousProfileTitle"
      :aria-label="previousProfileTitle"
      @click="zapTo(previousProfile)"
    >
      <FontAwesomeIcon
        class="zapIcon"
        :icon="['fas', 'caret-left']"
      />
    </button>
    <div
      ref="iconButton"
      class="colorOption activeProfile"
      :title="$t('Profile.Toggle Profile List')"
      :style="activeProfileBubble.style"
      tabindex="0"
      role="button"
      :aria-expanded="profileListShown"
      :aria-controls="id + 'list'"
      @click="toggleProfileList"
      @mousedown="handleIconMouseDown"
      @keydown.enter.space.prevent="toggleProfileList"
    >
      <div
        class="initial"
        dir="auto"
      >
        {{ activeProfileBubble.text }}
      </div>
    </div>
    <!-- Fjernsyn: zap to the next profile, wrapping around -->
    <button
      v-if="nextProfile"
      type="button"
      class="zapButton"
      :title="nextProfileTitle"
      :aria-label="nextProfileTitle"
      @click="zapTo(nextProfile)"
    >
      <FontAwesomeIcon
        class="zapIcon"
        :icon="['fas', 'caret-right']"
      />
    </button>
    <FtCard
      v-show="profileListShown"
      :id="id + 'list'"
      ref="profileListRef"
      class="profileList"
      tabindex="-1"
      @focusout="handleProfileListFocusOut"
      @keydown.esc.stop="handleProfileListEscape"
    >
      <h3
        :id="id + 'title'"
        class="profileListTitle"
      >
        {{ $t("Profile.Profile Select") }}
      </h3>
      <FtIconButton
        class="profileSettings"
        :icon="['fas', 'sliders-h']"
        :title="$t('Profile.Go To Profile Manager')"
        @click="openProfileSettings"
      />
      <div
        class="profileWrapper"
        role="listbox"
        :aria-labelledby="id + 'title'"
      >
        <div
          v-for="profile in profileList"
          :key="profile._id"
          class="profile"
          :aria-labelledby="id + profile._id"
          :aria-selected="isActiveProfile(profile)"
          tabindex="0"
          role="option"
          :data-profile-id="profile._id"
          @click="setActiveProfile"
          @keydown.enter.prevent="setActiveProfile"
        >
          <div
            class="colorOption"
            :style="profileBubbles[profile._id].style"
          >
            <div
              class="initial"
              dir="auto"
            >
              {{ profileBubbles[profile._id].text }}
            </div>
          </div>
          <p
            :id="id + profile._id"
            class="profileName"
            dir="auto"
          >
            {{ translateProfileName(profile) }}
          </p>
        </div>
      </div>
    </FtCard>
  </div>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, nextTick, ref, useId, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import FtCard from '../ft-card/ft-card.vue'
import FtIconButton from '../FtIconButton/FtIconButton.vue'

import store from '../../store/index'

import { showToast } from '../../helpers/utils'
import { MAIN_PROFILE_ID } from '../../../constants'
import { getFirstCharacter } from '../../helpers/strings'
import { profileBubble, readProfilePicture } from '../../helpers/profilePictures'
import { neighbourProfile } from '../../helpers/profileZapping'

/**
 * @typedef {object} Profile
 * @property {string} _id
 * @property {string} name
 * @property {string} bgColor
 * @property {string} textColor
 * @property {object[]} subscriptions
 * @property {string} subscriptions[].id
 * @property {string|undefined} subscriptions[].name
 * @property {string|undefined} subscriptions[].thumbnail
 */

const { locale, t } = useI18n()

const id = useId()

const profileListShown = ref(false)
let mouseDownOnIcon = false

/** @type {import('vue').ComputedRef<Profile[]>} */
const profileList = computed(() => store.getters.getProfileList)
/** @type {import('vue').ComputedRef<Profile>} */
const activeProfile = computed(() => store.getters.getActiveProfile)

const activeProfileInitial = computed(() => {
  return activeProfile.value?.name
    ? getFirstCharacter(translateProfileName(activeProfile.value), locale.value)
    : ''
})

/** @type {import('vue').ComputedRef<Record<Profile['_id'], string>>} */
const profileInitials = computed(() => {
  const locale_ = locale.value

  return profileList.value.reduce((initials, profile) => {
    initials[profile._id] = profile?.name
      ? getFirstCharacter(translateProfileName(profile), locale_)
      : ''

    return initials
  }, {})
})

// Fjernsyn: each profile's circle, with its picture if it has one
/** @type {import('vue').ComputedRef<Record<Profile['_id'], ReturnType<typeof profileBubble>>>} */
const profileBubbles = computed(() => {
  const pictures = store.getters.getProfilePictures

  return profileList.value.reduce((bubbles, profile) => {
    bubbles[profile._id] = profileBubble(readProfilePicture(pictures, profile._id), {
      bgColor: profile.bgColor,
      textColor: profile.textColor,
      initial: profileInitials.value[profile._id]
    })

    return bubbles
  }, {})
})

const activeProfileBubble = computed(() => {
  return profileBubble(readProfilePicture(store.getters.getProfilePictures, activeProfile.value?._id), {
    bgColor: activeProfile.value?.bgColor,
    textColor: activeProfile.value?.textColor,
    initial: activeProfileInitial.value
  })
})

// Fjernsyn: zapping through the profiles in the user's order, All Channels
// being one stop among them. Undefined when there is only the one profile.
const previousProfile = computed(() => neighbourProfile(profileList.value, activeProfile.value?._id, -1))
const nextProfile = computed(() => neighbourProfile(profileList.value, activeProfile.value?._id, 1))

const previousProfileTitle = computed(() => previousProfile.value
  ? t('Profile.Previous Profile: {profile}', { profile: translateProfileName(previousProfile.value) })
  : '')
const nextProfileTitle = computed(() => nextProfile.value
  ? t('Profile.Next Profile: {profile}', { profile: translateProfileName(nextProfile.value) })
  : '')

/** @type {AbortController | null} */
let zapToastController = null

/**
 * Switches profile and names it in a toast that replaces the previous zap's
 * rather than stacking under it.
 * @param {Profile} profile
 */
function zapTo(profile) {
  store.commit('setActiveProfile', profile._id)

  zapToastController?.abort()
  zapToastController = new AbortController()
  showToast(
    t('Profile.{profile} is now the active profile', { profile: translateProfileName(profile) }),
    null,
    null,
    zapToastController.signal
  )
}

/**
 * @param {Profile} profile
 */
function isActiveProfile(profile) {
  return profile._id === activeProfile.value._id
}

const profileListRef = useTemplateRef('profileListRef')

function toggleProfileList() {
  profileListShown.value = !profileListShown.value

  if (profileListShown.value) {
    // wait until the profile list is visible
    // then focus it so we can hide it automatically when it loses focus
    nextTick(() => {
      profileListRef.value?.$el?.focus()
    })
  }
}

const router = useRouter()

function openProfileSettings() {
  router.push({ path: '/settings/profile' })
  profileListShown.value = false
}

function handleIconMouseDown() {
  if (profileListShown.value) {
    mouseDownOnIcon = true
  }
}

function handleProfileListFocusOut() {
  if (mouseDownOnIcon) {
    mouseDownOnIcon = false
  } else if (!profileListRef.value?.$el.matches(':focus-within')) {
    profileListShown.value = false
  }
}

const iconButton = useTemplateRef('iconButton')

function handleProfileListEscape() {
  iconButton.value?.focus()
  // handleProfileListFocusOut will hide the dropdown for us
}

/**
 * @param {MouseEvent | KeyboardEvent} event
 */
function setActiveProfile(event) {
  /** @type {string} */
  const profileId = event.currentTarget.dataset.profileId

  if (activeProfile.value._id !== profileId) {
    const targetProfile = profileList.value.find((x) => {
      return x._id === profileId
    })

    if (targetProfile) {
      store.commit('setActiveProfile', profileId)

      showToast(t('Profile.{profile} is now the active profile', { profile: translateProfileName(targetProfile) }))
    }
  }

  profileListShown.value = false
}

/**
 * @param {Profile} profile
 */
function translateProfileName(profile) {
  return profile._id === MAIN_PROFILE_ID ? t('Profile.All Channels') : profile.name
}
</script>

<style scoped src="./FtProfileSelector.css" />
