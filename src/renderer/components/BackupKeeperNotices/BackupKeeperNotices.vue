<script setup>
/*
 * What main's backup keeper has to tell, and the window's part in what it
 * changes. Mounted once in App, in every window.
 *
 * Every window loads again the sections the keeper changed while the app ran
 * (useKeeperRefresh). The toasts are the main window's only, so that two
 * windows never tell the same thing twice, and only once the page is up, as
 * they live in it.
 *
 * Each run of failed writes is told once, by its key. The keys seen are kept
 * in sessionStorage, so a reload of the window does not tell again. Nothing
 * is asked: every machine follows the folder by merging.
 */
import { nextTick, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import store from '../../store/index'
import { showToast } from '../../helpers/utils'
import { useMainWindow } from '../../composables/useMainWindow'
import { useKeeperRefresh } from '../../composables/useKeeperRefresh'
import { useKeeperStatus } from '../../composables/useKeeperStatus'

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

/** The keys of the events told in this window */
const seen = shallowRef(new Set(readSeen()))

/** @param {string} key */
function markSeen(key) {
  seen.value = new Set(seen.value).add(key)
  sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen.value]))
}

// #endregion seen

// #region toasts

// Told once the page is up, as the toasts live in it: one shown before then
// would go nowhere
watch([status, () => props.windowUp, isMainWindow], async ([current, windowUp, isMain]) => {
  if (current == null || !windowUp || !isMain) {
    return
  }

  const messages = []

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
