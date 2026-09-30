import { screen as electronScreen } from 'electron'

/**
 * Every change the app itself makes to a window's bounds goes through here,
 * so that there is one place that knows which windows the app is moving and
 * why. That is the long press move of a frameless window, and the fit of the
 * window to the video's shape while the player is in full window.
 *
 * All coordinates are Electron's device-independent pixels, from the screen
 * module and the window itself, so page zoom and per-monitor scaling cannot
 * skew them. The renderer only says when a move starts and ends, and when a
 * fit starts and ends.
 */

// About one frame at 60 Hz: smooth enough to look attached to the cursor
const MOVE_TICK_MS = 16

// A window this close to the video's ratio is left alone, so that a video a
// few pixels off 16:9 does not make the window twitch
const RATIO_TOLERANCE = 0.01

// A window within this many pixels of the size it was fitted to still counts
// as fitted; window managers round a size to their own liking
const SIZE_TOLERANCE_PX = 2

// How long a resize by hand has to be still before it counts as finished.
// Linux reports no end of a drag, only each size on the way.
const SNAP_SETTLE_MS = 250

/**
 * @typedef {object} WindowGeometryDependencies
 * @property {Pick<Electron.Screen, 'getCursorScreenPoint' | 'getDisplayMatching'>} [screen]
 * @property {typeof setInterval} [setInterval]
 * @property {typeof clearInterval} [clearInterval]
 * @property {typeof setTimeout} [setTimeout]
 * @property {typeof clearTimeout} [clearTimeout]
 */

/**
 * The size with the given area and ratio (width over height), scaled up to
 * the minimum and then down to the maximum, keeping the ratio throughout.
 * The maximum wins, since a window larger than its screen is worse than one
 * below its minimum.
 * @param {{ area: number, ratio: number, minWidth: number, minHeight: number, maxWidth: number, maxHeight: number }} constraints
 * @returns {{ width: number, height: number }}
 */
export function fitSize({ area, ratio, minWidth, minHeight, maxWidth, maxHeight }) {
  let width = Math.sqrt(area * ratio)
  let height = width / ratio

  const up = Math.max(1, minWidth / width, minHeight / height)
  width *= up
  height *= up

  const down = Math.min(1, maxWidth / width, maxHeight / height)
  width *= down

  width = Math.round(width)
  return { width, height: Math.round(width / ratio) }
}

/**
 * @param {WindowGeometryDependencies} [dependencies]
 */
export function createWindowGeometry(dependencies = {}) {
  // Read lazily, since Electron's screen module is only usable once the app is ready
  const getScreen = () => dependencies.screen ?? electronScreen
  const startInterval = dependencies.setInterval ?? setInterval
  const stopInterval = dependencies.clearInterval ?? clearInterval
  const startTimeout = dependencies.setTimeout ?? setTimeout
  const stopTimeout = dependencies.clearTimeout ?? clearTimeout

  /** @type {Map<Electron.BrowserWindow, { interval: ReturnType<typeof setInterval>, follow: () => void, dispose: () => void }>} */
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

    function follow() {
      const point = getScreen().getCursorScreenPoint()
      const x = Math.round(point.x - offset.x)
      const y = Math.round(point.y - offset.y)

      if (x !== lastX || y !== lastY) {
        lastX = x
        lastY = y
        win.setBounds({ x, y, width, height })
      }
    }

    const interval = startInterval(() => {
      if (win.isDestroyed()) {
        endMove(win)
        return
      }

      follow()
    }, MOVE_TICK_MS)

    // A pointerup the renderer never sends, because focus went elsewhere, the
    // window changed state under the move, or the renderer itself went away,
    // must not leave the window following the cursor
    const stop = () => endMove(win)
    const windowEvents = ['blur', 'closed', 'maximize', 'enter-full-screen', 'minimize', 'hide']
    windowEvents.forEach(event => win.once(event, stop))

    const webContents = win.webContents
    /** @param {{ isMainFrame?: boolean, isSameDocument?: boolean }} details */
    const stopOnReload = (details) => {
      if (details?.isMainFrame && !details.isSameDocument) {
        stop()
      }
    }
    webContents?.once('render-process-gone', stop)
    webContents?.on('did-start-navigation', stopOnReload)

    moves.set(win, {
      interval,
      follow,
      dispose: () => {
        if (!win.isDestroyed()) {
          windowEvents.forEach(event => win.removeListener(event, stop))
        }
        if (webContents && !webContents.isDestroyed()) {
          webContents.removeListener('render-process-gone', stop)
          webContents.removeListener('did-start-navigation', stopOnReload)
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

    // Land where the cursor was let go, not up to a tick short of it; but
    // never on a window that has just been maximised or made fullscreen,
    // which setting its bounds would undo
    if (!win.isDestroyed() && !win.isMaximized() && !win.isFullScreen() && !win.isMinimized()) {
      move.follow()
    }
  }

  /**
   * @param {Electron.BrowserWindow} win
   */
  function isMoving(win) {
    return moves.has(win)
  }

  /**
   * @typedef {{ width: number, height: number }} Size
   * @typedef {object} Fit
   * @property {number} ratio the video's, width over height
   * @property {Size} restore the content size from before the first fit
   * @property {Size} fitted the content size the last fit asked for
   * @property {Size} settled the content size when the window was last still at the ratio
   * @property {Size | null} snappedFrom the size the last snap started from, until the window reaches the ratio
   * @property {() => void} dispose
   */

  /** @type {Map<Electron.BrowserWindow, Fit>} */
  const fits = new Map()

  /**
   * @param {Electron.BrowserWindow} win
   */
  function isResizable(win) {
    return !win.isDestroyed() && !win.isMaximized() && !win.isFullScreen() && !win.isMinimized()
  }

  /**
   * What the frame adds around the content, zero for a frameless window.
   * @param {Electron.BrowserWindow} win
   */
  function frameOf(win) {
    const outer = win.getBounds()
    const content = win.getContentBounds()
    return {
      left: content.x - outer.x,
      top: content.y - outer.y,
      width: outer.width - content.width,
      height: outer.height - content.height,
    }
  }

  /**
   * Gives the window's content the size, centred on where the content's centre
   * is now or keeping its top left corner, and moved as little as needed to
   * keep the whole window, frame and all, inside the work area of its display.
   * @param {Electron.BrowserWindow} win
   * @param {Size} size
   * @param {'centre' | 'topLeft'} [anchor]
   */
  function placeContent(win, { width, height }, anchor = 'centre') {
    const content = win.getContentBounds()
    const frame = frameOf(win)
    const { workArea } = getScreen().getDisplayMatching(win.getBounds())

    const wantedX = anchor === 'centre' ? Math.round(content.x + (content.width - width) / 2) : content.x
    const wantedY = anchor === 'centre' ? Math.round(content.y + (content.height - height) / 2) : content.y

    const clamp = (value, min, max) => Math.max(min, Math.min(value, max))
    const x = clamp(wantedX, workArea.x + frame.left, workArea.x + workArea.width - (frame.width - frame.left) - width)
    const y = clamp(wantedY, workArea.y + frame.top, workArea.y + workArea.height - (frame.height - frame.top) - height)

    win.setContentBounds({ x, y, width, height })
  }

  /**
   * The smallest and largest content the window can have: its minimum size,
   * and the work area of its display, both less the frame.
   * @param {Electron.BrowserWindow} win
   */
  function contentLimits(win) {
    const frame = frameOf(win)
    const [minWidth, minHeight] = win.getMinimumSize()
    const { workArea } = getScreen().getDisplayMatching(win.getBounds())

    return {
      minWidth: minWidth - frame.width,
      minHeight: minHeight - frame.height,
      maxWidth: workArea.width - frame.width,
      maxHeight: workArea.height - frame.height,
    }
  }

  /**
   * @param {Size} a
   * @param {Size} b
   */
  function sameSize(a, b) {
    return Math.abs(a.width - b.width) <= SIZE_TOLERANCE_PX && Math.abs(a.height - b.height) <= SIZE_TOLERANCE_PX
  }

  /**
   * @param {Size} size
   * @param {number} ratio
   */
  function hasRatio({ width, height }, ratio) {
    return Math.abs(width / height - ratio) / ratio <= RATIO_TOLERANCE
  }

  /**
   * @param {Electron.BrowserWindow} win
   * @returns {Size}
   */
  function contentSize(win) {
    const { width, height } = win.getContentBounds()
    return { width, height }
  }

  /**
   * Reshapes the window's content to the video's ratio, keeping its area and
   * its centre, and locks the ratio so resizing by hand keeps it (or, where
   * the window manager ignores the lock, snaps to it; see snapToRatio). The first
   * fit remembers the size to return to; later fits, for the next video or
   * for a video that changes shape, do not replace it. Does nothing for a
   * window that is gone, maximised, fullscreen or minimised, or without a
   * usable video size.
   * @param {Electron.BrowserWindow} win
   * @param {number} videoWidth
   * @param {number} videoHeight
   */
  function fitToVideo(win, videoWidth, videoHeight) {
    const ratio = videoWidth / videoHeight

    if (!win || !isResizable(win) || !Number.isFinite(ratio) || ratio <= 0) {
      return
    }

    const current = contentSize(win)

    let fit = fits.get(win)
    if (!fit) {
      fit = { ratio, restore: current, fitted: current, settled: current, snappedFrom: null, dispose: () => {} }
      fits.set(win, fit)
      fit.dispose = watchFittedWindow(win)
    }

    fit.ratio = ratio
    fit.snappedFrom = null

    if (hasRatio(current, ratio)) {
      fit.settled = current
    } else {
      const size = fitSize({ area: current.width * current.height, ratio, ...contentLimits(win) })

      placeContent(win, size)
      fit.fitted = size
      fit.settled = size
    }

    win.setAspectRatio(ratio)
  }

  /**
   * Does by hand what the ratio lock should have done during a resize, for
   * window managers that ignore it, as WSLg's and every Wayland compositor do
   * (Electron can only ask, through X11's size hints). Runs once a resize has
   * been still for a moment. Keeps the side that was dragged, the one that
   * changed the most since the window was last at the ratio, and the top
   * left corner, as a lock would. A window manager that refuses the corrected
   * size is not asked again for the same size, so a tiling one is not fought.
   * Where the lock worked the window already has the ratio and this does
   * nothing.
   * @param {Electron.BrowserWindow} win
   */
  function snapToRatio(win) {
    const fit = fits.get(win)

    if (!fit || !isResizable(win)) {
      return
    }

    const current = contentSize(win)

    if (hasRatio(current, fit.ratio)) {
      fit.settled = current
      fit.snappedFrom = null
      return
    }

    if (fit.snappedFrom && sameSize(current, fit.snappedFrom)) {
      return
    }

    const widthChange = Math.abs(current.width - fit.settled.width) / fit.settled.width
    const heightChange = Math.abs(current.height - fit.settled.height) / fit.settled.height
    const kept = widthChange >= heightChange
      ? { width: current.width, height: current.width / fit.ratio }
      : { width: current.height * fit.ratio, height: current.height }

    const size = fitSize({ area: kept.width * kept.height, ratio: fit.ratio, ...contentLimits(win) })

    fit.snappedFrom = current
    fit.settled = size
    placeContent(win, size, 'topLeft')
  }

  /**
   * Unlocks the ratio and, unless the window was resized by hand while fitted,
   * returns it to the size it had before the first fit, centred where it is
   * now. A maximised or fullscreen window is only unlocked, since setting its
   * bounds would undo that state. Does nothing if the window is not fitted.
   * @param {Electron.BrowserWindow} win
   */
  function releaseFit(win) {
    const fit = fits.get(win)

    if (!fit) {
      return
    }

    fits.delete(win)
    fit.dispose()

    if (win.isDestroyed()) {
      return
    }

    win.setAspectRatio(0)

    if (!isResizable(win)) {
      return
    }

    const content = win.getContentBounds()
    if (sameSize(content, fit.fitted) && !sameSize(content, fit.restore)) {
      placeContent(win, fit.restore)
    }
  }

  /**
   * Snaps a resize to the ratio once it has settled, and releases on its own
   * what the renderer can no longer release: a renderer that crashed or
   * reloaded, and a window that closed.
   * @param {Electron.BrowserWindow} win
   * @returns {() => void} removes the listeners and drops a snap still waiting
   */
  function watchFittedWindow(win) {
    /** @type {ReturnType<typeof setTimeout> | null} */
    let snapTimeout = null
    const scheduleSnap = () => {
      if (snapTimeout !== null) {
        stopTimeout(snapTimeout)
      }
      snapTimeout = startTimeout(() => {
        snapTimeout = null
        snapToRatio(win)
      }, SNAP_SETTLE_MS)
    }
    win.on('resize', scheduleSnap)

    const release = () => releaseFit(win)
    win.once('closed', release)

    const webContents = win.webContents
    /** @param {{ isMainFrame?: boolean, isSameDocument?: boolean }} details */
    const releaseOnReload = (details) => {
      if (details?.isMainFrame && !details.isSameDocument) {
        release()
      }
    }
    webContents?.once('render-process-gone', release)
    webContents?.on('did-start-navigation', releaseOnReload)

    return () => {
      if (snapTimeout !== null) {
        stopTimeout(snapTimeout)
        snapTimeout = null
      }
      if (!win.isDestroyed()) {
        win.removeListener('resize', scheduleSnap)
        win.removeListener('closed', release)
      }
      if (webContents && !webContents.isDestroyed()) {
        webContents.removeListener('render-process-gone', release)
        webContents.removeListener('did-start-navigation', releaseOnReload)
      }
    }
  }

  /**
   * The bounds to save for the next start: the window's own, unless it is
   * still at the size a fit gave it, in which case the size it had before the
   * fit, centred on the same point.
   * @param {Electron.BrowserWindow} win
   * @param {Electron.Rectangle} bounds the window's outer bounds, as they would be saved
   * @returns {Electron.Rectangle}
   */
  function persistableBounds(win, bounds) {
    const fit = fits.get(win)

    if (!fit || win.isDestroyed()) {
      return bounds
    }

    const content = win.getContentBounds()
    if (!sameSize(content, fit.fitted)) {
      return bounds
    }

    const frame = frameOf(win)
    const width = fit.restore.width + frame.width
    const height = fit.restore.height + frame.height

    return {
      x: Math.round(bounds.x + (bounds.width - width) / 2),
      y: Math.round(bounds.y + (bounds.height - height) / 2),
      width,
      height,
    }
  }

  /**
   * @param {Electron.BrowserWindow} win
   */
  function isFitted(win) {
    return fits.has(win)
  }

  return { startMove, endMove, isMoving, fitToVideo, releaseFit, persistableBounds, isFitted }
}

const windowGeometry = createWindowGeometry()

export const startMove = windowGeometry.startMove
export const endMove = windowGeometry.endMove
export const fitToVideo = windowGeometry.fitToVideo
export const releaseFit = windowGeometry.releaseFit
export const persistableBounds = windowGeometry.persistableBounds
