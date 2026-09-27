import { beforeEach, describe, expect, it } from 'vitest'

import {
  cancelDownload,
  dismissDownloadInMain,
  downloadFromPeerTube,
  isPeerTubeDownloadKey,
  listAllDownloads,
  revealDownload,
} from './downloads'

const PEERTUBE_KEY = 'peertube:tilvids.com:9c9de5e8-0a1e-484a-b099-e80766180a6d'
const YOUTUBE_ID = 'dQw4w9WgXcQ'

/** @type {{ name: string, args: unknown[] }[]} */
let calls

/**
 * @param {Record<string, (...args: any[]) => any>} [overrides]
 */
function fakeFtElectron(overrides = {}) {
  const record = name => (...args) => {
    calls.push({ name, args })
  }

  window.ftElectron = {
    ytDlpCancel: record('ytDlpCancel'),
    ytDlpReveal: record('ytDlpReveal'),
    ytDlpDismiss: record('ytDlpDismiss'),
    peerTubeDownload: record('peerTubeDownload'),
    peerTubeCancel: record('peerTubeCancel'),
    peerTubeReveal: record('peerTubeReveal'),
    peerTubeDismiss: record('peerTubeDismiss'),
    ytDlpListDownloads: async () => ({ downloads: [{ videoId: YOUTUBE_ID }], finished: { [YOUTUBE_ID]: '/d/yt.mp4' } }),
    peerTubeListDownloads: async () => ({ downloads: [{ videoId: PEERTUBE_KEY }], finished: { [PEERTUBE_KEY]: '/d/pt.mp4' } }),
    ...overrides,
  }
}

beforeEach(() => {
  calls = []
  fakeFtElectron()
})

describe('the download key', () => {
  it('tells a PeerTube key from a YouTube video id', () => {
    expect(isPeerTubeDownloadKey(PEERTUBE_KEY)).toBe(true)
    expect(isPeerTubeDownloadKey(YOUTUBE_ID)).toBe(false)
  })
})

describe('the panel actions, by key', () => {
  it('cancel goes to PeerTube for a PeerTube key, and to yt-dlp otherwise', () => {
    cancelDownload(PEERTUBE_KEY)
    cancelDownload(YOUTUBE_ID)

    expect(calls).toEqual([
      { name: 'peerTubeCancel', args: [PEERTUBE_KEY] },
      { name: 'ytDlpCancel', args: [YOUTUBE_ID] },
    ])
  })

  it('show in folder goes to PeerTube for a PeerTube key, and to yt-dlp otherwise', () => {
    revealDownload(PEERTUBE_KEY)
    revealDownload(YOUTUBE_ID)

    expect(calls).toEqual([
      { name: 'peerTubeReveal', args: [PEERTUBE_KEY] },
      { name: 'ytDlpReveal', args: [YOUTUBE_ID] },
    ])
  })

  it('dismiss goes to PeerTube for a PeerTube key, and to yt-dlp otherwise', () => {
    dismissDownloadInMain(PEERTUBE_KEY)
    dismissDownloadInMain(YOUTUBE_ID)

    expect(calls).toEqual([
      { name: 'peerTubeDismiss', args: [PEERTUBE_KEY] },
      { name: 'ytDlpDismiss', args: [YOUTUBE_ID] },
    ])
  })
})

describe('listAllDownloads', () => {
  it('merges what both services know', async () => {
    expect(await listAllDownloads()).toEqual({
      downloads: [{ videoId: YOUTUBE_ID }, { videoId: PEERTUBE_KEY }],
      finished: { [YOUTUBE_ID]: '/d/yt.mp4', [PEERTUBE_KEY]: '/d/pt.mp4' },
    })
  })

  it('still gives the yt-dlp ones when PeerTube cannot answer', async () => {
    fakeFtElectron({ peerTubeListDownloads: async () => { throw new Error('no handler') } })

    expect(await listAllDownloads()).toEqual({
      downloads: [{ videoId: YOUTUBE_ID }],
      finished: { [YOUTUBE_ID]: '/d/yt.mp4' },
    })
  })
})

describe('downloadFromPeerTube', () => {
  it('hands the request to main', () => {
    const request = {
      key: PEERTUBE_KEY,
      url: 'https://tilvids.com/download/web-videos/x-1080.mp4',
      title: 'A video',
      label: '1080p',
      resolution: 1080,
      audioOnly: false,
      videoUrl: 'https://tilvids.com/w/x',
    }

    downloadFromPeerTube(request)

    expect(calls).toEqual([{ name: 'peerTubeDownload', args: [request] }])
  })
})
