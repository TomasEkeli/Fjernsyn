import { describe, expect, it } from 'vitest'

import { isValidDownloadKey, keyHost, validateDownloadRequest } from './request'

const UUID = '9c9de5e8-0a1e-484a-b099-e80766180a6d'
const KEY = `peertube:tilvids.com:${UUID}`
const URL_ = `https://tilvids.com/download/web-videos/${UUID}-1080.mp4`

/**
 * @param {object} overrides
 */
function request(overrides = {}) {
  return { key: KEY, url: URL_, title: 'A video', label: '1080p', resolution: 1080, audioOnly: false, ...overrides }
}

describe('isValidDownloadKey', () => {
  it('takes a PeerTube key, with or without a resolution suffix', () => {
    expect(isValidDownloadKey(KEY)).toBe(true)
    expect(isValidDownloadKey(`${KEY}:1080`)).toBe(true)
    expect(isValidDownloadKey(`${KEY}:audio`)).toBe(true)
  })

  it('refuses a YouTube video id, so that the two can never collide', () => {
    expect(isValidDownloadKey('dQw4w9WgXcQ')).toBe(false)
  })

  it('refuses anything that is not quite a PeerTube key', () => {
    for (const key of [
      undefined,
      null,
      42,
      '',
      `peertube:TILVIDS.com:${UUID}`,
      `peertube:tilvids.com/x:${UUID}`,
      `peertube:tilvids.com:${UUID.slice(1)}`,
      `peertube::${UUID}`,
      `youtube:tilvids.com:${UUID}`,
      `peertube:tilvids.com:${UUID}:../x`,
      `${KEY}\n`,
    ]) {
      expect(isValidDownloadKey(key), String(key)).toBe(false)
    }
  })

  it('gives the host of a key', () => {
    expect(keyHost(`${KEY}:720`)).toBe('tilvids.com')
  })
})

describe('validateDownloadRequest', () => {
  it('passes a well-formed request through, normalised', () => {
    expect(validateDownloadRequest(request({ videoUrl: `https://tilvids.com/w/${UUID}` }))).toEqual({
      key: KEY,
      url: URL_,
      title: 'A video',
      label: '1080p',
      resolution: 1080,
      audioOnly: false,
      videoUrl: `https://tilvids.com/w/${UUID}`,
    })
  })

  it('refuses a payload that is not an object', () => {
    expect(validateDownloadRequest(null)).toBeNull()
    expect(validateDownloadRequest('https://tilvids.com/download/x.mp4')).toBeNull()
  })

  it('refuses a bad key, and a YouTube id as the key', () => {
    expect(validateDownloadRequest(request({ key: 'peertube:nope' }))).toBeNull()
    expect(validateDownloadRequest(request({ key: 'dQw4w9WgXcQ' }))).toBeNull()
  })

  it('refuses a URL that is not https', () => {
    for (const url of [
      `file:///home/tomas/${UUID}-1080.mp4`,
      `ftp://tilvids.com/download/web-videos/${UUID}-1080.mp4`,
      'javascript:alert(1)//x.mp4',
      'data:video/mp4;base64,AAAA.mp4',
      'not a url',
      42,
    ]) {
      expect(validateDownloadRequest(request({ url })), String(url)).toBeNull()
    }
  })

  it('refuses plain http, even from the instance the key names', () => {
    expect(validateDownloadRequest(request({ url: `http://tilvids.com/download/web-videos/${UUID}-1080.mp4` }))).toBeNull()
    expect(validateDownloadRequest(request({ url: `http://elsewhere.example/download/web-videos/${UUID}-1080.mp4` }))).toBeNull()
  })

  it('refuses credentials in the URL', () => {
    expect(validateDownloadRequest(request({ url: `https://user:pass@tilvids.com/download/web-videos/${UUID}-1080.mp4` }))).toBeNull()
  })

  it('takes the instance download and static paths', () => {
    for (const path of [
      `/download/web-videos/${UUID}-1080.mp4`,
      `/download/streaming-playlists/hls/videos/${UUID}-720-fragmented.mp4`,
      `/download/videos/generate/${UUID}?videoFileIds=12&videoFileIds=13`,
      `/static/web-videos/${UUID}-480.mp4`,
      `/lazy-static/web-videos/${UUID}-480`,
      `/object-storage/web-videos/${UUID}-480`,
      `/object-storage-proxy/web-videos/${UUID}-480`,
    ]) {
      expect(validateDownloadRequest(request({ url: `https://tilvids.com${path}` })), path).not.toBeNull()
    }
  })

  it('takes a media file on another host, as object storage serves it', () => {
    for (const ext of ['mp4', 'm4a', 'mp3', 'ogg', 'webm', 'MP4']) {
      const url = `https://bucket.s3.example.net/web-videos/${UUID}-1080.${ext}`
      expect(validateDownloadRequest(request({ url })), url).not.toBeNull()
    }
  })

  it('refuses a path that is neither a download nor a media file', () => {
    for (const url of [
      `https://tilvids.com/api/v1/videos/${UUID}`,
      'https://tilvids.com/',
      'https://evil.example/steal',
      'https://evil.example/download.mp4.exe',
      'https://evil.example/x/download/y',
    ]) {
      expect(validateDownloadRequest(request({ url })), url).toBeNull()
    }
  })

  it('caps the title and label, and makes anything else a string', () => {
    const long = validateDownloadRequest(request({ title: 'x'.repeat(1000), label: 'y'.repeat(200) }))
    expect(long.title).toHaveLength(300)
    expect(long.label).toHaveLength(40)

    const odd = validateDownloadRequest(request({ title: { toString: () => 'x' }, label: 7 }))
    expect(odd.title).toBe('')
    expect(odd.label).toBe('')
  })

  it('keeps a resolution only when it is a sane whole number', () => {
    expect(validateDownloadRequest(request({ resolution: 0, audioOnly: true })).resolution).toBe(0)
    expect(validateDownloadRequest(request({ resolution: -1 })).resolution).toBeNull()
    expect(validateDownloadRequest(request({ resolution: 1080.5 })).resolution).toBeNull()
    expect(validateDownloadRequest(request({ resolution: '1080' })).resolution).toBeNull()
    expect(validateDownloadRequest(request({ resolution: 100000 })).resolution).toBeNull()
  })

  it('takes audio only as a boolean and nothing else', () => {
    expect(validateDownloadRequest(request({ audioOnly: 'yes' })).audioOnly).toBe(false)
    expect(validateDownloadRequest(request({ audioOnly: true })).audioOnly).toBe(true)
  })

  it('drops a video page URL that is not http(s)', () => {
    expect(validateDownloadRequest(request({ videoUrl: 'javascript:alert(1)' })).videoUrl).toBeNull()
    expect(validateDownloadRequest(request()).videoUrl).toBeNull()
  })
})
