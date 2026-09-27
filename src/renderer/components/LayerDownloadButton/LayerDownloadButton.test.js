import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ytDlpDownloads } from '../../helpers/ytdlpDownloads'
import { isPeerTubeEnabled } from '../../platform/vue'
import { mountWithApp } from '../../testing/mount'
import LayerDownloadButton from './LayerDownloadButton.vue'

// platform/vue reaches the router through helpers/utils, and the router every
// view, this button's watch page included: a cycle back into the mock below
vi.mock('../../router/index', () => ({ default: {} }))

vi.mock('../../i18n/index', async () => {
  const { createTestI18n } = await import('../../testing/i18n')
  return { default: createTestI18n() }
})

// Whether PeerTube is switched on is the store's, which the wiring reads; the
// button is mounted without the wiring
vi.mock('../../platform/vue', async (importOriginal) => ({
  ...(await importOriginal()),
  isPeerTubeEnabled: vi.fn(() => true),
}))

const HOST = 'tilvids.com'
const UUID = '9c9de5e8-0a1e-484a-b099-e80766180a6d'
const KEY = `peertube:${HOST}:${UUID}`
const PAGE_URL = `https://${HOST}/w/kkGMgK9ZtnKfYAgnEtQxbv`

const OPTIONS = [
  { id: '1080', label: '1080p', resolution: 1080, height: 1080, sizeBytes: 1_200_000_000, url: `https://${HOST}/download/web-videos/${UUID}-1080.mp4`, kind: 'muxed' },
  { id: '720', label: '720p', resolution: 720, height: 720, sizeBytes: 640_000_000, url: `https://${HOST}/download/videos/generate/${UUID}?videoFileIds=12&videoFileIds=9`, kind: 'generated' },
  { id: 'audio', label: 'Audio only', resolution: 0, height: null, sizeBytes: 48_000_000, url: `https://${HOST}/download/web-videos/${UUID}-0.mp4`, kind: 'audio' },
]

function video(overrides = {}) {
  return {
    type: 'video',
    platform: 'peertube',
    host: HOST,
    videoId: UUID,
    title: 'Ungoogled Chromium in five minutes',
    url: PAGE_URL,
    liveNow: false,
    isUpcoming: false,
    liveStatus: null,
    downloadEnabled: true,
    downloadOptions: OPTIONS,
    ...overrides,
  }
}

/** @type {{ name: string, args: unknown[] }[]} */
let calls

beforeEach(() => {
  calls = []
  const record = name => (...args) => { calls.push({ name, args }) }
  window.ftElectron = {
    peerTubeDownload: record('peerTubeDownload'),
    peerTubeReveal: record('peerTubeReveal'),
    ytDlpReveal: record('ytDlpReveal'),
  }
  isPeerTubeEnabled.mockReset().mockReturnValue(true)
})

afterEach(() => {
  delete window.ftElectron
  for (const key of Object.keys(ytDlpDownloads.byId)) {
    delete ytDlpDownloads.byId[key]
  }
  for (const key of Object.keys(ytDlpDownloads.finished)) {
    delete ytDlpDownloads.finished[key]
  }
  ytDlpDownloads.panelOpen = false
})

function mountButton(props = {}) {
  return mountWithApp(LayerDownloadButton, { props: { video: video(), ...props } })
}

/**
 * A right click, as FtIconButton reads one: jsdom has no PointerEvent, so a
 * mouse event of that name
 */
async function rightClick(wrapper) {
  wrapper.find('button').element.dispatchEvent(new MouseEvent('pointerdown', { button: 2, bubbles: true }))
  await flushPromises()
}

/**
 * Opens the dropdown with a right click and picks the option with this text.
 */
async function choose(wrapper, text) {
  await rightClick(wrapper)
  const option = wrapper.findAll('li').find(item => item.text() === text)
  expect(option, `no option "${text}" in ${wrapper.findAll('li').map(item => item.text())}`).toBeDefined()
  await option.trigger('click')
}

function downloadsAsked() {
  return calls.filter(call => call.name === 'peerTubeDownload').map(call => call.args[0])
}

/** A download as main's PeerTube service reports it */
function snapshot(overrides = {}) {
  return {
    videoId: KEY,
    title: 'Ungoogled Chromium in five minutes',
    status: 'downloading',
    folder: '/home/me/Videos',
    destination: '/home/me/Videos/Ungoogled Chromium in five minutes [1080p].mp4',
    resuming: false,
    quality: '1080p',
    height: 1080,
    audioOnly: false,
    part: null,
    parts: null,
    partKind: 'both',
    downloadedBytes: 300_000_000,
    totalBytes: 1_200_000_000,
    speed: 2_000_000,
    eta: 450,
    reason: null,
    exitCode: null,
    endedAt: null,
    ...overrides,
  }
}

describe('LayerDownloadButton, when it is offered', () => {
  it('is there for a video with download options', () => {
    expect(mountButton().find('button').exists()).toBe(true)
  })

  it('is not there without download options, as when the author has disabled downloads', () => {
    expect(mountButton({ video: video({ downloadEnabled: false, downloadOptions: [] }) }).find('button').exists()).toBe(false)
  })

  it('is not there for a live, whatever options it carries', () => {
    const live = video({ liveNow: true, liveStatus: 'live' })
    expect(mountButton({ video: live }).find('button').exists()).toBe(false)
  })

  it('is not there while PeerTube is switched off', () => {
    isPeerTubeEnabled.mockReturnValue(false)
    expect(mountButton().find('button').exists()).toBe(false)
  })
})

describe('LayerDownloadButton, starting a download', () => {
  it('downloads the best option on a plain click', async () => {
    const wrapper = mountButton()

    await wrapper.find('button').trigger('click')

    expect(downloadsAsked()).toEqual([{
      key: KEY,
      url: OPTIONS[0].url,
      title: 'Ungoogled Chromium in five minutes',
      label: '1080p',
      resolution: 1080,
      audioOnly: false,
      videoUrl: PAGE_URL,
    }])
  })

  it('offers each resolution with its size, and audio only, on a right click', async () => {
    const wrapper = mountButton()

    await rightClick(wrapper)

    expect(wrapper.findAll('li').map(item => item.text())).toEqual([
      '1080p (1.2 GB)',
      '720p (640 MB)',
      'Audio only (48 MB)',
    ])
  })

  it('downloads the resolution chosen, a split-audio one through its generate URL', async () => {
    const wrapper = mountButton()

    await choose(wrapper, '720p (640 MB)')

    expect(downloadsAsked()).toEqual([{
      key: KEY,
      url: OPTIONS[1].url,
      title: 'Ungoogled Chromium in five minutes',
      label: '720p',
      resolution: 720,
      audioOnly: false,
      videoUrl: PAGE_URL,
    }])
  })

  it('downloads the audio alone when that is chosen', async () => {
    const wrapper = mountButton()

    await choose(wrapper, 'Audio only (48 MB)')

    expect(downloadsAsked()).toEqual([{
      key: KEY,
      url: OPTIONS[2].url,
      title: 'Ungoogled Chromium in five minutes',
      label: 'Audio only',
      resolution: 0,
      audioOnly: true,
      videoUrl: PAGE_URL,
    }])
  })

  it('names an option without a known size by its resolution alone', async () => {
    const wrapper = mountButton({ video: video({ downloadOptions: [{ ...OPTIONS[0], sizeBytes: null }] }) })

    await rightClick(wrapper)

    expect(wrapper.findAll('li').map(item => item.text())).toEqual(['1080p'])
  })

  it('builds a key main accepts from a host and uuid in any case', async () => {
    const wrapper = mountButton({ video: video({ host: 'TilVids.com', videoId: UUID.toUpperCase() }) })

    await wrapper.find('button').trigger('click')

    expect(downloadsAsked()[0].key).toBe(KEY)
  })

  it('downloads the audio on a plain click when that is all there is', async () => {
    const wrapper = mountButton({ video: video({ downloadOptions: [OPTIONS[2]] }) })

    await wrapper.find('button').trigger('click')

    expect(downloadsAsked()[0]).toMatchObject({ label: 'Audio only', resolution: 0, audioOnly: true })
  })
})

describe('LayerDownloadButton, through the download\'s life', () => {
  it('shows progress while downloading, with the stage, percent, time left and destination', () => {
    ytDlpDownloads.byId[KEY] = snapshot()
    const wrapper = mountButton()

    expect(wrapper.find('.progressRing').exists()).toBe(true)
    const title = wrapper.find('button').attributes('title')
    expect(title).toContain('Downloading')
    expect(title).toContain('25% of 1.2 GB')
    expect(title).toContain('8 min left')
    expect(title).toContain('Saving to /home/me/Videos/Ungoogled Chromium in five minutes [1080p].mp4')
  })

  it('opens the downloads panel when pressed while downloading, rather than starting another', async () => {
    ytDlpDownloads.byId[KEY] = snapshot()
    const wrapper = mountButton()

    await wrapper.find('button').trigger('click')

    expect(ytDlpDownloads.panelOpen).toBe(true)
    expect(downloadsAsked()).toEqual([])
  })

  it('becomes Show in folder once finished, and reveals the file through PeerTube\'s service', async () => {
    const path = '/home/me/Videos/Ungoogled Chromium in five minutes [1080p].mp4'
    ytDlpDownloads.byId[KEY] = snapshot({ status: 'finished', endedAt: Date.now() })
    ytDlpDownloads.finished[KEY] = path
    const wrapper = mountButton()

    expect(wrapper.find('.progressRing').exists()).toBe(false)
    expect(wrapper.find('button').attributes('title')).toContain(`Show in folder: ${path}`)

    await wrapper.find('button').trigger('click')

    expect(calls).toEqual([{ name: 'peerTubeReveal', args: [KEY] }])
  })

  it('stays Show in folder on coming back, from what main remembers, and offers to download again', async () => {
    ytDlpDownloads.finished[KEY] = '/home/me/Videos/Ungoogled Chromium in five minutes [1080p].mp4'
    const wrapper = mountButton()

    await choose(wrapper, 'Download again: 720p (640 MB)')

    expect(downloadsAsked()).toEqual([expect.objectContaining({ key: KEY, label: '720p', url: OPTIONS[1].url })])
  })

  it('reveals from the finished dropdown too', async () => {
    ytDlpDownloads.finished[KEY] = '/home/me/Videos/a.mp4'
    const wrapper = mountButton()

    await choose(wrapper, 'Show in Folder')

    expect(calls).toEqual([{ name: 'peerTubeReveal', args: [KEY] }])
  })

  it.each(['failed', 'cancelled'])('is back to download after the download %s', async (status) => {
    ytDlpDownloads.byId[KEY] = snapshot({ status, reason: status === 'failed' ? 'HTTP 403' : null, endedAt: Date.now() })
    ytDlpDownloads.finished[KEY] = '/home/me/Videos/earlier.mp4'
    const wrapper = mountButton()

    expect(wrapper.find('.progressRing').exists()).toBe(false)
    await wrapper.find('button').trigger('click')
    await flushPromises()

    expect(downloadsAsked()).toHaveLength(1)
  })

  it('follows the store as the download moves on', async () => {
    const wrapper = mountButton()
    expect(wrapper.find('.progressRing').exists()).toBe(false)

    ytDlpDownloads.byId[KEY] = snapshot()
    await flushPromises()
    expect(wrapper.find('.progressRing').exists()).toBe(true)

    ytDlpDownloads.byId[KEY] = snapshot({ status: 'finished', endedAt: Date.now() })
    ytDlpDownloads.finished[KEY] = '/home/me/Videos/a.mp4'
    await flushPromises()
    expect(wrapper.find('.progressRing').exists()).toBe(false)
    expect(wrapper.find('button').attributes('title')).toContain('Show in folder: /home/me/Videos/a.mp4')
  })

  it('is not taken over by a download of another video', () => {
    ytDlpDownloads.byId[`peertube:${HOST}:7243ebe1-8a4c-4d1b-9a4f-0c3a1a0e1f11`] = snapshot({ videoId: `peertube:${HOST}:7243ebe1-8a4c-4d1b-9a4f-0c3a1a0e1f11` })

    expect(mountButton().find('.progressRing').exists()).toBe(false)
  })
})
