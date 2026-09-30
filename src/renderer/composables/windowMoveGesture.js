/**
 * The long press that moves a frameless window, as a pure state machine: a
 * press held still for HOLD_MS arms it, and the first movement after that
 * starts the move, which main carries out until the button comes up. Any
 * movement before the hold is up gives the press back to whatever it was
 * going to be, which is what keeps scrolling, sliders, text selection and
 * drag-and-drop working.
 *
 * transition() decides and returns effects; useWindowMoveGesture.js is the
 * wiring that feeds it DOM events and carries the effects out.
 */

export const HOLD_MS = 400
export const MOVE_THRESHOLD_PX = 4
const HOLD_SLACK_MS = 50

/**
 * @typedef {'idle' | 'pressing' | 'armed' | 'moving'} Phase
 *
 * @typedef {object} GestureState
 * @property {Phase} phase
 * @property {number} [pointerId]
 * @property {number} [startX]
 * @property {number} [startY]
 * @property {number} [pressedAt]
 *
 * @typedef {(
 *   | { type: 'pointerdown', pointerId: number, pointerType: string, button: number,
 *       modifier: boolean, allowed: boolean, x: number, y: number }
 *   | { type: 'pointermove', pointerId: number, x: number, y: number }
 *   | { type: 'pointerup', pointerId: number }
 *   | { type: 'holdElapsed' }
 *   | { type: 'dragstart' }
 *   | { type: 'selectstart' }
 *   | { type: 'cancel' }
 * )} GestureEvent
 *
 * The effects, carried out in the order given:
 * - startTimer: call back with holdElapsed after HOLD_MS
 * - cancelTimer: forget the hold timer
 * - arm / disarm: show or stop showing that the window can be moved
 * - sendStart / sendEnd: tell main the move has started or ended
 * - suppressClick: swallow the click the release is about to produce
 * - preventDefault: cancel the event that was fed in
 * @typedef {'startTimer' | 'cancelTimer' | 'arm' | 'disarm' | 'sendStart' | 'sendEnd' |
 *   'suppressClick' | 'preventDefault'} GestureEffect
 *
 * @typedef {{ state: GestureState, effects: GestureEffect[] }} GestureResult
 */

/** @type {GestureState} */
export const IDLE = Object.freeze({ phase: 'idle' })

/**
 * @param {GestureState} state
 * @param {GestureEffect[]} [effects]
 * @returns {GestureResult}
 */
function stay(state, effects = []) {
  return { state, effects }
}

/**
 * @param {GestureEffect[]} effects
 * @returns {GestureResult}
 */
function toIdle(effects) {
  return { state: IDLE, effects }
}

/**
 * Whether a pointerdown can start the gesture: the plain left mouse button,
 * on something that is not already a drag or an input. Touch and pen never do.
 * @param {Extract<GestureEvent, { type: 'pointerdown' }>} event
 */
function canArm(event) {
  return event.pointerType === 'mouse' &&
    event.button === 0 &&
    !event.modifier &&
    event.allowed
}

/**
 * @param {GestureState} state
 * @param {GestureEvent} event
 * @param {number} now milliseconds, on the same clock the timer runs on
 * @returns {GestureResult}
 */
export function transition(state, event, now) {
  // Whatever the phase, the gesture can be called off
  if (event.type === 'cancel') {
    switch (state.phase) {
      case 'pressing':
        return toIdle(['cancelTimer'])
      case 'armed':
        return toIdle(['disarm'])
      case 'moving':
        return toIdle(['sendEnd', 'disarm'])
      default:
        return stay(state)
    }
  }

  // Only the pointer that pressed moves the window
  if ('pointerId' in event && state.phase !== 'idle' && event.pointerId !== state.pointerId) {
    return stay(state)
  }

  switch (state.phase) {
    case 'idle':
      if (event.type === 'pointerdown' && canArm(event)) {
        return {
          state: {
            phase: 'pressing',
            pointerId: event.pointerId,
            startX: event.x,
            startY: event.y,
            pressedAt: now
          },
          effects: ['startTimer']
        }
      }
      return stay(state)

    case 'pressing':
      switch (event.type) {
        case 'pointermove':
          if (Math.hypot(event.x - state.startX, event.y - state.startY) > MOVE_THRESHOLD_PX) {
            return toIdle(['cancelTimer'])
          }
          return stay(state)
        case 'pointerup':
          // Released before the hold: an ordinary click, left alone
          return toIdle(['cancelTimer'])
        case 'dragstart':
          // The page's own drag began before the hold was up, so it is the page's
          return toIdle(['cancelTimer'])
        case 'holdElapsed':
          // A timer from an earlier press cannot arm this one. The slack is
          // for timers that fire a little early and clocks that round.
          if (now - state.pressedAt < HOLD_MS - HOLD_SLACK_MS) {
            return stay(state)
          }
          return stay({ ...state, phase: 'armed' }, ['arm'])
        default:
          return stay(state)
      }

    case 'armed':
      switch (event.type) {
        case 'pointermove':
          return stay({ ...state, phase: 'moving' }, ['sendStart'])
        case 'pointerup':
          // Held but never moved: still a click, as a held button is in plain HTML
          return toIdle(['disarm'])
        case 'dragstart':
        case 'selectstart':
          // The window moves instead of a link, an image or a selection
          return stay(state, ['preventDefault'])
        default:
          return stay(state)
      }

    case 'moving':
      switch (event.type) {
        case 'pointerup':
          return toIdle(['sendEnd', 'disarm', 'suppressClick'])
        case 'dragstart':
        case 'selectstart':
          return stay(state, ['preventDefault'])
        default:
          return stay(state)
      }

    default:
      return stay(state)
  }
}
