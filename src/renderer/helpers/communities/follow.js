/**
 * Following a source by a URL someone pasted: which source it names, and
 * whether it can be followed, which only asking it can tell.
 *
 * Each source kind is offered the URL in turn (`kinds/index.js`,
 * `recogniseSource`), and the first that recognises it makes the source.
 * The source is then asked once, as a refresh would ask it, before anything
 * is kept: a Lemmy instance that serves no feed (slrpnk.net answers 404) or
 * answers with something that is not one cannot be followed yet, and an
 * instance that cannot be reached at all may only be down. What the trial
 * fetched is answered with the source, so that following it keeps that at
 * once rather than asking again.
 *
 * A kind whose videos come with the app (`shipped`, HackerTube) is followed
 * without a trial: the first open of Communities loads them.
 *
 * Framework-free: the store hands it what it needs (`store/modules/communities.js`).
 */

import { SOURCE_KINDS_BY_KIND, recogniseSource } from './kinds/index.js'

/** @import { Source } from './shares.js' */
/** @import { SourceFetch } from './kinds/index.js' */

/**
 * @typedef {{ outcome: 'unrecognised' }
 *   | { outcome: 'followed-already', source: Source }
 *   | { outcome: 'no-feed', source: Source }
 *   | { outcome: 'unreachable', source: Source }
 *   | { outcome: 'followable', source: Source, fetched: SourceFetch | null }} SourceTrial
 *
 * `no-feed`: the source answered, with an error or with something that is not
 * a feed its kind can read; `unreachable`: no answer came at all.
 * `fetched` is null for a kind that is followed without a trial.
 */

/**
 * Which source a pasted URL names, and whether it can be followed.
 *
 * @param {string} text what was pasted
 * @param {object} deps
 * @param {number} deps.now when it would be followed
 * @param {typeof fetch} deps.fetch what the trial asks through
 * @param {(sourceId: string) => boolean} deps.isFollowed
 * @returns {Promise<SourceTrial>}
 */
export async function trySource(text, { now, fetch: fetchFn, isFollowed }) {
  const source = typeof text === 'string' ? recogniseSource(text.trim(), now) : null

  if (source === null) {
    return { outcome: 'unrecognised' }
  }

  if (isFollowed(source._id)) {
    return { outcome: 'followed-already', source }
  }

  const kind = SOURCE_KINDS_BY_KIND[source.kind]

  if (kind.shipped === true) {
    return { outcome: 'followable', source, fetched: null }
  }

  // Whether any request got no answer at all, which is the network's fault
  // or the server's absence, rather than a server saying no
  let unanswered = false

  /** @type {typeof fetch} */
  const watched = async (...args) => {
    try {
      return await fetchFn(...args)
    } catch (error) {
      unanswered = true
      throw error
    }
  }

  try {
    // No PeerTube link is confirmed here: that may take as long as the
    // instances linked take to answer, and the next refresh does it
    const fetched = await kind.fetch(source, { fetch: watched })
    return { outcome: 'followable', source, fetched }
  } catch (error) {
    console.warn(`Communities: could not follow ${source._id}`, error)
    return { outcome: unanswered ? 'unreachable' : 'no-feed', source }
  }
}
