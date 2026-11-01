import { describe, expect, it, vi } from 'vitest'

import { PlatformError } from '../../platform/errors'
import { needsDetails } from './details'
import { createPeerTubeDetailsFill, PEERTUBE_DETAILS_AT_ONCE } from './peertubeDetails'
import { shareVideoKey } from './shares'

const ref = (index, host = 'tilvids.com') => ({
  platform: 'peertube',
  host,
  videoId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
})

const summaryOf = r => ({
  type: 'video',
  platform: 'peertube',
  host: r.host,
  videoId: r.videoId,
  title: `Video ${r.videoId}`,
  author: 'Channel',
  authorId: `channel@${r.host}`,
  lengthSeconds: 60,
  viewCount: 1,
  published: 2,
  liveNow: false,
  isUpcoming: false,
  nsfw: false,
  thumbnail: `https://${r.host}/t.jpg`,
})

/**
 * A fill over a table of details kept, with the requests it makes recorded
 *
 * @param {object} [options]
 * @param {ReturnType<typeof ref>[]} [options.refs]
 * @param {(r: ReturnType<typeof ref>) => Promise<any>} [options.answer]
 * @param {() => boolean} [options.enabled]
 */
function setUp({ refs = [ref(1), ref(2), ref(3)], answer = async r => summaryOf(r), enabled = () => true } = {}) {
  const kept = {}
  let order = refs
  const deps = {
    missing: vi.fn(() => order.filter(r => needsDetails(kept[shareVideoKey(r)], 10))),
    isDone: vi.fn(key => !needsDetails(kept[key], 10)),
    request: vi.fn(answer),
    record: vi.fn(async (records) => {
      for (const record of records) { kept[record._id] = record }
    }),
    enabled,
    now: () => 10,
    onFailure: vi.fn(),
  }

  return { deps, kept, fill: createPeerTubeDetailsFill(deps), setOrder: (next) => { order = next } }
}

describe('filling in the details of PeerTube videos', () => {
  it('asks the platform layer for each video missing details and keeps them by the ref asked, and is done', async () => {
    const { deps, kept, fill } = setUp()

    await fill.start()

    expect(deps.request.mock.calls.map(([r]) => r.videoId)).toEqual([ref(1), ref(2), ref(3)].map(r => r.videoId))
    expect(kept[shareVideoKey(ref(1))]).toMatchObject({ platform: 'peertube', host: 'tilvids.com', fetchedAt: 10, lengthSeconds: 60, authorId: 'channel@tilvids.com' })
    expect(fill.status()).toEqual({ state: 'done', requests: 3 })
  })

  it('keeps a video under the ref its share has, whatever host the origin answers as, so that it is done', async () => {
    const { kept, fill, deps } = setUp({ refs: [ref(1)], answer: async r => ({ ...summaryOf(r), host: 'elsewhere.example' }) })

    await fill.start()
    await fill.start()

    expect(Object.keys(kept)).toEqual([shareVideoKey(ref(1))])
    expect(deps.request).toHaveBeenCalledTimes(1)
  })

  it(`asks no more than ${PEERTUBE_DETAILS_AT_ONCE} at once`, async () => {
    let asking = 0
    let most = 0
    const { fill } = setUp({
      refs: [ref(1), ref(2), ref(3), ref(4), ref(5)],
      answer: async (r) => {
        most = Math.max(most, ++asking)
        await new Promise(resolve => setTimeout(resolve, 1))
        asking--
        return summaryOf(r)
      },
    })

    await fill.start()

    expect(most).toBe(PEERTUBE_DETAILS_AT_ONCE)
  })

  it('keeps a video its instance has not as gone, and one it refuses as private', async () => {
    const { kept, fill } = setUp({
      refs: [ref(1), ref(2)],
      answer: async r => { throw new PlatformError(r.videoId === ref(1).videoId ? 'notFound' : 'refused', 'no') },
    })

    await fill.start()

    expect(kept[shareVideoKey(ref(1))]).toMatchObject({ unavailable: 'gone' })
    expect(kept[shareVideoKey(ref(2))]).toMatchObject({ unavailable: 'private' })
  })

  it('keeps nothing for a failure that says nothing of the video, asks it once in a start, and again on the next', async () => {
    const { deps, kept, fill } = setUp({ refs: [ref(1)], answer: async () => { throw new PlatformError('unavailable', 'down') } })

    await fill.start()

    expect(kept).toEqual({})
    expect(deps.request).toHaveBeenCalledTimes(1)
    expect(deps.onFailure).toHaveBeenCalled()

    await fill.start()

    expect(deps.request).toHaveBeenCalledTimes(2)
  })

  it('carries on past a video whose details cannot be kept', async () => {
    const { deps, fill } = setUp()
    deps.record.mockRejectedValueOnce(new Error('disk'))

    await fill.start()

    expect(deps.request).toHaveBeenCalledTimes(3)
    expect(fill.status().state).toBe('done')
  })

  it('skips a video another window has fetched meanwhile', async () => {
    const { deps, kept, fill } = setUp()
    deps.isDone.mockImplementation(key => key === shareVideoKey(ref(2)) || !needsDetails(kept[key], 10))

    await fill.start()

    expect(deps.request.mock.calls.map(([r]) => r.videoId)).not.toContain(ref(2).videoId)
  })

  it('takes in what arrived while it ran, when started again meanwhile', async () => {
    const { deps, fill, setOrder } = setUp({ refs: [ref(1)] })
    deps.request.mockImplementationOnce(async (r) => {
      setOrder([ref(1), ref(2)])
      fill.start()
      return summaryOf(r)
    })

    await fill.start()
    await vi.waitFor(() => expect(fill.status().state).toBe('done'))

    expect(deps.request.mock.calls.map(([r]) => r.videoId)).toEqual([ref(1).videoId, ref(2).videoId])
  })

  it('asks nothing while it may not (PeerTube switched off, the datastore unread)', async () => {
    const { deps, fill } = setUp({ enabled: () => false })

    await fill.start()

    expect(deps.missing).not.toHaveBeenCalled()
    expect(deps.request).not.toHaveBeenCalled()
    expect(fill.status().state).toBe('idle')
  })
})
