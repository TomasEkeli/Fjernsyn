import { afterEach, describe, expect, it, vi } from 'vitest'

import ordinary from '../api/fixtures/local--player-ordinary.json'
import privateVideo from '../api/fixtures/local--player-private.json'
import noSuchVideo from '../api/fixtures/local--player-no-such-video.json'
import { CRAWL_FAILURES_BEFORE_PAUSE, CRAWL_PAUSE_MS, CRAWL_QUEUED_AT_ONCE, createCommunitiesCrawl } from './crawl'
import { needsDetails, SIGHTINGS_APART_MS } from './details'

/** A described answer for any video id */
function described(videoId) {
  const answer = structuredClone(ordinary.answer)
  answer.videoDetails.videoId = videoId
  answer.videoDetails.title = `Title ${videoId}`
  return answer
}

const ids = count => Array.from({ length: count }, (_, index) => `video${String(index).padStart(6, '0')}`)

/**
 * A crawl over a datastore kept in a Map, with a lane that runs nothing
 * until the test says, and a clock and timers the test moves.
 *
 * @param {object} [options]
 * @param {string[]} [options.videos] the community's YouTube videos, in wall order
 * @param {(videoId: string) => any} [options.answer] what YouTube answers for each
 * @param {number | null} [options.limit]
 * @param {Map<string, any>} [options.kept] the datastore, shared to model a restart
 * @param {(job: any) => boolean} [options.accept] whether the lane takes a job
 * @param {number} [options.start] the clock at the start
 * @param {number | null} [options.delayMs] a development run's wait between jobs
 * @param {boolean} [options.realTimers] the crawl's own default timer, for
 *   vitest's fake timers, rather than the ones `advance` moves
 */
function setup({ videos = ids(5), answer = described, limit = null, kept = new Map(), accept = () => true, start = 0, delayMs = null, realTimers = false } = {}) {
  const lane = []
  const timers = []
  let clock = start
  const asked = []
  const changes = []

  const request = vi.fn(async (videoId) => {
    asked.push(videoId)
    const reply = answer(videoId)
    if (reply instanceof Error) { throw reply }
    return reply
  })

  const crawl = createCommunitiesCrawl({
    missing: () => [...videos.filter(id => !kept.has(id)), ...videos.filter(id => kept.has(id) && needsDetails(kept.get(id), clock))],
    isDone: id => !needsDetails(kept.get(id), clock),
    recordFor: id => kept.get(id),
    request,
    record: async (records) => {
      for (const record of records) { kept.set(record._id, record) }
    },
    schedule: (job) => {
      if (!accept(job)) { return false }
      lane.push(job)
      return true
    },
    unschedule: (keys) => {
      for (const key of keys) {
        const index = lane.findIndex(job => job.key === key)
        if (index !== -1) { lane.splice(index, 1)[0].dropped() }
      }
    },
    limit,
    delayMs,
    now: () => clock,
    ...(realTimers ? {} : { setTimer: (fn, ms) => { timers.push({ at: clock + ms, fn }) } }),
    onChange: status => changes.push(status.state),
  })

  /** Runs the lane's jobs, one at a time, until it is empty or `max` have run */
  async function drain(max = Infinity) {
    let ran = 0
    while (lane.length > 0 && ran < max) {
      await lane.shift().run()
      ran++
    }
  }

  /** The lane cancelled, as a profile switch does */
  function cancelLane() {
    const dropped = lane.splice(0)
    for (const job of dropped) { job.dropped() }
  }

  async function advance(ms) {
    clock += ms
    const due = timers.filter(t => t.at <= clock)
    timers.splice(0, timers.length, ...timers.filter(t => t.at > clock))
    for (const timer of due) { timer.fn() }
  }

  return { crawl, lane, kept, asked, request, drain, cancelLane, advance, changes, videos }
}

describe('the crawl', () => {
  it('asks once for every video without details, most voted first, and keeps what it learns', async () => {
    const t = setup()

    t.crawl.start()
    await t.drain()

    expect(t.asked).toEqual(t.videos)
    expect([...t.kept.keys()]).toEqual(t.videos)
    expect(t.kept.get(t.videos[0])).toMatchObject({ videoId: t.videos[0], title: `Title ${t.videos[0]}`, lengthSeconds: 213 })
    expect(t.crawl.status().state).toBe('done')
  })

  it('never asks about a video that already has details', async () => {
    const kept = new Map([[ids(5)[1], { _id: ids(5)[1] }], [ids(5)[3], { _id: ids(5)[3] }]])
    const t = setup({ kept })

    t.crawl.start()
    await t.drain()

    expect(t.asked).toEqual([ids(5)[0], ids(5)[2], ids(5)[4]])
  })

  it('makes no request for a video whose details came in while it waited its turn', async () => {
    const t = setup()

    t.crawl.start()
    t.kept.set(t.videos[0], { _id: t.videos[0] })
    await t.drain()

    expect(t.asked).not.toContain(t.videos[0])
  })

  it('keeps no more than a couple of its jobs on the lane at once, so whatever is queued after them goes first', async () => {
    const t = setup({ videos: ids(50) })

    t.crawl.start()

    expect(t.lane).toHaveLength(CRAWL_QUEUED_AT_ONCE)

    t.lane.push({ key: 'backfill', run: async () => {}, dropped: () => {} })
    await t.drain(CRAWL_QUEUED_AT_ONCE)

    // The back-fill's job is now at the head, ahead of the crawl's next ones
    expect(t.lane[0].key).toBe('backfill')
    expect(t.lane).toHaveLength(1 + CRAWL_QUEUED_AT_ONCE)
  })

  it('gives each job a key of its own, apart from the AI lookups and the back-fill on the same lane', () => {
    const t = setup()

    t.crawl.start()

    expect(t.lane.map(job => job.key)).toEqual(t.videos.slice(0, CRAWL_QUEUED_AT_ONCE).map(id => `community-details-${id}`))
  })

  it('does nothing when started while it runs', async () => {
    const t = setup()

    t.crawl.start()
    t.crawl.start()
    await t.drain()

    expect(t.asked).toEqual(t.videos)
  })

  it('records a video that is not there as gone, so it is not asked about again and is left off the wall', async () => {
    const t = setup({ answer: id => id === ids(5)[2] ? noSuchVideo.answer : described(id) })

    t.crawl.start()
    await t.drain()

    expect(t.kept.get(ids(5)[2])).toMatchObject({ unavailable: 'gone' })
  })

  it('keeps a video that asks to sign in as a suspect, not hidden, however well the videos around it are answered', async () => {
    const t = setup({ answer: id => id === ids(5)[1] ? privateVideo.answer : described(id) })

    t.crawl.start()
    await t.drain()

    expect(t.kept.get(ids(5)[1])).toMatchObject({ loginRequired: { count: 1 } })
    expect(t.kept.get(ids(5)[1]).unavailable).toBeUndefined()
  })

  it('asks a suspect again on the next start, not in the same one, and never hides it for answers on the same day', async () => {
    const kept = new Map()
    const t = setup({ videos: ids(3), kept, answer: id => id === ids(3)[0] ? privateVideo.answer : described(id) })

    t.crawl.start()
    await t.drain()
    expect(t.asked).toEqual(ids(3))

    for (let again = 0; again < 5; again++) {
      await t.advance(60 * 60 * 1000)
      t.crawl.start()
      await t.drain()
    }

    expect(t.asked.filter(id => id === ids(3)[0])).toHaveLength(6)
    expect(kept.get(ids(3)[0]).unavailable).toBeUndefined()
  })

  it('takes a video for private after it asks to sign in on three starts at least twelve hours apart', async () => {
    const kept = new Map()
    const t = setup({ videos: ids(1), kept, answer: () => privateVideo.answer })

    for (let start = 0; start < 3; start++) {
      t.crawl.start()
      await t.drain()
      await t.advance(SIGHTINGS_APART_MS)
    }

    expect(kept.get(ids(1)[0])).toMatchObject({ unavailable: 'private' })
  })

  it('counts asking to sign in as a failure, so a bot check pauses it', async () => {
    const t = setup({ videos: ids(10), answer: () => privateVideo.answer })

    t.crawl.start()
    await t.drain()

    expect(t.asked).toHaveLength(CRAWL_FAILURES_BEFORE_PAUSE)
    expect(t.crawl.status().state).toBe('paused')
  })

  it('carries on past a job the lane would not take, without asking about it this start', async () => {
    const t = setup({ accept: job => job.key !== `community-details-${ids(5)[1]}` })

    t.crawl.start()
    await t.drain()

    expect(t.asked).toEqual([ids(5)[0], ...ids(5).slice(2)])
    expect(t.crawl.status().state).toBe('done')
  })

  it('schedules nothing more once a job is dropped while it is being scheduled', () => {
    let calls = 0
    const t = setup({
      videos: ids(10),
      accept: (job) => {
        calls++
        job.dropped()
        return true
      },
    })

    t.crawl.start()

    expect(calls).toBe(1)
    expect(t.crawl.status().state).toBe('stopped')
  })

  it('pauses after failures in a row, takes its queued jobs back off the lane, and carries on after the pause', async () => {
    let refusing = true
    const t = setup({ videos: ids(10), answer: id => refusing ? new Error('429') : described(id) })

    t.crawl.start()
    await t.drain(CRAWL_FAILURES_BEFORE_PAUSE)

    expect(t.asked).toHaveLength(CRAWL_FAILURES_BEFORE_PAUSE)
    expect(t.lane).toHaveLength(0)
    expect(t.crawl.status().state).toBe('paused')

    refusing = false
    await t.advance(CRAWL_PAUSE_MS - 1)
    expect(t.lane).toHaveLength(0)

    await t.advance(1)
    await t.drain()

    // The ones that failed are left for the next start, and none is asked twice
    expect(t.asked).toEqual(ids(10))
    expect(t.kept.size).toBe(10 - CRAWL_FAILURES_BEFORE_PAUSE)
    expect(t.crawl.status().state).toBe('done')
  })

  it('does not pause for failures that are not in a row', async () => {
    const t = setup({ videos: ids(6), answer: id => [0, 1, 3, 4].includes(ids(6).indexOf(id)) ? new Error('500') : described(id) })

    t.crawl.start()
    await t.drain()

    expect(t.asked).toEqual(ids(6))
    expect(t.crawl.status().state).toBe('done')
  })

  it('stops when the lane is cancelled, and the next start asks only for what is still missing', async () => {
    const t = setup({ videos: ids(10) })

    t.crawl.start()
    await t.drain(4)
    t.cancelLane()
    await t.drain()

    expect(t.crawl.status().state).toBe('stopped')
    expect(t.asked).toEqual(ids(10).slice(0, 4))

    t.crawl.start()
    await t.drain()

    expect(t.asked).toEqual(ids(10))
  })

  it('asks the failed ones again on the next start', async () => {
    let failing = true
    const t = setup({ videos: ids(3), answer: id => failing && id === ids(3)[1] ? new Error('500') : described(id) })

    t.crawl.start()
    await t.drain()
    failing = false
    t.crawl.start()
    await t.drain()

    expect(t.asked).toEqual([...ids(3), ids(3)[1]])
    expect(t.kept.size).toBe(3)
  })

  it('resumes after a restart from what the datastore is missing, asking for nothing twice', async () => {
    const kept = new Map()
    const first = setup({ videos: ids(10), kept, limit: 4 })

    first.crawl.start()
    await first.drain()

    const second = setup({ videos: ids(10), kept })

    second.crawl.start()
    await second.drain()

    expect(first.asked).toEqual(ids(10).slice(0, 4))
    expect(second.asked).toEqual(ids(10).slice(4))
    expect(kept.size).toBe(10)
  })

  it('takes in videos that arrive while it runs', async () => {
    const t = setup({ videos: ids(3) })

    t.crawl.start()
    await t.drain(1)
    t.videos.push('newcomer000')
    await t.drain()

    expect(t.asked).toEqual([...ids(3), 'newcomer000'])
  })

  it('reports running while it runs, and done at the end', async () => {
    const t = setup({ videos: ids(2) })

    expect(t.crawl.status().state).toBe('idle')
    t.crawl.start()
    expect(t.crawl.status().state).toBe('running')
    await t.drain()
    expect(t.changes.at(-1)).toBe('done')
  })
})

describe('the crawl\'s limit, for development runs', () => {
  it('makes no more requests than the limit, however many videos are missing', async () => {
    const t = setup({ videos: ids(100), limit: 7 })

    t.crawl.start()
    await t.drain()
    t.crawl.start()
    await t.drain()

    expect(t.request).toHaveBeenCalledTimes(7)
    expect(t.crawl.status().state).toBe('limited')
  })

  it('counts the requests that failed', async () => {
    const t = setup({ videos: ids(100), limit: 5, answer: id => ids(100).indexOf(id) % 2 === 0 ? new Error('500') : described(id) })

    t.crawl.start()
    await t.drain()

    expect(t.request).toHaveBeenCalledTimes(5)
  })

  it('makes none at a limit of nought', async () => {
    const t = setup({ limit: 0 })

    t.crawl.start()
    await t.drain()

    expect(t.request).not.toHaveBeenCalled()
    expect(t.lane).toHaveLength(0)
  })

  it('counts across a cancel and a pause: the limit is for the whole time the app runs', async () => {
    const t = setup({ videos: ids(100), limit: 6, answer: id => ids(100).indexOf(id) < 3 ? new Error('429') : described(id) })

    t.crawl.start()
    await t.drain()
    await t.advance(CRAWL_PAUSE_MS)
    await t.drain(1)
    t.cancelLane()
    t.crawl.start()
    await t.drain()

    expect(t.request).toHaveBeenCalledTimes(6)
  })
})

describe('the crawl\'s delay, for development runs', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps one job in flight, and queues the next only the delay after it finishes', async () => {
    vi.useFakeTimers()
    const t = setup({ videos: ids(3), delayMs: 1000, realTimers: true })

    t.crawl.start()
    expect(t.lane).toHaveLength(1)

    await t.drain()
    expect(t.asked).toEqual([ids(3)[0]])
    expect(t.lane).toHaveLength(0)

    vi.advanceTimersByTime(999)
    expect(t.lane).toHaveLength(0)

    vi.advanceTimersByTime(1)
    expect(t.lane).toHaveLength(1)

    await t.drain()
    vi.advanceTimersByTime(1000)
    await t.drain()
    expect(t.asked).toEqual(ids(3))
    expect(t.crawl.status().state).toBe('running')

    vi.advanceTimersByTime(1000)
    expect(t.lane).toHaveLength(0)
    expect(t.crawl.status().state).toBe('done')
  })

  it('is no delay, and a couple of jobs at once, when none is set', async () => {
    vi.useFakeTimers()
    const t = setup({ videos: ids(5), realTimers: true })

    t.crawl.start()
    expect(t.lane).toHaveLength(CRAWL_QUEUED_AT_ONCE)

    await t.drain()
    expect(t.asked).toEqual(ids(5))
    expect(vi.getTimerCount()).toBe(0)
  })
})
