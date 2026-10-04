import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  cancelSubscriptionLane,
  enqueueSubscriptionJobs,
  LANE_ENRICHMENT,
  removeSubscriptionJobs,
  resetSubscriptionWorkerForTests,
  setSubscriptionBudgetForTests,
  setSubscriptionWorkerDelayForTests
} from './subscriptionWorker'

afterEach(() => {
  resetSubscriptionWorkerForTests()
})

/** A job that runs until the test lets it finish */
function heldJob(key) {
  let finish
  const finished = new Promise((resolve) => { finish = resolve })

  return {
    job: { key, run: vi.fn(() => finished), dropped: vi.fn() },
    finish: () => finish(),
  }
}

describe('the request manager, cancelling a lane', () => {
  it('tells each job it drops that it will not run, and leaves the running one alone', async () => {
    setSubscriptionWorkerDelayForTests(0)
    setSubscriptionBudgetForTests(1)

    const running = heldJob('running')
    const queued = heldJob('queued')

    enqueueSubscriptionJobs(LANE_ENRICHMENT, [running.job, queued.job])
    await vi.waitFor(() => expect(running.job.run).toHaveBeenCalled())

    cancelSubscriptionLane(LANE_ENRICHMENT)

    expect(queued.job.dropped).toHaveBeenCalledTimes(1)
    expect(queued.job.run).not.toHaveBeenCalled()
    expect(running.job.dropped).not.toHaveBeenCalled()

    running.finish()
  })
})

describe('the request manager, taking jobs back out', () => {
  it('takes out the queued jobs named, telling each, and leaves the rest and the running one', async () => {
    setSubscriptionWorkerDelayForTests(0)
    setSubscriptionBudgetForTests(1, 10)

    const running = heldJob('running')
    const unwanted = heldJob('unwanted')
    const wanted = heldJob('wanted')

    enqueueSubscriptionJobs(LANE_ENRICHMENT, [running.job, unwanted.job, wanted.job])
    await vi.waitFor(() => expect(running.job.run).toHaveBeenCalled())

    expect(removeSubscriptionJobs(LANE_ENRICHMENT, ['unwanted', 'running', 'never queued'])).toBe(1)
    expect(unwanted.job.dropped).toHaveBeenCalledTimes(1)
    expect(running.job.dropped).not.toHaveBeenCalled()

    running.finish()
    await vi.waitFor(() => expect(wanted.job.run).toHaveBeenCalled())
    expect(unwanted.job.run).not.toHaveBeenCalled()

    // Its key is free again
    expect(enqueueSubscriptionJobs(LANE_ENRICHMENT, [heldJob('unwanted').job])).toBe(1)
    wanted.finish()
  })
})
