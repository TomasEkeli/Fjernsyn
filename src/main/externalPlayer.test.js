import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { peerTubeWatchUrl } from './peertubeExternalPlayer'
import { handleOpenInExternalPlayer } from './externalPlayer'
import { spawn } from 'node:child_process'

const SETTINGS = vi.hoisted(() => ({ values: {} }))

vi.mock('../datastores/handlers/base', () => ({
  settings: {
    _findOne: async (id) => (id in SETTINGS.values ? { _id: id, value: SETTINGS.values[id] } : null),
  },
}))

vi.mock('./utils', () => ({ isFreeTubeUrl: () => true }))

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ unref: () => {} })),
}))

// The player map is read relative to the built main bundle; hand over the real one
vi.mock('node:fs/promises', async () => {
  const { readFileSync } = await import('node:fs')
  return { readFile: async () => readFileSync(join(process.cwd(), 'static/external-player-map.json')) }
})

const UUID = 'b29290cc-dc51-4a12-bcb2-2aa5fece7605'
const WATCH_URL = `https://video.blender.org/videos/watch/${UUID}`
const YOUTUBE_ID = 'dQw4w9WgXcQ'

function fakeEvent() {
  return {
    senderFrame: { url: 'app://bundle/index.html' },
    sender: { isFocused: () => true },
    reply: vi.fn(),
  }
}

/**
 * The arguments the player is started with, or null when it is not started
 *
 * @param {object} payload
 */
async function argsFor(payload) {
  spawn.mockClear()
  const event = fakeEvent()

  await handleOpenInExternalPlayer(event, payload)

  return spawn.mock.calls.length === 0 ? null : spawn.mock.calls[0][1]
}

describe('peerTubeWatchUrl', () => {
  it.each([
    [WATCH_URL],
    ['https://video.blender.org/w/9c9de5e8-0a1e-484a-b099-e80766180a6d'],
    ['https://tilvids.com/w/kkGMgK9ZtnKfYAgnEtQxbv'],
  ])('accepts a PeerTube watch URL: %s', (url) => {
    expect(peerTubeWatchUrl(url)).toBe(url)
  })

  it('hands over the watch URL alone, without query or fragment', () => {
    expect(peerTubeWatchUrl(`${WATCH_URL}?start=30#comments`)).toBe(WATCH_URL)
  })

  it.each([
    ['plain http', `http://video.blender.org/videos/watch/${UUID}`],
    ['another scheme', `file:///videos/watch/${UUID}`],
    ['credentials', `https://user:secret@video.blender.org/videos/watch/${UUID}`],
    ['a user name alone', `https://user@video.blender.org/videos/watch/${UUID}`],
    ['a port', `https://video.blender.org:8443/videos/watch/${UUID}`],
    ['a YouTube host', `https://www.youtube.com/videos/watch/${UUID}`],
    ['a Google host', `https://youtube.googleapis.com/w/${UUID}`],
    ['localhost', `https://localhost/videos/watch/${UUID}`],
    ['a bare IP', `https://127.0.0.1/videos/watch/${UUID}`],
    ['a YouTube watch URL', `https://www.youtube.com/watch?v=${YOUTUBE_ID}`],
    ['a channel path', 'https://video.blender.org/c/blender'],
    ['a playlist path', 'https://video.blender.org/w/p/kkGMgK9ZtnKfYAgnEtQxbv'],
    ['a non-uuid watch id', 'https://video.blender.org/videos/watch/12345'],
    ['more path', `https://video.blender.org/videos/watch/${UUID}/extra`],
    ['an embed path', `https://video.blender.org/videos/embed/${UUID}`],
    ['a leading dash', 'https://video.blender.org/w/--start=0'],
    ['not a URL', 'video.blender.org/videos/watch/x'],
    ['not a string', 42],
    ['nothing', undefined],
  ])('refuses %s', (_what, url) => {
    expect(peerTubeWatchUrl(url)).toBeNull()
  })
})

describe('handleOpenInExternalPlayer', () => {
  beforeEach(() => {
    SETTINGS.values = { externalPlayer: 'mpv' }
  })

  it('hands the player a valid PeerTube watch URL, with start time and speed', async () => {
    expect(await argsFor({ videoUrl: WATCH_URL, startTime: 30, playbackRate: 1.5 }))
      .toEqual(['--start=30', '--speed=1.5', WATCH_URL])
  })

  it('does not apply playlist arguments to a PeerTube video', async () => {
    expect(await argsFor({ videoUrl: WATCH_URL, playlistId: 'PLabcdef', playlistIndex: 2, playlistShuffle: true, playlistLoop: true }))
      .toEqual([WATCH_URL])
  })

  it('hands over the PeerTube URL alone when default arguments are ignored', async () => {
    SETTINGS.values.externalPlayerIgnoreDefaultArgs = true

    expect(await argsFor({ videoUrl: WATCH_URL, startTime: 30 })).toEqual([WATCH_URL])
  })

  it.each([
    [`http://video.blender.org/videos/watch/${UUID}`],
    [`https://www.youtube.com/videos/watch/${UUID}`],
    [`https://a:b@video.blender.org/videos/watch/${UUID}`],
    ['https://video.blender.org/about'],
  ])('starts nothing for a refused URL: %s', async (videoUrl) => {
    expect(await argsFor({ videoUrl, startTime: 30 })).toBeNull()
  })

  it('prefers a valid YouTube video id over a URL', async () => {
    expect(await argsFor({ videoId: YOUTUBE_ID, videoUrl: WATCH_URL }))
      .toEqual([`https://www.youtube.com/watch?v=${YOUTUBE_ID}`])
  })

  describe('YouTube payloads, unchanged', () => {
    it('opens a video with start time and speed', async () => {
      expect(await argsFor({ videoId: YOUTUBE_ID, startTime: 12, playbackRate: 2 }))
        .toEqual(['--start=12', '--speed=2', `https://www.youtube.com/watch?v=${YOUTUBE_ID}`])
    })

    it('opens a video in its playlist', async () => {
      expect(await argsFor({ videoId: YOUTUBE_ID, playlistId: 'PLabcdef', playlistIndex: 2, playlistShuffle: true }))
        .toEqual(['--playlist-start=2', '--shuffle', 'https://youtube.com/playlist?list=PLabcdef'])
    })

    it('opens a playlist alone when default arguments are ignored', async () => {
      SETTINGS.values.externalPlayerIgnoreDefaultArgs = true

      expect(await argsFor({ playlistId: 'PLabcdef' })).toEqual(['https://youtube.com/playlist?list=PLabcdef'])
    })

    it('starts nothing for an invalid id, or with no external player set', async () => {
      expect(await argsFor({ videoId: 'short' })).toBeNull()

      SETTINGS.values = {}
      expect(await argsFor({ videoId: YOUTUBE_ID })).toBeNull()
    })
  })

  it('reads the map once it is on disk', () => {
    // Guards the fake above: the map the handler reads is the real one
    const map = JSON.parse(readFileSync(join(process.cwd(), 'static/external-player-map.json'), 'utf-8'))
    expect(map.find(entry => entry.value === 'mpv').cmdArguments.startOffset).toBe('--start=')
  })
})
