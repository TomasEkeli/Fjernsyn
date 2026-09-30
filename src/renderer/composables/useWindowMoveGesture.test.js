import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ARMED_CLASS, installWindowMoveGesture, isAllowedTarget, isOnScrollbar } from './useWindowMoveGesture'
import { HOLD_MS } from './windowMoveGesture'

/**
 * jsdom has no PointerEvent, so a mouse event of that name with the pointer
 * fields the gesture reads
 */
function pointer(type, target, { x = 50, y = 50, pointerType = 'mouse', pointerId = 1, button = 0, ...init } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button, ...init })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  Object.defineProperty(event, 'pointerType', { value: pointerType })
  target.dispatchEvent(event)
  return event
}

function click(target) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('installWindowMoveGesture', () => {
  let clock
  let bridge
  let uninstall
  let button
  let clicks

  beforeEach(() => {
    vi.useFakeTimers()
    clock = 0
    bridge = { startWindowMove: vi.fn(), endWindowMove: vi.fn() }
    document.body.innerHTML = '<button id="button">Press</button><input id="input"><div draggable="true" id="card">card</div>'
    button = document.getElementById('button')
    clicks = vi.fn()
    button.addEventListener('click', clicks)
    uninstall = installWindowMoveGesture({ bridge: () => bridge, now: () => clock })
  })

  afterEach(() => {
    uninstall()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  function hold() {
    clock += HOLD_MS
    vi.advanceTimersByTime(HOLD_MS)
  }

  it('moves the window after a long press and a drag, and swallows the click', () => {
    pointer('pointerdown', button)
    hold()
    expect(document.documentElement.classList.contains(ARMED_CLASS)).toBe(true)

    pointer('pointermove', button, { x: 80, y: 60 })
    pointer('pointermove', button, { x: 120, y: 90 })
    expect(bridge.startWindowMove).toHaveBeenCalledTimes(1)

    pointer('pointerup', button)
    click(button)

    expect(bridge.endWindowMove).toHaveBeenCalledTimes(1)
    expect(clicks).not.toHaveBeenCalled()
    expect(document.documentElement.classList.contains(ARMED_CLASS)).toBe(false)
  })

  it('lets the click after a move be the only one swallowed', () => {
    pointer('pointerdown', button)
    hold()
    pointer('pointermove', button, { x: 80, y: 60 })
    pointer('pointerup', button)
    click(button)
    click(button)

    expect(clicks).toHaveBeenCalledTimes(1)
  })

  it('clears the click suppressor on the next frame when no click comes', () => {
    pointer('pointerdown', button)
    hold()
    pointer('pointermove', button, { x: 80, y: 60 })
    pointer('pointerup', button)
    vi.advanceTimersToNextFrame()
    click(button)

    expect(clicks).toHaveBeenCalledTimes(1)
  })

  it('still clicks after a long press released without moving', () => {
    pointer('pointerdown', button)
    hold()
    pointer('pointerup', button)
    click(button)

    expect(bridge.startWindowMove).not.toHaveBeenCalled()
    expect(clicks).toHaveBeenCalledTimes(1)
    expect(document.documentElement.classList.contains(ARMED_CLASS)).toBe(false)
  })

  it('does not arm when the pointer moves before the hold is up', () => {
    pointer('pointerdown', button)
    clock += 100
    pointer('pointermove', button, { x: 70, y: 50 })
    hold()

    expect(document.documentElement.classList.contains(ARMED_CLASS)).toBe(false)
    pointer('pointermove', button, { x: 90, y: 50 })
    expect(bridge.startWindowMove).not.toHaveBeenCalled()
  })

  it.each(['input', 'card'])('does not arm on the %s', (id) => {
    const target = document.getElementById(id)
    pointer('pointerdown', target)
    hold()

    expect(document.documentElement.classList.contains(ARMED_CLASS)).toBe(false)
  })

  it('does not arm for touch', () => {
    pointer('pointerdown', button, { pointerType: 'touch' })
    hold()

    expect(document.documentElement.classList.contains(ARMED_CLASS)).toBe(false)
  })

  it('prevents a native drag once armed, so the window moves instead', () => {
    pointer('pointerdown', button)
    hold()
    const dragstart = new Event('dragstart', { bubbles: true, cancelable: true })
    button.dispatchEvent(dragstart)

    expect(dragstart.defaultPrevented).toBe(true)
  })

  it('leaves a native drag alone before the hold is up', () => {
    pointer('pointerdown', button)
    const dragstart = new Event('dragstart', { bubbles: true, cancelable: true })
    button.dispatchEvent(dragstart)
    hold()

    expect(dragstart.defaultPrevented).toBe(false)
    expect(document.documentElement.classList.contains(ARMED_CLASS)).toBe(false)
  })

  it.each([
    ['Escape', () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))],
    ['blur', () => window.dispatchEvent(new Event('blur'))],
    ['pointercancel', () => pointer('pointercancel', button)],
  ])('ends a running move on %s', (_, cancel) => {
    pointer('pointerdown', button)
    hold()
    pointer('pointermove', button, { x: 80, y: 60 })
    cancel()

    expect(bridge.endWindowMove).toHaveBeenCalledTimes(1)
    expect(document.documentElement.classList.contains(ARMED_CLASS)).toBe(false)
  })

  it('swallows the click when the button is released after Escape called the move off', () => {
    pointer('pointerdown', button)
    hold()
    pointer('pointermove', button, { x: 80, y: 60 })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    pointer('pointerup', button)
    click(button)

    expect(clicks).not.toHaveBeenCalled()
  })

  it('keeps the context menu shut during a move', () => {
    pointer('pointerdown', button)
    hold()
    pointer('pointermove', button, { x: 80, y: 60 })
    const contextmenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    button.dispatchEvent(contextmenu)

    expect(contextmenu.defaultPrevented).toBe(true)
  })

  it('does nothing while disabled', () => {
    uninstall()
    uninstall = installWindowMoveGesture({ bridge: () => bridge, now: () => clock, enabled: () => false })

    pointer('pointerdown', button)
    hold()
    pointer('pointermove', button, { x: 80, y: 60 })

    expect(document.documentElement.classList.contains(ARMED_CLASS)).toBe(false)
    expect(bridge.startWindowMove).not.toHaveBeenCalled()
  })

  it('does nothing without the Electron bridge, as in the web build', () => {
    uninstall()
    uninstall = installWindowMoveGesture({ bridge: () => undefined, now: () => clock })

    pointer('pointerdown', button)
    hold()
    expect(() => pointer('pointermove', button, { x: 80, y: 60 })).not.toThrow()
    expect(() => pointer('pointerup', button)).not.toThrow()
  })

  it('ends a running move when uninstalled', () => {
    pointer('pointerdown', button)
    hold()
    pointer('pointermove', button, { x: 80, y: 60 })
    uninstall()

    expect(bridge.endWindowMove).toHaveBeenCalledTimes(1)
    uninstall = () => {}
  })
})

describe('isAllowedTarget', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it.each([
    ['a draggable card', '<div draggable="true"><span id="t">x</span></div>', false],
    ['a button with its own long press', '<button data-long-press="true"><svg id="t"></svg></button>', false],
    ['an input', '<input id="t">', false],
    ['a textarea', '<textarea id="t"></textarea>', false],
    ['a select', '<select id="t"></select>', false],
    ['editable text', '<div contenteditable><b id="t">x</b></div>', false],
    ['a carousel', '<swiper-container><div id="t"></div></swiper-container>', false],
    ['the player\'s seek bar', '<div class="shaka-controls-container"><div class="shaka-bottom-controls"><div id="t"></div></div></div>', false],
    ['the player\'s settings menu', '<div class="shaka-controls-container"><div class="shaka-settings-menu"><button id="t"></button></div></div>', false],
    ['the video surface', '<div class="shaka-controls-container"><div class="shaka-play-button-container" id="t"></div></div>', true],
    ['a button', '<button id="t">x</button>', true],
    ['a link', '<a href="#x" id="t">x</a>', true],
    ['a card that has stopped being draggable', '<div draggable="false"><span id="t">x</span></div>', true],
  ])('%s: %s', (_, html, allowed) => {
    document.body.innerHTML = html
    const event = new MouseEvent('pointerdown', { clientX: 0, clientY: 0 })
    Object.defineProperty(event, 'target', { value: document.getElementById('t') })

    expect(isAllowedTarget(event)).toBe(allowed)
  })
})

describe('isOnScrollbar', () => {
  function element({ clientWidth = 100, clientHeight = 100, scrollWidth = 100, scrollHeight = 100, clientLeft = 0, clientTop = 0 } = {}) {
    const el = document.createElement('div')
    Object.defineProperties(el, {
      clientWidth: { value: clientWidth },
      clientHeight: { value: clientHeight },
      scrollWidth: { value: scrollWidth },
      scrollHeight: { value: scrollHeight },
      clientLeft: { value: clientLeft },
      clientTop: { value: clientTop },
    })
    el.getBoundingClientRect = () => ({ left: 10, top: 10, right: 10 + clientWidth + 15, bottom: 10 + clientHeight + 15 })
    return el
  }

  beforeEach(() => {
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 1000, configurable: true })
    Object.defineProperty(document.documentElement, 'clientHeight', { value: 800, configurable: true })
  })

  it('is on the vertical scrollbar of an element that scrolls', () => {
    const el = element({ scrollHeight: 400 })

    expect(isOnScrollbar(el, { clientX: 115, clientY: 50 })).toBe(true)
    expect(isOnScrollbar(el, { clientX: 105, clientY: 50 })).toBe(false)
  })

  it('is on the horizontal scrollbar of an element that scrolls sideways', () => {
    const el = element({ scrollWidth: 400 })

    expect(isOnScrollbar(el, { clientX: 50, clientY: 115 })).toBe(true)
  })

  it('is on a scrollbar on the left, as in a right-to-left layout', () => {
    const el = element({ scrollHeight: 400, clientLeft: 15 })

    expect(isOnScrollbar(el, { clientX: 15, clientY: 50 })).toBe(true)
    expect(isOnScrollbar(el, { clientX: 30, clientY: 50 })).toBe(false)
  })

  it('is never on a scrollbar of an element that does not scroll', () => {
    const el = element()

    expect(isOnScrollbar(el, { clientX: 115, clientY: 115 })).toBe(false)
  })

  it('is on the page\'s scrollbar past the page\'s content area', () => {
    const el = element()

    expect(isOnScrollbar(el, { clientX: 1005, clientY: 50 })).toBe(true)
    expect(isOnScrollbar(el, { clientX: 50, clientY: 805 })).toBe(true)
  })
})
