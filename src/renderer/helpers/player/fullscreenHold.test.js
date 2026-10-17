import { describe, expect, it, vi } from 'vitest'

import { createFullscreenHold } from './fullscreenHold'

/**
 * A document whose full screen element the test sets, and an element whose
 * own `requestFullscreen` makes it that, as the browser's does
 */
function createHarness({ holdResult = true } = {}) {
  const doc = new EventTarget()
  doc.fullscreenElement = null

  const order = []

  const electron = {
    holdWindowFullscreen: vi.fn(async () => {
      order.push('hold')
      return holdResult
    }),
    releaseWindowFullscreen: vi.fn(() => order.push('release')),
  }

  /** @type {Map<number, () => void>} */
  const timeouts = new Map()
  let nextId = 1

  const fullscreenHold = createFullscreenHold({
    electron,
    document: doc,
    setTimeout: (callback) => {
      const id = nextId++
      timeouts.set(id, callback)
      return id
    },
    clearTimeout: (id) => timeouts.delete(id),
  })

  function enter(element) {
    doc.fullscreenElement = element
    doc.dispatchEvent(new Event('fullscreenchange'))
  }

  function exit() {
    doc.fullscreenElement = null
    doc.dispatchEvent(new Event('fullscreenchange'))
  }

  function createElement({ refuse = false } = {}) {
    const prototype = {
      requestFullscreen: vi.fn(async function () {
        order.push('element')
        if (refuse) {
          throw new TypeError('Permissions check failed')
        }
        enter(this)
      }),
    }
    return Object.create(prototype)
  }

  return {
    ...fullscreenHold,
    electron,
    doc,
    order,
    timeouts,
    runTimeouts: () => [...timeouts.values()].forEach(callback => callback()),
    enter,
    exit,
    createElement,
    pressKey: (key) => doc.dispatchEvent(Object.assign(new Event('keydown'), { key })),
  }
}

describe('fullscreenHold (renderer)', () => {
  it('holds the window before the element asks for full screen, with the options passed on', async () => {
    const { holdWindowUnder, createElement, order, doc } = createHarness()
    const element = createElement()
    holdWindowUnder(element)

    await element.requestFullscreen({ navigationUI: 'hide' })

    expect(order).toEqual(['hold', 'element'])
    expect(Object.getPrototypeOf(element).requestFullscreen).toHaveBeenCalledWith({ navigationUI: 'hide' })
    expect(doc.fullscreenElement).toBe(element)
  })

  it('says it is holding while the window goes full screen, and stops after', async () => {
    const { holdWindowUnder, createElement } = createHarness()
    const element = createElement()
    const onHolding = vi.fn()
    holdWindowUnder(element, onHolding)

    await element.requestFullscreen()

    expect(onHolding.mock.calls).toEqual([[true], [false]])
  })

  it('lets go of the window at once when full screen ends with no next player expected', async () => {
    const { holdWindowUnder, createElement, exit, electron } = createHarness()
    const element = createElement()
    holdWindowUnder(element)
    await element.requestFullscreen()

    exit()

    expect(electron.releaseWindowFullscreen).toHaveBeenCalledTimes(1)
  })

  it('keeps the window for the next player, which takes full screen up', async () => {
    const { holdWindowUnder, expectSuccessor, createElement, exit, electron, timeouts } = createHarness()
    const first = createElement()
    holdWindowUnder(first)
    await first.requestFullscreen()

    expectSuccessor()
    exit()
    expect(electron.releaseWindowFullscreen).not.toHaveBeenCalled()
    expect(timeouts.size).toBe(1)

    const next = createElement()
    holdWindowUnder(next)
    await next.requestFullscreen()

    expect(timeouts.size).toBe(0)
    expect(electron.releaseWindowFullscreen).not.toHaveBeenCalled()

    // And the next one, left by Esc, lets go
    exit()
    expect(electron.releaseWindowFullscreen).toHaveBeenCalledTimes(1)
  })

  it('lets go when the next player does not come in time', async () => {
    const { holdWindowUnder, expectSuccessor, createElement, exit, electron, runTimeouts } = createHarness()
    const element = createElement()
    holdWindowUnder(element)
    await element.requestFullscreen()

    expectSuccessor()
    exit()
    runTimeouts()

    expect(electron.releaseWindowFullscreen).toHaveBeenCalledTimes(1)
  })

  it('lets go on Esc while waiting for the next player, but not on other keys', async () => {
    const { holdWindowUnder, expectSuccessor, createElement, exit, electron, pressKey, timeouts } = createHarness()
    const element = createElement()
    holdWindowUnder(element)
    await element.requestFullscreen()

    expectSuccessor()
    exit()
    pressKey('ArrowDown')
    expect(electron.releaseWindowFullscreen).not.toHaveBeenCalled()

    pressKey('Escape')
    expect(electron.releaseWindowFullscreen).toHaveBeenCalledTimes(1)
    expect(timeouts.size).toBe(0)
  })

  it('does not let go on Esc when nothing waits', () => {
    const { holdWindowUnder, createElement, electron, pressKey } = createHarness()
    holdWindowUnder(createElement())

    pressKey('Escape')

    expect(electron.releaseWindowFullscreen).not.toHaveBeenCalled()
  })

  it('without a next player after all: lets go once the player\'s full screen has ended', async () => {
    const { holdWindowUnder, expectSuccessor, noSuccessor, createElement, exit, electron } = createHarness()
    const element = createElement()
    holdWindowUnder(element)
    await element.requestFullscreen()

    // Leaving the view: the player is destroyed before its element goes
    expectSuccessor()
    noSuccessor()
    expect(electron.releaseWindowFullscreen).not.toHaveBeenCalled()

    exit()
    expect(electron.releaseWindowFullscreen).toHaveBeenCalledTimes(1)
  })

  it('without a next player after all: lets go at once when already waiting', async () => {
    const { holdWindowUnder, expectSuccessor, noSuccessor, createElement, exit, electron, timeouts } = createHarness()
    const element = createElement()
    holdWindowUnder(element)
    await element.requestFullscreen()

    expectSuccessor()
    exit()
    noSuccessor()

    expect(electron.releaseWindowFullscreen).toHaveBeenCalledTimes(1)
    expect(timeouts.size).toBe(0)
  })

  it('without a next player when none was expected: nothing to let go of', () => {
    const { noSuccessor, electron } = createHarness()

    noSuccessor()

    expect(electron.releaseWindowFullscreen).not.toHaveBeenCalled()
  })

  it('lets go when the element is refused full screen, and passes the refusal on', async () => {
    const { holdWindowUnder, createElement, electron } = createHarness()
    const element = createElement({ refuse: true })
    const onHolding = vi.fn()
    holdWindowUnder(element, onHolding)

    await expect(element.requestFullscreen()).rejects.toThrow('Permissions check failed')

    expect(electron.releaseWindowFullscreen).toHaveBeenCalledTimes(1)
    expect(onHolding).toHaveBeenLastCalledWith(false)
  })

  it('listens to the document once, however many players there have been', async () => {
    const { holdWindowUnder, createElement, exit, electron } = createHarness()
    for (let i = 0; i < 3; i++) {
      holdWindowUnder(createElement())
    }

    const element = createElement()
    holdWindowUnder(element)
    await element.requestFullscreen()
    exit()

    expect(electron.releaseWindowFullscreen).toHaveBeenCalledTimes(1)
  })
})
