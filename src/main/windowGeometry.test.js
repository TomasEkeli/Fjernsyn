import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { createWindowGeometry } from './windowGeometry'

vi.mock('electron', () => ({ screen: undefined }))

function createStubWindow({ x = 100, y = 50, width = 800, height = 600, maximized = false, fullScreen = false } = {}) {
  const win = new EventEmitter()
  const state = { x, y, width, height, maximized, fullScreen, destroyed: false }

  Object.assign(win, {
    state,
    isDestroyed: () => state.destroyed,
    isMaximized: () => state.maximized,
    isFullScreen: () => state.fullScreen,
    getPosition: () => [state.x, state.y],
    getSize: () => [state.width, state.height],
    setBounds: vi.fn((bounds) => Object.assign(state, bounds)),
  })

  return win
}

function createHarness() {
  const cursor = { x: 0, y: 0 }
  /** @type {Map<number, () => void>} */
  const intervals = new Map()
  let nextId = 1

  const geometry = createWindowGeometry({
    screen: { getCursorScreenPoint: () => ({ ...cursor }) },
    setInterval: (callback) => {
      const id = nextId++
      intervals.set(id, callback)
      return id
    },
    clearInterval: (id) => intervals.delete(id),
  })

  return {
    geometry,
    cursor,
    intervals,
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
    for (const event of ['blur', 'closed', 'maximize', 'enter-full-screen']) {
      expect(win.listenerCount(event)).toBe(0)
    }
  })

  it.each(['blur', 'closed', 'maximize', 'enter-full-screen'])('stops when the window emits %s', (event) => {
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
