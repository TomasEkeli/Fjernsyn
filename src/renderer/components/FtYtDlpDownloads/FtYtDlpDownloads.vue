<template>
  <div
    v-if="visible"
    ref="root"
    class="ytDlpDownloads"
    @keydown.esc.stop="close(true)"
  >
    <span class="indicator">
      <FtIconButton
        ref="indicatorButton"
        :title="indicatorTitle"
        :icon="['fas', 'download']"
        :theme="null"
        :size="20"
        :use-shadow="false"
        @click="toggle"
      />
      <FtProgressRing
        v-if="running.length > 0"
        class="indicatorRing"
        :fraction="overallFraction"
      />
      <span
        v-if="running.length > 1"
        class="indicatorCount"
        aria-hidden="true"
      >{{ running.length }}</span>
    </span>
    <div
      v-if="ytDlpDownloads.panelOpen"
      ref="panel"
      class="panel"
      role="dialog"
      :aria-label="t('Video.yt-dlp.Downloads.Downloads')"
      tabindex="-1"
    >
      <h2 class="panelTitle">
        {{ t('Video.yt-dlp.Downloads.Downloads') }}
      </h2>
      <p
        v-if="rows.length === 0"
        class="empty"
      >
        {{ t('Video.yt-dlp.Downloads.Nothing here') }}
      </p>
      <ul
        v-else
        class="rows"
      >
        <li
          v-for="download in rows"
          :key="download.videoId"
          class="row"
        >
          <p
            class="rowTitle"
            dir="auto"
          >
            {{ download.title || download.videoId }}
          </p>
          <p
            v-if="qualityText(download)"
            class="rowQuality"
          >
            {{ qualityText(download) }}
          </p>
          <p
            class="rowStatus"
            role="status"
          >
            {{ statusText(download) }}
          </p>
          <progress
            v-if="isRunning(download)"
            class="rowProgress"
            :aria-label="statusText(download)"
            max="1"
            :value="progressFraction(download) ?? undefined"
          />
          <p
            v-if="detailsText(download)"
            class="rowDetails"
          >
            {{ detailsText(download) }}
          </p>
          <p
            v-if="whereText(download)"
            class="rowWhere"
          >
            {{ whereText(download) }}
          </p>
          <div class="rowActions">
            <FtButton
              v-if="download.status === 'finished'"
              :label="t('Video.yt-dlp.Downloads.Show in folder')"
              :icon="['fas', 'folder-open']"
              @click="revealDownload(download.videoId)"
            />
            <FtButton
              v-if="isRunning(download)"
              :label="t('Video.yt-dlp.Downloads.Cancel')"
              text-color="var(--text-with-main-color)"
              background-color="var(--primary-color)"
              @click="cancelDownload(download.videoId)"
            />
            <FtButton
              v-else
              :label="t('Video.yt-dlp.Downloads.Dismiss')"
              text-color="var(--primary-text-color)"
              background-color="var(--secondary-card-bg-color)"
              @click="dismissDownload(download.videoId)"
            />
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { faFolderOpen } from '@fortawesome/free-solid-svg-icons'

import FtButton from '../FtButton/FtButton.vue'
import FtIconButton from '../FtIconButton/FtIconButton.vue'
import FtProgressRing from '../FtProgressRing/FtProgressRing.vue'

import { library } from '../../fontawesome-minimal'
// yt-dlp's and PeerTube's downloads both, each action sent by the key
import { cancelDownload, revealDownload } from '../../helpers/downloads'
import {
  detailsText,
  dismissDownload,
  isRunning,
  progressFraction,
  qualityText,
  statusText,
  whereText,
  ytDlpDownloads,
} from '../../helpers/ytdlpDownloads'

// Registered here rather than in main.js, to keep the fork out of upstream's list
library.add(faFolderOpen)

const { t } = useI18n()

/**
 * Running first, in the order they started, then the ended ones, latest first.
 */
const rows = computed(() => {
  const all = Object.values(ytDlpDownloads.byId)
  const running = all.filter(isRunning)
  const ended = all.filter(download => !isRunning(download))
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))

  return [...running, ...ended]
})

const running = computed(() => rows.value.filter(isRunning))

// Only there while there is something to show, and only in Electron
const visible = computed(() => !!process.env.IS_ELECTRON && rows.value.length > 0)

/**
 * The average of the running downloads whose progress is known, or null to
 * spin when none is.
 */
const overallFraction = computed(() => {
  const fractions = running.value.map(progressFraction).filter(fraction => fraction !== null)
  return fractions.length > 0 ? fractions.reduce((sum, fraction) => sum + fraction, 0) / fractions.length : null
})

const indicatorTitle = computed(() => {
  return running.value.length > 0
    ? t('Video.yt-dlp.Downloads.Downloads running', { count: running.value.length })
    : t('Video.yt-dlp.Downloads.Downloads')
})

const root = useTemplateRef('root')
const panel = useTemplateRef('panel')
const indicatorButton = useTemplateRef('indicatorButton')

function toggle() {
  ytDlpDownloads.panelOpen = !ytDlpDownloads.panelOpen
}

/**
 * @param {boolean} [returnFocus]
 */
function close(returnFocus = false) {
  if (!ytDlpDownloads.panelOpen) {
    return
  }

  ytDlpDownloads.panelOpen = false

  if (returnFocus) {
    indicatorButton.value?.$el.querySelector('button')?.focus()
  }
}

// Opened from here or from the watch page button: either way, focus it so
// that it can be read and closed from the keyboard
watch(() => ytDlpDownloads.panelOpen, async (open) => {
  if (open) {
    await nextTick()
    panel.value?.focus()
  }
})

// Nothing left to show: nothing left open either
watch(visible, (isVisible) => {
  if (!isVisible) {
    ytDlpDownloads.panelOpen = false
  }
})

/**
 * @param {PointerEvent} event
 */
function closeOnOutsidePointer(event) {
  if (ytDlpDownloads.panelOpen && root.value && !root.value.contains(/** @type {Node} */ (event.target))) {
    close()
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', closeOnOutsidePointer)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeOnOutsidePointer)
})
</script>

<style scoped src="./FtYtDlpDownloads.css" />
