/**
 * Source kinds: the code for each sort of place a source can be.
 *
 * A source kind does three things, and the rest of Collections asks nothing
 * else of it:
 *
 * - `recognise` turns a URL someone pasted into the source it names, or
 *   nothing when the URL is not of its kind. Pure, and never asks the network.
 * - `fetch` asks the source what it shares now, through the `fetch` it is
 *   given (so tests hand it a fake server), and answers its items in its own
 *   shape, with fields to keep on the source's record once their shares are
 *   in. It throws when the source cannot be reached or answers with
 *   something it cannot read; the refresh then keeps what the source had.
 * - `toShares` makes those items shares (`../hackertube.js` has the shape).
 *
 * The refresh (`../refresh.js`) asks every followed source through its kind.
 * Following by URL asks each kind in turn, in the order below, whether it
 * recognises it (`recogniseSource`).
 */

import { hackerTubeKind } from './hackertube.js'

/**
 * @typedef {object} SourceFetch
 * @property {any[]} items what the source shares now, in the kind's own
 *   shape; empty when it has nothing new
 * @property {Record<string, any>} [sourceFields] fields to lay over the
 *   source's record once the items' shares are in (HackerTube: the date and
 *   taxonomy of the export they came from)
 */

/**
 * @typedef {object} SourceKind
 * @property {string} kind the `kind` on a source's record
 * @property {(url: string, now: number) => import('../shares.js').Source | null} recognise
 * @property {(source: import('../shares.js').Source, deps: { fetch: typeof fetch }) => Promise<SourceFetch>} fetch
 * @property {(items: any[], source: import('../shares.js').Source, seenAt: number) => import('../shares.js').Share[]} toShares
 */

/**
 * Every source kind, in the order a pasted URL is offered to them
 *
 * @type {readonly SourceKind[]}
 */
export const SOURCE_KINDS = Object.freeze([hackerTubeKind])

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
