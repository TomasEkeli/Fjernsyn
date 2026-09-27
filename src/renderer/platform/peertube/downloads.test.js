import { describe, expect, it } from 'vitest'

import { downloadOptionsFor } from './downloads'

import blenderHls from './fixtures/video.blender.org--video-hls.json'
import fourD2Video from './fixtures/video.4d2.org--video-split-audio.json'
import liveNow from './fixtures/peertube.livespotting.com--video-live.json'
import marcoWaiting from './fixtures/video.marcorennmaus.de--video-live-waiting-no-download.json'
import tilvidsVideo from './fixtures/tilvids.com--video-hls-downloads.json'

const TILVIDS_UUID = tilvidsVideo.body.uuid
const FOUR_D2_UUID = fourD2Video.body.uuid
const BLENDER_UUID = blenderHls.body.uuid

describe('downloadOptionsFor', () => {
  it('offers each muxed HLS file from its own download URL, and the audio-only file last (tilvids.com)', () => {
    expect(downloadOptionsFor(tilvidsVideo.body, 'tilvids.com')).toEqual([
      {
        id: '720',
        label: '720p',
        resolution: 720,
        height: 720,
        sizeBytes: 271650158,
        url: `https://tilvids.com/download/streaming-playlists/hls/videos/${TILVIDS_UUID}-720-fragmented.mp4`,
        kind: 'muxed',
      },
      {
        id: '360',
        label: '360p',
        resolution: 360,
        height: 360,
        sizeBytes: 114420047,
        url: `https://tilvids.com/download/streaming-playlists/hls/videos/${TILVIDS_UUID}-360-fragmented.mp4`,
        kind: 'muxed',
      },
      {
        id: '144',
        label: '144p',
        resolution: 144,
        height: 144,
        sizeBytes: 55356842,
        url: `https://tilvids.com/download/streaming-playlists/hls/videos/${TILVIDS_UUID}-144-fragmented.mp4`,
        kind: 'muxed',
      },
      {
        id: 'audio',
        label: 'Audio only',
        resolution: 0,
        height: null,
        sizeBytes: 29784790,
        url: `https://tilvids.com/download/web-videos/${TILVIDS_UUID}-0.mp4`,
        kind: 'audio',
      },
    ])
  })

  it('muxes a video-only resolution with the audio through the generate endpoint, by both file ids (video.4d2.org)', () => {
    const options = downloadOptionsFor(fourD2Video.body, 'video.4d2.org')

    expect(options.map(({ id, kind }) => [id, kind])).toEqual([
      ['1080', 'generated'],
      ['720', 'generated'],
      ['480', 'generated'],
      ['240', 'generated'],
      ['audio', 'audio'],
    ])
    // The video file 4380856 (1080p) with the playlist's own audio file 4380855
    expect(options[0]).toEqual({
      id: '1080',
      label: '1080p',
      resolution: 1080,
      height: 1080,
      sizeBytes: 838722692 + 31946956,
      url: `https://video.4d2.org/download/videos/generate/${FOUR_D2_UUID}?videoFileIds=4380856&videoFileIds=4380855`,
      kind: 'generated',
    })
    expect(options[3].url).toBe(`https://video.4d2.org/download/videos/generate/${FOUR_D2_UUID}?videoFileIds=4380859&videoFileIds=4380855`)
  })

  it('offers the audio-only Web Video file for audio, before the HLS fragment (video.4d2.org)', () => {
    const audio = downloadOptionsFor(fourD2Video.body, 'video.4d2.org').at(-1)

    expect(audio).toEqual({
      id: 'audio',
      label: 'Audio only',
      resolution: 0,
      height: null,
      sizeBytes: 39088339,
      url: `https://video.4d2.org/download/web-videos/${FOUR_D2_UUID}-0.mp4`,
      kind: 'audio',
    })
  })

  it('prefers the Web Video file over the HLS fragment for the same resolution (video.blender.org)', () => {
    expect(downloadOptionsFor(blenderHls.body, 'video.blender.org').map(({ id, sizeBytes, url }) => [id, sizeBytes, url])).toEqual([
      ['1080', 23262402, `https://video.blender.org/download/web-videos/${BLENDER_UUID}-1080.mp4`],
      ['480', 8320545, `https://video.blender.org/download/web-videos/${BLENDER_UUID}-480.mp4`],
      ['audio', 2799967, `https://video.blender.org/download/web-videos/${BLENDER_UUID}-0.mp4`],
    ])
  })

  it('offers nothing when the author has disabled downloads', () => {
    expect(downloadOptionsFor(marcoWaiting.body, 'video.marcorennmaus.de')).toEqual([])

    // A variant of the blender recording, which has files, with downloads off
    expect(downloadOptionsFor({ ...blenderHls.body, downloadEnabled: false }, 'video.blender.org')).toEqual([])
  })

  it('offers nothing for a live', () => {
    expect(liveNow.body.downloadEnabled).toBe(true)
    expect(downloadOptionsFor(liveNow.body, 'peertube.livespotting.com')).toEqual([])
  })

  it('makes a relative download URL absolute on the host', () => {
    // A variant of the tilvids recording with a path for a download URL
    const video = structuredClone(tilvidsVideo.body)
    video.streamingPlaylists[0].files[0].fileDownloadUrl = `/download/streaming-playlists/hls/videos/${TILVIDS_UUID}-720-fragmented.mp4`

    expect(downloadOptionsFor(video, 'tilvids.com')[0].url)
      .toBe(`https://tilvids.com/download/streaming-playlists/hls/videos/${TILVIDS_UUID}-720-fragmented.mp4`)
  })

  it('leaves out a video-only resolution when there is no audio file to mux it with', () => {
    // A variant of the 4d2 recording without its audio-only files
    const video = structuredClone(fourD2Video.body)
    video.files = []
    video.streamingPlaylists[0].files = video.streamingPlaylists[0].files.filter(file => file.resolution.id !== 0)

    expect(downloadOptionsFor(video, 'video.4d2.org')).toEqual([])
  })

  it('never offers a URL that is not http(s)', () => {
    const video = structuredClone(tilvidsVideo.body)
    video.streamingPlaylists[0].files[0].fileDownloadUrl = 'javascript:alert(1)'

    expect(downloadOptionsFor(video, 'tilvids.com').map(option => option.id)).toEqual(['360', '144', 'audio'])
  })

  it('answers nothing for what is not a video', () => {
    expect(downloadOptionsFor(null, 'tilvids.com')).toEqual([])
    expect(downloadOptionsFor({ downloadEnabled: true }, 'tilvids.com')).toEqual([])
  })
})
