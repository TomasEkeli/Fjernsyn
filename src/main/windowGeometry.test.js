import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { createWindowGeometry, fitSize } from './windowGeometry'

vi.mock('electron', () => ({ screen: undefined }))

/**
 * The state holds the window's outer bounds; the content bounds are those
 * less the frame, which is zero for a frameless window.
 */
function createStubWindow({
  x = 100,
  y = 50,
  width = 800,
  height = 600,
  maximized = false,
  fullScreen = false,
  frame = { left: 0, top: 0, right: 0, bottom: 0 },
  minimumSize = [340, 380],
} = {}) {
  const win = new EventEmitter()
  const state = { x, y, width, height, maximized, fullScreen, minimized: false, destroyed: false, aspectRatio: 0 }
  const webContents = Object.assign(new EventEmitter(), { isDestroyed: () => state.destroyed })

  Object.assign(win, {
    state,
    webContents,
    isDestroyed: () => state.destroyed,
    isMaximized: () => state.maximized,
    isFullScreen: () => state.fullScreen,
    isMinimized: () => state.minimized,
    getPosition: () => [state.x, state.y],
    getSize: () => [state.width, state.height],
    getBounds: () => ({ x: state.x, y: state.y, width: state.width, height: state.height }),
    getMinimumSize: () => [...minimumSize],
    setBounds: vi.fn((bounds) => Object.assign(state, bounds)),
    getContentBounds: () => ({
      x: state.x + frame.left,
      y: state.y + frame.top,
      width: state.width - frame.left - frame.right,
      height: state.height - frame.top - frame.bottom,
    }),
    setContentBounds: vi.fn((bounds) => Object.assign(state, {
      x: bounds.x - frame.left,
      y: bounds.y - frame.top,
      width: bounds.width + frame.left + frame.right,
      height: bounds.height + frame.top + frame.bottom,
    })),
    setAspectRatio: vi.fn((ratio) => { state.aspectRatio = ratio }),
  })

  return win
}

/** Sets the content size as a user dragging an edge would */
function resizeByHand(win, width, height) {
  const content = win.getContentBounds()
  win.state.width += width - content.width
  win.state.height += height - content.height
}

function createHarness({ workArea = { x: 0, y: 0, width: 1920, height: 1040 } } = {}) {
  const cursor = { x: 0, y: 0 }
  /** @type {Map<number, () => void>} */
  const intervals = new Map()
  /** @type {Map<number, () => void>} */
  const timeouts = new Map()
  let nextId = 1

  const geometry = createWindowGeometry({
    screen: {
      getCursorScreenPoint: () => ({ ...cursor }),
      getDisplayMatching: () => ({ workArea: { ...workArea } }),
    },
    setInterval: (callback) => {
      const id = nextId++
      intervals.set(id, callback)
      return id
    },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (callback) => {
      const id = nextId++
      timeouts.set(id, callback)
      return id
    },
    clearTimeout: (id) => timeouts.delete(id),
  })

  return {
    geometry,
    cursor,
    intervals,
    timeouts,
    // Runs the timeouts pending now, as time passing would
    settle: () => {
      const pending = [...timeouts.entries()]
      timeouts.clear()
      pending.forEach(([, callback]) => callback())
    },
    tick: () => [...intervals.values()].forEach(callback => callback()),
    moveCursor: (x, y) => Object.assign(cursor, { x, y }),
  }
}

describe('windowGeometry', () => {
  it('follows the cursor, keeping the offset it had on the window when the move started', () => {
    const { geometry, tick, moveCursor } = createHarness()
    const win = createStubWindow({ x: 100, y: 50 })

    moveCursor(130, 60)
    geometry.startMove(win)

    moveCursor(150, 90)
    tick()
    expect(win.state).toMatchObject({ x: 120, y: 80, width: 800, height: 600 })

    moveCursor(400, 300)
    tick()
    expect(win.state).toMatchObject({ x: 370, y: 290 })

    moveCursor(10, 5)
    tick()
    expect(win.state).toMatchObject({ x: -20, y: -5 })
  })

  it('keeps the size it started with, whatever the window reports during the move', () => {
    const { geometry, tick, moveCursor } = createHarness()
    const win = createStubWindow({ width: 800, height: 600 })

    geometry.startMove(win)
    win.state.width = 1000
    moveCursor(20, 20)
    tick()

    expect(win.setBounds).toHaveBeenLastCalledWith({ x: 120, y: 70, width: 800, height: 600 })
  })

  it('does not set the bounds when the cursor has not moved', () => {
    const { geometry, tick } = createHarness()
    const win = createStubWindow()

    geometry.startMove(win)
    tick()
    tick()

    expect(win.setBounds).not.toHaveBeenCalled()
  })

  it('refuses to move a maximised window', () => {
    const { geometry, intervals } = createHarness()
    const win = createStubWindow({ maximized: true })

    geometry.startMove(win)

    expect(intervals.size).toBe(0)
    expect(geometry.isMoving(win)).toBe(false)
  })

  it('refuses to move a fullscreen window', () => {
    const { geometry, intervals } = createHarness()
    const win = createStubWindow({ fullScreen: true })

    geometry.startMove(win)

    expect(intervals.size).toBe(0)
  })

  it('refuses a destroyed or missing window', () => {
    const { geometry, intervals } = createHarness()
    const win = createStubWindow()
    win.state.destroyed = true

    geometry.startMove(win)
    geometry.startMove(null)

    expect(intervals.size).toBe(0)
  })

  it('ignores a second start while a move is running, keeping the first offset', () => {
    const { geometry, intervals, tick, moveCursor } = createHarness()
    const win = createStubWindow({ x: 100, y: 50 })

    moveCursor(110, 60)
    geometry.startMove(win)
    moveCursor(300, 300)
    geometry.startMove(win)

    expect(intervals.size).toBe(1)

    tick()
    expect(win.state).toMatchObject({ x: 290, y: 290 })
  })

  it('moves two windows independently', () => {
    const { geometry, intervals, tick, moveCursor } = createHarness()
    const first = createStubWindow({ x: 0, y: 0 })
    const second = createStubWindow({ x: 500, y: 500 })

    geometry.startMove(first)
    geometry.startMove(second)
    expect(intervals.size).toBe(2)

    geometry.endMove(first)
    moveCursor(10, 10)
    tick()

    expect(first.setBounds).not.toHaveBeenCalled()
    expect(second.state).toMatchObject({ x: 510, y: 510 })
  })

  it('stops on endMove, and removes its listeners', () => {
    const { geometry, intervals } = createHarness()
    const win = createStubWindow()

    geometry.startMove(win)
    geometry.endMove(win)

    expect(intervals.size).toBe(0)
    expect(geometry.isMoving(win)).toBe(false)
    for (const event of ['blur', 'closed', 'maximize', 'enter-full-screen', 'minimize', 'hide']) {
      expect(win.listenerCount(event)).toBe(0)
    }
    expect(win.webContents.listenerCount('render-process-gone')).toBe(0)
    expect(win.webContents.listenerCount('did-start-navigation')).toBe(0)
  })

  it.each(['blur', 'closed', 'maximize', 'enter-full-screen', 'minimize', 'hide'])('stops when the window emits %s', (event) => {
    const { geometry, intervals } = createHarness()
    const win = createStubWindow()

    geometry.startMove(win)
    if (event === 'closed') {
      win.state.destroyed = true
    }
    win.emit(event)

    expect(intervals.size).toBe(0)
    expect(geometry.isMoving(win)).toBe(false)
  })

  it('stops when the renderer goes away, as it cannot send the end', () => {
    const { geometry, intervals } = createHarness()
    const win = createStubWindow()

    geometry.startMove(win)
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed' })

    expect(intervals.size).toBe(0)
  })

  it('stops when the page reloads, but not on a navigation within it', () => {
    const { geometry, intervals } = createHarness()
    const win = createStubWindow()

    geometry.startMove(win)
    win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    win.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(intervals.size).toBe(1)

    win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(intervals.size).toBe(0)
  })

  it('lands where the cursor was let go, however recently it moved', () => {
    const { geometry, moveCursor } = createHarness()
    const win = createStubWindow({ x: 100, y: 50 })

    geometry.startMove(win)
    moveCursor(40, 30)
    geometry.endMove(win)

    expect(win.state).toMatchObject({ x: 140, y: 80 })
  })

  it('does not set the bounds of a window that was maximised under the move', () => {
    const { geometry, moveCursor } = createHarness()
    const win = createStubWindow()

    geometry.startMove(win)
    moveCursor(40, 30)
    win.state.maximized = true
    win.emit('maximize')

    expect(win.setBounds).not.toHaveBeenCalled()
  })

  it('stops by itself when the window is destroyed under it', () => {
    const { geometry, intervals, tick, moveCursor } = createHarness()
    const win = createStubWindow()

    geometry.startMove(win)
    win.state.destroyed = true
    moveCursor(50, 50)
    tick()

    expect(intervals.size).toBe(0)
    expect(win.setBounds).not.toHaveBeenCalled()
  })

  it('can move again after a move has ended', () => {
    const { geometry, intervals } = createHarness()
    const win = createStubWindow()

    geometry.startMove(win)
    geometry.endMove(win)
    geometry.startMove(win)

    expect(intervals.size).toBe(1)
  })

  it('treats endMove with no move running as a no-op', () => {
    const { geometry } = createHarness()
    const win = createStubWindow()

    expect(() => geometry.endMove(win)).not.toThrow()
    expect(() => geometry.endMove(null)).not.toThrow()
  })
})

describe('fitSize', () => {
  const unbounded = { minWidth: 0, minHeight: 0, maxWidth: Infinity, maxHeight: Infinity }

  it('keeps the area and takes the ratio', () => {
    const { width, height } = fitSize({ ...unbounded, area: 1200 * 900, ratio: 16 / 9 })

    expect({ width, height }).toEqual({ width: 1386, height: 780 })
  })

  it('scales up to the minimum size, keeping the ratio', () => {
    const { width, height } = fitSize({ ...unbounded, minWidth: 340, minHeight: 380, area: 400 * 400, ratio: 16 / 9 })

    expect(height).toBe(380)
    expect(width / height).toBeCloseTo(16 / 9, 2)
  })

  it('scales down to the maximum size, keeping the ratio, even below the minimum', () => {
    const { width, height } = fitSize({ minWidth: 340, minHeight: 1200, maxWidth: 1920, maxHeight: 1040, area: 1200 * 900, ratio: 9 / 16 })

    expect({ width, height }).toEqual({ width: 585, height: 1040 })
  })
})

describe('fitting the window to a video', () => {
  it('reshapes the window to the video, keeping its area and its centre, and locks the ratio', () => {
    const { geometry } = createHarness()
    const win = createStubWindow({ x: 360, y: 70, width: 1200, height: 900 })

    geometry.fitToVideo(win, 1920, 1080)

    expect(win.getContentBounds()).toEqual({ x: 267, y: 130, width: 1386, height: 780 })
    expect(win.state.aspectRatio).toBeCloseTo(16 / 9, 6)
    expect(geometry.isFitted(win)).toBe(true)
  })

  it('fits the content, not the frame, when the window has one', () => {
    const { geometry } = createHarness()
    const win = createStubWindow({ x: 360, y: 40, width: 1200, height: 930, frame: { left: 0, top: 30, right: 0, bottom: 0 } })

    geometry.fitToVideo(win, 1920, 1080)

    expect(win.getContentBounds()).toMatchObject({ width: 1386, height: 780 })
    expect(win.state).toMatchObject({ width: 1386, height: 810 })
  })

  it('stays inside the work area', () => {
    const { geometry } = createHarness()
    const win = createStubWindow({ x: 700, y: 70, width: 1200, height: 900 })

    geometry.fitToVideo(win, 1920, 1080)

    expect(win.getContentBounds()).toEqual({ x: 534, y: 130, width: 1386, height: 780 })
  })

  it('shrinks a tall video to the height of the work area', () => {
    const { geometry } = createHarness()
    const win = createStubWindow({ x: 360, y: 70, width: 1200, height: 900 })

    geometry.fitToVideo(win, 1080, 1920)

    expect(win.getContentBounds()).toMatchObject({ y: 0, width: 585, height: 1040 })
  })

  it('leaves a window alone that already has the ratio, give or take a percent, but still locks it', () => {
    const { geometry } = createHarness()
    const win = createStubWindow({ width: 1280, height: 720 })

    geometry.fitToVideo(win, 1920, 1088)

    expect(win.setContentBounds).not.toHaveBeenCalled()
    expect(win.state.aspectRatio).toBeCloseTo(1920 / 1088, 6)
  })

  it.each([
    ['maximised', { maximized: true }],
    ['fullscreen', { fullScreen: true }],
    ['minimised', { minimized: true }],
    ['destroyed', { destroyed: true }],
  ])('does nothing to a %s window', (_, flags) => {
    const { geometry } = createHarness()
    const win = createStubWindow()
    Object.assign(win.state, flags)

    geometry.fitToVideo(win, 1920, 1080)

    expect(win.setContentBounds).not.toHaveBeenCalled()
    expect(win.setAspectRatio).not.toHaveBeenCalled()
    expect(geometry.isFitted(win)).toBe(false)
  })

  it('does nothing without a window or without a video size', () => {
    const { geometry } = createHarness()
    const win = createStubWindow()

    expect(() => geometry.fitToVideo(null, 1920, 1080)).not.toThrow()
    geometry.fitToVideo(win, 0, 0)
    geometry.fitToVideo(win, 1920, Number.NaN)

    expect(win.setContentBounds).not.toHaveBeenCalled()
    expect(geometry.isFitted(win)).toBe(false)
  })

  it('restores the size the window had before, centred where it is now, and unlocks the ratio', () => {
    const { geometry } = createHarness()
    const win = createStubWindow({ x: 360, y: 70, width: 1200, height: 900 })

    geometry.fitToVideo(win, 1920, 1080)
    geometry.releaseFit(win)

    expect(win.getContentBounds()).toEqual({ x: 360, y: 70, width: 1200, height: 900 })
    expect(win.setAspectRatio).toHaveBeenLastCalledWith(0)
    expect(geometry.isFitted(win)).toBe(false)
  })

  it('keeps the size from before the first fit across fits to videos of another shape', () => {
    const { geometry } = createHarness()
    const win = createStubWindow({ x: 360, y: 70, width: 1200, height: 900 })

    geometry.fitToVideo(win, 1920, 1080)
    geometry.fitToVideo(win, 1080, 1920)
    geometry.fitToVideo(win, 2560, 1080)
    geometry.releaseFit(win)

    expect(win.getContentBounds()).toMatchObject({ width: 1200, height: 900 })
    expect(win.state.aspectRatio).toBe(0)
  })

  it('keeps a size set by hand while fitted', () => {
    const { geometry } = createHarness()
    const win = createStubWindow({ x: 360, y: 70, width: 1200, height: 900 })

    geometry.fitToVideo(win, 1920, 1080)
    resizeByHand(win, 1600, 900)
    win.setContentBounds.mockClear()
    geometry.releaseFit(win)

    expect(win.setContentBounds).not.toHaveBeenCalled()
    expect(win.state.aspectRatio).toBe(0)
  })

  it('does not forget a size set by hand when the same video fits again', () => {
    const { geometry } = createHarness()
    const win = createStubWindow({ x: 360, y: 70, width: 1200, height: 900 })

    geometry.fitToVideo(win, 1920, 1080)
    resizeByHand(win, 1600, 900)
    geometry.fitToVideo(win, 1920, 1080)
    win.setContentBounds.mockClear()
    geometry.releaseFit(win)

    expect(win.setContentBounds).not.toHaveBeenCalled()
  })

  it('unlocks the ratio of a maximised window without setting its bounds', () => {
    const { geometry } = createHarness()
    const win = createStubWindow()

    geometry.fitToVideo(win, 1920, 1080)
    win.state.maximized = true
    win.setContentBounds.mockClear()
    geometry.releaseFit(win)

    expect(win.setContentBounds).not.toHaveBeenCalled()
    expect(win.state.aspectRatio).toBe(0)
  })

  it('treats releaseFit with nothing fitted as a no-op', () => {
    const { geometry } = createHarness()
    const win = createStubWindow()

    geometry.releaseFit(win)
    expect(() => geometry.releaseFit(null)).not.toThrow()

    expect(win.setAspectRatio).not.toHaveBeenCalled()
    expect(win.setContentBounds).not.toHaveBeenCalled()
  })

  it('releases by itself when the renderer goes away, as it cannot send the release', () => {
    const { geometry } = createHarness()
    const win = createStubWindow({ x: 360, y: 70, width: 1200, height: 900 })

    geometry.fitToVideo(win, 1920, 1080)
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed' })

    expect(geometry.isFitted(win)).toBe(false)
    expect(win.getContentBounds()).toMatchObject({ width: 1200, height: 900 })
    expect(win.state.aspectRatio).toBe(0)
  })

  it('releases by itself when the page reloads, but not on a navigation within it', () => {
    const { geometry } = createHarness()
    const win = createStubWindow()

    geometry.fitToVideo(win, 1920, 1080)
    win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(geometry.isFitted(win)).toBe(true)

    win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(geometry.isFitted(win)).toBe(false)
  })

  it('forgets a closed window without touching it', () => {
    const { geometry } = createHarness()
    const win = createStubWindow()

    geometry.fitToVideo(win, 1920, 1080)
    win.setAspectRatio.mockClear()
    win.setContentBounds.mockClear()
    win.state.destroyed = true
    win.emit('closed')

    expect(geometry.isFitted(win)).toBe(false)
    expect(win.setAspectRatio).not.toHaveBeenCalled()
    expect(win.setContentBounds).not.toHaveBeenCalled()
  })

  it('removes its listeners on release', () => {
    const { geometry } = createHarness()
    const win = createStubWindow()

    geometry.fitToVideo(win, 1920, 1080)
    geometry.releaseFit(win)

    expect(win.listenerCount('closed')).toBe(0)
    expect(win.webContents.listenerCount('render-process-gone')).toBe(0)
    expect(win.webContents.listenerCount('did-start-navigation')).toBe(0)
  })
})

describe('snapping a resize the window manager did not lock', () => {
  function fittedWindow() {
    const harness = createHarness()
    const win = createStubWindow({ x: 360, y: 70, width: 1200, height: 900 })
    harness.geometry.fitToVideo(win, 1920, 1080)
    // The fit's own resize settles to the ratio, which asks for nothing
    win.emit('resize')
    harness.settle()
    win.setContentBounds.mockClear()
    return { ...harness, win }
  }

  it('keeps the width that was dragged and the top left corner, once the drag has settled', () => {
    const { win, settle } = fittedWindow()

    resizeByHand(win, 1000, 780)
    win.emit('resize')
    expect(win.setContentBounds).not.toHaveBeenCalled()

    settle()
    expect(win.getContentBounds()).toEqual({ x: 267, y: 130, width: 1000, height: 563 })
  })

  it('keeps the height when the height was dragged', () => {
    const { win, settle } = fittedWindow()

    resizeByHand(win, 1386, 900)
    win.emit('resize')
    settle()

    expect(win.getContentBounds()).toEqual({ x: 267, y: 130, width: 1600, height: 900 })
  })

  it('waits for the drag to be still, whatever the number of resizes on the way', () => {
    const { win, timeouts } = fittedWindow()

    resizeByHand(win, 1300, 780)
    win.emit('resize')
    resizeByHand(win, 1100, 780)
    win.emit('resize')

    expect(timeouts.size).toBe(1)
  })

  it('does nothing where the window manager kept the ratio', () => {
    const { win, settle } = fittedWindow()

    resizeByHand(win, 1600, 900)
    win.emit('resize')
    settle()

    expect(win.setContentBounds).not.toHaveBeenCalled()
  })

  it('gives up on a size the window manager refused, rather than fight it', () => {
    const { win, settle } = fittedWindow()
    win.setContentBounds.mockImplementation(() => {})

    resizeByHand(win, 1000, 780)
    win.emit('resize')
    settle()
    win.emit('resize')
    settle()

    expect(win.setContentBounds).toHaveBeenCalledTimes(1)
  })

  it('counts a snapped size as set by hand, so leaving full window keeps it', () => {
    const { geometry, win, settle } = fittedWindow()

    resizeByHand(win, 1000, 780)
    win.emit('resize')
    settle()
    win.setContentBounds.mockClear()
    geometry.releaseFit(win)

    expect(win.setContentBounds).not.toHaveBeenCalled()
  })

  it('leaves a maximised window alone', () => {
    const { win, settle } = fittedWindow()

    win.state.maximized = true
    resizeByHand(win, 1920, 1040)
    win.emit('resize')
    settle()

    expect(win.setContentBounds).not.toHaveBeenCalled()
  })

  it('stops watching on release, dropping a snap still waiting', () => {
    const { geometry, win, timeouts } = fittedWindow()

    resizeByHand(win, 1000, 780)
    win.emit('resize')
    geometry.releaseFit(win)

    expect(timeouts.size).toBe(0)
    expect(win.listenerCount('resize')).toBe(0)
  })
})

describe('persistableBounds', () => {
  it('gives the size from before the fit, so a fitted size is never saved', () => {
    const { geometry } = createHarness()
    const win = createStubWindow({ x: 360, y: 40, width: 1200, height: 930, frame: { left: 0, top: 30, right: 0, bottom: 0 } })

    geometry.fitToVideo(win, 1920, 1080)

    expect(geometry.persistableBounds(win, win.getBounds())).toEqual({ x: 360, y: 40, width: 1200, height: 930 })
  })

  it('passes the bounds through when nothing is fitted', () => {
    const { geometry } = createHarness()
    const win = createStubWindow()
    const bounds = { x: 1, y: 2, width: 3, height: 4 }

    expect(geometry.persistableBounds(win, bounds)).toBe(bounds)
  })

  it('passes the bounds through when the size was set by hand while fitted', () => {
    const { geometry } = createHarness()
    const win = createStubWindow({ x: 360, y: 70, width: 1200, height: 900 })

    geometry.fitToVideo(win, 1920, 1080)
    resizeByHand(win, 1600, 900)
    const bounds = win.getBounds()

    expect(geometry.persistableBounds(win, bounds)).toBe(bounds)
  })
})
