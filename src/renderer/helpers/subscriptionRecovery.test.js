import { beforeEach, describe, expect, it, vi } from 'vitest'

import { cancelSubscriptionRecovery, recoverUnresolvedChannels, resetSubscriptionRecoveryForTests, subscriptionRecoveryProgress } from './subscriptionRecovery'
import { enqueueSubscriptionJobs, resetSubscriptionWorkerForTests, setSubscriptionBudgetForTests, setSubscriptionWorkerDelayForTests, LANE_REFRESH } from './subscriptionWorker'
import { FETCH_FAILED, FETCH_OK, FETCH_SKIPPED, FETCH_UNAVAILABLE } from './subscriptionFetchStatus'

// The recovery's own bookkeeping: what it counts as got back, what it hands on
// to be cached, and what it asks for again one at a time

vi.mock('../store/index', async () => {
  const { createFakeStore } = await import('../testing/store')
  return { default: createFakeStore({ getters: { getProfileList: [] } }) }
})

vi.mock('./utils', () => ({ showToast: vi.fn(), copyToClipboard: vi.fn() }))

vi.mock('../i18n/index', () => ({ default: { global: { t: key => key } } }))

const channel = id => ({ id, name: id })

/**
 * Runs a recovery whose fetch answers each channel with the status given for
 * it, recording what `onRecovered` saw and what the progress said then.
 *
 * @param {Record<string, string>} statuses
 */
async function recover(statuses) {
  const asked = []
  const handedOn = []
  const recoveredSeen = []

  await recoverUnresolvedChannels({
    feed: 'videos',
    channels: Object.keys(statuses).map(channel),
    fetchChannel: async ({ id }) => {
      asked.push(id)
      const status = statuses[id]
      return { status, entries: status === FETCH_OK ? [] : status === FETCH_UNAVAILABLE ? [] : null }
    },
    onRecovered: (results) => {
      handedOn.push(...results.map(({ channel: { id } }) => id))
      recoveredSeen.push(subscriptionRecoveryProgress.recovered)
    },
  })

  return { asked, handedOn, recoveredSeen }
}

beforeEach(() => {
  resetSubscriptionWorkerForTests()
  resetSubscriptionRecoveryForTests()
  setSubscriptionWorkerDelayForTests(0)
})

describe('recoverUnresolvedChannels', () => {
  it('counts a channel it got an answer for as recovered', async () => {
    const { handedOn, recoveredSeen } = await recover({ a: FETCH_OK, b: FETCH_UNAVAILABLE })

    expect(handedOn).toEqual(['a', 'b'])
    expect(recoveredSeen).toEqual([2])
  })

  it('does not count a skipped channel as recovered, but drops it, never asking for it again', async () => {
    const { asked, handedOn, recoveredSeen } = await recover({ a: FETCH_OK, skipped: FETCH_SKIPPED })

    // Handed on, so the refresh takes it off its unresolved list; with no
    // entries that writes nothing
    expect(handedOn).toEqual(['a', 'skipped'])
    expect(recoveredSeen).toEqual([1])
    expect(asked).toEqual(['a', 'skipped'])
  })

  it('counts nothing when every channel was skipped', async () => {
    const { recoveredSeen } = await recover({ x: FETCH_SKIPPED, y: FETCH_SKIPPED })

    expect(recoveredSeen).toEqual([0])
  })

  it('asks for a channel that failed again, on its own', async () => {
    const { asked } = await recover({ a: FETCH_OK, failing: FETCH_FAILED })

    expect(asked).toEqual(['a', 'failing', 'failing'])
  })

  it('ends when cancelled while its job is still waiting for the budget', async () => {
    // A refresh holding the whole budget, so the recovery's first group queues
    setSubscriptionBudgetForTests(1)

    let releaseRefresh
    enqueueSubscriptionJobs(LANE_REFRESH, [{
      key: 'refresh-videos-busy',
      run: () => new Promise((resolve) => { releaseRefresh = resolve })
    }])

    let settled = false
    const recovery = recoverUnresolvedChannels({
      feed: 'videos',
      channels: [channel('a')],
      fetchChannel: async () => ({ status: FETCH_OK, entries: [] }),
      onRecovered: () => {}
    }).then(() => { settled = true })

    await new Promise(resolve => setTimeout(resolve, 10))
    expect(subscriptionRecoveryProgress.active).toBe(true)

    // What a refresh starting, a profile switch or the Stop button does
    cancelSubscriptionRecovery()
    releaseRefresh()

    await Promise.race([recovery, new Promise(resolve => setTimeout(resolve, 200))])

    expect(settled).toBe(true)
    expect(subscriptionRecoveryProgress.active).toBe(false)
  })
})
