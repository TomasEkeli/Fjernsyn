/**
 * Fjernsyn: full screen kept across the move from one video to the next.
 *
 * The player's full screen is HTML full screen on its container, and Electron
 * makes the window follow such an element, out of full screen when it leaves
 * the page, as the player's does between two videos. A window that is full
 * screen before the element asks is left alone, so here the element's
 * `requestFullscreen` first has main make the window full screen
 * (src/main/fullscreenHold.js), whoever calls it: shaka's button and double
 * click, the F key, a player starting in full screen.
 *
 * The window is let go of once full screen has ended for good: at once when
 * it ends with the player still there (Esc, the button, picture in picture),
 * or when the next player does not take it up in time after the one before
 * went in full screen. Esc lets go of it at once while waiting.
 */

// Long enough for the next video's details to come and its player to be set
// up; a window let go of before then comes back with the player, as without
// the hold
const SUCCESSOR_WAIT_MS = 10_000

/**
 * @typedef {object} FullscreenHoldDependencies
 * @property {{ holdWindowFullscreen: () => Promise<boolean>, releaseWindowFullscreen: () => void }} electron
 * @property {Document} [document]
 * @property {typeof setTimeout} [setTimeout]
 * @property {typeof clearTimeout} [clearTimeout]
 */

/**
 * @param {FullscreenHoldDependencies} dependencies
 */
export function createFullscreenHold({ electron, document: doc = document, setTimeout: startTimeout = setTimeout, clearTimeout: stopTimeout = clearTimeout }) {
  let successorExpected = false
  let successorWait = null
  let listening = false

  function listen() {
    if (listening) {
      return
    }

    listening = true
    doc.addEventListener('fullscreenchange', fullscreenChanged)
    doc.addEventListener('keydown', keyPressed)
  }

  function fullscreenChanged() {
    if (doc.fullscreenElement) {
      // Taken up, by the next player or this one
      successorExpected = false
      stopWaiting()
      return
    }

    if (successorExpected) {
      successorExpected = false
      stopWaiting()
      successorWait = startTimeout(release, SUCCESSOR_WAIT_MS)
    } else {
      release()
    }
  }

  /** @param {KeyboardEvent} event */
  function keyPressed(event) {
    if (event.key === 'Escape' && successorWait !== null && !doc.fullscreenElement) {
      release()
    }
  }

  function stopWaiting() {
    if (successorWait !== null) {
      stopTimeout(successorWait)
      successorWait = null
    }
  }

  function release() {
    successorExpected = false
    stopWaiting()
    electron.releaseWindowFullscreen()
  }

  /**
   * Has the element's full screen go on top of a held window full screen
   * @param {HTMLElement} element
   * @param {(holding: boolean) => void} [onHolding] told while the window is
   *   on its way into full screen, before the element is
   */
  function holdWindowUnder(element, onHolding) {
    listen()

    const requestFullscreen = Object.getPrototypeOf(element).requestFullscreen

    element.requestFullscreen = async function (options) {
      // The request itself is the one waited for
      stopWaiting()

      onHolding?.(true)
      try {
        await electron.holdWindowFullscreen()
        return await requestFullscreen.call(this, options)
      } catch (error) {
        if (!doc.fullscreenElement) {
          release()
        }
        throw error
      } finally {
        onHolding?.(false)
      }
    }
  }

  /**
   * The player is going in full screen, for a next one to start in it, so the
   * window waits for that one rather than leaving full screen with this one
   */
  function expectSuccessor() {
    successorExpected = true
  }

  /**
   * No player is coming after all (the view left, a message in its place):
   * the window leaves full screen now, or once the player's own has ended
   */
  function noSuccessor() {
    const waiting = successorExpected || successorWait !== null
    successorExpected = false

    if (waiting && !doc.fullscreenElement) {
      release()
    }
  }

  return { holdWindowUnder, expectSuccessor, noSuccessor }
}

const fullscreenHold = process.env.IS_ELECTRON
  ? createFullscreenHold({
      electron: {
        holdWindowFullscreen: () => window.ftElectron.holdWindowFullscreen(),
        releaseWindowFullscreen: () => window.ftElectron.releaseWindowFullscreen(),
      },
    })
  : null

/**
 * @param {HTMLElement} element
 * @param {(holding: boolean) => void} [onHolding]
 */
export function holdWindowUnderFullscreen(element, onHolding) {
  fullscreenHold?.holdWindowUnder(element, onHolding)
}

export function expectFullscreenSuccessor() {
  fullscreenHold?.expectSuccessor()
}

export function noFullscreenSuccessor() {
  fullscreenHold?.noSuccessor()
}
