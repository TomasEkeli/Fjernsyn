/**
 * The window held in full screen under the player's own full screen, so that
 * it stays full screen when the player goes from one video to the next.
 *
 * The player's full screen is HTML full screen on its container. Electron
 * makes the window follow such an element: full screen when it enters, out of
 * full screen when it leaves, and it leaves when the player's element leaves
 * the page between two videos. Only a window that is already full screen when
 * the element asks is left alone (`native_fullscreen_` in Electron's
 * `WebContents::SetHtmlApiFullscreen`): the element's full screen then comes
 * and goes on top of it. So the renderer has the window made full screen here
 * first, and asks for its element's after.
 *
 * Only a window made full screen here is let go of here. One the user made
 * full screen (F11, the menu) was not, and stays full screen.
 */

// How long the window is given to report that it is full screen, after which
// the element asks anyway, as it would have without the hold
const ENTER_TIMEOUT_MS = 1000

/**
 * @typedef {object} FullscreenHoldDependencies
 * @property {typeof setTimeout} [setTimeout]
 * @property {typeof clearTimeout} [clearTimeout]
 */

/**
 * @param {FullscreenHoldDependencies} [dependencies]
 */
export function createFullscreenHold(dependencies = {}) {
  const startTimeout = dependencies.setTimeout ?? setTimeout
  const stopTimeout = dependencies.clearTimeout ?? clearTimeout

  /** @type {Map<Electron.BrowserWindow, () => void>} the windows held, each with what stops watching it */
  const held = new Map()

  /**
   * Makes the window full screen, unless it already is, and resolves once it
   * is or the wait is over.
   * @param {Electron.BrowserWindow} win
   * @returns {Promise<boolean>} whether the window is held, by this call or an earlier one
   */
  function hold(win) {
    if (!win || win.isDestroyed()) {
      return Promise.resolve(false)
    }

    if (held.has(win)) {
      return Promise.resolve(true)
    }

    // The user's own full screen, or the element's from before the hold
    if (win.isFullScreen()) {
      return Promise.resolve(false)
    }

    // Whatever takes the window out of full screen ends the hold: F11, the
    // window manager, or a release
    const forget = () => unwatch(win)
    // A renderer that reloads or goes away can no longer let go
    const releaseNow = () => release(win)
    /** @param {{ isMainFrame?: boolean, isSameDocument?: boolean }} details */
    const releaseOnReload = (details) => {
      if (details?.isMainFrame && !details.isSameDocument) {
        release(win)
      }
    }

    const webContents = win.webContents
    win.once('leave-full-screen', forget)
    win.once('closed', forget)
    webContents?.once('render-process-gone', releaseNow)
    webContents?.on('did-start-navigation', releaseOnReload)

    held.set(win, () => {
      win.off('leave-full-screen', forget)
      win.off('closed', forget)
      if (webContents && !webContents.isDestroyed()) {
        webContents.off('render-process-gone', releaseNow)
        webContents.off('did-start-navigation', releaseOnReload)
      }
    })

    return new Promise((resolve) => {
      let timeout = null

      const entered = () => {
        stopTimeout(timeout)
        win.off('enter-full-screen', entered)
        resolve(held.has(win))
      }

      win.once('enter-full-screen', entered)
      timeout = startTimeout(entered, ENTER_TIMEOUT_MS)
      win.setFullScreen(true)
    })
  }

  /**
   * Takes the window out of full screen if it is held; a no-op otherwise
   * @param {Electron.BrowserWindow} win
   */
  function release(win) {
    if (!win || !held.has(win)) {
      return
    }

    unwatch(win)

    // Not only when it reports full screen: a release while it is still on
    // its way in must not leave it to arrive
    if (!win.isDestroyed()) {
      win.setFullScreen(false)
    }
  }

  /** @param {Electron.BrowserWindow} win */
  function unwatch(win) {
    const stopWatching = held.get(win)
    held.delete(win)
    stopWatching?.()
  }

  /**
   * Whether the window is full screen only because it is held, which the
   * saved window state should not remember
   * @param {Electron.BrowserWindow} win
   */
  function isHeld(win) {
    return held.has(win)
  }

  return { hold, release, isHeld }
}

const fullscreenHold = createFullscreenHold()

export const holdFullscreen = fullscreenHold.hold
export const releaseFullscreen = fullscreenHold.release
export const isFullscreenHeld = fullscreenHold.isHeld
