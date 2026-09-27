import { beforeEach, describe, expect, it, vi } from 'vitest'

import { recoverUnresolvedChannels, resetSubscriptionRecoveryForTests, subscriptionRecoveryProgress } from './subscriptionRecovery'
import { resetSubscriptionWorkerForTests, setSubscriptionWorkerDelayForTests } from './subscriptionWorker'
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
})
