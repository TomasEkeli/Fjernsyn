import { reactive, readonly } from 'vue'

/**
 * One manager for every subscription request.
 *
 * Refreshing a feed, recovering the channels a refresh could not reach and
 * filling in the details RSS leaves out are three different jobs that all talk
 * to the same host, and they must not decide independently how hard to push it:
 * three polite trickles are one burst, which is the thing being avoided. So
 * there is one manager, one shared budget, and lanes served in priority order.
 *
 * The budget is a sliding window: at most `SUBSCRIPTION_BUDGET` requests may
 * start in any `SUBSCRIPTION_BUDGET_WINDOW_MS`, and at most that many may be in
 * flight at once. That is deliberately the same traffic shape as the batching it
 * replaces — fifty channels, then a two second pause — with the difference that
 * it composes: three feeds refreshing at once and the back-fill running
 * underneath them cannot together exceed what one feed used to do alone.
 *
 * Lanes each have a width, which is how much of the budget they may occupy at
 * once, and a minimum gap between their own requests. Refresh may take the whole
 * budget; recovery stays at one request at a time because it only runs when
 * something has already refused us; enrichment keeps a narrow width so it fills
 * the slack a refresh leaves rather than competing with it.
 *
 * It has outgrown the name. Any background request to YouTube that the reader
 * did not ask for one by one goes through the same budget, so that it adds up
 * with the subscription work instead of on top of it: the AI label lookups for
 * the tiles on a wall ride the enrichment lane (helpers/aiMarker, ADR-0020).
 *
 * The queues hold closures, so they stay out of the store; only the progress the
 * interface needs is reactive. It all lives at module scope rather than in a
 * component so that switching tabs, or navigating away entirely, does not
 * abandon work that takes minutes to finish.
 */

/** Fetching a feed because someone, or the clock, asked for it. Served first. */
export const LANE_REFRESH = 'refresh'

/** Recovering channels a refresh could not reach. */
export const LANE_RECOVERY = 'recovery'

/** Filling in details RSS does not carry. Served with whatever is left. */
export const LANE_ENRICHMENT = 'enrichment'

/** Priority order. Positional: earlier lanes are offered the budget first. */
const LANES = [LANE_REFRESH, LANE_RECOVERY, LANE_ENRICHMENT]

/** The window the budget is counted over. */
export const SUBSCRIPTION_BUDGET_WINDOW_MS = 2000

/**
 * Requests allowed to start per window, and to be in flight at once.
 *
 * Measured, not guessed, twice. The original measurement said 100 at a time
 * failed every request within 300ms and took the renderer down; that failure
 * was the devcontainer running out of memory, not YouTube. Re-measured
 * 2026-08-14 with the confound mitigated: 50, 75 and 100 each fetched a full
 * three-feed cycle of 1833 channel requests with zero failures, scaling almost
 * exactly linearly (75s, 50s and 37s wall).
 *
 * 75 rather than 100 because each higher width has survived exactly one cycle,
 * and this is the path that must keep working when things are already going
 * wrong: a YouTube rate limit, once earned, also poisons the watch page that
 * the poToken challenge is scraped from. 75 takes most of the speedup and
 * keeps a margin below the tested ceiling. `FT_SUBS_BUDGET` overrides this
 * for measuring. Change the default only with evidence.
 * Traces: thoughts/logs/2026-08-14-subs-budget-{75,100}.log.
 */
export const SUBSCRIPTION_BUDGET_DEFAULT = 75

/**
 * How much of the budget each lane may occupy at once.
 *
 * Refresh is the thing being waited for, so it may have the lot. Recovery is one
 * at a time by design. Enrichment is held to a couple so that a refresh running
 * beside it still gets nearly the whole budget, while a back-fill on its own
 * still goes at a useful rate.
 */
export const LANE_WIDTHS = {
  refresh: Number.POSITIVE_INFINITY,
  recovery: 1,
  enrichment: 2
}

/**
 * The minimum gap between two requests of the same lane.
 *
 * Recovery is deliberately the slowest. It only runs because something has
 * already refused us, so it is the worst possible moment to be quick, and by the
 * time it is going one channel at a time that is the last thing left to try.
 *
 * The back-fill is asking an API that is answering perfectly well, so it can be
 * brisker. Even so the gap is not what makes it slow: a channel takes about four
 * seconds, of which this is half, the rest being two requests because a fresh
 * Innertube session is created per call.
 *
 * Refresh has no gap of its own: the budget is its pacing.
 */
export const LANE_DELAYS_MS = {
  refresh: 0,
  recovery: 1500,
  enrichment: 500
}

/**
 * @typedef {object} WorkerJob
 * @property {string} key deduplication key, usually feed + channel id
 * @property {string} [label] shown to the user while it runs
 * @property {number} [weight] how many requests this job makes at once, if it is
 *   not the usual one. The recovery asks for a whole group of channels in one
 *   job, on purpose — the size of the group is the thing it is escalating down —
 *   and a budget that counted that as one request would be counting a
 *   twenty-five channel burst as politeness.
 * @property {() => Promise<void>} run
 * @property {() => void} [dropped] called instead of `run` when the job is
 *   cancelled before its turn, for a caller that keeps its own note of what
 *   it has queued and would otherwise never hear that it will not run
 */

/** @type {Record<string, WorkerJob[]>} */
const queues = {
  [LANE_REFRESH]: [],
  [LANE_RECOVERY]: [],
  [LANE_ENRICHMENT]: []
}

/**
 * Keys currently queued or running, so the same channel is not fetched twice
 * because it appeared in two batches.
 * @type {Record<string, Set<string>>}
 */
const claimed = {
  [LANE_REFRESH]: new Set(),
  [LANE_RECOVERY]: new Set(),
  [LANE_ENRICHMENT]: new Set()
}

/** @returns {Record<string, { done: number, queued: number, inFlight: number }>} */
function emptyLaneCounters() {
  return {
    [LANE_REFRESH]: { done: 0, queued: 0, inFlight: 0 },
    [LANE_RECOVERY]: { done: 0, queued: 0, inFlight: 0 },
    [LANE_ENRICHMENT]: { done: 0, queued: 0, inFlight: 0 }
  }
}

const progress = reactive({
  /** @type {'idle' | 'refresh' | 'recovery' | 'enrichment'} */
  lane: 'idle',
  /** Jobs finished since the current run began, across all lanes. */
  done: 0,
  /** Jobs still queued, across all lanes. */
  queued: 0,
  /** Requests in flight, across all lanes. */
  inFlight: 0,
  /** @type {string | null} */
  label: null,
  /** The same three counts, per lane, for callers that care about only one. */
  lanes: emptyLaneCounters()
})

/** Progress for the interface to read. Mutated only in here. */
export const subscriptionWorkerProgress = readonly(progress)

let pumping = false
let cancelledLanes = new Set()

/**
 * Incremented for every pump. A pump only clears the shared progress if it is
 * still the current one, so a loop that has been abandoned cannot report itself
 * idle over the top of the run that replaced it.
 */
let generation = 0

/** When each lane last started a request, for the per-lane gap. */
let lastStartedAt = { [LANE_REFRESH]: 0, [LANE_RECOVERY]: 0, [LANE_ENRICHMENT]: 0 }

/**
 * Starts inside the current budget window, oldest first, with what each cost.
 * @type {{ at: number, weight: number }[]}
 */
let recentStarts = []

/** Requests in flight, counting a job that makes several as several. */
let weightInFlight = 0

/** The highest number of requests in flight at once since it was last read. */
let peakInFlight = 0

/** Resolves when anything happens that might allow another job to start. */
let wake = null

/** Overridden so tests do not have to wait in real time. */
let delayOverrideMs = null

let budgetOverride = null
let windowOverride = null

/** @param {number} ms */
export function setSubscriptionWorkerDelayForTests(ms) {
  delayOverrideMs = ms
}

/**
 * @param {number} budget
 * @param {number} [windowMs]
 */
export function setSubscriptionBudgetForTests(budget, windowMs) {
  budgetOverride = budget
  windowOverride = windowMs ?? null
}

/**
 * The budget in force. Read through a function rather than frozen at import so
 * that the test seam and the environment override both work.
 */
export function subscriptionBudget() {
  if (budgetOverride != null) { return budgetOverride }

  const configured = Number.parseInt(process.env.FT_SUBS_BUDGET ?? '', 10)

  return Number.isFinite(configured) && configured > 0 ? configured : SUBSCRIPTION_BUDGET_DEFAULT
}

function budgetWindowMs() {
  return windowOverride ?? SUBSCRIPTION_BUDGET_WINDOW_MS
}

/** @param {string} lane */
function delayForLane(lane) {
  if (delayOverrideMs != null) {
    // Refresh is paced by the budget alone, and a test that shortens the lane
    // gaps is not asking for it to acquire one
    return LANE_DELAYS_MS[lane] === 0 ? 0 : delayOverrideMs
  }

  return LANE_DELAYS_MS[lane] ?? LANE_DELAYS_MS[LANE_RECOVERY]
}

/** @param {string} lane */
function widthForLane(lane) {
  return Math.min(LANE_WIDTHS[lane] ?? 1, subscriptionBudget())
}

function syncCounts() {
  let queued = 0
  let inFlight = 0
  let done = 0

  for (const lane of LANES) {
    progress.lanes[lane].queued = queues[lane].length

    queued += queues[lane].length
    inFlight += progress.lanes[lane].inFlight
    done += progress.lanes[lane].done
  }

  progress.queued = queued
  progress.inFlight = inFlight
  progress.done = done
}

/** Wake the pump: something happened that might let another job start. */
function signal() {
  if (wake != null) {
    const resolve = wake
    wake = null
    resolve()
  }
}

/**
 * Add jobs to a lane. Jobs whose key is already queued or running are dropped,
 * so callers can re-offer the visible feed without worrying about duplicates.
 *
 * @param {string} lane
 * @param {WorkerJob[]} jobs
 */
export function enqueueSubscriptionJobs(lane, jobs) {
  // Offering work to a lane means we are no longer cancelling it
  cancelledLanes.delete(lane)

  let added = 0

  for (const job of jobs) {
    if (claimed[lane].has(job.key)) { continue }

    claimed[lane].add(job.key)
    queues[lane].push(job)
    added++
  }

  syncCounts()

  if (added > 0) {
    // Deliberately not awaited: callers enqueue and carry on
    pump()
    signal()
  }

  return added
}

/**
 * Queue one job and resolve once it has run, so a caller can sequence work
 * across the queue without holding it open. A job dropped as a duplicate
 * resolves immediately: the work is already accounted for either way, and a
 * caller waiting forever on a job that will never run would be worse.
 *
 * @param {string} lane
 * @param {WorkerJob} job
 * @returns {Promise<void>}
 */
export function enqueueSubscriptionJob(lane, job) {
  return new Promise((resolve) => {
    const added = enqueueSubscriptionJobs(lane, [{
      ...job,
      run: async () => {
        try {
          await job.run()
        } finally {
          resolve()
        }
      },
      // Cancelled before its turn: it will not run, and waiting on it would
      // be waiting forever
      dropped: () => {
        try {
          job.dropped?.()
        } finally {
          resolve()
        }
      }
    }])

    if (added === 0) { resolve() }
  })
}

/**
 * Move jobs already queued to the front of their lane, in the order given.
 *
 * The back-fill queues a channel as soon as a refresh finds it short of
 * details, which is long before anyone looks at it, so by the time someone does
 * the channel they are reading is somewhere in a queue of six hundred. This is
 * how the part of the feed on screen gets served first without being fetched
 * twice: it is the same job, moved.
 *
 * @param {string} lane
 * @param {string[]} keys
 * @returns {number} how many were found and moved
 */
export function promoteSubscriptionJobs(lane, keys) {
  if (keys.length === 0) { return 0 }

  const wanted = new Map(keys.map((key, index) => [key, index]))
  const promoted = queues[lane].filter(job => wanted.has(job.key))

  if (promoted.length === 0) { return 0 }

  promoted.sort((a, b) => wanted.get(a.key) - wanted.get(b.key))

  queues[lane] = promoted.concat(queues[lane].filter(job => !wanted.has(job.key)))

  return promoted.length
}

/**
 * Drop everything queued for a lane. Jobs already in flight are allowed to
 * finish, since there is nothing to abort a request with here and their results
 * are still worth having.
 *
 * @param {string} lane
 */
export function cancelSubscriptionLane(lane) {
  cancelledLanes.add(lane)

  const dropped = queues[lane]

  for (const job of dropped) {
    claimed[lane].delete(job.key)
  }

  queues[lane] = []
  syncCounts()
  signal()

  for (const job of dropped) {
    try {
      job.dropped?.()
    } catch (error) {
      console.error(error)
    }
  }
}

export function cancelAllSubscriptionWork() {
  for (const lane of LANES) {
    cancelSubscriptionLane(lane)
  }
}

function queuedCount() {
  return LANES.reduce((total, lane) => total + queues[lane].length, 0)
}

/** @param {WorkerJob} job */
function jobWeight(job) {
  return Math.max(1, job.weight ?? 1)
}

/** @param {number} now */
function pruneRecentStarts(now) {
  const cutoff = now - budgetWindowMs()

  while (recentStarts.length > 0 && recentStarts[0].at <= cutoff) {
    recentStarts.shift()
  }
}

function startedWeightInWindow() {
  return recentStarts.reduce((total, start) => total + start.weight, 0)
}

/**
 * How much of the budget to hold back from this lane for the lanes below it.
 *
 * Without this the refresh lane, which may take the whole budget, would starve
 * the back-fill for the entire length of a refresh — and running the back-fill
 * during the refresh, in the slack it leaves, is the point of putting them on
 * one manager. Only lanes with work waiting reserve anything, and only as much
 * as they are not already using, so the reservation costs nothing when there is
 * nothing under way beneath.
 *
 * Counted in requests, using each lane's width, which is exact for the lanes
 * whose jobs make one request each. The recovery lane's group jobs make several,
 * so a reservation for it is an understatement — deliberately, since holding
 * back twenty five requests for a lane that may not want them would be worse.
 *
 * @param {string} lane
 */
function reservedForLowerLanes(lane) {
  let reserved = 0
  let below = false

  for (const other of LANES) {
    if (other === lane) {
      below = true
      continue
    }

    if (!below) { continue }
    if (queues[other].length === 0) { continue }

    reserved += Math.max(0, widthForLane(other) - progress.lanes[other].inFlight)
  }

  // Never hold back more than half the budget, so that a small budget cannot
  // invert the priority order and leave the refresh waiting on the back-fill
  return Math.min(reserved, Math.floor(subscriptionBudget() / 2))
}

/**
 * Whether a job of this lane could start right now, and if not, the earliest
 * moment it could. `at` is null when only a job finishing would help.
 *
 * @param {string} lane
 * @param {number} now
 * @param {number} weight what the job at the head of the lane will cost
 * @returns {{ ok: boolean, at: number | null }}
 */
function startability(lane, now, weight) {
  const budget = subscriptionBudget()

  // A single job that costs more than the entire budget still has to run, or it
  // would wait for room that can never appear. It runs on its own instead.
  const cost = Math.min(weight, budget)

  if (weightInFlight > 0 && weightInFlight + cost + reservedForLowerLanes(lane) > budget) {
    return { ok: false, at: null }
  }

  if (progress.lanes[lane].inFlight >= widthForLane(lane)) { return { ok: false, at: null } }

  const startedWeight = startedWeightInWindow()

  // The same reservation as above, and for the same reason. Leaving it off here
  // was measured starving the back-fill: a refresh took every one of the fifty
  // tokens in each two second window, so the back-fill managed one channel per
  // window while the refresh ran, against two per second once it stopped. Room
  // to run and permission to start are both room, and holding back one without
  // the other reserves nothing.
  if (startedWeight > 0 && startedWeight + cost + reservedForLowerLanes(lane) > budget) {
    return { ok: false, at: recentStarts[0].at + budgetWindowMs() }
  }

  const gap = delayForLane(lane)

  if (gap > 0 && lastStartedAt[lane] > 0 && now - lastStartedAt[lane] < gap) {
    return { ok: false, at: lastStartedAt[lane] + gap }
  }

  return { ok: true, at: now }
}

/**
 * Start whatever the budget allows, in lane priority order.
 * @returns {number | null} when to look again, if only time will help
 */
function startWhatWeCan() {
  /** @type {number | null} */
  let earliest = null

  for (const lane of LANES) {
    while (queues[lane].length > 0) {
      const now = Date.now()

      pruneRecentStarts(now)

      const { ok, at } = startability(lane, now, jobWeight(queues[lane][0]))

      if (!ok) {
        if (at != null && (earliest == null || at < earliest)) { earliest = at }
        break
      }

      startJob(lane, now)
    }
  }

  return earliest
}

/**
 * @param {string} lane
 * @param {number} now
 */
function startJob(lane, now) {
  const job = queues[lane].shift()
  const counters = progress.lanes[lane]
  const weight = jobWeight(job)

  recentStarts.push({ at: now, weight })
  lastStartedAt[lane] = now
  weightInFlight += weight
  counters.inFlight++

  if (job.label != null) {
    progress.label = job.label
  }

  progress.lane = lane

  syncCounts()

  if (weightInFlight > peakInFlight) {
    peakInFlight = weightInFlight
  }

  Promise.resolve()
    .then(() => job.run())
    .catch((error) => {
      // A failing job must not stop the queue: the whole point is to keep
      // grinding through a list that is partly broken.
      console.error(error)
    })
    .finally(() => {
      claimed[lane].delete(job.key)
      weightInFlight -= weight
      counters.inFlight--
      counters.done++
      syncCounts()
      signal()
    })
}

/** The lane whose work is worth reporting: the highest priority one with any. */
function activeLane() {
  for (const lane of LANES) {
    if (progress.lanes[lane].inFlight > 0 || queues[lane].length > 0) { return lane }
  }

  return 'idle'
}

/** @param {number | null} deadline */
function waitForSomething(deadline) {
  return new Promise((resolve) => {
    wake = resolve

    if (deadline == null) { return }

    const ms = Math.max(0, deadline - Date.now())

    setTimeout(() => {
      // Only the pump waiting on this timer should be woken by it
      if (wake === resolve) {
        wake = null
        resolve()
      }
    }, ms)
  })
}

async function pump() {
  if (pumping) { return }

  pumping = true

  const thisGeneration = ++generation

  for (const lane of LANES) {
    progress.lanes[lane].done = 0
  }

  try {
    while (true) {
      const deadline = startWhatWeCan()

      progress.lane = activeLane()

      if (progress.inFlight === 0 && queuedCount() === 0) { break }

      await waitForSomething(deadline)

      if (thisGeneration !== generation) { return }
    }
  } finally {
    if (thisGeneration === generation) {
      pumping = false
      cancelledLanes = new Set()
      progress.lane = 'idle'
      progress.label = null

      for (const lane of LANES) {
        progress.lanes[lane].done = 0
      }

      syncCounts()
    }
  }
}

/** Whether the manager currently has anything to do. */
export function subscriptionWorkerBusy() {
  return pumping
}

/**
 * The highest number of requests in flight at once since this was last called,
 * which is the number the budget exists to hold down. Reading it resets it, so
 * each refresh cycle reports its own peak rather than the largest ever seen.
 */
export function takeSubscriptionPeakInFlight() {
  const peak = peakInFlight

  peakInFlight = 0

  return peak
}

/** Test seam: forget all state between cases. */
export function resetSubscriptionWorkerForTests() {
  for (const lane of LANES) {
    queues[lane] = []
    claimed[lane].clear()
  }

  cancelledLanes = new Set()
  pumping = false
  // Abandons any pump still in flight, which the generation guard stops from
  // reporting itself idle later
  generation++
  wake = null
  recentStarts = []
  weightInFlight = 0
  lastStartedAt = { [LANE_REFRESH]: 0, [LANE_RECOVERY]: 0, [LANE_ENRICHMENT]: 0 }
  peakInFlight = 0
  progress.lane = 'idle'
  progress.label = null
  progress.lanes = emptyLaneCounters()
  syncCounts()
  delayOverrideMs = null
  budgetOverride = null
  windowOverride = null
}
