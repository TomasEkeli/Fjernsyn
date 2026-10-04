import { describe, expect, it } from 'vitest'

import { effectOfAnswer, fireDecision, shouldCheck } from './laterScheduler'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const AT = Date.parse('2026-10-04T20:00:00Z')

describe('the Later scheduler', () => {
  describe('when to check', () => {
    it('checks an item never checked this run, whenever its time', () => {
      expect(shouldCheck(AT - 5 * HOUR, AT, undefined)).toBe(true)
      expect(shouldCheck(AT + 10 * HOUR, AT, undefined)).toBe(true)
    })

    it('checks hourly far from its time', () => {
      expect(shouldCheck(AT - 5 * HOUR, AT, AT - 5 * HOUR - 59 * MINUTE)).toBe(false)
      expect(shouldCheck(AT - 5 * HOUR, AT, AT - 6 * HOUR)).toBe(true)
      expect(shouldCheck(AT + 4 * HOUR, AT, AT + 3.5 * HOUR)).toBe(false)
    })

    it('checks every minute from two minutes before until three hours after', () => {
      expect(shouldCheck(AT - 3 * MINUTE, AT, AT - 4 * MINUTE)).toBe(false)
      expect(shouldCheck(AT - 2 * MINUTE, AT, AT - 3 * MINUTE)).toBe(true)
      expect(shouldCheck(AT, AT, AT - 30 * 1000)).toBe(false)
      expect(shouldCheck(AT, AT, AT - MINUTE)).toBe(true)
      expect(shouldCheck(AT + 3 * HOUR, AT, AT + 3 * HOUR - MINUTE)).toBe(true)
      expect(shouldCheck(AT + 3 * HOUR + 1, AT, AT + 3 * HOUR - MINUTE)).toBe(false)
    })
  })

  describe('what an answer does', () => {
    it('fires a live one', () => {
      expect(effectOfAnswer({ state: 'live' }, AT)).toEqual({ type: 'fire' })
    })

    it('follows a time that moved by more than a minute', () => {
      expect(effectOfAnswer({ state: 'upcoming', startsAt: AT + 30 * MINUTE }, AT)).toEqual({ type: 'moveTime', at: AT + 30 * MINUTE })
      expect(effectOfAnswer({ state: 'upcoming', startsAt: AT - 2 * MINUTE }, AT)).toEqual({ type: 'moveTime', at: AT - 2 * MINUTE })
    })

    it('does nothing for an upcoming one on time, or with no time', () => {
      expect(effectOfAnswer({ state: 'upcoming', startsAt: AT + 30 * 1000 }, AT)).toEqual({ type: 'none' })
      expect(effectOfAnswer({ state: 'upcoming', startsAt: null }, AT)).toEqual({ type: 'none' })
    })

    it('ends one that is over', () => {
      expect(effectOfAnswer({ state: 'over' }, AT)).toEqual({ type: 'over' })
    })

    it('does nothing for an unavailable one, nor for no answer (a check that threw)', () => {
      expect(effectOfAnswer({ state: 'unavailable' }, AT)).toEqual({ type: 'none' })
      expect(effectOfAnswer(undefined, AT)).toEqual({ type: 'none' })
    })
  })

  describe('how a live one fires', () => {
    const base = { shown: true, watchingVideoId: null, ownPageReloads: true, playerMounted: false }

    it('notifies when the window is not seen, wherever it is', () => {
      expect(fireDecision({ ...base, shown: false }, 'v')).toBe('notify')
      expect(fireDecision({ ...base, shown: false, watchingVideoId: 'v' }, 'v')).toBe('notify')
      expect(fireDecision({ ...base, shown: false, watchingVideoId: 'other', playerMounted: true }, 'v')).toBe('notify')
    })

    it('reloads its own watch page', () => {
      expect(fireDecision({ ...base, watchingVideoId: 'v' }, 'v')).toBe('reload')
      expect(fireDecision({ ...base, watchingVideoId: 'v', playerMounted: true }, 'v')).toBe('reload')
    })

    it('counts down on its own page where that page does not reload (upstream\'s watch view)', () => {
      expect(fireDecision({ ...base, watchingVideoId: 'v', ownPageReloads: false }, 'v')).toBe('countdown')
    })

    it('puts a notice on the player while another video is watched', () => {
      expect(fireDecision({ ...base, watchingVideoId: 'other', playerMounted: true }, 'v')).toBe('playerNotice')
    })

    it('counts down on a watch page with no player, such as another event\'s countdown', () => {
      expect(fireDecision({ ...base, watchingVideoId: 'other', playerMounted: false }, 'v')).toBe('countdown')
    })

    it('counts down off a watch page', () => {
      expect(fireDecision(base, 'v')).toBe('countdown')
    })
  })
})
