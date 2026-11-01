/**
 * Source kinds: the code for each sort of place a source can be.
 *
 * A source kind does three things, and the rest of Collections asks nothing
 * else of it:
 *
 * - `recognise` turns a URL someone pasted into the source it names, or
 *   nothing when the URL is not of its kind. Pure, and never asks the network.
 * - `fetch` asks the source what it shares now, through the `fetch` it is
 *   given (so tests hand it a fake server), confirming any link that looks
 *   like a PeerTube video through the `peertube` it is given, and answers its items in its own
 *   shape, with fields to keep on the source's record once their shares are
 *   in, and data of its own too large to rewrite with its record on every
 *   refresh, kept apart. It throws when the source cannot be reached or answers with
 *   something it cannot read; the refresh then keeps what the source had.
 * - `toShares` makes those items shares (`../shares.js` has the shape),
 *   given the shares kept, for a kind that chooses between items as it
 *   chose before (Lemmy, between two posts of one video).
 *
 * The refresh (`../refresh.js`) asks every followed source through its kind.
 * Following by URL asks each kind in turn, in the order below, whether it
 * recognises it (`recogniseSource`).
 */

import { hackerTubeKind } from './hackertube.js'
import { lemmyKind } from './lemmy.js'

/**
 * @typedef {object} SourceFetch
 * @property {any[]} items what the source shares now, in the kind's own
 *   shape; empty when it has nothing new
 * @property {Record<string, any>} [sourceFields] small fields to lay over
 *   the source's record once the items' shares are in (HackerTube: the date
 *   of the export they came from)
 * @property {Record<string, any>} [sourceData] the source's own data, kept
 *   apart from its record (`collection-source-data.db`, not backed up) and
 *   written only when given (HackerTube: the export's taxonomy)
 */

/**
 * @typedef {object} PeerTubeLinks what a kind asks of a link that looks like
 *   a PeerTube video (`../peertubeLinks.js`)
 * @property {(candidate: { host: string, videoId: string }) => Promise<import('../../../platform/shapes').PeerTubeVideoRef | null>} refFor
 *   the video's ref at its origin, once the platform layer has confirmed it,
 *   or null; never rejects
 */

/**
 * @typedef {object} SourceKind
 * @property {string} kind the `kind` on a source's record
 * @property {(url: string, now: number) => import('../shares.js').Source | null} recognise
 * @property {(source: import('../shares.js').Source) => string} [feedUrl]
 *   the URL an OPML export lists the source as (`../opml.js`), which
 *   `recognise` must take back as the same source; its `url` when absent
 * @property {(source: import('../shares.js').Source, deps: { fetch: typeof fetch, peertube?: PeerTubeLinks }) => Promise<SourceFetch>} fetch
 *   `peertube` confirms PeerTube links; without it, a kind takes none
 * @property {(items: any[], source: import('../shares.js').Source, seenAt: number, kept: Record<string, import('../shares.js').Share>) => import('../shares.js').Share[]} toShares
 * @property {boolean} [shipped] whether its videos come with the app, so
 *   that following it by URL asks it nothing first (`../follow.js`), and the
 *   first open of Collections loads them (HackerTube)
 */

/**
 * Every source kind, in the order a pasted URL is offered to them
 *
 * @type {readonly SourceKind[]}
 */
export const SOURCE_KINDS = Object.freeze([hackerTubeKind, lemmyKind])

/**
 * The source kinds by their `kind`
 *
 * @type {Readonly<Record<string, SourceKind>>}
 */
export const SOURCE_KINDS_BY_KIND = Object.freeze(Object.fromEntries(SOURCE_KINDS.map(kind => [kind.kind, kind])))

/**
 * The source a URL names, made by the first kind that recognises it, or
 * nothing when none does.
 *
 * @param {string} url
 * @param {number} now when it is followed
 * @returns {import('../shares.js').Source | null}
 */
export function recogniseSource(url, now) {
  for (const kind of SOURCE_KINDS) {
    const source = kind.recognise(url, now)
    if (source !== null) { return source }
  }

  return null
}
