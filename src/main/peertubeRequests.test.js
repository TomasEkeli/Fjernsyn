import { describe, expect, it } from 'vitest'

import { PEERTUBE_MARKER_CONFIRMED, PEERTUBE_MARKER_HEADER, PEERTUBE_MARKER_PROBE } from '../peerTubeHosts'
import { createPeerTubeRequestHeaders, peerTubeUserAgent } from './peertubeRequests'

const USER_AGENT = 'Fjernsyn/1.2.3 (+https://github.com/TomasEkeli/Fjernsyn)'
const CHROMIUM_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const APP_REFERER = 'http://localhost:9080/'

function create() {
  return createPeerTubeRequestHeaders({ userAgent: USER_AGENT })
}

/** Headers as a renderer request carries them, with the marker if given */
function browserHeaders(marker) {
  return {
    ...(marker ? { [PEERTUBE_MARKER_HEADER]: marker } : {}),
    'User-Agent': CHROMIUM_AGENT,
    Referer: APP_REFERER,
    Accept: 'application/json',
  }
}

const UNTOUCHED = { 'User-Agent': CHROMIUM_AGENT, Referer: APP_REFERER, Accept: 'application/json' }
const PEERTUBE = { 'User-Agent': USER_AGENT, Accept: 'application/json' }

describe('PeerTube request headers', () => {
  it('names Fjernsyn, its version and the project in the User-Agent', () => {
    expect(peerTubeUserAgent('1.2.3')).toBe(USER_AGENT)
  })

  it('gives a confirmed request the User-Agent, and drops the marker and the Referer', () => {
    const headers = browserHeaders(PEERTUBE_MARKER_CONFIRMED)

    expect(create().apply('https://video.blender.org/api/v1/videos/abc', headers)).toBe(true)
    expect(headers).toEqual(PEERTUBE)
  })

  it('recognises the marker and replaces the headers whatever their case', () => {
    const headers = {
      'x-fjernsyn-peertube': 'confirmed',
      'user-agent': CHROMIUM_AGENT,
      referer: APP_REFERER,
    }

    expect(create().apply('https://tilvids.com/api/v1/config', headers)).toBe(true)
    expect(headers).toEqual({ 'User-Agent': USER_AGENT })
  })

  it('treats later unmarked requests to a confirmed host the same way', () => {
    const requests = create()
    requests.apply('https://video.blender.org/api/v1/videos/abc', browserHeaders(PEERTUBE_MARKER_CONFIRMED))

    const image = browserHeaders()
    expect(requests.apply('https://VIDEO.blender.org/lazy-static/thumbnails/x.jpg', image)).toBe(true)
    expect(image).toEqual(PEERTUBE)
  })

  it('gives a probe the User-Agent, but does not remember its host', () => {
    const requests = create()
    const probe = browserHeaders(PEERTUBE_MARKER_PROBE)

    expect(requests.apply('https://maybe.example.org/api/v1/config', probe)).toBe(true)
    expect(probe).toEqual(PEERTUBE)

    const later = browserHeaders()
    expect(requests.apply('https://maybe.example.org/index.html', later)).toBe(false)
    expect(later).toEqual(UNTOUCHED)
  })

  it.each([
    'https://www.youtube.com/youtubei/v1/player',
    'https://rr1---sn-abc.googlevideo.com/videoplayback?id=1',
    'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  ])('never alters or learns a YouTube or Google host, however marked: %s', (url) => {
    const requests = create()

    for (const marker of [PEERTUBE_MARKER_CONFIRMED, PEERTUBE_MARKER_PROBE, '1']) {
      const marked = browserHeaders(marker)
      expect(requests.apply(url, marked)).toBe(false)
      expect(marked).toEqual(UNTOUCHED)
    }

    const later = browserHeaders()
    expect(requests.apply(url, later)).toBe(false)
    expect(later).toEqual(UNTOUCHED)
  })

  it('leaves unmarked requests to any other host untouched', () => {
    const requests = create()
    requests.apply('https://video.blender.org/api/v1/config', browserHeaders(PEERTUBE_MARKER_CONFIRMED))

    const headers = browserHeaders()
    expect(requests.apply('https://tilvids.com/api/v1/config', headers)).toBe(false)
    expect(headers).toEqual(UNTOUCHED)
  })

  it('tells hosts apart by port', () => {
    const requests = create()
    requests.apply('https://peertube.example.org:9000/api/v1/config', browserHeaders(PEERTUBE_MARKER_CONFIRMED))

    expect(requests.apply('https://peertube.example.org/static/x.png', browserHeaders())).toBe(false)
    expect(requests.apply('https://peertube.example.org:9000/static/x.png', browserHeaders())).toBe(true)
  })

  it('keeps what each instance has learnt to itself', () => {
    create().apply('https://video.blender.org/api/v1/config', browserHeaders(PEERTUBE_MARKER_CONFIRMED))

    expect(create().apply('https://video.blender.org/api/v1/config', browserHeaders())).toBe(false)
  })

  it('drops the marker even from a URL it cannot parse', () => {
    const headers = browserHeaders(PEERTUBE_MARKER_CONFIRMED)

    expect(create().apply('not a url', headers)).toBe(false)
    expect(headers).toEqual(UNTOUCHED)
  })
})
