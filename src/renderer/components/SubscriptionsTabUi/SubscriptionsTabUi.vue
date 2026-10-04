<template>
  <div>
    <FtLoader
      v-if="isLoading"
    />
    <div
      v-if="!isLoading && errorChannels.length !== 0"
    >
      <h3> {{ $t("Subscriptions.Error Channels") }}</h3>
      <FtFlexBox>
        <FtChannelBubble
          v-for="channel in errorChannels"
          :key="channel.id"
          :channel-name="channel.name"
          :channel-id="channel.id"
          :channel-thumbnail="channel.thumbnail"
        />
      </FtFlexBox>
    </div>
    <FtFlexBox
      v-if="!isLoading && activeVideoList.length === 0"
    >
      <p
        v-if="!activeProfileHasSubscriptions"
        class="message"
      >
        {{ $t("Subscriptions['Your Subscription list is currently empty. Start adding subscriptions to see them here.']") }}
      </p>
      <p
        v-else-if="!fetchSubscriptionsAutomatically && !attemptedFetch"
        class="message"
      >
        {{ $t("Subscriptions.Disabled Automatic Fetching") }}
      </p>
      <p
        v-else-if="aiHidEverything"
        class="message"
      >
        {{ $t('AI Chip.All Hidden') }}
      </p>
      <p
        v-else-if="videoList.length > 0 && !watchedIsShown()"
        class="message"
      >
        {{ $t("Watched Chip.All Watched") }}
      </p>
      <p
        v-else
        class="message"
      >
        {{ $t("Subscriptions.Empty Channels") }}
      </p>
    </FtFlexBox>
    <FtElementList
      v-if="!isLoading && activeVideoList.length > 0"
      :data="activeVideoList"
      :use-channels-hidden-preference="false"
      ai-wall
    />
    <FtAutoLoadNextPageWrapper
      v-if="!isLoading && filteredVideoList.length > dataLimit"
      @load-next-page="increaseLimit"
    >
      <FtFlexBox>
        <FtButton
          :label="$t('Subscriptions.Load More')"
          background-color="var(--primary-color)"
          text-color="var(--text-with-main-color)"
          @click="increaseLimit"
        />
      </FtFlexBox>
    </FtAutoLoadNextPageWrapper>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

import FtAutoLoadNextPageWrapper from '../FtAutoLoadNextPageWrapper.vue'
import FtButton from '../FtButton/FtButton.vue'
import FtChannelBubble from '../FtChannelBubble/FtChannelBubble.vue'
import FtElementList from '../FtElementList/FtElementList.vue'
import FtFlexBox from '../ft-flex-box/ft-flex-box.vue'
import FtLoader from '../FtLoader/FtLoader.vue'

import store from '../../store/index'

import { debounce } from '../../helpers/utils'
import { watchedIsShown, withWatchedPreference } from '../../helpers/watchedShown'
import { aiIsShown, withAiPreference } from '../../helpers/aiShown'

/**
 * The subscriptions stream, as a list on a page.
 *
 * Named for the tabs it used to be one of; it now renders the one merged stream
 * of videos, shorts, live streams and posts. The name is left alone because
 * upstream carries this file too and a rename buys nothing but merge conflicts.
 *
 * Everything here is about display: which slice is on screen, and which of the
 * viewing preferences hide entries. What the entries are and where they came
 * from is the composable's business; refreshing them is the page's, since that
 * is where the control row holding the button is.
 */
const props = defineProps({
  isLoading: {
    type: Boolean,
    default: false
  },
  videoList: {
    type: Array,
    default: () => []
  },
  errorChannels: {
    type: Array,
    default: () => []
  },
  attemptedFetch: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['visible-entries'])

/**
 * How much of the stream is rendered at once, and how much each "load more"
 * adds.
 *
 * A prop until the four feeds became one, so that posts could be paged twenty
 * at a time where videos went a hundred. There is one stream now, so there is
 * one page size.
 */
const PAGE_SIZE = 100

const subscriptionLimit = sessionStorage.getItem('subscriptionLimit')

const dataLimit = ref(subscriptionLimit !== null ? parseInt(subscriptionLimit) : PAGE_SIZE)

const activeVideoList = computed(() => {
  if (filteredVideoList.value.length < dataLimit.value) {
    return filteredVideoList.value
  } else {
    return filteredVideoList.value.slice(0, dataLimit.value)
  }
})

const activeProfileHasSubscriptions = computed(() => {
  return store.getters.getActiveProfile.subscriptions.length > 0
})

/** @type {import('vue').ComputedRef<boolean>} */
const fetchSubscriptionsAutomatically = computed(() => {
  return store.getters.getFetchSubscriptionsAutomatically
})

const onlyShowLatestFromChannel = computed(() => {
  return store.getters.getOnlyShowLatestFromChannel
})

const onlyShowLatestFromChannelNumber = computed(() => {
  return store.getters.getOnlyShowLatestFromChannelNumber
})

const filteredVideoList = computed(() => {
  // AI videos hidden by the pill are out before the stream is cut into pages,
  // as watched ones are, so that a page of them does not stand empty while
  // more is to be had below
  let videoList = withAiPreference(withWatchedPreference(props.videoList))

  if (onlyShowLatestFromChannel.value) {
    const authors = new Map()
    videoList = videoList.filter((video) => {
      if (!video.authorId) {
        return true
      }

      if (!authors.has(video.authorId)) {
        authors.set(video.authorId, 1)
        return true
      } else {
        const currentVideos = authors.get(video.authorId)

        if (currentVideos < onlyShowLatestFromChannelNumber.value) {
          authors.set(video.authorId, currentVideos + 1)
          return true
        }
      }

      return false
    })
  }

  return videoList
})

/**
 * Whether the AI pill took out everything watched videos left, for the empty
 * stream to say so, rather than that nothing has been published
 */
const aiHidEverything = computed(() => !aiIsShown() && withWatchedPreference(props.videoList).length > 0)

function increaseLimit() {
  dataLimit.value += PAGE_SIZE
  sessionStorage.setItem('subscriptionLimit', dataLimit.value.toFixed(0))
}

// This component is the only place that knows which part of the feed is actually
// on screen, so it is the place that says what it is. What that is worth doing
// about is not its business: the entries no longer say which kind they are, and
// the composable that assembled them is what knows. Debounced because the
// visible slice changes on every refresh, profile switch and "load more", and
// often several times in quick succession.
const reportVisibleEntries = debounce(() => {
  if (props.isLoading) { return }

  emit('visible-entries', activeVideoList.value)
}, 500)

watch(activeVideoList, reportVisibleEntries)
</script>

<style scoped src="./SubscriptionsTabUi.css" />
