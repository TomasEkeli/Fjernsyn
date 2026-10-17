// What Ctrl+Down and Ctrl+Up move through on the watch page, as youtube.com's
// shorts player moves down and up: the trail of videos moved to, and the
// shorts still ahead.
//
// - The trail is the videos moved through in order, the one played now among
//   them. Up is the one before it; down, after moving up, is the one after it
//   again, so that up then down comes back to the same video.
// - Down from the end of the trail on a short is the next short of YouTube's
//   shorts sequence after it (`listShorts`, the layer's
//   `listShortsSequence`). The first short moved down from is the sequence's
//   seed, and its pages are taken in order, once each, the next asked for
//   before the shorts in hand run out. A short already on the trail or named
//   by an earlier page is not offered again, nor one `skip` passes over (one
//   already watched).
// - Down from the end on a video that is not a short is the watch view's
//   choice (its next recommendation); the view records the move with `step`,
//   so that up comes back. A short reached so, still on the trail, goes on
//   down through the sequence the trail already has, where it has one,
//   rather than seeding another.
// - A video not on the trail starts a new one: opened some other way than
//   down or up, it is where moving begins again, and a short opened so seeds
//   a new sequence. What was ahead of the old trail is dropped with it.
//
// Framework-free: the view holds one for as long as it is mounted, which the
// router keeps across watch routes.

/** How many pages one move down may ask for while every short on them is passed over */
const MAX_PAGES_PER_MOVE = 3

/** How few shorts ahead start the next page being asked for */
const LOW_WATER = 2

/**
 * @typedef {object} ShortsPage
 * @property {{ videoId: string }[]} items
 * @property {unknown} cursor `null` at the sequence's end
 */

/**
 * @param {object} deps
 * @param {(id: string, cursor: unknown) => Promise<ShortsPage>} deps.listShorts
 *   a page of the shorts sequence after the short `id`, the first for a
 *   `null` cursor
 * @param {(id: string) => boolean} [deps.skip] whether a short of the
 *   sequence is passed over, asked as it comes up
 */
export function createSwipeTrail({ listShorts, skip = () => false }) {
  /** @type {string[]} the videos moved through, in order, each once */
  let trail = []
  /** @type {string[]} the sequence's shorts not yet moved to */
  let ahead = []
  /** @type {Set<string>} every id on the trail or named by a page, so that each comes once */
  let named = new Set()
  /** @type {Set<string>} the trail's videos that came from the sequence */
  let fromSequence = new Set()
  /** @type {string | null} the short the sequence was asked after; `null` until its first page is in */
  let seed = null
  /** @type {unknown} */
  let cursor = null
  let ended = false
  /** @type {Promise<void> | null} the page being asked for */
  let asking = null
  /** Tells a trail apart from the one that replaced it, so that a page asked for the old one is dropped */
  let generation = 0

  /** @param {string} id */
  function startAt(id) {
    generation++
    trail = [id]
    ahead = []
    named = new Set([id])
    fromSequence = new Set()
    seed = null
    cursor = null
    ended = false
    asking = null
  }

  /**
   * The video's place on the trail, a new trail started there when it is not on it.
   *
   * @param {string} id
   */
  function placeOf(id) {
    if (!trail.includes(id)) {
      startAt(id)
    }

    return trail.indexOf(id)
  }

  /**
   * The video before `id` on the trail, `null` at its start or off it.
   *
   * @param {string} id
   * @returns {string | null}
   */
  function previous(id) {
    const index = trail.indexOf(id)
    return index > 0 ? trail[index - 1] : null
  }

  /**
   * The video after `id` on the trail, which up moved back from; `null` at
   * its end or off it.
   *
   * @param {string} id
   * @returns {string | null}
   */
  function following(id) {
    const index = trail.indexOf(id)
    return index !== -1 && index < trail.length - 1 ? trail[index + 1] : null
  }

  /**
   * Whether the video came to the trail from the shorts sequence, and so is a
   * short whether or not its details have said so yet.
   *
   * @param {string} id
   */
  function isFromSequence(id) {
    return fromSequence.has(id)
  }

  /**
   * Whether the sequence has said it has no more: a move down that found
   * nothing found nothing for good, rather than only shorts passed over.
   */
  function hasEnded() {
    return ended
  }

  /**
   * Takes a short of the sequence off the trail, never to be offered again:
   * one the view will not show after all, which it then moves past from the
   * video before.
   *
   * @param {string} id
   */
  function forget(id) {
    trail = trail.filter(onTrail => onTrail !== id)
    fromSequence.delete(id)
  }

  /**
   * Records a move down that was not to the sequence's next short: from
   * `fromId`, whatever was after it on the trail replaced by `toId`.
   *
   * @param {string} fromId
   * @param {string} toId
   */
  function step(fromId, toId) {
    const index = placeOf(fromId)
    trail = [...trail.slice(0, index + 1).filter(id => id !== toId), toId]
    named.add(toId)
  }

  /**
   * Asks for the sequence's next page, after `fromId` when it has none yet.
   * One at a time: a second call while one is out waits for that one.
   *
   * @param {string} fromId
   */
  function askForMore(fromId) {
    if (asking !== null) {
      return asking
    }

    const askedIn = generation
    const after = seed ?? fromId

    const request = (async () => {
      try {
        const page = await listShorts(after, seed === null ? null : cursor)

        if (askedIn !== generation) {
          return
        }

        seed = after

        for (const { videoId } of page.items) {
          if (!named.has(videoId)) {
            named.add(videoId)
            ahead.push(videoId)
          }
        }

        cursor = page.cursor ?? null
        ended = cursor === null
      } finally {
        if (askedIn === generation) {
          asking = null
        }
      }
    })()

    asking = request
    return request
  }

  /**
   * The next short ahead that is not passed over, taken off the shorts ahead;
   * `null` when none is.
   *
   * @returns {string | null}
   */
  function takeAhead() {
    while (ahead.length > 0) {
      const id = /** @type {string} */ (ahead.shift())

      if (!trail.includes(id) && !skip(id)) {
        return id
      }
    }

    return null
  }

  /**
   * Where down goes from the short `fromId`: the trail's next video where up
   * moved back from one, else the sequence's next short, which joins the
   * trail. `null` when the sequence has nothing more to offer. Rejects as
   * `listShorts` does when a page it waited for failed; a page asked for
   * ahead of need that nothing waits for fails quietly, and is asked for
   * again when needed.
   *
   * @param {string} fromId
   * @returns {Promise<string | null>}
   */
  async function nextShort(fromId) {
    placeOf(fromId)
    const movedIn = generation
    let pagesAsked = 0

    while (true) {
      // Again after every page: another move may have gone on meanwhile
      const again = following(fromId)

      if (again !== null) {
        return again
      }

      if (movedIn !== generation || !trail.includes(fromId)) {
        return null
      }

      const id = takeAhead()

      if (id !== null) {
        trail.push(id)
        fromSequence.add(id)

        if (ahead.length <= LOW_WATER && !ended && seed !== null) {
          askForMore(fromId).catch(() => {})
        }

        return id
      }

      if (ended || pagesAsked >= MAX_PAGES_PER_MOVE) {
        return null
      }

      pagesAsked++
      await askForMore(fromId)
    }
  }

  return Object.freeze({ previous, following, isFromSequence, hasEnded, forget, step, nextShort })
}
