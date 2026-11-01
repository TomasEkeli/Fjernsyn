import { loginRequiredRecord, unavailableRecord, videoDetailsFromPlayerResponse, videoDetailsRecord } from './details'

/**
 * The crawl: every collection video's own details, fetched once, in the
 * background, and kept.
 *
 * On a new installation that is all of HackerTube, some six and a half
 * thousand videos, one plain `/player` request each. It starts the first time
 * Collections is opened and carries on while the app runs, whichever page is
 * shown, through the request manager's enrichment lane (ADR-0020).
 *
 * Progress is the datastore: a video with a record is done (`needsDetails`
 * in `details.js` names the exceptions), so a crawl stopped by quitting, by a
 * profile switch cancelling the lane, or by a pause after failures, resumes
 * from what is missing the next time it is started. Within one start, a
 * video is asked about at most once; one that failed is left missing, for the
 * next start.
 *
 * It never holds more than a couple of jobs on the lane, queued or running,
 * and adds the next only when one is done. A job joins the lane at its back
 * and is never moved forward, so the AI lookups (which move themselves to the
 * front) and the subscription back-fill (whatever it queued meanwhile) always
 * go first: the crawl only ever takes the turns nothing else wants.
 *
 * A video YouTube says is not there is recorded as gone. One that asks to sign
 * in may be private, or the request may have met a bot check: it is recorded
 * as a suspect (`loginRequiredRecord`), which only answers on several starts
 * far apart turn into private, and counted as a failure. A few failures in a
 * row pause the crawl for a while, as they do the AI lookups.
 *
 * Framework-free and built from what it is given, so that the rules are
 * tested without a network, a store or a request manager:
 *
 * - `missing()` answers the YouTube video ids to ask about, in the order to
 *   ask for them
 * - `isDone(videoId)` says whether one is no longer to be asked about:
 *   another window may have fetched it meanwhile
 * - `recordFor(videoId)` answers the record kept for it, if any
 * - `request(videoId)` answers the raw `/player` response, or throws
 * - `record(records)` keeps records (`details.js`)
 * - `schedule({ key, run, dropped })` queues `run` at the back of the lane,
 *   and calls `dropped` instead if it is taken out first; answers false when
 *   the lane would not take it
 * - `unschedule(keys)` takes queued jobs back out, calling their `dropped`
 * - `limit` is the most requests the crawl may make while the app runs, or
 *   null for no limit: a development run's cap (`crawlLimit.js`)
 * - `delayMs`, a development run's wait: when set, only one job is on the
 *   lane at a time, and the next is queued that many ms after it finishes
 *   (`crawlLimit.js`); null for none
 * - `enabled()` says whether it may ask at all, on this backend
 *
 * @param {object} deps
 * @param {() => string[]} deps.missing
 * @param {(videoId: string) => boolean} deps.isDone
 * @param {(videoId: string) => import('./details').VideoDetails | undefined} deps.recordFor
 * @param {(videoId: string) => Promise<any>} deps.request
 * @param {(records: import('./details').VideoDetails[]) => Promise<void>} deps.record
 * @param {(job: { key: string, run: () => Promise<void>, dropped: () => void }) => boolean} deps.schedule
 * @param {(keys: string[]) => void} deps.unschedule
 * @param {number | null} [deps.limit]
 * @param {number | null} [deps.delayMs]
 * @param {() => boolean} [deps.enabled]
 * @param {() => number} [deps.now]
 * @param {(fn: () => void, ms: number) => void} [deps.setTimer]
 * @param {(status: CrawlStatus) => void} [deps.onChange]
 * @param {(message: string, error?: unknown) => void} [deps.onFailure]
 */
export function createCollectionsCrawl({
  missing,
  isDone,
  recordFor,
  request,
  record,
  schedule,
  unschedule,
  limit = null,
  delayMs = null,
  enabled = () => true,
  now = () => Date.now(),
  setTimer = (fn, ms) => { setTimeout(fn, ms) },
  onChange = () => {},
  onFailure = () => {},
}) {
  /**
   * @typedef {object} Run one start of the crawl, until it is done, stopped
   *   or limited
   * @property {number} id
   * @property {'running' | 'paused'} state
   * @property {string[]} order
   * @property {number} cursor
   * @property {boolean} refreshed whether the order has been read again since
   *   it was last used up
   * @property {Set<string>} asked
   * @property {Map<string, { running: boolean }>} pending queued or running
   */

  /** @type {Run | null} */
  let run = null
  let runs = 0

  /** @type {CrawlStatus['state']} */
  let state = 'idle'

  /** Requests made while the app runs, across every start, for the limit */
  let requests = 0
  let failuresInARow = 0

  function status() {
    return { state, requests }
  }

  /** @param {CrawlStatus['state']} next */
  function setState(next) {
    state = next
    onChange(status())
  }

  /** Its jobs on the lane at once: one while a development delay is set */
  const atOnce = delayMs === null ? CRAWL_QUEUED_AT_ONCE : 1

  /** @param {Run} current */
  function limitReached(current) {
    return limit !== null && requests + current.pending.size >= limit
  }

  /**
   * The next video to ask about, or null when there is none: the order is
   * read again once when it is used up, to take in videos that arrived
   * while it ran.
   *
   * @param {Run} current
   * @returns {string | null}
   */
  function nextCandidate(current) {
    while (true) {
      if (current.cursor >= current.order.length) {
        if (current.refreshed) { return null }

        current.order = missing()
        current.cursor = 0
        current.refreshed = true
        continue
      }

      const videoId = current.order[current.cursor++]

      if (current.asked.has(videoId) || current.pending.has(videoId) || isDone(videoId)) { continue }

      current.refreshed = false
      return videoId
    }
  }

  /** @param {Run} current */
  function fill(current) {
    if (run !== current || current.state !== 'running') { return }

    while (current.pending.size < atOnce && !limitReached(current)) {
      const videoId = nextCandidate(current)

      if (videoId === null) { break }

      current.pending.set(videoId, { running: false })

      const added = schedule({
        key: CRAWL_KEY_PREFIX + videoId,
        run: () => ask(current, videoId),
        dropped: () => dropped(current, videoId),
      })

      // Stopped while it was being scheduled
      if (run !== current) { return }

      if (!added) {
        // Not taken, which nothing should cause: passed over this start
        current.pending.delete(videoId)
        current.asked.add(videoId)
      }
    }

    if (current.pending.size === 0) {
      run = null
      setState(limit !== null && requests >= limit ? 'limited' : 'done')
    }
  }

  /**
   * @param {Run} current
   * @param {string} videoId
   */
  function dropped(current, videoId) {
    current.pending.delete(videoId)

    // Taken out by its own pause, it is asked about once the pause is over;
    // taken out by anything else, the lane was cancelled: stop, until the
    // next start
    if (run === current && current.state === 'running') {
      run = null
      setState('stopped')
    }
  }

  /**
   * @param {Run} current
   * @param {unknown} error
   */
  function failed(current, error) {
    failuresInARow++

    if (failuresInARow < CRAWL_FAILURES_BEFORE_PAUSE) { return }

    failuresInARow = 0
    onFailure(`Collections: fetching video details failed ${CRAWL_FAILURES_BEFORE_PAUSE} times in a row; pausing for ${CRAWL_PAUSE_MS / 60000} minutes`, error)

    if (run !== current || current.state !== 'running') { return }

    current.state = 'paused'
    setState('paused')

    const queued = [...current.pending].filter(([, job]) => !job.running).map(([videoId]) => CRAWL_KEY_PREFIX + videoId)
    unschedule(queued)

    setTimer(() => {
      if (run !== current || current.state !== 'paused') { return }

      current.state = 'running'
      // From the top, so that what the pause took off the lane comes next
      current.cursor = 0
      setState('running')
      fill(current)
    }, CRAWL_PAUSE_MS)
  }

  /**
   * @param {Run} current
   * @param {string} videoId
   */
  async function ask(current, videoId) {
    const job = current.pending.get(videoId)

    try {
      if (job === undefined || run !== current || current.state !== 'running') { return }
      if (isDone(videoId)) { return }
      // Never more than the limit, whatever was queued
      if (limit !== null && requests >= limit) { return }

      if (!enabled()) {
        run = null
        setState('stopped')
        return
      }

      job.running = true
      current.asked.add(videoId)
      requests++
      onChange(status())

      try {
        const answer = videoDetailsFromPlayerResponse(await request(videoId), videoId)
        const at = now()

        if (answer.kind === 'login-required') {
          await record([loginRequiredRecord({ videoId }, recordFor(videoId), at)])
          onFailure(`Collections: ${videoId} asks to sign in; private, or refused`)
          failed(current, null)
          return
        }

        await record([answer.kind === 'gone'
          ? unavailableRecord({ videoId }, 'gone', at)
          : videoDetailsRecord({ videoId }, answer.details, at)])
        failuresInARow = 0
      } catch (error) {
        onFailure(`Collections: fetching the details of ${videoId} failed; it is asked again on the next start`, error)
        failed(current, error)
      }
    } finally {
      current.pending.delete(videoId)

      if (delayMs === null) {
        fill(current)
      } else {
        setTimer(() => fill(current), delayMs)
      }
    }
  }

  /**
   * Start the crawl, unless it is already under way, or has made as many
   * requests as it may. Started while it runs, it reads what is missing again
   * once it reaches the end, to take in what arrived meanwhile.
   */
  function start() {
    if (run !== null) {
      run.refreshed = false
      return
    }

    if (!enabled()) { return }

    if (limit !== null && requests >= limit) {
      setState('limited')
      return
    }

    run = {
      id: ++runs,
      state: 'running',
      order: missing(),
      cursor: 0,
      refreshed: true,
      asked: new Set(),
      pending: new Map(),
    }

    setState('running')
    fill(run)
  }

  return Object.freeze({ start, status })
}

/**
 * @typedef {object} CrawlStatus
 * @property {'idle' | 'running' | 'paused' | 'done' | 'stopped' | 'limited'} state
 *   idle before the first start; running, or paused after failures, while a
 *   start is under way; then done when nothing was left to ask about, stopped
 *   when the lane was cancelled or the backend changed, limited when the
 *   development cap ran out
 * @property {number} requests made while the app runs
 */

/** Keeps the crawl's jobs apart from the AI lookups' and the back-fill's, on the same lane */
export const CRAWL_KEY_PREFIX = 'collection-details-'

/** The crawl's jobs on the lane at once, queued or running: the lane's width */
export const CRAWL_QUEUED_AT_ONCE = 2

/**
 * Failures in a row after which the crawl pauses: YouTube refusing one video
 * is likely refusing the next, and asking on regardless is the way to be
 * refused for longer and to poison the watch page that PO token minting needs
 */
export const CRAWL_FAILURES_BEFORE_PAUSE = 3

/** How long the crawl pauses for, after that many failures in a row */
export const CRAWL_PAUSE_MS = 5 * 60 * 1000
