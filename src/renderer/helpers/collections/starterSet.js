/**
 * The starter set: the sources Collections follows by itself, once per
 * installation, so that the page is good on its first open. HackerTube, whose
 * videos come with the app, and five Lemmy communities measured on 2026-11-01
 * for how much of what they share is a video (`.scratch/collections/spec.md`,
 * "The starter set").
 *
 * Applied once, and never again: the `collectionsStarterSetDone` setting says
 * it has been (`applyCollectionsStarterSet` in `store/modules/collections.js`),
 * so a starter source unfollowed stays unfollowed. Applying it follows each
 * starter not followed already, so an installation that followed some of them
 * before the set existed gets the rest, once, and nothing twice.
 *
 * Followed as they are, without asking them first as a pasted URL is asked
 * (`follow.js`): these are known to serve a feed, and the refresh that opening
 * Collections makes brings their videos. One that is down then is followed
 * all the same and marked failed until a refresh reaches it.
 */

import { recogniseSource } from './kinds/index.js'

/** The URLs of the starter set, in the spec's order */
export const STARTER_SOURCE_URLS = Object.freeze([
  'https://hackertube.org',
  'https://lemmy.cafe/c/mealtimevideos',
  'https://lemmy.world/c/videos',
  'https://lemmy.world/c/peertube',
  'https://lemmy.cafe/c/documentaries',
  'https://programming.dev/c/talks',
])

/**
 * The starter set, as followed now
 *
 * @param {number} now
 * @returns {import('./shares.js').Source[]}
 */
export function starterSources(now) {
  return STARTER_SOURCE_URLS.map(url => recogniseSource(url, now)).filter(source => source !== null)
}

/**
 * Which of the starter set to follow: none once the set has been applied,
 * whatever is followed, and otherwise each one not followed already
 *
 * @param {import('./shares.js').Source[]} starters
 * @param {{ applied: boolean, isFollowed: (sourceId: string) => boolean }} options
 * @returns {import('./shares.js').Source[]}
 */
export function starterSourcesToFollow(starters, { applied, isFollowed }) {
  if (applied) { return [] }

  return starters.filter(source => !isFollowed(source._id))
}
