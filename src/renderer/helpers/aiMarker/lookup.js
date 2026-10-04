import { isYouTubeVideoRef, platformOf, PLATFORM_YOUTUBE } from '../../platform/refs'
import { readAiLabel } from './label'

/**
 * Failures in a row after which lookups pause: YouTube refusing one video is
 * likely refusing the next, and asking on regardless, two a second while the
 * reader scrolls, is the way to be refused for longer and to poison the watch
 * page that PO token minting needs.
 */
export const FAILURES_BEFORE_PAUSE = 3

/** How long lookups pause for, after that many failures in a row */
export const PAUSE_MS = 5 * 60 * 1000

/**
 * Finding out whether YouTube labels a video "Made with AI", one video at a
 * time.
 *
 * No list YouTube sends says so, in any client: search results, a channel's
 * videos, the RSS feed and the related videos carry nothing about it. Only a
 * video's own `/next` does. So a video is asked about when a tile for it
 * mounts on a wall that opted in, and the answer, its verdict, is kept for
 * good, so that it is asked about once, ever.
 *
 * Framework-free and built from what it is given, so that the rules are
 * tested without a network, a store or a request manager:
 *
 * - `request(videoId)` answers the raw `/next` response, or throws
 * - `verdicts` is where verdicts are kept: `get(videoId)` answers `'ai'`,
 *   `'not-ai'` or `undefined`, and `set(videoId, verdict)` keeps one
 * - `schedule({ key, run, dropped })` queues `run` to be called in its turn,
 *   and calls `dropped` instead if it is taken out of the queue first
 * - `unschedule(key)` takes a queued lookup back out, calling its `dropped`
 * - `isChannelMarked(channelId)` says whether the user marked a channel as AI
 * - `enabled()` says whether lookups may be made at all, on this backend
 *
 * A video is never looked up when it already has a verdict, when a lookup for
 * it is already queued or running, when it is not a YouTube video, or when its
 * channel is marked. A lookup is taken back out of the queue when its last
 * tile goes, and one whose tiles have all gone by its turn makes no request.
 * A failed lookup keeps nothing, so the next tile for that video asks again,
 * and so does an answer the label cannot be read from. A few failures in a
 * row pause lookups for a while.
 *
 * @param {object} deps
 * @param {(videoId: string) => Promise<any>} deps.request
 * @param {{ get: (videoId: string) => ('ai' | 'not-ai' | undefined), set: (videoId: string, verdict: 'ai' | 'not-ai') => void }} deps.verdicts
 * @param {(job: { key: string, run: () => Promise<void>, dropped: () => void }) => void} deps.schedule
 * @param {(key: string) => void} [deps.unschedule]
 * @param {(channelId: string) => boolean} deps.isChannelMarked
 * @param {() => boolean} [deps.enabled]
 * @param {(message: string, error: unknown) => void} [deps.onFailure]
 * @param {() => number} [deps.now]
 */
export function createAiLookup({
  request,
  verdicts,
  schedule,
  unschedule = () => {},
  isChannelMarked,
  enabled = () => true,
  onFailure = () => {},
  now = () => Date.now(),
}) {
  /**
   * How many tiles want each video's answer right now. A tile that unmounts
   * stops wanting it; a lookup nobody wants is taken out of the queue.
   * @type {Map<string, number>}
   */
  const wanted = new Map()

  /**
   * Videos with a lookup queued or running.
   * @type {Set<string>}
   */
  const pending = new Set()

  /**
   * Videos whose lookup is running, which cannot be taken back.
   * @type {Set<string>}
   */
  const running = new Set()

  let failuresInARow = 0
  let pausedUntil = 0

  function paused() {
    return now() < pausedUntil
  }

  /**
   * @param {any} video
   * @returns {string | null} the YouTube video id, or null for anything else
   */
  function youtubeId(video) {
    if (platformOf(video) !== PLATFORM_YOUTUBE) { return null }

    return isYouTubeVideoRef(video?.videoId) ? video.videoId : null
  }

  /**
   * @param {any} video
   * @returns {boolean}
   */
  function channelIsMarked(video) {
    return typeof video?.authorId === 'string' && isChannelMarked(video.authorId)
  }

  /**
   * What is known about a video: its verdict, or `undefined` while it has
   * none, which is every video that is not YouTube's.
   *
   * @param {any} video
   * @returns {'ai' | 'not-ai' | undefined}
   */
  function verdictOf(video) {
    const id = youtubeId(video)

    return id === null ? undefined : verdicts.get(id)
  }

  /** @param {string} id */
  function release(id) {
    const count = (wanted.get(id) ?? 0) - 1

    if (count > 0) {
      wanted.set(id, count)
      return
    }

    wanted.delete(id)

    // Nobody is waiting for it now: out of the queue, so it does not spend a
    // turn ahead of lookups somebody is waiting for
    if (pending.has(id) && !running.has(id)) {
      unschedule(id)
    }
  }

  /**
   * @param {string} id
   * @param {unknown} error
   */
  function failed(id, error) {
    failuresInARow++

    if (failuresInARow >= FAILURES_BEFORE_PAUSE) {
      failuresInARow = 0
      pausedUntil = now() + PAUSE_MS
      onFailure(`AI label lookups failed ${FAILURES_BEFORE_PAUSE} times in a row; pausing them for ${PAUSE_MS / 60000} minutes`, error)
    } else {
      onFailure(`AI label lookup for ${id} failed; it will be asked again`, error)
    }
  }

  /**
   * @param {string} id
   * @param {string | null} channelId
   */
  async function run(id, channelId) {
    running.add(id)

    try {
      // Gone from every wall, known by now (opening the video records it),
      // its channel marked since it was queued, or lookups paused: there is
      // nothing to ask
      if (!wanted.has(id) || verdicts.get(id) !== undefined || paused()) { return }
      if (channelId !== null && isChannelMarked(channelId)) { return }

      const verdict = readAiLabel(await request(id))

      if (verdict === null) {
        throw new Error('the answer has no description to read the label from')
      }

      failuresInARow = 0
      verdicts.set(id, verdict)
    } catch (error) {
      failed(id, error)
    } finally {
      running.delete(id)
      pending.delete(id)
    }
  }

  /**
   * Ask for a video's verdict, on behalf of a tile showing it. Answers the
   * function the tile calls when it goes, which is safe to call more than
   * once.
   *
   * @param {any} video
   * @returns {() => void}
   */
  function want(video) {
    const id = youtubeId(video)

    if (id === null || verdicts.get(id) !== undefined || channelIsMarked(video) || !enabled() || paused()) {
      return () => {}
    }

    wanted.set(id, (wanted.get(id) ?? 0) + 1)

    if (!pending.has(id)) {
      pending.add(id)

      const channelId = typeof video.authorId === 'string' ? video.authorId : null

      schedule({
        key: id,
        run: () => run(id, channelId),
        dropped: () => { pending.delete(id) },
      })
    }

    let released = false

    return () => {
      if (released) { return }

      released = true
      release(id)
    }
  }

  return Object.freeze({ verdictOf, want })
}
