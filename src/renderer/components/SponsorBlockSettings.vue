<template>
  <FtSettingsSection
    :title="$t('Settings.SponsorBlock Settings.SponsorBlock Settings')"
  >
    <FtFlexBox class="settingsFlexStart500px">
      <FtToggleSwitch
        :label="$t('Settings.SponsorBlock Settings.Enable SponsorBlock')"
        :default-value="useSponsorBlock"
        @change="handleUpdateSponsorBlock"
      />
      <FtToggleSwitch
        :label="$t('Settings.SponsorBlock Settings.UseDeArrowTitles')"
        :default-value="useDeArrowTitles"
        :tooltip="$t('Tooltips.SponsorBlock Settings.UseDeArrowTitles')"
        @change="handleUpdateUseDeArrowTitles"
      />
      <FtToggleSwitch
        :label="$t('Settings.SponsorBlock Settings.UseDeArrowThumbnails')"
        :default-value="useDeArrowThumbnails"
        :tooltip="$t('Tooltips.SponsorBlock Settings.UseDeArrowThumbnails')"
        @change="handleUpdateUseDeArrowThumbnails"
      />
    </FtFlexBox>
    <template
      v-if="useSponsorBlock || useDeArrowTitles || useDeArrowThumbnails"
    >
      <FtFlexBox
        v-if="useSponsorBlock"
        class="settingsFlexStart500px"
      >
        <FtToggleSwitch
          :label="$t('Settings.SponsorBlock Settings.Notify when sponsor segment is skipped')"
          :default-value="sponsorBlockShowSkippedToast"
          @change="handleUpdateSponsorBlockShowSkippedToast"
        />
      </FtFlexBox>
      <FtFlexBox>
        <FtInput
          ref="sponsorBlockUrlInput"
          :placeholder="$t('Settings.SponsorBlock Settings[\'SponsorBlock API Url (Default is https://sponsor.ajay.app)\']')"
          :show-action-button="false"
          :show-label="true"
          :value="sponsorBlockUrl"
          @blur="handleUpdateSponsorBlockUrl"
        />
      </FtFlexBox>
      <FtFlexBox
        v-if="useDeArrowThumbnails"
      >
        <FtInput
          ref="deArrowThumbnailGeneratorUrl"
          :placeholder="$t('Settings.SponsorBlock Settings[\'DeArrow Thumbnail Generator API Url (Default is https://dearrow-thumb.ajay.app)\']')"
          :show-action-button="false"
          :show-label="true"
          :value="deArrowThumbnailGeneratorUrl"
          @blur="handleUpdateDeArrowThumbnailGeneratorUrl"
        />
      </FtFlexBox>

      <FtFlexBox
        v-if="useSponsorBlock"
      >
        <FtSponsorBlockCategory
          v-for="category in CATEGORIES"
          :key="category"
          :category-name="category"
        />
      </FtFlexBox>
      <FtFlexBox
        v-if="useSponsorBlock"
        class="excludedChannels"
      >
        <FtInputTags
          :disabled="sponsorBlockExcludedChannelsDisabled"
          :disabled-msg="t('Settings.SponsorBlock Settings.Excluded Channels.Disabled Message')"
          :label="t('SponsorBlock.Channels That Are Never Skipped')"
          :tag-name-placeholder="t('SponsorBlock.Excluded Channels Placeholder')"
          :tag-list="sponsorBlockExcludedChannels"
          :tooltip="t('SponsorBlock.Channels That Are Never Skipped Tooltip')"
          :validate-tag-name="checkYoutubeChannelId"
          :find-tag-info="findChannelTagInfoWrapper"
          :resolve-tag-name="resolveSubscribedChannelName"
          :data-list="subscribedChannelSuggestions"
          :are-channel-tags="true"
          :show-tags="sponsorBlockShowExcludedChannels"
          @invalid-name="handleInvalidChannel"
          @error-find-tag-info="handleChannelAPIError"
          @change="handleSponsorBlockExcludedChannels"
          @already-exists="handleChannelsExists"
          @toggle-show-tags="handleSponsorBlockShowExcludedChannels"
          @input="excludedChannelText = $event"
        />
      </FtFlexBox>
    </template>
  </FtSettingsSection>
</template>

<script setup>
import { computed, ref, useTemplateRef, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import FtSettingsSection from './FtSettingsSection/FtSettingsSection.vue'
import FtToggleSwitch from './FtToggleSwitch/FtToggleSwitch.vue'
import FtInput from './FtInput/FtInput.vue'
import FtFlexBox from './ft-flex-box/ft-flex-box.vue'
import FtSponsorBlockCategory from './FtSponsorBlockCategory/FtSponsorBlockCategory.vue'
import FtInputTags from './FtInputTags/FtInputTags.vue'

import store from '../store/index'

import { showToast } from '../helpers/utils'
import { checkYoutubeChannelId, findChannelTagInfo } from '../helpers/channels.js'
import { youtubeImageUrlToInvidious } from '../helpers/api/invidious'
import { MAIN_PROFILE_ID } from '../../constants'
import {
  exclusionSuggestions,
  parseExcludedChannels,
  resolveSubscribedChannelId,
  suggestionsMatching
} from '../../sponsorBlockExcludedChannels'

const { t } = useI18n()

const CATEGORIES = [
  'sponsor',
  'self-promotion',
  'interaction',
  'intro',
  'outro',
  'recap',
  'music offtopic',
  'filler'
]

const sponsorBlockExcludedChannelsDisabled = ref(false)

/** @type {import('vue').ComputedRef<boolean>} */
const useSponsorBlock = computed(() => store.getters.getUseSponsorBlock)

/** @type {import('vue').ComputedRef<string>} */
const sponsorBlockUrl = computed(() => store.getters.getSponsorBlockUrl)

/** @type {import('vue').ComputedRef<boolean>} */
const sponsorBlockShowSkippedToast = computed(() => store.getters.getSponsorBlockShowSkippedToast)

/** @type {import('vue').ComputedRef<boolean>} */
const useDeArrowTitles = computed(() => store.getters.getUseDeArrowTitles)

/** @type {import('vue').ComputedRef<boolean>} */
const useDeArrowThumbnails = computed(() => store.getters.getUseDeArrowThumbnails)

/** @type {import('vue').ComputedRef<string>} */
const deArrowThumbnailGeneratorUrl = computed(() => store.getters.getDeArrowThumbnailGeneratorUrl)

const sponsorBlockUrlInputRef = useTemplateRef('sponsorBlockUrlInput')
const deArrowThumbnailGeneratorUrlRef = useTemplateRef('deArrowThumbnailGeneratorUrl')

/** @type {import('vue').ComputedRef<any[]>} */
const sponsorBlockExcludedChannels = computed(() => parseExcludedChannels(store.getters.getSponsorBlockExcludedChannels))

/** @type {import('vue').ComputedRef<boolean>} */
const sponsorBlockShowExcludedChannels = computed(() => store.getters.getSponsorBlockShowExcludedChannels)

/** @type {import('vue').ComputedRef<'local' | 'invidious'>} */
const backendPreference = computed(() => store.getters.getBackendPreference)

/** @type {import('vue').ComputedRef<boolean>} */
const backendFallback = computed(() => store.getters.getBackendFallback)

const backendOptions = computed(() => ({
  preference: backendPreference.value,
  fallback: backendFallback.value
}))

/** @type {import('vue').ComputedRef<string>} */
const currentInvidiousInstanceUrl = computed(() => store.getters.getCurrentInvidiousInstanceUrl)

/** @type {import('vue').ComputedRef<{ id: string, name?: string, thumbnail?: string }[]>} */
const subscribedChannels = computed(() => store.getters.profileById(MAIN_PROFILE_ID)?.subscriptions ?? [])

const excludedChannelText = ref('')

const excludableChannelNames = computed(() => {
  return exclusionSuggestions(subscribedChannels.value, sponsorBlockExcludedChannels.value)
})

const subscribedChannelSuggestions = computed(() => {
  return suggestionsMatching(excludableChannelNames.value, excludedChannelText.value)
})

// Looking channels up only means anything while the list is on screen, and it
// is only on screen while SponsorBlock is on
onMounted(() => {
  if (useSponsorBlock.value) {
    verifySponsorBlockExcludedChannels()
  }
})

watch(useSponsorBlock, (enabled) => {
  if (enabled) {
    verifySponsorBlockExcludedChannels()
  }
})

/**
 * @param {any[]} value
 */
function handleSponsorBlockExcludedChannels(value) {
  store.dispatch('updateSponsorBlockExcludedChannels', JSON.stringify(value))
}

function handleSponsorBlockShowExcludedChannels() {
  store.dispatch('updateSponsorBlockShowExcludedChannels', !sponsorBlockShowExcludedChannels.value)
}

/**
 * @param {boolean} value
 */
function handleUpdateSponsorBlock(value) {
  store.dispatch('updateUseSponsorBlock', value)
}

/**
 * @param {boolean} value
 */
function handleUpdateUseDeArrowTitles(value) {
  store.dispatch('updateUseDeArrowTitles', value)
}

/**
 * @param {boolean} value
 */
function handleUpdateUseDeArrowThumbnails(value) {
  store.dispatch('updateUseDeArrowThumbnails', value)
}

/**
 * @param {boolean} value
 */
function handleUpdateSponsorBlockShowSkippedToast(value) {
  store.dispatch('updateSponsorBlockShowSkippedToast', value)
}

/**
 * @param {string} value
 */
function handleUpdateSponsorBlockUrl(value) {
  const cleanValue = cleanupUrl(value)
  store.dispatch('updateSponsorBlockUrl', cleanValue)

  if (cleanValue !== value) {
    sponsorBlockUrlInputRef.value?.setText(cleanValue)
  }
}

/**
 * @param {string} value
 */
function handleUpdateDeArrowThumbnailGeneratorUrl(value) {
  const cleanValue = cleanupUrl(value)
  store.dispatch('updateDeArrowThumbnailGeneratorUrl', cleanValue)

  if (cleanValue !== value) {
    deArrowThumbnailGeneratorUrlRef.value?.setText(cleanValue)
  }
}

function handleInvalidChannel() {
  showToast(t('SponsorBlock.Excluded Channel Not Found'))
}

function handleChannelAPIError() {
  showToast(t('Settings.Distraction Free Settings.Hide Channels API Error'))
}

function handleChannelsExists() {
  showToast(t('SponsorBlock.Excluded Channel Already Listed'))
}

/**
 * @param {string} url
 */
function cleanupUrl(url) {
  return url
    .replace(/\/+$/, '')
    .replace(/\/api$/, '')
}

/**
 * A name typed in stands for the subscribed channel of that name, so a channel
 * can be added without first finding its id. Only the user's own subscriptions
 * are searched, and nothing goes to the network for it.
 * @param {string} text
 * @returns {string | null} the channel id, or null to read the text as an id or URL
 */
function resolveSubscribedChannelName(text) {
  return resolveSubscribedChannelId(subscribedChannels.value, text)
}

/**
 * A subscribed channel's stored thumbnail, pointed at the Invidious instance
 * when that is the backend, as the rest of the app shows it.
 * @param {string} thumbnail
 */
function subscribedChannelIcon(thumbnail) {
  if (backendPreference.value === 'invidious') {
    return youtubeImageUrlToInvidious(thumbnail, currentInvidiousInstanceUrl.value)
  }

  return thumbnail.startsWith('//') ? `https:${thumbnail}` : thumbnail
}

/**
 * @param {string} text
 */
async function findChannelTagInfoWrapper(text) {
  // What the subscriptions already know about a channel saves asking YouTube
  const subscribed = subscribedChannels.value.find(channel => channel.id === text)

  if (subscribed?.name && subscribed.thumbnail) {
    return {
      preferredName: subscribed.name,
      icon: subscribedChannelIcon(subscribed.thumbnail),
      iconHref: `/channel/${subscribed.id}`
    }
  }

  return await findChannelTagInfo(text, backendOptions.value)
}

// Turning SponsorBlock off and on again while a pass is still looking channels
// up would start a second pass, and the two would write over each other
let verifyingExcludedChannels = false

async function verifySponsorBlockExcludedChannels() {
  if (verifyingExcludedChannels) return
  verifyingExcludedChannels = true

  try {
    await verifyExcludedChannelTags()
  } finally {
    verifyingExcludedChannels = false
    sponsorBlockExcludedChannelsDisabled.value = false
  }
}

async function verifyExcludedChannelTags() {
  const excludedChannelsCpy = [...sponsorBlockExcludedChannels.value]

  for (let i = 0; i < excludedChannelsCpy.length; i++) {
    const tag = excludedChannelsCpy[i]

    // if channel has been processed and confirmed as non existent, skip
    if (tag.invalid) continue

    // process if no preferred name and is possibly a YouTube ID
    if ((tag.preferredName === '' || !tag.icon) && checkYoutubeChannelId(tag.name)) {
      sponsorBlockExcludedChannelsDisabled.value = true

      const { preferredName, icon, iconHref, invalidId, err } = await findChannelTagInfoWrapper(tag.name)

      // A lookup that failed says nothing about the channel, and writing its
      // empty answer back would lose the name the entry was added with
      if (err) continue

      if (invalidId) {
        excludedChannelsCpy[i] = { name: tag.name, invalid: invalidId }
      } else {
        excludedChannelsCpy[i] = { name: tag.name, preferredName: preferredName || tag.preferredName, icon, iconHref }
      }

      // update on every tag in case it closes
      handleSponsorBlockExcludedChannels(excludedChannelsCpy)
    }
  }
}

</script>

<style scoped>
/* Clear of the category dropdowns above, which it would otherwise touch */
.excludedChannels {
  margin-block-start: 20px;
}
</style>
