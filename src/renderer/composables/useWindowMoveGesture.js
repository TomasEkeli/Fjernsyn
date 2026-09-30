import { onBeforeUnmount, onMounted } from 'vue'

import { HOLD_MS, IDLE, transition } from './windowMoveGesture'

/**
 * Where a long press must not move the window, because the press already
 * means something there: the page's own drag-and-drop, a long press of its
 * own, anything typed into,
 * a carousel that swipes, and the player's controls, menus and seek bar. The
 * video itself is left movable, which is why this names the player's control
 * bar and menus rather than its controls container, which covers the video.
 */
const EXCLUDED_TARGETS = [
  // A button with its own long press, as back and forward have for their history
  '[data-long-press]',
  'input',
  'textarea',
  'select',
  '[contenteditable]',
  'swiper-container',
  '.shaka-bottom-controls',
  '.shaka-controls-top-button-panel',
  '.shaka-settings-menu',
  '.shaka-overflow-menu',
  '.shaka-context-menu',
].join(', ')

export const ARMED_CLASS = 'window-move-armed'

/**
 * Whether the pointer is on a scrollbar of the element it pressed, or of the
 * page. A scrollbar is part of its element, so the event's target alone does
 * not tell; the pointer being outside the element's content box does.
 * @param {Element} target
 * @param {PointerEvent} event
 */
export function isOnScrollbar(target, event) {
  const root = target.ownerDocument.documentElement
  if (event.clientX >= root.clientWidth || event.clientY >= root.clientHeight) {
    // Past the page's own content area, which only its scrollbars occupy
    return root.clientWidth > 0 && root.clientHeight > 0
  }

  const scrollsX = target.scrollWidth > target.clientWidth
  const scrollsY = target.scrollHeight > target.clientHeight
  if (!scrollsX && !scrollsY) {
    return false
  }

  const rect = target.getBoundingClientRect()
  // Relative to the inside of the border; a scrollbar on the left, as in a
  // right-to-left layout, is inside clientLeft and so comes out negative
  const x = event.clientX - rect.left - target.clientLeft
  const y = event.clientY - rect.top - target.clientTop

  return (scrollsY && (x < 0 || x >= target.clientWidth)) ||
    (scrollsX && y >= target.clientHeight)
}

/**
 * The nearest element around the target that the page really drags, if any.
 * A video card marks its thumbnail, its buttons and its text draggable only
 * so that it can cancel their drags (all but its link's, see FtListVideo's
 * onDragStart), so those are passed over. Where every card is edge to edge,
 * as in the wall density, they would otherwise leave nothing to move the
 * window by. A list that reorders its cards makes the item around the card
 * draggable, which still counts.
 * @param {Element} target
 */
function closestDragSurface(target) {
  let draggable = target.closest('[draggable="true"]')

  while (draggable !== null && draggable.parentElement?.closest('.ft-list-video')) {
    draggable = draggable.parentElement.closest('[draggable="true"]')
  }

  return draggable
}

/**
 * @param {PointerEvent} event
 */
export function isAllowedTarget(event) {
  const target = event.target
  if (!(target instanceof Element)) {
    return false
  }

  return closestDragSurface(target) === null &&
    target.closest(EXCLUDED_TARGETS) === null &&
    !isOnScrollbar(target, event)
}

/**
 * Wires the long press state machine to a document: listens for the
 * pointer, keyboard and focus events that drive it, and carries out its
 * effects. Returns the function that removes it all again.
 *
 * @param {object} [options]
 * @param {Document} [options.document]
 * @param {() => boolean} [options.enabled] read at each press
 * @param {() => ({ startWindowMove: () => void, endWindowMove: () => void } | undefined)} [options.bridge]
 * @param {() => number} [options.now]
 */
export function installWindowMoveGesture({
  document: doc = document,
  enabled = () => true,
  bridge = () => window.ftElectron,
  now = () => performance.now(),
} = {}) {
  const win = doc.defaultView
  let state = IDLE
  let holdTimer = null
  let removeClickSuppressor = null

  function suppressNextClick() {
    removeClickSuppressor?.()

    /** @param {MouseEvent} event */
    const swallow = (event) => {
      event.stopPropagation()
      event.preventDefault()
      remove()
    }

    // The click comes straight after the pointerup, in the same input event.
    // If none does, as when the release lands outside what was pressed, the
    // next frame clears the listener so it cannot eat a later, real click.
    const frame = win.requestAnimationFrame(() => remove())

    function remove() {
      doc.removeEventListener('click', swallow, true)
      win.cancelAnimationFrame(frame)
      removeClickSuppressor = null
    }

    doc.addEventListener('click', swallow, true)
    removeClickSuppressor = remove
  }

  /**
   * @param {import('./windowMoveGesture').GestureEvent} gestureEvent
   * @param {Event} [domEvent]
   */
  function feed(gestureEvent, domEvent) {
    const result = transition(state, gestureEvent, now())
    state = result.state

    for (const effect of result.effects) {
      switch (effect) {
        case 'startTimer':
          win.clearTimeout(holdTimer)
          holdTimer = win.setTimeout(() => {
            holdTimer = null
            feed({ type: 'holdElapsed' })
          }, HOLD_MS)
          break
        case 'cancelTimer':
          win.clearTimeout(holdTimer)
          holdTimer = null
          break
        case 'arm':
          doc.documentElement.classList.add(ARMED_CLASS)
          break
        case 'disarm':
          doc.documentElement.classList.remove(ARMED_CLASS)
          break
        case 'sendStart':
          bridge()?.startWindowMove?.()
          break
        case 'sendEnd':
          bridge()?.endWindowMove?.()
          break
        case 'suppressClick':
          suppressNextClick()
          break
        case 'preventDefault':
          domEvent?.preventDefault()
          break
      }
    }
  }

  /** @param {PointerEvent} event */
  function onPointerDown(event) {
    if (state.phase === 'idle' && !enabled()) {
      return
    }

    feed({
      type: 'pointerdown',
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      button: event.button,
      modifier: event.ctrlKey || event.altKey || event.shiftKey || event.metaKey,
      // Only worked out for a press that could otherwise arm, as it measures layout
      allowed: event.pointerType === 'mouse' && event.button === 0 && isAllowedTarget(event),
      x: event.clientX,
      y: event.clientY,
    }, event)
  }

  /** @param {PointerEvent} event */
  function onPointerMove(event) {
    if (state.phase !== 'idle') {
      feed({ type: 'pointermove', pointerId: event.pointerId, x: event.clientX, y: event.clientY }, event)
    }
  }

  /** @param {PointerEvent} event */
  function onPointerUp(event) {
    if (state.phase !== 'idle') {
      feed({ type: 'pointerup', pointerId: event.pointerId }, event)
    }
  }

  /** @param {Event} event */
  function onCancel(event) {
    if (state.phase !== 'idle') {
      feed({ type: 'cancel' }, event)
    }
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    if (event.key === 'Escape') {
      onCancel(event)
    }
  }

  /** @param {Event} event */
  function onPreventable(event) {
    if (state.phase !== 'idle') {
      feed({ type: event.type }, event)
    }
  }

  const documentListeners = [
    ['pointerdown', onPointerDown],
    ['pointermove', onPointerMove],
    ['pointerup', onPointerUp],
    ['pointercancel', onCancel],
    ['keydown', onKeyDown],
    ['dragstart', onPreventable],
    ['selectstart', onPreventable],
    ['contextmenu', onPreventable],
  ]

  // Capture, so that nothing on the page can stop the gesture from seeing an event
  documentListeners.forEach(([type, listener]) => doc.addEventListener(type, listener, true))
  win.addEventListener('blur', onCancel)

  return function uninstall() {
    onCancel(new Event('cancel'))
    removeClickSuppressor?.()
    documentListeners.forEach(([type, listener]) => doc.removeEventListener(type, listener, true))
    win.removeEventListener('blur', onCancel)
  }
}

/**
 * Lets the window be moved by a long press and a drag anywhere in the app
 * that does not already drag. For a frameless window, which has no title bar
 * to move it by; installed once, from App.vue.
 *
 * @param {object} [options]
 * @param {() => boolean} [options.enabled] read at each press
 */
export function useWindowMoveGesture({ enabled } = {}) {
  let uninstall = null
  let unmounted = false

  onMounted(async () => {
    // The web build has no window to move
    if (!process.env.IS_ELECTRON) {
      return
    }

    // Nor does native Wayland let the app move one, so main keeps the frame there
    const isWayland = await window.ftElectron.isWaylandPlatform?.().catch(() => false)
    if (!isWayland && !unmounted) {
      uninstall = installWindowMoveGesture({ enabled })
    }
  })

  onBeforeUnmount(() => {
    unmounted = true
    uninstall?.()
    uninstall = null
  })
}
