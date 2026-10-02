import { describe, expect, it } from 'vitest'

import { createPlatformLayer } from '../index'
import { createFakeFetch } from '../peertube/testing/fakeFetch'
import { createFakeYouTube } from './testing/fakeYouTube'

const PEERTUBE_REF = { platform: 'peertube', host: 'video.blender.org', videoId: '3d95fb3d-c866-42c8-9db1-fe82f48ccb95' }
const YOUTUBE_REF = 'dQw4w9WgXcQ'

const playable = {
  recordedAt: '2026-10-02',
  source: 'synthesised',
  call: `getLocalVideoInfo('${YOUTUBE_REF}')`,
  answer: { info: { playability_status: { status: 'OK' }, basic_info: { title: 'A YouTube video' } } },
}

function setUp() {
  const fakeFetch = createFakeFetch([])
  const fakeYouTube = createFakeYouTube({ getLocalVideoInfo: playable })
  const layer = createPlatformLayer({
    fetch: fakeFetch.fetch,
    youtube: fakeYouTube.youtube,
    config: { peertubeEnabled: true, backendPreference: 'local', backendFallback: false },
  })

  return { layer, fakeFetch, fakeYouTube }
}

async function failure(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a failure')
}

describe('routing a ref to its platform', () => {
  it('sends a YouTube video ref to the YouTube adapter and a PeerTube one to PeerTube, on one layer', async () => {
    const { layer, fakeFetch, fakeYouTube } = setUp()

    const youtubeVideo = await layer.getVideo(YOUTUBE_REF)

    expect(youtubeVideo.videoId).toBe(YOUTUBE_REF)
    expect(fakeYouTube.callsOf('getLocalVideoInfo')).toEqual([[YOUTUBE_REF]])
    expect(fakeFetch.requests).toHaveLength(0)

    // Nothing is registered on the fake fetch, so PeerTube fails as a network
    // failure does: what matters is that it asked PeerTube, not YouTube
    expect((await failure(layer.getVideo(PEERTUBE_REF))).kind).toBe('unavailable')
    expect(fakeFetch.requests.map(request => new URL(request.url).hostname)).toContain('video.blender.org')
    expect(fakeYouTube.calls).toHaveLength(1)
  })

  it('rejects a ref that is neither as invalid, asking nobody', async () => {
    const { layer, fakeFetch, fakeYouTube } = setUp()

    expect((await failure(layer.getVideo('not a ref'))).kind).toBe('invalid')
    expect((await failure(layer.getChannel('not a ref'))).kind).toBe('invalid')
    expect(fakeFetch.requests).toHaveLength(0)
    expect(fakeYouTube.calls).toHaveLength(0)
  })
})
