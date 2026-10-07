<template>
  <template v-if="isMainWindow">
    <!--
      FtPrompt teleports into `.app`, which App renders only once the window is
      up. Over the start screen this stands in for it, so that a prompt asked
      while the app starts has somewhere to go.
    -->
    <div
      v-if="!windowUp"
      class="app keeperStartLayer"
    />
    <FtPrompt
      v-if="prompt !== null"
      :key="prompt.key"
      :label="prompt.label"
      :option-names="prompt.options.map(option => option.label)"
      :option-values="prompt.options.map(option => option.answer)"
      @click="answerPrompt"
    />
    <FtCard
      v-if="!windowUp && waitingSince !== null"
      class="keeperWaiting"
    >
      <p>
        {{ t('Settings.Data Settings.Backup.Keeper.Prompt.Waiting', { time: waitedText }) }}
      </p>
      <FtButton
        :label="t('Settings.Data Settings.Backup.Keeper.Stop waiting')"
        @click="answerKeeper('stopWaiting')"
      />
    </FtCard>
  </template>
</template>

<script setup>
/*
 * What main's backup keeper has to tell or ask, in the main window only, so
 * that two windows never ask twice. Mounted once in App, outside the block
 * that waits for the data, as the startup question about a base still
 * arriving is asked over the start screen: before the settings load, so in
 * the default locale and theme, and without the store's settings.
 *
 * Each pause is asked once, by its key, and each take in and run of failed
 * writes is told once. The keys seen are kept in sessionStorage, so a reload
 * of the window does not ask again; a choice put off stays open in the Backup
 * group.
 */
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import FtButton from '../FtButton/FtButton.vue'
import FtCard from '../ft-card/ft-card.vue'
import FtPrompt from '../FtPrompt/FtPrompt.vue'

import { showToast } from '../../helpers/utils'
import { useMainWindow } from '../../composables/useMainWindow'
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
 * @property {boolean} arriving whether this is the startup question, which must be answered
 * @property {string} label
 * @property {{ label: string, answer: import('../../../main/backup/keeper').KeeperAnswer }[]} options
 */

/** Set while the answer to the startup question is on its way to main */
const answering = ref(false)

const notNow = computed(() => ({ label: t('Settings.Data Settings.Backup.Keeper.Not now'), answer: 'notNow' }))

/** @type {import('vue').ComputedRef<Prompt | null>} */
const prompt = computed(() => {
  const current = status.value

  if (current == null) {
    return null
  }

  if (!props.windowUp) {
    const { arriving } = current

    if (arriving === null || arriving.waitingSince !== null || answering.value) {
      return null
    }

    return {
      key: 'arriving',
      arriving: true,
      label: t('Settings.Data Settings.Backup.Keeper.Prompt.Arriving', {
        machine: words.machine(arriving.machineName),
        time: words.time(arriving.writtenAt),
      }),
      options: [
        { label: t('Settings.Data Settings.Backup.Keeper.Wait for it'), answer: 'wait' },
        { label: t('Settings.Data Settings.Backup.Keeper.Continue with this data'), answer: 'continue' },
      ],
    }
  }

  const { pause } = current

  if (pause === null || seen.value.has(pause.key)) {
    return null
  }

  const asked = pausePrompt(pause)
  return asked === null ? null : { key: pause.key, arriving: false, ...asked }
})

/**
 * @param {NonNullable<import('../../../main/backup/keeper').KeeperStatus['pause']>} pause
 * @returns {Pick<Prompt, 'label' | 'options'> | null}
 */
function pausePrompt(pause) {
  const overwriteAll = { label: t('Settings.Data Settings.Backup.Keeper.Overwrite with this data'), answer: 'overwrite' }

  switch (pause.reason) {
    case 'otherMachine':
      return {
        label: t('Settings.Data Settings.Backup.Keeper.Prompt.Other machine', {
          machine: words.machine(pause.machineName),
          time: words.time(pause.writtenAt),
        }),
        options: [
          { label: t('Settings.Data Settings.Backup.Keeper.Restore'), answer: 'restore' },
          { label: t('Settings.Data Settings.Backup.Keeper.Overwrite'), answer: 'overwrite' },
          notNow.value,
        ],
      }
    case 'refused': {
      const reason = words.refusedReason(pause.detail)

      return {
        label: reason === null
          ? t('Settings.Data Settings.Backup.Keeper.Prompt.Refused without reason')
          : t('Settings.Data Settings.Backup.Keeper.Prompt.Refused', { reason }),
        options: [overwriteAll, notNow.value],
      }
    }
    case 'newer':
      return { label: t('Settings.Data Settings.Backup.Keeper.Prompt.Newer'), options: [notNow.value] }
    default:
      // baseMissing: the start went on without the base, and the notice asks
      // once it has arrived, when the pause becomes otherMachine
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

  if (current.arriving) {
    // The start waits on this question, so closing the prompt does not answer it
    if (answer === null) {
      return
    }

    answering.value = true
    await answerKeeper(answer)
    answering.value = false
    return
  }

  markSeen(current.key)
  await answerKeeper(answer ?? 'notNow')
}

// #endregion prompts

// #region waiting

/** @type {import('vue').ComputedRef<number | null>} */
const waitingSince = computed(() => status.value?.arriving?.waitingSince ?? null)

const now = ref(Date.now())
let ticking = 0

watch(waitingSince, (since) => {
  clearInterval(ticking)

  if (since !== null) {
    now.value = Date.now()
    ticking = setInterval(() => { now.value = Date.now() }, 1000)
  }
}, { immediate: true })

onBeforeUnmount(() => clearInterval(ticking))

/** How long the start has waited for the base, as m:ss */
const waitedText = computed(() => {
  const seconds = Math.max(0, Math.floor((now.value - (waitingSince.value ?? now.value)) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
})

// #endregion waiting

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

<style scoped src="./BackupKeeperNotices.css" />
