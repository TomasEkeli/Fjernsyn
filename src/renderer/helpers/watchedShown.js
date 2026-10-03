import store from '../store/index'

import { entryVideoId } from './subscriptions'

/**
 * Whether the walls show what has already been watched.
 *
 * One preference for every wall that offers the choice, the subscriptions
 * stream and Explore, and the same one Distraction Free settings has always
 * had as "Hide Videos on Watch". The chip on each wall is that setting brought
 * to the page it changes, not a copy of it: pressing one moves the other and
 * the settings switch with it, and it outlasts a restart, because whether to
 * see what has been seen is a standing preference more than a mood.
 *
 * The setting is still named for the subscriptions page it began on, since
 * renaming it would forget what everyone had it set to.
 *
 * @returns {boolean}
 */
export function watchedIsShown() {
  return !store.getters.getHideWatchedSubs
}

/**
 * @param {boolean} shown
 */
export function setWatchedShown(shown) {
  if (shown === watchedIsShown()) {
    return Promise.resolve()
  }

  return store.dispatch('updateHideWatchedSubs', !shown)
}

/**
 * The entries that are left once everything watched is taken out, or all of
 * them while watched entries are shown.
 *
 * Keyed on what an entry leads to rather than on the entry, so that a post
 * sharing a video goes when that video is watched; an entry leading to no video
 * at all, a text post or a poll, is never "watched" and always stays. See
 * `entryVideoId`.
 *
 * Reads both the setting and the history inside, so a computed calling this is
 * subscribed to each: pressing the chip or finishing a video redraws the wall.
 *
 * @template T
 * @param {T[]} entries
 * @returns {T[]}
 */
export function withWatchedPreference(entries) {
  if (watchedIsShown()) {
    return entries
  }

  const history = store.getters.getHistoryCacheById

  return entries.filter(entry => history[entryVideoId(entry)] === undefined)
}
