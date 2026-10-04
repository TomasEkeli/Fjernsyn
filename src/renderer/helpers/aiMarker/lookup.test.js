import { describe, expect, it, vi } from 'vitest'

import madeWithAi from './fixtures/local--next-made-with-ai-mweb.json'
import ordinary from './fixtures/local--next-ordinary.json'
import { createAiLookup, FAILURES_BEFORE_PAUSE, PAUSE_MS } from './lookup'

const AI_VIDEO = { videoId: '8Kstkyi3RoE', authorId: 'UCaiaiaiaiaiaiaiaiaiaiai', title: 'Made with AI' }
const ORDINARY_VIDEO = { videoId: 'dQw4w9WgXcQ', authorId: 'UCuAXFkgsw1L7xaCfnd5JJOw', title: 'Never Gonna Give You Up' }
const PEERTUBE_VIDEO = {
  videoId: 'b29290cc-dc51-4a12-bcb2-2aa5fece7605',
  platform: 'peertube',
  host: 'video.blender.org',
  authorId: 'blender@video.blender.org',
}

/**
 * A lookup with fakes for everything it is given: a request answering from
 * fixtures by video id, a verdict store that is a map, and a scheduler that
 * holds jobs until the test runs them, as the request manager holds them
 * until their turn.
 *
 * @param {object} [options]
 * @param {Record<string, any>} [options.answers] video id to a fixture, or an Error to throw
 * @param {string[]} [options.markedChannels]
 */
function setup({ answers = {}, markedChannels = [] } = {}) {
  const clock = { now: 0 }
  const store = new Map()
  const marked = new Set(markedChannels)
  /** @type {{ key: string, run: () => Promise<void>, dropped: () => void }[]} */
  const queue = []

  const request = vi.fn(async (videoId) => {
    const answer = answers[videoId]

    if (answer instanceof Error) { throw answer }
    if (answer === undefined) { throw new Error(`no answer for ${videoId}`) }

    return structuredClone(answer.answer)
  })

  const lookup = createAiLookup({
    request,
    verdicts: {
      get: videoId => store.get(videoId),
      set: (videoId, verdict) => { store.set(videoId, verdict) },
    },
    schedule: job => queue.push(job),
    unschedule: (key) => {
      const index = queue.findIndex(job => job.key === key)

      if (index !== -1) {
        queue.splice(index, 1)[0].dropped()
      }
    },
    isChannelMarked: channelId => marked.has(channelId),
    now: () => clock.now,
  })

  /** Each queued job's turn, in order, as the request manager would give it */
  async function runQueue() {
    while (queue.length > 0) {
      await queue.shift().run()
    }
  }

  return { lookup, request, store, queue, marked, clock, runQueue }
}

describe('the AI lookup', () => {
  it('asks about a video in its turn and keeps the verdict the label gives', async () => {
    const { lookup, request, store, runQueue } = setup({ answers: { [AI_VIDEO.videoId]: madeWithAi, [ORDINARY_VIDEO.videoId]: ordinary } })

    lookup.want(AI_VIDEO)
    lookup.want(ORDINARY_VIDEO)

    expect(request).not.toHaveBeenCalled()

    await runQueue()

    expect(request.mock.calls).toEqual([[AI_VIDEO.videoId], [ORDINARY_VIDEO.videoId]])
    expect(store.get(AI_VIDEO.videoId)).toBe('ai')
    expect(lookup.verdictOf(AI_VIDEO)).toBe('ai')
    expect(lookup.verdictOf(ORDINARY_VIDEO)).toBe('not-ai')
  })

  it('makes no request for a video that has a verdict', async () => {
    const { lookup, request, store, queue, runQueue } = setup()
    store.set(AI_VIDEO.videoId, 'ai')
    store.set(ORDINARY_VIDEO.videoId, 'not-ai')

    lookup.want(AI_VIDEO)
    lookup.want(ORDINARY_VIDEO)

    expect(queue).toHaveLength(0)
    await runQueue()
    expect(request).not.toHaveBeenCalled()
  })

  it('makes one request for two asks about the same video', async () => {
    const { lookup, request, runQueue } = setup({ answers: { [AI_VIDEO.videoId]: madeWithAi } })

    lookup.want(AI_VIDEO)
    lookup.want({ ...AI_VIDEO })

    await runQueue()

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('keeps nothing when the request fails, and asks again on the next ask', async () => {
    const answers = { [AI_VIDEO.videoId]: new Error('status code 429') }
    const { lookup, request, store, runQueue } = setup({ answers })

    lookup.want(AI_VIDEO)
    await runQueue()

    expect(request).toHaveBeenCalledTimes(1)
    expect(store.has(AI_VIDEO.videoId)).toBe(false)
    expect(lookup.verdictOf(AI_VIDEO)).toBeUndefined()

    answers[AI_VIDEO.videoId] = madeWithAi
    lookup.want(AI_VIDEO)
    await runQueue()

    expect(request).toHaveBeenCalledTimes(2)
    expect(store.get(AI_VIDEO.videoId)).toBe('ai')
  })

  it('makes no request when the tile has gone before its turn, and gives the turn up', async () => {
    const { lookup, request, store, queue, runQueue } = setup({ answers: { [AI_VIDEO.videoId]: madeWithAi } })

    const release = lookup.want(AI_VIDEO)
    release()

    expect(queue).toHaveLength(0)
    await runQueue()

    expect(request).not.toHaveBeenCalled()
    expect(store.has(AI_VIDEO.videoId)).toBe(false)
  })

  it('makes no request when the tile has gone by its turn, even if the turn was not given up', async () => {
    const queue = []
    const request = vi.fn()
    const lookup = createAiLookup({
      request,
      verdicts: { get: () => undefined, set: vi.fn() },
      schedule: job => queue.push(job),
      isChannelMarked: () => false,
    })

    lookup.want(AI_VIDEO)()
    await queue.shift().run()

    expect(request).not.toHaveBeenCalled()
  })

  it('still asks while any tile for the video is left', async () => {
    const { lookup, request, runQueue } = setup({ answers: { [AI_VIDEO.videoId]: madeWithAi } })

    const releaseFirst = lookup.want(AI_VIDEO)
    lookup.want(AI_VIDEO)
    releaseFirst()
    releaseFirst()
    await runQueue()

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('asks again for a video whose skipped lookup is wanted again later', async () => {
    const { lookup, request, runQueue } = setup({ answers: { [AI_VIDEO.videoId]: madeWithAi } })

    lookup.want(AI_VIDEO)()
    await runQueue()
    lookup.want(AI_VIDEO)
    await runQueue()

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('asks again once a dropped lookup is wanted again', async () => {
    const { lookup, request, queue, runQueue } = setup({ answers: { [AI_VIDEO.videoId]: madeWithAi } })

    lookup.want(AI_VIDEO)
    queue.shift().dropped()
    lookup.want(AI_VIDEO)
    await runQueue()

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('never asks about a video from a channel marked as AI', async () => {
    const { lookup, request, queue, runQueue } = setup({ markedChannels: [AI_VIDEO.authorId] })

    lookup.want(AI_VIDEO)

    expect(queue).toHaveLength(0)
    await runQueue()
    expect(request).not.toHaveBeenCalled()
  })

  it('skips a queued lookup whose channel was marked before its turn', async () => {
    const { lookup, request, marked, runQueue } = setup({ answers: { [AI_VIDEO.videoId]: madeWithAi } })

    lookup.want(AI_VIDEO)
    marked.add(AI_VIDEO.authorId)
    await runQueue()

    expect(request).not.toHaveBeenCalled()
  })

  it('never asks about a PeerTube video', async () => {
    const { lookup, request, queue } = setup()

    lookup.want(PEERTUBE_VIDEO)

    expect(queue).toHaveLength(0)
    expect(request).not.toHaveBeenCalled()
    expect(lookup.verdictOf(PEERTUBE_VIDEO)).toBeUndefined()
  })

  it('never asks about something that is not a video id', () => {
    const { lookup, queue } = setup()

    lookup.want({ videoId: 'not a video' })
    lookup.want({ playlistId: 'PLx' })

    expect(queue).toHaveLength(0)
  })

  it('makes no request for a video recorded while its lookup waited', async () => {
    const { lookup, request, store, runQueue } = setup({ answers: { [AI_VIDEO.videoId]: madeWithAi } })

    lookup.want(AI_VIDEO)
    store.set(AI_VIDEO.videoId, 'ai')
    await runQueue()

    expect(request).not.toHaveBeenCalled()
  })

  it('keeps nothing from an answer the label cannot be read from, and asks again', async () => {
    const { lookup, request, store, runQueue } = setup({ answers: { [AI_VIDEO.videoId]: { answer: { contents: {} } } } })

    lookup.want(AI_VIDEO)
    await runQueue()

    expect(store.has(AI_VIDEO.videoId)).toBe(false)

    lookup.want(AI_VIDEO)
    await runQueue()

    expect(request).toHaveBeenCalledTimes(2)
  })

  it('pauses after failures in a row, and asks again once the pause is over', async () => {
    const answers = {}
    const videos = Array.from({ length: FAILURES_BEFORE_PAUSE + 1 }, (_, index) => ({ videoId: `refused${String(index).padStart(4, '0')}` }))
    for (const video of videos) { answers[video.videoId] = new Error('status code 429') }
    const { lookup, request, queue, clock, runQueue } = setup({ answers })

    for (const video of videos) { lookup.want(video) }
    await runQueue()

    // The last was queued before the pause began, and skipped in its turn
    expect(request).toHaveBeenCalledTimes(FAILURES_BEFORE_PAUSE)

    lookup.want(videos[0])
    expect(queue).toHaveLength(0)

    clock.now += PAUSE_MS
    answers[videos[0].videoId] = madeWithAi
    lookup.want(videos[0])
    await runQueue()

    expect(request).toHaveBeenCalledTimes(FAILURES_BEFORE_PAUSE + 1)
  })

  it('counts only failures in a row towards a pause', async () => {
    const answers = { a0000000000: new Error('x'), b0000000000: new Error('x'), c0000000000: ordinary, d0000000000: new Error('x'), e0000000000: ordinary }
    const { lookup, request, runQueue } = setup({ answers })

    for (const videoId of Object.keys(answers)) { lookup.want({ videoId }) }
    await runQueue()

    expect(request).toHaveBeenCalledTimes(5)
  })

  it('asks nothing while lookups are not enabled', () => {
    const queue = []
    const lookup = createAiLookup({
      request: vi.fn(),
      verdicts: { get: () => undefined, set: vi.fn() },
      schedule: job => queue.push(job),
      isChannelMarked: () => false,
      enabled: () => false,
    })

    lookup.want(AI_VIDEO)

    expect(queue).toHaveLength(0)
  })
})
