<template>
  <FtPrompt
    v-if="isMainWindow && prompt !== null"
    :key="prompt.key"
    :label="prompt.label"
    :option-names="prompt.options.map(option => option.label)"
    :option-values="prompt.options.map(option => option.answer)"
    @click="answerPrompt"
  />
</template>

<script setup>
/*
 * What main's backup keeper has to tell or ask, and the window's part in
 * what it changes. Mounted once in App, in every window.
 *
 * Every window loads again the sections the keeper changed while the app ran
 * (useKeeperRefresh). The prompts and toasts are the main window's only, so
 * that two windows never ask twice, and only once the page is up, as both
 * live in it.
 *
 * Each pause is asked once, by its key, and each take in and run of failed
 * writes is told once. The keys seen are kept in sessionStorage, so a reload
 * of the window does not ask again; a choice put off stays open in the Backup
 * group.
 */
import { computed, nextTick, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import FtPrompt from '../FtPrompt/FtPrompt.vue'

import store from '../../store/index'
import { showToast } from '../../helpers/utils'
import { useMainWindow } from '../../composables/useMainWindow'
import { useKeeperRefresh } from '../../composables/useKeeperRefresh'
import { answerKeeper, useKeeperStatus, useKeeperWords } from '../../composables/useKeeperStatus'

const props = defineProps({
  /** Whether the page is up: the data loaded and the start screen gone */
  windowUp: {
    type: Boolean,
    required: true,
  },
})

const SEEN_KEY = 'BackupKeeperNotices/seen'

// Long enough to read a message with a path in it, as the Backup group's
const LONG_TOAST_MS = 15_000

const { t } = useI18n()
const words = useKeeperWords()
const status = useKeeperStatus()
const isMainWindow = useMainWindow()

useKeeperRefresh(store, () => props.windowUp)

// #region seen

/** @returns {string[]} */
function readSeen() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(SEEN_KEY))
    return Array.isArray(stored) ? stored : []
  } catch {
    return []
  }
}

/** The keys of the pauses asked and the events told in this window */
const seen = shallowRef(new Set(readSeen()))

/** @param {string} key */
function markSeen(key) {
  seen.value = new Set(seen.value).add(key)
  sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen.value]))
}

// #endregion seen

// #region prompts

/**
 * @typedef Prompt
 * @property {string} key
 * @property {string} label
 * @property {{ label: string, answer: import('../../../main/backup/keeper').KeeperAnswer }[]} options
 */

/** @type {import('vue').ComputedRef<Prompt | null>} */
const prompt = computed(() => {
  const pause = status.value?.pause ?? null

  if (!props.windowUp || pause === null || seen.value.has(pause.key)) {
    return null
  }

  const asked = pausePrompt(pause)
  return asked === null ? null : { key: pause.key, ...asked }
})

/**
 * @param {NonNullable<import('../../../main/backup/keeper').KeeperStatus['pause']>} pause
 * @returns {Pick<Prompt, 'label' | 'options'> | null}
 */
function pausePrompt(pause) {
  const notNow = { label: t('Settings.Data Settings.Backup.Keeper.Not now'), answer: 'notNow' }

  switch (pause.reason) {
    case 'refused': {
      const reason = words.refusedReason(pause.detail)

      return {
        label: reason === null
          ? t('Settings.Data Settings.Backup.Keeper.Prompt.Refused without reason')
          : t('Settings.Data Settings.Backup.Keeper.Prompt.Refused', { reason }),
        options: [{ label: t('Settings.Data Settings.Backup.Keeper.Overwrite with this data'), answer: 'overwrite' }, notNow],
      }
    }
    case 'newer':
      return { label: t('Settings.Data Settings.Backup.Keeper.Prompt.Newer'), options: [notNow] }
    default:
      return null
  }
}

/**
 * @param {import('../../../main/backup/keeper').KeeperAnswer | null} answer
 *   null when the prompt was closed without a choice
 */
async function answerPrompt(answer) {
  const current = prompt.value

  if (current === null) {
    return
  }

  markSeen(current.key)
  await answerKeeper(answer ?? 'notNow')
}

// #endregion prompts

// #region toasts

// Told once the page is up, as the toasts live in it: one shown before then
// would go nowhere
watch([status, () => props.windowUp, isMainWindow], async ([current, windowUp, isMain]) => {
  if (current == null || !windowUp || !isMain) {
    return
  }

  const messages = []

  if (current.tookIn !== null && !seen.value.has(current.tookIn.key)) {
    markSeen(current.tookIn.key)
    messages.push(t('Settings.Data Settings.Backup.Keeper.Restored', {
      machine: words.machine(current.tookIn.machineName),
      time: words.time(current.tookIn.writtenAt),
    }))
  }

  // One toast for a run of failed writes, which keeps the time of its first
  const failureKey = current.failure === null ? null : `failure:${current.failure.since}`

  if (failureKey !== null && !seen.value.has(failureKey)) {
    markSeen(failureKey)
    messages.push(t('Settings.Data Settings.Backup.Keeper.Failed', { message: current.failure.message }))
  }

  if (messages.length > 0) {
    // The toasts' holder mounts with the page, in the same update as this
    await nextTick()
    messages.forEach(message => showToast(message, LONG_TOAST_MS))
  }
}, { immediate: true })

// #endregion toasts
</script>
