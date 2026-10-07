import { computed, onBeforeUnmount, ref } from 'vue'

/**
 * How long the start screen stays at the least. A start that loads faster
 * would otherwise flash the card for a moment, which reads as a glitch rather
 * than as a start screen.
 */
export const START_SCREEN_MINIMUM_MS = 1000

/**
 * The start screen: the test card from the moment the window opens until the
 * data has loaded, and for at least a second. Every window has one, and one
 * opened later, whose data loads at once, still holds it for the second.
 *
 * The web build has none, as it has no keeper to wait for; it starts as
 * upstream's does.
 *
 * @param {import('vue').Ref<boolean>} dataReady
 * @returns {import('vue').ComputedRef<boolean>} whether the start screen shows
 */
export function useStartScreen(dataReady) {
  if (!process.env.IS_ELECTRON) {
    return computed(() => false)
  }

  const held = ref(true)
  const timeout = setTimeout(() => { held.value = false }, START_SCREEN_MINIMUM_MS)

  onBeforeUnmount(() => clearTimeout(timeout))

  return computed(() => held.value || !dataReady.value)
}

/**
 * Resolves once main's keeper has finished its startup check, which may take
 * in another machine's backup: nothing may read the data before then, or it
 * would read what the take in is about to replace. Main answers at once when
 * the check is done, so a window opened later goes straight on.
 *
 * A failed answer is logged and the start goes on: a start screen that never
 * leaves is worse than data read before the keeper was asked.
 */
export async function waitForKeeper() {
  if (!process.env.IS_ELECTRON) {
    return
  }

  try {
    await window.ftElectron.keeperReady()
  } catch (error) {
    console.error('The backup keeper did not say it was ready', error)
  }
}
