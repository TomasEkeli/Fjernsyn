<template>
  <div>
    <FtCard class="card">
      <h2>
        {{ $t('Sources.Sources') }}
      </h2>
      <div class="follow">
        <FtInput
          ref="followInput"
          class="followInput"
          :placeholder="$t('Sources.Follow Placeholder')"
          :action-button-label="$t('Sources.Follow')"
          :force-action-button-icon-name="['fas', 'plus']"
          :value="address"
          :disabled="!canFollow"
          :show-label="false"
          @input="address = $event"
          @click="follow"
        />
        <p
          class="followStatus"
          :class="{ refused: status.refused }"
          role="status"
        >
          {{ status.text }}
        </p>
      </div>
      <FtLoader
        v-if="!ready"
      />
      <p
        v-else-if="sources.length === 0"
        class="message"
      >
        {{ grabFailed ? $t('Sources.Read Failed') : $t('Sources.Nothing Followed') }}
      </p>
      <ul
        v-else
        class="sources"
      >
        <li
          v-for="source in sources"
          :key="source._id"
          class="source"
        >
          <RouterLink
            class="sourceLink"
            :to="{ name: 'collectionSource', params: { sourceId: source._id } }"
          >
            <span class="sourceName">{{ source.name }}</span>
            <span class="sourceAbout">
              <span>{{ source.kindLabel }}</span>
              <span>{{ source.instance }}</span>
              <span>{{ $t('Sources.Videos', { count: source.videoCount }, source.videoCount) }}</span>
            </span>
          </RouterLink>
          <FtButton
            class="unfollowButton"
            :label="$t('Sources.Unfollow')"
            :aria-label="$t('Sources.Unfollow Source', { name: source.name })"
            :title="$t('Sources.Unfollow Source', { name: source.name })"
            :disabled="unfollowing !== null"
            @click="unfollowAsked = source"
          />
        </li>
      </ul>
    </FtCard>
    <FtPrompt
      v-if="unfollowAsked !== null"
      :label="$t('Sources.Unfollow Prompt', { name: unfollowAsked.name })"
      :extra-labels="[$t('Sources.Unfollow Prompt Detail')]"
      :option-names="[$t('Sources.Unfollow'), $t('Cancel')]"
      :option-values="['unfollow', 'cancel']"
      :is-first-option-destructive="true"
      @click="handleUnfollowPrompt"
    />
  </div>
</template>

<script setup>
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import FtButton from '../../components/FtButton/FtButton.vue'
import FtCard from '../../components/ft-card/ft-card.vue'
import FtInput from '../../components/FtInput/FtInput.vue'
import FtLoader from '../../components/FtLoader/FtLoader.vue'
import FtPrompt from '../../components/FtPrompt/FtPrompt.vue'

import store from '../../store/index'

import { sourceInstance, sourceKindLabel } from '../../helpers/collections/sourceLabels'
import { showToast } from '../../helpers/utils'

/**
 * Sources: the places Collections follows, as the Channels page lists the
 * channels subscribed to, without its profiles.
 *
 * A source is followed by pasting its address: each source kind is asked in
 * turn whether it recognises it, and the source is then asked once for what
 * it shares before it is followed (`helpers/collections/follow.js`), so that
 * an instance serving no feed, or none that can be read, is refused at once
 * rather than followed and failing on every refresh. Its videos are kept as
 * soon as it is followed. Unfollowing, after a prompt, takes its videos off
 * Collections; a feed lists only the latest posts, so following it again does
 * not bring the older ones back.
 *
 * Each source opens its own page (`views/CollectionSource`).
 *
 * Visiting it follows the starter set on a first run, and nothing more: the
 * list is what Collections will follow from the start, and a starter source
 * can be unfollowed before any wall is opened. Their videos come with the
 * first wall opened (HackerTube's from the bundle, the communities' from its
 * refresh), so until then each shows none here.
 */

const { t } = useI18n()

/** @type {import('vue').ComputedRef<boolean>} */
const ready = computed(() => store.getters.getCollectionsReady)

// Once the datastore is read: before, what is held says nothing of what is followed
let applied = false
watch(ready, (isReady) => {
  if (!isReady || applied) { return }

  applied = true
  store.dispatch('applyCollectionsStarterSet').catch(error => console.error('Sources: could not follow the starter set', error))
}, { immediate: true })

/** @type {import('vue').ComputedRef<boolean>} */
const grabFailed = computed(() => store.getters.getCollectionsGrabFailed)

/**
 * Every followed source, by name, with how it is described and how many of
 * its videos are kept
 */
const sources = computed(() => {
  /** @type {Map<string, number>} */
  const counts = new Map()

  for (const share of store.getters.getCollectionShares) {
    counts.set(share.sourceId, (counts.get(share.sourceId) ?? 0) + 1)
  }

  return store.getters.getCollectionSources
    .map(source => ({
      _id: source._id,
      name: source.name,
      kindLabel: sourceKindLabel(source.kind, t),
      instance: sourceInstance(source),
      videoCount: counts.get(source._id) ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
})

const followInput = useTemplateRef('followInput')

/** What is in the field */
const address = ref('')

/** Whether a follow is under way */
const following = ref(false)

/** @type {import('vue').ComputedRef<boolean>} */
const canFollow = computed(() => ready.value && !grabFailed.value && !following.value)

/**
 * What the line under the field says: how to write an address, what is being
 * done, or how the last follow went; `refused` for a follow that did not
 * happen
 *
 * @type {import('vue').Ref<{ text: string, refused: boolean }>}
 */
const status = ref({ text: t('Sources.Follow Hint'), refused: false })

/**
 * @param {string} text what was pasted, as the field gives it
 */
async function follow(text) {
  if (!canFollow.value || text.trim() === '') { return }

  following.value = true
  status.value = { text: t('Sources.Trying'), refused: false }

  try {
    const followed = await store.dispatch('followCollectionSourceByUrl', text)
    status.value = statusOf(followed)

    if (followed.outcome === 'followed') {
      address.value = ''
    }
  } catch (error) {
    console.error('Sources: could not follow', error)
    status.value = { text: t('Sources.Follow Failed'), refused: true }
  } finally {
    following.value = false
    // Back in the field, once it is no longer disabled, for the next address
    await nextTick()
    followInput.value?.focus()
  }
}

/**
 * @param {{ outcome: string, source?: { name: string } }} followed
 * @returns {{ text: string, refused: boolean }}
 */
function statusOf({ outcome, source }) {
  const name = source?.name ?? ''

  switch (outcome) {
    case 'followed':
      return { text: t('Sources.Followed', { name }), refused: false }
    case 'followed-already':
      return { text: t('Sources.Followed Already', { name }), refused: false }
    case 'no-feed':
      return { text: t('Sources.No Feed', { name }), refused: true }
    case 'unreachable':
      return { text: t('Sources.Unreachable', { name }), refused: true }
    case 'unavailable':
      return { text: t('Sources.Read Failed'), refused: true }
    default:
      return { text: t('Sources.Unrecognised'), refused: true }
  }
}

/** @type {import('vue').Ref<{ _id: string, name: string } | null>} the source the prompt asks about */
const unfollowAsked = ref(null)

/** @type {import('vue').Ref<string | null>} the source being unfollowed */
const unfollowing = ref(null)

/**
 * @param {'unfollow' | 'cancel' | null} answer
 */
async function handleUnfollowPrompt(answer) {
  const source = unfollowAsked.value
  unfollowAsked.value = null

  if (answer !== 'unfollow' || source === null) { return }

  unfollowing.value = source._id

  try {
    await store.dispatch('unfollowCollectionSource', source._id)
    showToast(t('Sources.Unfollowed', { name: source.name }))
  } catch (error) {
    console.error('Sources: could not unfollow', error)
    showToast(t('Sources.Unfollow Failed', { name: source.name }))
  } finally {
    unfollowing.value = null
  }
}
</script>

<style scoped src="./Sources.css" />
