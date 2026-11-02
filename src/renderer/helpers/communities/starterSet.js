/**
 * The starter set: the sources Communities follows by itself, so that the page
 * is good on its first open. HackerTube, whose videos come with the app, and
 * Lemmy communities where much of what is shared is a video. The first six
 * were measured on 2026-11-01 (`.scratch/communities/spec.md`, "The starter
 * set"); the rest were added after.
 *
 * Each starter is offered once per installation: the
 * `communitiesStarterSourcesOffered` setting lists the ids of those offered,
 * followed or not (`applyCommunitiesStarterSet` in
 * `store/modules/communities.js`), so a starter source unfollowed stays
 * unfollowed, and one added to the set later is offered to an installation
 * that had the set before it. An installation from before that setting has
 * the old `communitiesStarterSetDone` mark instead, which stands for the
 * original six. Applying the set follows each starter neither offered nor
 * followed already, and nothing twice.
 *
 * Followed as they are, without asking them first as a pasted URL is asked
 * (`follow.js`): these are known to serve a feed, and the refresh that opening
 * Communities makes brings their videos. One that is down then is followed
 * all the same and marked failed until a refresh reaches it.
 */

import { recogniseSource } from './kinds/index.js'

/**
 * The starter set as it was first, before `communitiesStarterSourcesOffered`:
 * what the old `communitiesStarterSetDone` mark says was offered. Never changed.
 */
export const ORIGINAL_STARTER_SOURCE_URLS = Object.freeze([
  'https://hackertube.org',
  'https://lemmy.cafe/c/mealtimevideos',
  'https://lemmy.world/c/videos',
  'https://lemmy.world/c/peertube',
  'https://lemmy.cafe/c/documentaries',
  'https://programming.dev/c/talks',
])

/** The URLs of the starter set, in order: the original six, then those added */
export const STARTER_SOURCE_URLS = Object.freeze([
  ...ORIGINAL_STARTER_SOURCE_URLS,
  'https://sopuli.xyz/c/videos',
  'https://sh.itjust.works/c/youtubeclassics',
  'https://lemmy.world/c/videoessays',
  'https://lemmy.blahaj.zone/c/trailers',
  'https://lemmy.zip/c/industrialvideos',
  'https://sh.itjust.works/c/AnimatedMusicVideos',
  'https://lemmy.world/c/80smusic',
  'https://lemmy.world/c/70smusic',
  'https://lemmy.ca/c/electronicmusic',
  'https://lemmy.world/c/vgmusic',
  'https://lemmy.world/c/melodicdeathmetal',
  'https://lemmy.world/c/music',
  'https://lemmy.world/c/metal',
])

/** @param {readonly string[]} urls */
const idsOf = urls => Object.freeze(urls.map(url => recogniseSource(url, 0)?._id).filter(id => id != null))

/** The source ids of the starter set, in its order */
export const STARTER_SOURCE_IDS = idsOf(STARTER_SOURCE_URLS)

/** The source ids of the original six */
export const ORIGINAL_STARTER_SOURCE_IDS = idsOf(ORIGINAL_STARTER_SOURCE_URLS)

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
 * The ids of the starter sources offered already: those the
 * `communitiesStarterSourcesOffered` setting lists, and the original six where
 * the old `communitiesStarterSetDone` mark says the set was applied
 *
 * @param {unknown} offered the setting's value
 * @param {boolean} legacyDone the old mark
 * @returns {Set<string>}
 */
export function starterSourcesOffered(offered, legacyDone) {
  const ids = new Set(Array.isArray(offered) ? offered.filter(id => typeof id === 'string') : [])
  if (legacyDone) {
    for (const id of ORIGINAL_STARTER_SOURCE_IDS) { ids.add(id) }
  }
  return ids
}

/**
 * The setting's value with every starter of the set now among those offered,
 * sorted, so that two machines that merge it arrive at the same list
 *
 * @param {unknown} offered the setting's value
 * @returns {string[]}
 */
export function withEveryStarterOffered(offered) {
  return [...new Set([...starterSourcesOffered(offered, false), ...STARTER_SOURCE_IDS])].sort()
}

/**
 * Which of the starter set to follow: each one neither offered already nor
 * followed already
 *
 * @param {import('./shares.js').Source[]} starters
 * @param {{ offered: Set<string>, isFollowed: (sourceId: string) => boolean }} options
 * @returns {import('./shares.js').Source[]}
 */
export function starterSourcesToFollow(starters, { offered, isFollowed }) {
  return starters.filter(source => !offered.has(source._id) && !isFollowed(source._id))
}
