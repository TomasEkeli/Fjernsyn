<template>
  <div
    v-if="item"
    class="laterCountdown"
    role="alert"
  >
    <img
      class="thumbnail"
      :src="thumbnail"
      alt=""
    >
    <p class="text">
      {{ t('Later.Switching', { title: item.title, seconds }) }}
    </p>
    <div class="actions">
      <button
        class="action watchNow"
        @click="watchNow"
      >
        {{ t('Later.Watch now') }}
      </button>
      <button
        class="action cancel"
        @click="cancel"
      >
        {{ t('Later.Cancel') }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import store from '../../store/index'

/**
 * An armed item gone live while nothing is being watched: it says so and
 * counts ten seconds down, then goes to the stream. Watch now goes at once,
 * Cancel takes the alarm off and leaves the item at the top of the list. A
 * toast cannot hold this, as a toast is one big button with one action.
 */

/** Seconds counted down before switching */
const COUNTDOWN_SECONDS = 10

const { t } = useI18n()
const router = useRouter()

/** @type {import('vue').ComputedRef<import('../../helpers/later').LaterItem | null>} */
const item = computed(() => store.getters.getLaterCountdown)

const thumbnail = computed(() => `https://i.ytimg.com/vi/${item.value?.videoId}/mqdefault.jpg`)

const seconds = ref(COUNTDOWN_SECONDS)
let timer = null

function stop() {
  clearInterval(timer)
  timer = null
}

watch(item, (current) => {
  stop()

  if (current == null) { return }

  seconds.value = COUNTDOWN_SECONDS
  timer = setInterval(() => {
    seconds.value--

    if (seconds.value <= 0) {
      finish()
    }
  }, 1000)
}, { immediate: true })

// Taken off the list or disarmed elsewhere while counting down: nothing to go to
watch(() => item.value != null && store.getters.getIsArmed(item.value._id), (armed) => {
  if (item.value != null && !armed) {
    stop()
    store.commit('setLaterCountdown', null)
  }
})

onBeforeUnmount(stop)

/**
 * At zero: to the stream, unless the window was hidden meanwhile, where
 * nothing is to play; then as for a hidden window, a desktop notification,
 * and the item waits at the top of the list
 */
async function finish() {
  const current = item.value
  stop()

  if (current == null) { return }

  if (process.env.IS_ELECTRON && !await window.ftElectron.isWindowShown()) {
    await window.ftElectron.showLiveNotification({
      videoId: current.videoId,
      title: current.title,
      author: current.author,
      thumbnail: thumbnail.value,
    }).catch(() => false)
    store.dispatch('laterRefuse', current._id)
    return
  }

  watchNow()
}

function watchNow() {
  const current = item.value
  stop()

  if (current == null) { return }

  store.dispatch('laterWatchNow', current._id)
  router.push({ path: `/watch/${current.videoId}` })
}

function cancel() {
  const current = item.value
  stop()

  if (current == null) { return }

  store.dispatch('laterRefuse', current._id)
}
</script>

<style scoped src="./LaterCountdown.css" />
