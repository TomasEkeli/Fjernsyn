/**
 * Which window runs the Collections crawl: one at a time, so that two windows
 * on Collections do not each ask YouTube about the same videos.
 *
 * The first window to claim it holds it until it gives it back (its crawl is
 * done), or closes, crashes or loads a page again, after which the next
 * window to claim it gets it. A window is watched for those once, the first
 * time it claims; what a window does once it no longer holds the crawl lets
 * go of nothing.
 *
 * @typedef {{ id: number, on: (event: string, listener: () => void) => void, once: (event: string, listener: () => void) => void }} ClaimingContents
 *   a window's web contents, as far as the claim looks at them
 */
export function createCollectionsCrawlClaim() {
  /** @type {number | null} */
  let holder = null

  /** @type {Set<number>} */
  const watched = new Set()

  /** @param {number} id */
  function letGo(id) {
    if (holder === id) { holder = null }
  }

  /**
   * @param {ClaimingContents} contents
   * @returns {boolean} whether this window now holds the crawl
   */
  function claim(contents) {
    if (holder !== null && holder !== contents.id) { return false }

    holder = contents.id

    if (!watched.has(contents.id)) {
      watched.add(contents.id)

      const id = contents.id
      contents.once('destroyed', () => {
        watched.delete(id)
        letGo(id)
      })
      contents.on('render-process-gone', () => letGo(id))
      contents.on('did-navigate', () => letGo(id))
    }

    return true
  }

  /** @param {ClaimingContents} contents */
  function release(contents) {
    letGo(contents.id)
  }

  return Object.freeze({ claim, release, holder: () => holder })
}
