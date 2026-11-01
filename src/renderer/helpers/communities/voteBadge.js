/**
 * What the vote badge on a communities wall's card says: the quiet number at
 * the top left of the thumbnail, and what hovering it shows.
 *
 * The number is the video's votes summed over the shares of the sources shown
 * (`communityValues` in shares.js), the same number the upvotes sort orders
 * the wall by. A video none of whose shown shares has votes has no badge; one
 * whose votes sum to zero has one, saying so.
 *
 * Hovering it says two different things on the two walls. On Communities, the
 * sources that shared the video and each one's votes, and nothing else. On a
 * source's page, that source's own share: why it was shared, when, its votes
 * and the way to the discussion.
 *
 * Pure: the sources and shares are looked up by the caller's functions.
 */

import { shareId } from './shares.js'

/** @import { CommunityVideo, Share, Source } from './shares.js' */

/**
 * @typedef {object} BadgeLookups
 * @property {(sourceId: string) => Source | undefined} sourceFor a followed source by id
 * @property {(shareId: string) => Share | undefined} shareFor a share held, by id
 */

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * The number on a card's badge; null for no badge
 *
 * @param {Partial<CommunityVideo>} video
 * @returns {number | null}
 */
export function badgeVotes(video) {
  const votes = video.community?.votes
  return isNumber(votes) ? votes : null
}

/**
 * Votes as the badge writes them: HackerTube's half votes kept, as 22.5 is
 * what the source says and what the wall is ordered by, anything finer
 * dropped, and the language's own digits and grouping
 *
 * @param {number} votes
 * @param {string[]} locales
 * @returns {string}
 */
export function formatVotes(votes, locales) {
  return new Intl.NumberFormat(locales, { maximumFractionDigits: 1 }).format(votes)
}

/**
 * Communities' hover: each shown source that shared the video, by name, with
 * its own votes for it (null where it has none), the most first, sources
 * without votes last, ties by name. A source no longer followed is left out.
 *
 * @param {Partial<CommunityVideo>} video
 * @param {BadgeLookups} lookups
 * @param {string[]} locales the language whose order ties are put in
 * @returns {{ sourceId: string, name: string, votes: number | null }[]}
 */
export function votesBySource(video, { sourceFor, shareFor }, locales) {
  const sourceIds = video.community?.sourceIds ?? []

  const rows = []

  for (const sourceId of sourceIds) {
    const source = sourceFor(sourceId)
    if (source === undefined) { continue }

    const votes = shareFor(shareId(sourceId, /** @type {CommunityVideo} */ (video)))?.votes
    rows.push({ sourceId, name: source.name, votes: isNumber(votes) ? votes : null })
  }

  return rows.sort((a, b) => {
    if (a.votes !== b.votes) {
      if (a.votes === null) { return 1 }
      if (b.votes === null) { return -1 }
      return b.votes - a.votes
    }

    return a.name.localeCompare(b.name, locales, { sensitivity: 'base' })
  })
}

/**
 * @typedef {object} ShareContext a source's page's hover: its share of the video
 * @property {string | null} kind the source's kind, which decides how its date reads
 * @property {number | null} votes
 * @property {string | null} why
 * @property {number | null} sharedAt
 * @property {string | null} discussionUrl as the source gave it; see `discussionLink`
 */

/**
 * A source's page's hover: that source's share of the video, or null when
 * it is not held
 *
 * @param {Partial<CommunityVideo>} video
 * @param {string} sourceId
 * @param {BadgeLookups} lookups
 * @returns {ShareContext | null}
 */
export function shareContext(video, sourceId, { sourceFor, shareFor }) {
  const share = shareFor(shareId(sourceId, /** @type {CommunityVideo} */ (video)))
  if (share === undefined) { return null }

  const why = typeof share.why === 'string' && share.why.trim() !== '' ? share.why : null

  return {
    kind: sourceFor(sourceId)?.kind ?? null,
    votes: isNumber(share.votes) ? share.votes : null,
    why,
    sharedAt: isNumber(share.sharedAt) ? share.sharedAt : null,
    discussionUrl: typeof share.discussionUrl === 'string' ? share.discussionUrl : null,
  }
}

/**
 * When a share was shared, in words: the year alone for HackerTube, whose
 * date is only the last year the video was recommended on Hacker News, kept
 * as the first of January of it in UTC, so read in UTC too; the day for a
 * source that dates its posts. Empty without a date.
 *
 * @param {number | null} sharedAt
 * @param {string | null} kind
 * @param {string[]} locales
 * @returns {string}
 */
export function shareDateText(sharedAt, kind, locales) {
  if (!isNumber(sharedAt)) { return '' }

  /** @type {Intl.DateTimeFormatOptions} */
  const options = kind === 'hackertube'
    ? { year: 'numeric', timeZone: 'UTC' }
    : { dateStyle: 'medium' }

  return new Intl.DateTimeFormat(locales, options).format(sharedAt)
}

/**
 * The discussion's address, if it is a web address and nothing else, as the
 * URL parser writes it: it came from a feed, and is put in a link
 *
 * @param {unknown} url
 * @returns {string | null}
 */
export function discussionLink(url) {
  if (typeof url !== 'string') { return null }

  const parsed = URL.parse(url)
  return parsed !== null && (parsed.protocol === 'https:' || parsed.protocol === 'http:') ? parsed.href : null
}
