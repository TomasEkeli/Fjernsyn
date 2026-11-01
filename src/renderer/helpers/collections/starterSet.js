/**
 * The sources Collections follows by itself, besides HackerTube, on its first
 * open: for now one Lemmy community, `mealtimevideos@lemmy.cafe`, followed
 * where HackerTube is (`openCollections` in `store/modules/collections.js`),
 * and only when HackerTube is, so that the two come and go by one rule.
 *
 * This is where the starter set is to grow: its other sources join this list,
 * HackerTube with them, and the rule for when they are followed (today "no
 * HackerTube record", which an unfollow would undo on the next open) becomes
 * a setting that says the set was applied once. Following by URL needs none of
 * this: a pasted URL goes to `recogniseSource` and is followed as it is.
 */

import { recogniseSource } from './kinds/index.js'

/** The URLs of the sources followed on the first open, besides HackerTube */
export const STARTER_SOURCE_URLS = Object.freeze([
  'https://lemmy.cafe/c/mealtimevideos',
])

/**
 * The sources followed on the first open, besides HackerTube, as followed now
 *
 * @param {number} now
 * @returns {import('./shares.js').Source[]}
 */
export function starterSources(now) {
  return STARTER_SOURCE_URLS.map(url => recogniseSource(url, now)).filter(source => source !== null)
}
