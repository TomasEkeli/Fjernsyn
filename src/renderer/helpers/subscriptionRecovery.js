import { reactive, readonly } from 'vue'

import store from '../store/index'

import {
  cancelSubscriptionLane,
  enqueueSubscriptionJob,
  LANE_RECOVERY
} from './subscriptionWorker'
import { isRetryableFetchStatus, FETCH_SKIPPED } from './subscriptionFetchStatus'
import { traceRecovery } from './subscriptionTrace'
import { buildRecoveryGroups } from './subscriptionRecoveryGroups'

/**
 * Going back for the channels a refresh could not reach.
 *
 * A refresh asks for every channel at once. When that goes badly it can go
 * badly for hundreds of them, and the repair by hand is: refresh again, then
 * switch to each profile in turn and refresh those, and failing that open every
 * channel one at a time. This is that, without the hand.
 *
 * The escalation is in how much is asked for at once. The refresh itself is
 * batches of fifty. Then profiles, in batches of at most twenty five. Then one
 * channel at a time. Each step asks for less than the one before, on the theory
 * that a refusal is a reaction to how much is being asked for.
 *
 * Only channels that failed in a way worth retrying are carried forward, so a
 * channel that is simply gone never sets any of this off, and each step carries
 * only what the step before it could not get.
 *
 * It runs on the shared worker, so it cannot overlap with itself or with the
 * detail back-fill, and it never touches the loading state: the feed shows what
 * the refresh did manage, and grows as the rest arrives.
 */

/**
 * Passed as the retry count so that a fetch reports its failure rather than
 * working through its ladder of fallbacks.
 *
 * Those ladders exist for one channel having a bad day, and are actively
 * harmful here: eight genuinely failing channels once turned into forty two
 * requests. Sending more requests because requests are being refused is the
 * wrong instinct, and this is the situation where it matters most. Any value
 * past the end of a ladder's cases will do.
 */
export const NO_RETRY_ATTEMPTS = 9

const progress = reactive({
  active: false,
  /** @type {'profiles' | 'channels' | null} */
  stage: null,
  /** Channels still to be tried. */
  remaining: 0,
  /** Channels got back since this run started. */
  recovered: 0,
  /** @type {string | null} */
  label: null
})

/** Progress for the interface to read. Mutated only in here. */
export const subscriptionRecoveryProgress = readonly(progress)

/**
 * Bumped by every cancel. A recovery notes it when it is queued and stops as
 * soon as it has moved on, so one cancel ends the recovery running and every
 * recovery waiting behind it.
 *
 * A flag cleared by whichever recovery started next could not do that: the
 * next one in line cleared it and carried on with the list of a refresh that
 * had just been superseded or stopped.
 */
let cancellations = 0

/**
 * The recoveries, one after another. Each feed's refresh queues its own when
 * it finishes, so a refresh of four feeds can line up four of them, and they
 * must not run at once: the recovery is one escalation, sharing one progress.
 * @type {Promise<unknown>}
 */
let line = Promise.resolve()

let running = false

/**
 * Channel ids settled during the current run, which are not asked for again:
 * recovered, confirmed gone, or skipped.
 */
const recovered = new Set()

function resetProgress() {
  progress.active = false
  progress.stage = null
  progress.label = null
  progress.remaining = 0
  progress.recovered = 0
}

/**
 * @typedef {object} RecoveryOptions
 * @property {string} feed
 * @property {object[]} channels the ones the refresh could not reach
 * @property {(channel: object) => Promise<{ status: string, entries: any[] | null }>} fetchChannel
 *   expected to have its retry ladder suppressed
 * @property {(results: { channel: object, result: object }[]) => void | Promise<void>} onRecovered
 *   called after each group with whatever that group managed to get, and
 *   awaited, because it writes the cache the feed is then rebuilt from
 */

/**
 * Queue a recovery behind any already waiting, to run unless a cancel comes
 * first. The options are asked for when its turn comes, so that it works on
 * the channels still missing then.
 *
 * @param {string} feed
 * @param {() => Omit<RecoveryOptions, 'feed'>} options
 * @returns {Promise<boolean>} whether it started, so that the caller can tell
 *   a recovery that ran, to its end or to a cancel, from one that never did
 */
export function queueSubscriptionRecovery(feed, options) {
  const queuedAt = cancellations

  const turn = line.then(async () => {
    if (cancellations !== queuedAt) {
      traceRecovery(feed, 'skipped')
      return false
    }

    await recoverUnresolvedChannels({ ...options(), feed }, queuedAt)

    return true
  })

  // One that throws must not stop the ones behind it
  line = turn.catch(() => {})

  return turn
}

/**
 * Work through the channels a refresh could not reach, by profile group and
 * then one at a time. Resolves when there is nothing left to try, or when
 * cancelled.
 *
 * @param {RecoveryOptions} options
 * @param {number} [queuedAt] the cancel count when it was queued; a cancel
 *   since then means it does not start
 */
export async function recoverUnresolvedChannels({ feed, channels, fetchChannel, onRecovered }, queuedAt = cancellations) {
  if (running || channels.length === 0) { return }

  const cancelled = () => cancellations !== queuedAt

  if (cancelled()) { return }

  running = true
  recovered.clear()

  progress.active = true
  progress.recovered = 0
  progress.remaining = channels.length

  /** @param {object[]} groupChannels */
  const attempt = async (groupChannels) => {
    const settled = await Promise.all(groupChannels.map(async (channel) => {
      return { channel, result: await fetchChannel(channel) }
    }))

    const succeeded = settled.filter(({ result }) => !isRetryableFetchStatus(result.status))

    for (const { channel } of succeeded) {
      recovered.add(channel.id)
    }

    // A skipped channel (a PeerTube one, with PeerTube switched off since) is
    // settled, so it is not asked for again, but nothing was got back for it
    progress.recovered += succeeded.filter(({ result }) => result.status !== FETCH_SKIPPED).length
    progress.remaining = Math.max(0, progress.remaining - succeeded.length)

    if (succeeded.length > 0) {
      await onRecovered(succeeded)
    }
  }

  try {
    progress.stage = 'profiles'

    const groups = buildRecoveryGroups(channels, store.getters.getProfileList)

    traceRecovery(feed, 'begin', { channels: channels.length, groups: groups.length })

    for (const group of groups) {
      if (cancelled()) { return }

      progress.label = group.label

      await enqueueSubscriptionJob(LANE_RECOVERY, {
        key: `${feed}-recovery-group-${group.channels.map(channel => channel.id).join()}`,
        label: group.label ?? undefined,
        // The group is asked for all at once, which is the whole point of it,
        // so it costs the manager what it really spends
        weight: group.channels.length,
        run: () => attempt(group.channels)
      })

      traceRecovery(feed, 'group', {
        label: group.label ?? '(no profile)',
        channels: group.channels.length,
        recovered: progress.recovered,
        remaining: progress.remaining
      })
    }

    const stillMissing = channels.filter(channel => !recovered.has(channel.id))

    traceRecovery(feed, 'profiles-done', {
      recovered: progress.recovered,
      remaining: stillMissing.length
    })

    if (stillMissing.length === 0 || cancelled()) { return }

    // Whatever survived a batch of twenty five is asked for entirely on its
    // own, which is as gentle as this can be made
    progress.stage = 'channels'

    traceRecovery(feed, 'one-at-a-time', { channels: stillMissing.length })

    for (const channel of stillMissing) {
      if (cancelled()) { return }

      progress.label = channel.name ?? channel.id

      await enqueueSubscriptionJob(LANE_RECOVERY, {
        key: `${feed}-recovery-channel-${channel.id}`,
        label: channel.name ?? channel.id,
        run: () => attempt([channel])
      })
    }
  } finally {
    traceRecovery(feed, cancelled() ? 'cancelled' : 'end', {
      recovered: progress.recovered,
      remaining: progress.remaining
    })

    running = false
    recovered.clear()
    resetProgress()
  }
}

/**
 * Stop the current run, and every recovery queued behind it. Anything queued
 * on the lane is dropped, and the request in flight is left to finish because
 * there is nothing here to abort one with.
 */
export function cancelSubscriptionRecovery() {
  cancellations++
  cancelSubscriptionLane(LANE_RECOVERY)
}

/** Test seam. */
export function resetSubscriptionRecoveryForTests() {
  // Moved on, so nothing a previous test left queued or running carries on
  cancellations++
  line = Promise.resolve()
  running = false
  recovered.clear()
  resetProgress()
}
