import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getLocalChannelVideos } from '../api/local'
import { parseYouTubeRSSFeed } from '../subscriptions'
import { videosFeed } from './videos'
import { FETCH_OK } from '../subscriptionFetchStatus'

// The videos feed's YouTube ladder, local scraper first, with its edges
// replaced: the scraper and the RSS parser answer what each test says, and
// fetch stands in for the RSS endpoint.

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getBackendPreference: 'local',
        getBackendFallback: false,
        getCurrentInvidiousInstanceUrl: 'https://invidious.example',
      },
    }),
  }
})

vi.mock('../api/local', () => ({
  getLocalChannelVideos: vi.fn(),
}))

vi.mock('../api/invidious', () => ({
  getInvidiousChannelVideos: vi.fn(),
  invidiousFetch: vi.fn(),
}))

vi.mock('../subscriptions', () => ({
  parseYouTubeRSSFeed: vi.fn(),
  updateVideoListAfterProcessing: vi.fn(),
}))

vi.mock('../subscriptionChannelLiveness', () => ({
  probeChannelLiveness: vi.fn(),
}))

vi.mock('../utils', () => ({
  getChannelPlaylistId: vi.fn((id) => id.replace(/^UC/, 'UULF')),
  showToast: vi.fn(),
  copyToClipboard: vi.fn(),
}))

vi.mock('../../i18n/index', () => ({
  default: { global: { t: (key) => key } },
}))

const CHANNEL = Object.freeze({ id: 'UCW1rQvQViyJJv_dsq7E4xyQ', name: 'Trond Granlund - Topic' })

const SCRAPED = Object.freeze({ type: 'video', videoId: 'N-wHLE3HRYQ', title: 'Aleine i skauen', lengthSeconds: 239 })
const FROM_RSS = Object.freeze({ type: 'video', videoId: '7eFvY0KgH9w', title: 'Maggie-O' })

const RSS_URL = 'https://www.youtube.com/feeds/videos.xml?playlist_id=UULFW1rQvQViyJJv_dsq7E4xyQ'

/** @param {number} untitled */
function scraperAnswers(untitled) {
  getLocalChannelVideos.mockResolvedValue({
    name: CHANNEL.name,
    thumbnailUrl: 'https://yt3.ggpht.com/a=s88',
    videos: [SCRAPED],
    untitled
  })
}

function rssAnswers() {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<feed/>', { status: 200 }))
  parseYouTubeRSSFeed.mockResolvedValue({ videos: [FROM_RSS], name: CHANNEL.name })
}

function rssFails() {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('no network in tests'))
}

beforeEach(() => {
  getLocalChannelVideos.mockReset()
  parseYouTubeRSSFeed.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the local scraper rung', () => {
  it('answers with what it scraped when every entry came with a title', async () => {
    scraperAnswers(0)
    rssAnswers()

    const result = await videosFeed.fetchChannel(CHANNEL, { useRss: false })

    expect(result).toMatchObject({ status: FETCH_OK, entries: [SCRAPED] })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('asks RSS instead when YouTube left titles out, without calling it an error', async () => {
    scraperAnswers(74)
    rssAnswers()

    const result = await videosFeed.fetchChannel(CHANNEL, { useRss: false })

    expect(globalThis.fetch).toHaveBeenCalledWith(RSS_URL)
    expect(result).toMatchObject({ status: FETCH_OK, entries: [FROM_RSS] })
    expect(console.error).not.toHaveBeenCalled()
  })

  it('keeps the titled entries when RSS is what already failed', async () => {
    rssFails()
    scraperAnswers(74)

    const result = await videosFeed.fetchChannel(CHANNEL, { useRss: true })

    expect(result).toMatchObject({ status: FETCH_OK, entries: [SCRAPED] })
    // the one failed RSS request, and no second go at it
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })
})
