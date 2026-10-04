import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  cancelSubscriptionLane,
  enqueueSubscriptionJob,
  enqueueSubscriptionJobs,
  LANE_ENRICHMENT,
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

  it('settles a job awaited through enqueueSubscriptionJob when it is dropped, rather than never', async () => {
    setSubscriptionWorkerDelayForTests(0)
    setSubscriptionBudgetForTests(1)

    const running = heldJob('running')
    enqueueSubscriptionJobs(LANE_ENRICHMENT, [running.job])
    await vi.waitFor(() => expect(running.job.run).toHaveBeenCalled())

    const dropped = vi.fn()
    const run = vi.fn()
    const settled = enqueueSubscriptionJob(LANE_ENRICHMENT, { key: 'waiting', run, dropped })

    cancelSubscriptionLane(LANE_ENRICHMENT)

    await expect(settled).resolves.toBeUndefined()
    expect(dropped).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()

    running.finish()
  })
})
