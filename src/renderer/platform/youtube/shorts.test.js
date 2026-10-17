import { describe, expect, it, vi } from 'vitest'

import { PlatformError } from '../errors'
import { createPlatformLayer } from '../index'
import { shortsOfFeed } from './shorts'
import { createFakeYouTube } from './testing/fakeYouTube'

import localSequence from './fixtures/local--shorts-sequence.json'
import localSequenceContinuation from './fixtures/local--shorts-sequence-continuation.json'

const SHORT = '4hDEK_1wPBk'

/** The recorded first page's shorts, its four ads gone */
const FIRST_PAGE = ['Ttz4sPWYuDo', 'pHSFL5cMFn4', '8VN0PS_R0S0', '7qDjsYmw-iM', 'ZrN_q4kLnCo', 'phLu1z6Iu1M', 'XLtcx5DXsXQ', 'NTx8QxiU-To', 'YvJ9dukCgqw', 'NyY2V7mH43c']
/** The recorded second page's shorts, its five ads gone */
const SECOND_PAGE = ['d8hlb1ByjiE', '7kwj0PivZaQ', 'LeOKNY5jdy4', 'NjZK3PusvH0', 'vvmZ1q9RXzg', 'E147qAF-ze8', 'tFm7kCvNRzM', 'CjiK_Hrl52g', '4Wg8z_uTBg8', 'kW1DLaAJo9I']

const ids = page => page.items.map(item => item.videoId)

/**
 * A `ShortFormVideoInfo` from the first page's fixture, continuing in place
 * into the second's, as youtubei.js does
 */
function localSequenceInstance() {
  const sequence = structuredClone(localSequence.answer)
  sequence.getWatchNextContinuation = vi.fn(async () => Object.assign(sequence, structuredClone(localSequenceContinuation.answer)))
  return sequence
}

function setUp({ config = {}, answers = {} } = {}) {
  const sequence = localSequenceInstance()
  const fake = createFakeYouTube({
    getLocalShortsSequence: async () => sequence,
    getLocalShortsSequenceContinuation: async seq => seq.wn_has_continuation ? seq.getWatchNextContinuation() : null,
    ...answers,
  })
  const layer = createPlatformLayer({
    fetch: () => Promise.reject(new TypeError('no network in tests')),
    youtube: fake.youtube,
    config: { backendPreference: 'local', backendFallback: false, ...config },
  })

  return { fake, layer, sequence }
}

describe('YouTube\'s shorts sequence', () => {
  it('is the shorts the feed names after the short, without its ads, from Local', async () => {
    const { fake, layer } = setUp()

    const page = await layer.listShortsSequence(SHORT)

    expect(ids(page)).toEqual(FIRST_PAGE)
    expect(page.items[0]).toEqual({ videoId: 'Ttz4sPWYuDo' })
    expect(page.cursor).not.toBeNull()
    expect(fake.callsOf('getLocalShortsSequence')).toEqual([[SHORT, false]])
  })

  it('asks in safety mode while only family friendly videos are shown', async () => {
    const { fake, layer } = setUp({ config: { showFamilyFriendlyOnly: true } })

    await layer.listShortsSequence(SHORT)

    expect(fake.callsOf('getLocalShortsSequence')).toEqual([[SHORT, true]])
  })

  it('continues the same sequence with the cursor, until the feed has no more', async () => {
    const { fake, layer, sequence } = setUp()

    const first = await layer.listShortsSequence(SHORT)
    const second = await layer.listShortsSequence(SHORT, { cursor: first.cursor })

    expect(ids(second)).toEqual(SECOND_PAGE)
    expect(fake.callsOf('getLocalShortsSequence')).toHaveLength(1)
    expect(fake.callsOf('getLocalShortsSequenceContinuation')).toEqual([[sequence]])

    sequence.wn_has_continuation = false
    const last = await layer.listShortsSequence(SHORT, { cursor: second.cursor })

    expect(last).toEqual({ items: [], cursor: null })
  })

  it('ends where the page says there is no more', async () => {
    const { layer, sequence } = setUp()
    sequence.wn_has_continuation = false

    expect((await layer.listShortsSequence(SHORT)).cursor).toBeNull()
  })

  it('is unavailable where Invidious alone is asked, without asking it or Local', async () => {
    const { fake, layer } = setUp({ config: { backendPreference: 'invidious' } })

    const error = await layer.listShortsSequence(SHORT).catch(e => e)

    expect(error).toBeInstanceOf(PlatformError)
    expect(error.kind).toBe('unavailable')
    expect(fake.calls).toEqual([])
  })

  it('is asked of Local where Invidious is preferred, with fallback on', async () => {
    const { fake, layer } = setUp({ config: { backendPreference: 'invidious', backendFallback: true } })

    expect(ids(await layer.listShortsSequence(SHORT))).toEqual(FIRST_PAGE)
    expect(fake.callsOf('getLocalShortsSequence')).toHaveLength(1)
  })

  it('fails as a platform error when Local fails', async () => {
    const { layer } = setUp({ answers: { getLocalShortsSequence: new TypeError('Failed to fetch') } })

    const error = await layer.listShortsSequence(SHORT).catch(e => e)

    expect(error).toBeInstanceOf(PlatformError)
  })

  it('is invalid for a PeerTube video, without a request', async () => {
    const { fake, layer } = setUp()

    const error = await layer.listShortsSequence({ platform: 'peertube', host: 'tube.example', videoId: '9c9de5e8-0a1e-484a-b099-e80766180a6d' }).catch(e => e)

    expect(error.kind).toBe('invalid')
    expect(fake.calls).toEqual([])
  })
})

describe('the shorts a page of the feed names', () => {
  const entry = payload => ({ type: 'NavigationEndpoint', name: 'reelWatchEndpoint', payload })

  it('drops ads, entries without a video id, and repeats', () => {
    expect(shortsOfFeed([
      entry({ videoId: 'aaaaaaaaaaa', overlay: {} }),
      entry({ videoId: 'bbbbbbbbbbb', adClientParams: {} }),
      entry({ playerParams: 'x' }),
      entry({ videoId: 'not an id' }),
      { type: 'NavigationEndpoint' },
      null,
      entry({ videoId: 'aaaaaaaaaaa', overlay: {} }),
      entry({ videoId: 'c-c_ccccccc', overlay: {} }),
    ])).toEqual([{ videoId: 'aaaaaaaaaaa' }, { videoId: 'c-c_ccccccc' }])
  })

  it('is none for a feed that is not a list', () => {
    expect(shortsOfFeed(undefined)).toEqual([])
  })
})
