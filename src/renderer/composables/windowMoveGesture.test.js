import { describe, expect, it } from 'vitest'

import { HOLD_MS, IDLE, MOVE_THRESHOLD_PX, transition } from './windowMoveGesture'

const POINTER = 1

function pointerdown(overrides = {}) {
  return {
    type: 'pointerdown',
    pointerId: POINTER,
    pointerType: 'mouse',
    button: 0,
    modifier: false,
    allowed: true,
    x: 100,
    y: 100,
    ...overrides
  }
}

function pointermove(x, y, pointerId = POINTER) {
  return { type: 'pointermove', pointerId, x, y }
}

function pointerup(pointerId = POINTER) {
  return { type: 'pointerup', pointerId }
}

/**
 * Feeds events in order, each at its own time, and returns the final state
 * together with the effects of the last event.
 * @param {[object, number][]} events
 */
function run(events, state = IDLE) {
  let result = { state, effects: [] }
  for (const [event, now] of events) {
    result = transition(result.state, event, now)
  }
  return result
}

const pressed = () => run([[pointerdown(), 0]]).state
const armed = () => run([[pointerdown(), 0], [{ type: 'holdElapsed' }, HOLD_MS]]).state
const moving = () => run([[pointerdown(), 0], [{ type: 'holdElapsed' }, HOLD_MS], [pointermove(120, 100), HOLD_MS + 10]]).state

describe('windowMoveGesture', () => {
  describe('from idle', () => {
    it('starts pressing on a plain left mouse press, and starts the hold timer', () => {
      const { state, effects } = transition(IDLE, pointerdown(), 0)

      expect(state).toMatchObject({ phase: 'pressing', pointerId: POINTER, startX: 100, startY: 100, pressedAt: 0 })
      expect(effects).toEqual(['startTimer'])
    })

    it.each([
      ['a touch', { pointerType: 'touch' }],
      ['a pen', { pointerType: 'pen' }],
      ['the right button', { button: 2 }],
      ['the middle button', { button: 1 }],
      ['a modifier key', { modifier: true }],
      ['a target that is not allowed', { allowed: false }],
    ])('ignores %s', (_, overrides) => {
      const { state, effects } = transition(IDLE, pointerdown(overrides), 0)

      expect(state.phase).toBe('idle')
      expect(effects).toEqual([])
    })

    it('ignores everything but a pointerdown', () => {
      for (const event of [pointermove(1, 1), pointerup(), { type: 'holdElapsed' }, { type: 'dragstart' }, { type: 'cancel' }]) {
        expect(transition(IDLE, event, 0)).toEqual({ state: IDLE, effects: [] })
      }
    })
  })

  describe('from pressing', () => {
    it('goes back to idle when the pointer moves beyond the threshold, cancelling the timer', () => {
      const { state, effects } = transition(pressed(), pointermove(100 + MOVE_THRESHOLD_PX + 1, 100), 50)

      expect(state.phase).toBe('idle')
      expect(effects).toEqual(['cancelTimer'])
    })

    it('stays pressing through movement within the threshold', () => {
      const { state, effects } = transition(pressed(), pointermove(100 + MOVE_THRESHOLD_PX, 100), 50)

      expect(state.phase).toBe('pressing')
      expect(effects).toEqual([])
    })

    it('measures the threshold as a distance, not per axis', () => {
      const { state } = transition(pressed(), pointermove(103, 103), 50)

      expect(state.phase).toBe('idle')
    })

    it('lets a release before the hold be an ordinary click', () => {
      const { state, effects } = transition(pressed(), pointerup(), 100)

      expect(state.phase).toBe('idle')
      expect(effects).toEqual(['cancelTimer'])
    })

    it('gives way to the page\'s own drag', () => {
      const { state, effects } = transition(pressed(), { type: 'dragstart' }, 100)

      expect(state.phase).toBe('idle')
      expect(effects).toEqual(['cancelTimer'])
    })

    it('arms when the hold timer fires', () => {
      const { state, effects } = transition(pressed(), { type: 'holdElapsed' }, HOLD_MS)

      expect(state.phase).toBe('armed')
      expect(effects).toEqual(['arm'])
    })

    it('arms on a timer that fires a few milliseconds early', () => {
      const { state } = transition(pressed(), { type: 'holdElapsed' }, HOLD_MS - 5)

      expect(state.phase).toBe('armed')
    })

    it('does not arm on a timer that fires well before the hold is up, as one from an earlier press would', () => {
      const { state, effects } = transition(pressed(), { type: 'holdElapsed' }, HOLD_MS / 2)

      expect(state.phase).toBe('pressing')
      expect(effects).toEqual([])
    })

    it('ignores another pointer', () => {
      const { state, effects } = transition(pressed(), pointerup(2), 100)

      expect(state.phase).toBe('pressing')
      expect(effects).toEqual([])
    })

    it('cancels the timer when called off', () => {
      const { state, effects } = transition(pressed(), { type: 'cancel' }, 100)

      expect(state.phase).toBe('idle')
      expect(effects).toEqual(['cancelTimer'])
    })
  })

  describe('from armed', () => {
    it('starts the move on the first movement, however small, and sends start once', () => {
      const first = transition(armed(), pointermove(101, 100), HOLD_MS + 5)

      expect(first.state.phase).toBe('moving')
      expect(first.effects).toEqual(['sendStart'])

      const second = transition(first.state, pointermove(200, 150), HOLD_MS + 20)

      expect(second.state.phase).toBe('moving')
      expect(second.effects).toEqual([])
    })

    it('lets a release without movement click, with no click suppressed', () => {
      const { state, effects } = transition(armed(), pointerup(), HOLD_MS + 100)

      expect(state.phase).toBe('idle')
      expect(effects).toEqual(['disarm'])
      expect(effects).not.toContain('suppressClick')
    })

    it.each(['dragstart', 'selectstart'])('prevents a %s, so the window moves instead', (type) => {
      const { state, effects } = transition(armed(), { type }, HOLD_MS + 5)

      expect(state.phase).toBe('armed')
      expect(effects).toEqual(['preventDefault'])
    })

    it('disarms when called off', () => {
      const { state, effects } = transition(armed(), { type: 'cancel' }, HOLD_MS + 5)

      expect(state.phase).toBe('idle')
      expect(effects).toEqual(['disarm'])
    })
  })

  describe('from moving', () => {
    it('ends the move on release, and swallows the click that follows', () => {
      const { state, effects } = transition(moving(), pointerup(), HOLD_MS + 500)

      expect(state.phase).toBe('idle')
      expect(effects).toEqual(['sendEnd', 'disarm', 'suppressClick'])
    })

    it('ignores the release of another pointer', () => {
      const { state, effects } = transition(moving(), pointerup(2), HOLD_MS + 500)

      expect(state.phase).toBe('moving')
      expect(effects).toEqual([])
    })

    it.each(['dragstart', 'selectstart'])('prevents a %s', (type) => {
      const { state, effects } = transition(moving(), { type }, HOLD_MS + 50)

      expect(state.phase).toBe('moving')
      expect(effects).toEqual(['preventDefault'])
    })

    it('sends end when called off, as by Escape, blur or pointercancel, without swallowing a click', () => {
      const { state, effects } = transition(moving(), { type: 'cancel' }, HOLD_MS + 50)

      expect(state.phase).toBe('idle')
      expect(effects).toEqual(['sendEnd', 'disarm'])
    })

    it('ignores a stray hold timer', () => {
      const { state, effects } = transition(moving(), { type: 'holdElapsed' }, HOLD_MS * 3)

      expect(state.phase).toBe('moving')
      expect(effects).toEqual([])
    })
  })

  it('runs a whole move from press to release', () => {
    const effects = []
    let state = IDLE
    for (const [event, now] of [
      [pointerdown(), 0],
      [pointermove(101, 101), 100],
      [{ type: 'holdElapsed' }, HOLD_MS],
      [pointermove(150, 120), HOLD_MS + 16],
      [pointermove(300, 200), HOLD_MS + 32],
      [pointerup(), HOLD_MS + 48],
    ]) {
      const result = transition(state, event, now)
      state = result.state
      effects.push(...result.effects)
    }

    expect(state).toBe(IDLE)
    expect(effects).toEqual(['startTimer', 'arm', 'sendStart', 'sendEnd', 'disarm', 'suppressClick'])
  })
})
