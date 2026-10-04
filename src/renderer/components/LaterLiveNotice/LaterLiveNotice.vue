<template>
  <div
    v-if="notices.length > 0"
    class="laterLiveNotices"
    @keydown.enter.stop
    @keydown.space.stop
    @dblclick.stop
  >
    <div
      v-for="item in notices"
      :key="item._id"
      class="laterLiveNotice"
      role="alert"
    >
      <img
        class="thumbnail"
        :src="`https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`"
        alt=""
      >
      <div class="text">
        <p class="liveNow">
          {{ t('Later.Live now', { channel: item.author }) }}
        </p>
        <p
          class="title"
          dir="auto"
        >
          {{ item.title }}
        </p>
      </div>
      <div class="actions">
        <button
          class="action watchNow"
          @click.stop="watchNow(item)"
        >
          {{ t('Later.Watch now') }}
        </button>
        <button
          class="action dismiss"
          @click.stop="dismiss(item)"
        >
          {{ t('Later.Dismiss') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import store from '../../store/index'

/**
 * The armed Later items gone live while another video plays: drawn in the
 * player, as the live chat overlay is, so that full window and fullscreen show
 * them too. Each stays until Watch now, which goes to the stream and takes it
 * off the list, or Dismiss, which takes its alarm off and leaves it at the top
 * of the list. Several stack, soonest first.
 *
 * Enter and Space on its buttons go no further than the buttons, so that the
 * player's own shortcuts, which listen on the document, do not also act.
 */

const { t } = useI18n()
const router = useRouter()

/** @type {import('vue').ComputedRef<import('../../helpers/later').LaterItem[]>} */
const notices = computed(() => store.getters.getLaterNotices)

/** @param {import('../../helpers/later').LaterItem} item */
async function watchNow(item) {
  await store.dispatch('laterWatchNow', item._id)
  router.push({ path: `/watch/${item.videoId}` })
}

/** @param {import('../../helpers/later').LaterItem} item */
function dismiss(item) {
  store.dispatch('laterRefuse', item._id)
}
</script>

<style scoped src="./LaterLiveNotice.css" />
