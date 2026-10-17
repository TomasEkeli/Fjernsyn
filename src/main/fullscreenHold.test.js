import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { createFullscreenHold } from './fullscreenHold'

/**
 * A window whose full screen arrives when the test says so, as a real one's
 * arrives after the window manager's transition
 */
function createStubWindow({ fullScreen = false } = {}) {
  const win = new EventEmitter()
  const state = { fullScreen, destroyed: false }
  const webContents = Object.assign(new EventEmitter(), { isDestroyed: () => state.destroyed })

  Object.assign(win, {
    state,
    webContents,
    isDestroyed: () => state.destroyed,
    isFullScreen: () => state.fullScreen,
    setFullScreen: vi.fn(),
    arrive() {
      state.fullScreen = true
      win.emit('enter-full-screen')
    },
    leave() {
      state.fullScreen = false
      win.emit('leave-full-screen')
    },
  })

  return win
}

function createHarness() {
  /** @type {Map<number, () => void>} */
  const timeouts = new Map()
  let nextId = 1

  const fullscreenHold = createFullscreenHold({
    setTimeout: (callback) => {
      const id = nextId++
      timeouts.set(id, callback)
      return id
    },
    clearTimeout: (id) => timeouts.delete(id),
  })

  return {
    ...fullscreenHold,
    timeouts,
    runTimeouts: () => [...timeouts.values()].forEach(callback => callback()),
  }
}

describe('fullscreenHold', () => {
  it('makes the window full screen and resolves once it is', async () => {
    const { hold, isHeld } = createHarness()
    const win = createStubWindow()

    let resolved = false
    const holding = hold(win).then((value) => {
      resolved = true
      return value
    })

    expect(win.setFullScreen).toHaveBeenCalledWith(true)
    await Promise.resolve()
    expect(resolved).toBe(false)

    win.arrive()

    await expect(holding).resolves.toBe(true)
    expect(isHeld(win)).toBe(true)
  })

  it('resolves after the wait when the window never reports full screen', async () => {
    const { hold, runTimeouts } = createHarness()
    const win = createStubWindow()

    const holding = hold(win)
    runTimeouts()

    await expect(holding).resolves.toBe(true)
  })

  it('leaves a window the user made full screen alone, and does not take it out', async () => {
    const { hold, release, isHeld } = createHarness()
    const win = createStubWindow({ fullScreen: true })

    await expect(hold(win)).resolves.toBe(false)
    expect(win.setFullScreen).not.toHaveBeenCalled()
    expect(isHeld(win)).toBe(false)

    release(win)
    expect(win.setFullScreen).not.toHaveBeenCalled()
  })

  it('holds once: a second hold resolves at once without asking again', async () => {
    const { hold } = createHarness()
    const win = createStubWindow()

    const first = hold(win)
    win.arrive()
    await first

    await expect(hold(win)).resolves.toBe(true)
    expect(win.setFullScreen).toHaveBeenCalledTimes(1)
  })

  it('takes a held window out of full screen on release, and only once', async () => {
    const { hold, release, isHeld } = createHarness()
    const win = createStubWindow()

    const holding = hold(win)
    win.arrive()
    await holding

    release(win)
    expect(win.setFullScreen).toHaveBeenLastCalledWith(false)
    expect(isHeld(win)).toBe(false)

    release(win)
    expect(win.setFullScreen).toHaveBeenCalledTimes(2)
  })

  it('forgets the hold when the window leaves full screen some other way, as by F11', async () => {
    const { hold, release, isHeld } = createHarness()
    const win = createStubWindow()

    const holding = hold(win)
    win.arrive()
    await holding

    win.leave()
    expect(isHeld(win)).toBe(false)

    // Full screen again by the user's hand: a release later is not for this
    win.arrive()
    release(win)
    expect(win.setFullScreen).toHaveBeenCalledTimes(1)
  })

  it('lets go when the renderer goes away or reloads', async () => {
    const { hold, isHeld } = createHarness()

    const crashed = createStubWindow()
    const crashing = hold(crashed)
    crashed.arrive()
    await crashing
    crashed.webContents.emit('render-process-gone')
    expect(isHeld(crashed)).toBe(false)
    expect(crashed.setFullScreen).toHaveBeenLastCalledWith(false)

    const reloaded = createStubWindow()
    const reloading = hold(reloaded)
    reloaded.arrive()
    await reloading
    reloaded.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(isHeld(reloaded)).toBe(true)
    reloaded.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(isHeld(reloaded)).toBe(false)
  })

  it('stops watching a window it no longer holds', async () => {
    const { hold, release } = createHarness()
    const win = createStubWindow()

    const holding = hold(win)
    win.arrive()
    await holding
    release(win)

    expect(win.listenerCount('leave-full-screen')).toBe(0)
    expect(win.listenerCount('closed')).toBe(0)
    expect(win.webContents.listenerCount('render-process-gone')).toBe(0)
    expect(win.webContents.listenerCount('did-start-navigation')).toBe(0)
  })

  it('does nothing for a window that is gone', async () => {
    const { hold } = createHarness()
    const win = createStubWindow()
    win.state.destroyed = true

    await expect(hold(win)).resolves.toBe(false)
    expect(win.setFullScreen).not.toHaveBeenCalled()
  })
})
