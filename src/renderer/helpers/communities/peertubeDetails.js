import { peerTubeFailureRecord, videoDetailsFromPeerTubeSummary, videoDetailsRecord } from './details.js'
import { shareVideoKey } from './shares.js'

/**
 * The crawl's PeerTube path: the details of every PeerTube video the shares
 * name that has none, from the platform layer (`getVideoSummary`), kept in
 * the same records as YouTube's (`details.js`), with the same rules for what
 * is done.
 *
 * Most PeerTube videos have their details from the moment they are shared, as
 * confirming a link fetches them (`peertubeLinks.js`); this fills in the rest:
 * shares whose details could not be kept then, shares that came without them
 * (a backup holds shares, not details), and live, upcoming and unavailable
 * videos once their records are stale.
 *
 * Not on the request manager, whose budget is YouTube's (ADR-0020): each
 * request goes to the video's own instance, and few are made, at most
 * `PEERTUBE_DETAILS_AT_ONCE` at a time. Nor is it under the development cap
 * on the crawl, which is there to spare YouTube.
 *
 * Within one start a video is asked at most once; one that failed for a
 * reason that says nothing of it (its instance down, rate limiting) is left
 * missing, for the next start. Started while it runs, it reads what is
 * missing again once it reaches the end.
 *
 * Framework-free and built from what it is given:
 *
 * - `missing()` answers the refs to ask about, in the order to ask
 * - `isDone(key)` says whether a video, by its ref as one string, no longer
 *   needs asking about: another window may have fetched it meanwhile
 * - `request(ref)` answers the layer's summary, or rejects with a
 *   `PlatformError`
 * - `record(records)` keeps records
 * - `enabled()` says whether it may ask at all
 *
 * @param {object} deps
 * @param {() => import('../../platform/shapes').PeerTubeVideoRef[]} deps.missing
 * @param {(key: string) => boolean} deps.isDone
 * @param {(ref: import('../../platform/shapes').PeerTubeVideoRef) => Promise<import('../../platform/shapes').VideoSummary>} deps.request
 * @param {(records: import('./details.js').VideoDetails[]) => Promise<void>} deps.record
 * @param {() => boolean} [deps.enabled]
 * @param {() => number} [deps.now]
 * @param {(message: string, error?: unknown) => void} [deps.onFailure]
 */
export function createPeerTubeDetailsFill({ missing, isDone, request, record, enabled = () => true, now = () => Date.now(), onFailure = () => {} }) {
  /** @type {'idle' | 'running' | 'done'} */
  let state = 'idle'
  let requests = 0

  /** @type {Promise<void> | null} */
  let running = null

  /** Whether it was started again while it ran, so that it reads what is missing again */
  let again = false

  /**
   * @param {import('../../platform/shapes').PeerTubeVideoRef} ref
   */
  async function ask(ref) {
    requests++

    /** @type {import('./details.js').VideoDetails | null} */
    let kept
    try {
      // Kept under the ref asked, the share's, so that the video is done
      kept = videoDetailsRecord(ref, videoDetailsFromPeerTubeSummary(await request(ref)), now())
    } catch (error) {
      kept = peerTubeFailureRecord(ref, error, now())

      if (kept === null) {
        onFailure(`Communities: could not have the details of ${shareVideoKey(ref)}; they are asked for again on the next start`, error)
        return
      }
    }

    try {
      await record([kept])
    } catch (error) {
      onFailure(`Communities: could not keep the details of ${shareVideoKey(ref)}`, error)
    }
  }

  async function run() {
    /** @type {Set<string>} */
    const asked = new Set()

    do {
      again = false
      const order = missing()
      let next = 0

      const work = async () => {
        while (next < order.length) {
          const ref = order[next++]
          const key = shareVideoKey(ref)

          if (asked.has(key) || isDone(key)) { continue }
          if (!enabled()) { return }

          asked.add(key)
          await ask(ref)
        }
      }

      await Promise.all(Array.from({ length: PEERTUBE_DETAILS_AT_ONCE }, work))
    } while (again && enabled())
  }

  /**
   * Start it, unless it is already under way, in which case it reads what is
   * missing again once it reaches the end.
   *
   * @returns {Promise<void>} settled when this run is over
   */
  function start() {
    if (running !== null) {
      again = true
      return running
    }

    if (!enabled()) { return Promise.resolve() }

    state = 'running'
    // Run from the next microtask, so that a start made from inside it finds
    // it under way
    running = Promise.resolve().then(run).catch((error) => {
      onFailure('Communities: filling in the details of PeerTube videos failed', error)
    }).finally(() => {
      running = null
      state = 'done'
    })

    return running
  }

  return Object.freeze({
    start,
    /** @returns {{ state: 'idle' | 'running' | 'done', requests: number }} */
    status: () => ({ state, requests }),
  })
}

/** PeerTube videos asked about at once, each of its own instance */
export const PEERTUBE_DETAILS_AT_ONCE = 2
