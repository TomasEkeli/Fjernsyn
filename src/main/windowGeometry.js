import { screen as electronScreen } from 'electron'

/**
 * Every change the app itself makes to a window's bounds goes through here,
 * so that there is one place that knows which windows the app is moving and
 * why. Today that is the long press move of a frameless window; fitting the
 * window to a video's aspect ratio is meant to be another function beside it,
 * using the same bounds path.
 *
 * All coordinates are Electron's device-independent pixels, from the screen
 * module and the window itself, so page zoom and per-monitor scaling cannot
 * skew them. The renderer only says when a move starts and ends.
 */

// About one frame at 60 Hz: smooth enough to look attached to the cursor
const MOVE_TICK_MS = 16

/**
 * @typedef {object} WindowGeometryDependencies
 * @property {Pick<Electron.Screen, 'getCursorScreenPoint'>} [screen]
 * @property {typeof setInterval} [setInterval]
 * @property {typeof clearInterval} [clearInterval]
 */

/**
 * @param {WindowGeometryDependencies} [dependencies]
 */
export function createWindowGeometry(dependencies = {}) {
  // Read lazily, since Electron's screen module is only usable once the app is ready
  const getScreen = () => dependencies.screen ?? electronScreen
  const startInterval = dependencies.setInterval ?? setInterval
  const stopInterval = dependencies.clearInterval ?? clearInterval

  /** @type {Map<Electron.BrowserWindow, { interval: ReturnType<typeof setInterval>, dispose: () => void }>} */
  const moves = new Map()

  /**
   * Starts moving the window with the cursor, keeping the cursor where it was
   * on the window when the move started. Does nothing for a window that is
   * gone, maximised or fullscreen, or already moving.
   * @param {Electron.BrowserWindow} win
   */
  function startMove(win) {
    if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen() || moves.has(win)) {
      return
    }

    const cursor = getScreen().getCursorScreenPoint()
    const [windowX, windowY] = win.getPosition()
    const offset = { x: cursor.x - windowX, y: cursor.y - windowY }

    // The size is held fixed for the whole move. Setting only the position
    // lets Windows grow or shrink the window as it crosses between monitors
    // with different scaling, and it then keeps the wrong size.
    const [width, height] = win.getSize()
    let lastX = windowX
    let lastY = windowY

    const interval = startInterval(() => {
      if (win.isDestroyed()) {
        endMove(win)
        return
      }

      const point = getScreen().getCursorScreenPoint()
      const x = Math.round(point.x - offset.x)
      const y = Math.round(point.y - offset.y)

      if (x !== lastX || y !== lastY) {
        lastX = x
        lastY = y
        win.setBounds({ x, y, width, height })
      }
    }, MOVE_TICK_MS)

    // A pointerup the renderer never sees, because focus went elsewhere or
    // the window changed state under the move, must not leave it running
    const stop = () => endMove(win)
    const events = ['blur', 'closed', 'maximize', 'enter-full-screen']
    events.forEach(event => win.once(event, stop))

    moves.set(win, {
      interval,
      dispose: () => {
        if (!win.isDestroyed()) {
          events.forEach(event => win.removeListener(event, stop))
        }
      }
    })
  }

  /**
   * Stops a move started by startMove. Does nothing if the window is not moving.
   * @param {Electron.BrowserWindow} win
   */
  function endMove(win) {
    const move = moves.get(win)

    if (!move) {
      return
    }

    moves.delete(win)
    stopInterval(move.interval)
    move.dispose()
  }

  /**
   * @param {Electron.BrowserWindow} win
   */
  function isMoving(win) {
    return moves.has(win)
  }

  return { startMove, endMove, isMoving }
}

const windowGeometry = createWindowGeometry()

export const startMove = windowGeometry.startMove
export const endMove = windowGeometry.endMove
