<template>
  <div>
    <FtCard class="card">
      <h2>{{ $t("Profile.Profile Manager") }}</h2>
      <FtFlexBox
        class="profileList"
      >
        <FtProfileBubble
          v-for="profile in profileList"
          :key="profile._id"
          :is-main-profile="profile._id === MAIN_PROFILE_ID"
          :profile-name="profile.name"
          :background-color="profile.bgColor"
          :text-color="profile.textColor"
          :picture="profilePictures.get(profile._id)"
          :class="{ openedProfile: openSettingsProfile?._id === profile._id }"
          @click="openSettingsForProfileWithId(profile._id)"
        />
      </FtFlexBox>
      <FtFlexBox
        v-if="!isNewProfileOpen"
      >
        <FtButton
          :label="$t('Profile.Create New Profile')"
          @click="openSettingsForNewProfile"
        />
      </FtFlexBox>
    </FtCard>
    <div
      v-if="openSettingsProfile"
      :key="openSettingsProfileId"
    >
      <FtCard
        v-if="!isNewProfileOpen"
        class="card channelsCard"
      >
        <p class="channelsMessage">
          {{ $t('Profile.Channels Moved') }}
        </p>
        <RouterLink
          class="channelsLink"
          :to="isMainProfile ? '/subscribedchannels' : { path: '/subscribedchannels', query: { open: openSettingsProfileId } }"
        >
          {{ isMainProfile ? $t('Profile.Go to Channels') : $t('Profile.Sort Channels', { profile: openSettingsProfile.name }) }}
        </RouterLink>
      </FtCard>
      <FtProfileEdit
        :profile="openSettingsProfile"
        :is-new="isNewProfileOpen"
        :is-main-profile="isMainProfile"
        @new-profile-created="handleNewProfileCreated"
        @profile-deleted="handleProfileDeleted"
      />
    </div>
  </div>
</template>

<script setup>
import { computed, ref, shallowRef, watch } from 'vue'

import FtCard from '../../components/ft-card/ft-card.vue'
import FtFlexBox from '../../components/ft-flex-box/ft-flex-box.vue'
import FtProfileBubble from '../../components/FtProfileBubble/FtProfileBubble.vue'
import FtButton from '../../components/FtButton/FtButton.vue'
import FtProfileEdit from '../../components/FtProfileEdit/FtProfileEdit.vue'

import store from '../../store/index'

import { calculateColorLuminance, getRandomColor } from '../../helpers/colors'
import { readProfilePicture } from '../../helpers/profilePictures'
import { MAIN_PROFILE_ID } from '../../../constants'

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

const isNewProfileOpen = ref(false)

/** @type {import('vue').Ref<string>} */
const openSettingsProfileId = ref('')

/** @type {import('vue').ShallowRef<Profile|null>} */
const openSettingsProfile = shallowRef(null)

/** @type {import('vue').ComputedRef<Profile[]>} */
const profileList = computed(() => {
  return store.getters.getProfileList
})

watch(profileList, () => {
  openSettingsProfile.value = getProfileById(openSettingsProfileId.value)
}, { deep: true })

// Fjernsyn: each profile's picture, by id
const profilePictures = computed(() => {
  const pictures = store.getters.getProfilePictures

  return new Map(profileList.value.map(profile => [profile._id, readProfilePicture(pictures, profile._id)]))
})

const isMainProfile = computed(() => {
  return MAIN_PROFILE_ID === openSettingsProfileId.value
})

function openSettingsForNewProfile() {
  isNewProfileOpen.value = true

  openSettingsProfile.value = {
    name: '',
    bgColor: getRandomColor().value,
    textColor: calculateColorLuminance(getRandomColor().value),
    subscriptions: []
  }

  openSettingsProfileId.value = ''
}

/**
 * @param {string} profileId
 */
function openSettingsForProfileWithId(profileId) {
  if (profileId === openSettingsProfileId.value) {
    return
  }

  isNewProfileOpen.value = false
  openSettingsProfileId.value = profileId
  openSettingsProfile.value = getProfileById(profileId)
}

/**
 * @param {string | null} profileId
 */
function getProfileById(profileId) {
  if (!profileId) {
    return null
  }

  return store.getters.profileById(profileId)
}

function handleNewProfileCreated() {
  isNewProfileOpen.value = false
  openSettingsProfile.value = null
  openSettingsProfileId.value = ''
}

function handleProfileDeleted() {
  openSettingsProfile.value = null
  openSettingsProfileId.value = ''
}
</script>

<style scoped src="./ProfileSettings.css" />
