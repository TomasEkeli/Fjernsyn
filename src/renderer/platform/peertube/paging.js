// Paging PeerTube lists into the common `Page` shape (`../shapes.js`).
//
// PeerTube pages by offset: `start` and `count`, answered with
// `{ total, data }`. The cursor handed out is the next `start`, a number, and
// `null` at the end: when a page comes back empty, or when `start` plus what
// the instance sent reaches `total`. The next `start` counts every item the
// instance sent, including any the adapter then drops (an NSFW video, an item
// it cannot read), so that nothing is asked for twice or skipped.

import { PlatformError } from '../errors'

// The page size the adapter asks for; the client never sends more than 100
export const PAGE_COUNT = 30

/**
 * The offset a cursor stands for: `0` for none, the cursor itself for a
 * non-negative integer. Anything else was not handed out by this adapter.
 *
 * @param {unknown} cursor
 * @returns {number}
 */
export function startOf(cursor) {
  if (cursor == null) {
    return 0
  }

  if (typeof cursor === 'number' && Number.isInteger(cursor) && cursor >= 0) {
    return cursor
  }

  throw new PlatformError('invalid', `Not a PeerTube cursor: ${String(cursor)}`)
}

/**
 * @template T
 * @param {any} body `{ total, data }`
 * @param {number} start the offset the page was asked from
 * @param {(item: any) => T | null} read an item in the common shape, or `null` to leave it out
 * @param {(item: T) => boolean} [keep]
 * @returns {import('../shapes').Page<T>}
 */
export function pageOf(body, start, read, keep = () => true) {
  const data = Array.isArray(body?.data) ? body.data : []
  const items = data.map(read).filter(item => item != null && keep(item))
  const next = start + data.length
  const total = typeof body?.total === 'number' ? body.total : null

  return {
    items,
    cursor: data.length === 0 || (total !== null && next >= total) ? null : next,
  }
}

// How many further pages are asked for when filtering empties a page
export const MAX_REFILLS = 3

/**
 * A page that filtering (NSFW) left empty although the list goes on is
 * followed by the next, up to `MAX_REFILLS` more requests; then what there is
 * is returned, which may still be empty with a non-null cursor (not the end).
 *
 * @template T
 * @param {(start: number) => Promise<import('../shapes').Page<T>>} fetchPage
 * @param {number} start
 * @returns {Promise<import('../shapes').Page<T>>}
 */
export async function fetchSkippingEmpty(fetchPage, start) {
  let page = await fetchPage(start)

  for (let refill = 0; refill < MAX_REFILLS && page.items.length === 0 && page.cursor !== null; refill++) {
    page = await fetchPage(/** @type {number} */ (page.cursor))
  }

  return page
}
