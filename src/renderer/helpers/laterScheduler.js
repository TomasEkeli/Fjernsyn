/**
 * The scheduler's decisions, as pure functions: when an armed item is checked,
 * what a check's answer does, and how an item found live is fired.
 *
 * Pure, so that each rule is tested on its own; `composables/useLaterScheduler`
 * does the asking, the timing and the store.
 */

import { CHECK_AFTER_MS, CHECK_BEFORE_MS } from './later'

/** How often each armed item is checked while near its time */
export const CHECK_NEAR_EVERY_MS = 60 * 1000

/** And how often otherwise, which catches a moved time and a stream already live */
export const CHECK_FAR_EVERY_MS = 60 * 60 * 1000

/** A stated time this much off the alarm's is a moved time */
export const MOVED_BY_MS = 60 * 1000

/**
 * Whether to check an armed item now. Never checked this run, or not for an
 * hour: yes. Within two minutes before its time and three hours after, and
 * not for a minute: yes.
 * @param {number} now ms
 * @param {number} at the alarm's stated start, ms
 * @param {number | undefined} lastChecked ms, this run only
 */
export function shouldCheck(now, at, lastChecked) {
  if (lastChecked == null || now - lastChecked >= CHECK_FAR_EVERY_MS) {
    return true
  }

  const near = now >= at - CHECK_BEFORE_MS && now <= at + CHECK_AFTER_MS

  return near && now - lastChecked >= CHECK_NEAR_EVERY_MS
}

/**
 * @typedef {{ type: 'fire' }
 *   | { type: 'moveTime', at: number }
 *   | { type: 'over' }
 *   | { type: 'none' }} CheckEffect
 */

/**
 * What a check's answer does to an armed item.
 * @param {import('./api/liveState').LiveState} answer
 * @param {number} at the alarm's stated start, ms
 * @returns {CheckEffect}
 */
export function effectOfAnswer(answer, at) {
  switch (answer?.state) {
    case 'live':
      return { type: 'fire' }

    case 'upcoming':
      if (typeof answer.startsAt === 'number' && Math.abs(answer.startsAt - at) > MOVED_BY_MS) {
        return { type: 'moveTime', at: answer.startsAt }
      }
      return { type: 'none' }

    case 'over':
      return { type: 'over' }

    // Unavailable, or anything else: nothing. If it never comes back, it
    // reaches Did not start, and is removed by hand
    default:
      return { type: 'none' }
  }
}

/**
 * How an item found live is fired.
 *
 * - The window is not seen (hidden or minimised): a desktop notification.
 * - It is on the item's own watch page, and that page reloads into the
 *   stream (the layer's watch view): the reload.
 * - The player is up, showing another video: a notice on the player.
 * - Anything else, a watch page with no player among it: the countdown.
 *
 * @param {object} situation
 * @param {boolean} situation.shown the window is visible and not minimised
 * @param {string | null} situation.watchingVideoId the video id the route's
 *   watch page is for, or null off a watch page
 * @param {boolean} situation.ownPageReloads the watch page shown reloads when
 *   its own event goes live, which only the layer's watch view does
 * @param {boolean} situation.playerMounted
 * @param {string} videoId the item's
 * @returns {'notify' | 'reload' | 'playerNotice' | 'countdown'}
 */
export function fireDecision({ shown, watchingVideoId, ownPageReloads, playerMounted }, videoId) {
  if (!shown) { return 'notify' }

  if (watchingVideoId === videoId && ownPageReloads) { return 'reload' }

  if (watchingVideoId !== null && watchingVideoId !== videoId && playerMounted) { return 'playerNotice' }

  return 'countdown'
}
