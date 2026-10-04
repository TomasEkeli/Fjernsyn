import { ref } from 'vue'

/**
 * Whether this window is the main one: the first, or the one main put in its
 * place when it closed. Only the main window checks the Later list's armed
 * items and runs the takeover, so that two windows never do either twice.
 * Outside Electron there is one window, and it is the main one.
 *
 * @returns {import('vue').Ref<boolean>}
 */
export function useMainWindow() {
  const isMain = ref(!process.env.IS_ELECTRON)

  if (process.env.IS_ELECTRON) {
    window.ftElectron.isMainWindow().then((value) => { isMain.value = value === true })
    window.ftElectron.handleMainWindowChanged((value) => { isMain.value = value })
  }

  return isMain
}
