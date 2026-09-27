import { describe, expect, it, vi } from 'vitest'

import { statusText, whereText } from './ytdlpDownloads'

vi.mock('../i18n/index', async () => {
  const { createTestI18n } = await import('../testing/i18n')
  return { default: createTestI18n() }
})

const PEERTUBE_KEY = 'peertube:tilvids.com:9c9de5e8-0a1e-484a-b099-e80766180a6d'

/**
 * @param {object} overrides
 */
function download(overrides) {
  return {
    videoId: PEERTUBE_KEY,
    title: 'A video',
    status: 'downloading',
    folder: '/home/tomas/Downloads',
    destination: '/home/tomas/Downloads/A video [1080p].mp4',
    reason: null,
    exitCode: null,
    ...overrides,
  }
}

describe('where a download is going, in the panel', () => {
  it('says nothing of a path for a PeerTube download that did not finish, since nothing is kept', () => {
    expect(whereText(download({ status: 'failed', reason: 'HTTP 403' }))).toBe('')
    expect(whereText(download({ status: 'cancelled' }))).toBe('')
  })

  it('gives the path for a PeerTube download under way or finished', () => {
    expect(whereText(download({ status: 'downloading' }))).toBe('Saving to /home/tomas/Downloads/A video [1080p].mp4')
    expect(whereText(download({ status: 'finished' }))).toBe('Saved to /home/tomas/Downloads/A video [1080p].mp4')
  })

  it('still says where a yt-dlp download was saving to, since its partial files stay', () => {
    expect(whereText(download({ videoId: 'dQw4w9WgXcQ', status: 'cancelled' }))).toBe('Was saving to /home/tomas/Downloads/A video [1080p].mp4')
  })

  it('says a cancelled PeerTube download starts over, not resumes', () => {
    expect(statusText(download({ status: 'cancelled' }))).toBe('Cancelled. Nothing was kept, press download again to start over')
    expect(statusText(download({ videoId: 'dQw4w9WgXcQ', status: 'cancelled' }))).toBe('Cancelled. Press download again to resume')
  })
})
