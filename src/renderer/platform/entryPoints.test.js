import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'

import { openInternalPath, showToast } from '../helpers/utils'
import { createFakeStore } from '../testing/store'
import { openPeerTubeEntry, resolvePeerTubeEntry } from './entryPoints.js'
import { PlatformError } from './errors'
import { installPlatformLayer } from './vue.js'

// The layer is under test beside itself; here a fake answers what each test
// says, and records what it was asked
const fake = vi.hoisted(() => ({ layer: null }))

vi.mock('./index.js', () => ({ createPlatformLayer: () => fake.layer }))

vi.mock('./peertube/client', () => ({ createPeerTubeClient: () => ({}) }))

vi.mock('../helpers/utils', () => ({
  showToast: vi.fn(),
  openInternalPath: vi.fn(),
  getVideoParamsFromUrl: () => ({ videoId: null, timestamp: null, playlistId: null }),
}))

vi.mock('../i18n/index', async () => {
  const { createTestI18n } = await import('../testing/i18n')
  return { default: createTestI18n() }
})

const UUID = 'b29290cc-dc51-4a12-bcb2-2aa5fece7605'
const WATCH_URL = `https://video.blender.org/w/${UUID}`

/** What the layer answers for a PeerTube video URL */
function videoAnswer(timestamp = null) {
  return {
    platform: 'peertube',
    kind: 'video',
    ref: { platform: 'peertube', host: 'video.blender.org', videoId: UUID },
    host: 'video.blender.org',
    timestamp,
  }
}

const CHANNEL_ANSWER = {
  platform: 'peertube',
  kind: 'channel',
  ref: 'blender_studio@video.blender.org',
  host: 'video.blender.org',
  name: 'blender_studio',
}

/**
 * A fake layer whose `resolveUrl` answers from `answer` (a value, or a
 * function of the input; an Error is a rejection)
 *
 * @param {unknown} answer
 */
function layerAnswering(answer) {
  return {
    resolveUrl: vi.fn(async (input) => {
      const value = typeof answer === 'function' ? answer(input) : answer

      if (value instanceof Error) {
        throw value
      }

      return value
    }),
  }
}

let store

/**
 * @param {unknown} answer
 * @param {object} [options]
 * @param {boolean} [options.enabled]
 */
function setUp(answer, { enabled = true } = {}) {
  fake.layer = layerAnswering(answer)
  store = createFakeStore({ getters: { getEnablePeerTube: enabled } })
  installPlatformLayer(createApp({ render: () => null }), store)
  return fake.layer
}

beforeEach(() => {
  showToast.mockClear()
  openInternalPath.mockClear()
})

describe('resolvePeerTubeEntry', () => {
  it('leaves everything alone while PeerTube is off, without asking the layer', async () => {
    const layer = setUp(videoAnswer(), { enabled: false })

    expect(await resolvePeerTubeEntry(WATCH_URL)).toBeNull()
    expect(await resolvePeerTubeEntry('blender_studio@video.blender.org')).toBeNull()
    expect(layer.resolveUrl).not.toHaveBeenCalled()
  })

  it('opens a PeerTube video on its watch page', async () => {
    setUp(videoAnswer())

    expect(await resolvePeerTubeEntry(WATCH_URL)).toEqual({
      route: { path: `/peertube/watch/video.blender.org/${UUID}` },
    })
  })

  it('carries the start time the URL had as the watch page timestamp', async () => {
    setUp(videoAnswer(90))

    expect(await resolvePeerTubeEntry(`${WATCH_URL}?start=1m30s`)).toEqual({
      route: { path: `/peertube/watch/video.blender.org/${UUID}`, query: { timestamp: 90 } },
    })
  })

  it('does not ask for a start at zero, as the YouTube path does not', async () => {
    setUp(videoAnswer(0))

    expect(await resolvePeerTubeEntry(`${WATCH_URL}?start=0`)).toEqual({
      route: { path: `/peertube/watch/video.blender.org/${UUID}` },
    })
  })

  it('hands the layer the input trimmed', async () => {
    const layer = setUp(videoAnswer())

    await resolvePeerTubeEntry(`  ${WATCH_URL}\n`)

    expect(layer.resolveUrl).toHaveBeenCalledWith(WATCH_URL)
  })

  it.each([
    ['a channel URL', 'https://video.blender.org/c/blender_studio/videos'],
    ['a handle', 'blender_studio@video.blender.org'],
    ['a handle with its leading @', '@blender_studio@video.blender.org'],
  ])('opens %s on the PeerTube channel page', async (_what, input) => {
    setUp(CHANNEL_ANSWER)

    expect(await resolvePeerTubeEntry(input)).toEqual({
      route: { path: '/peertube/channel/blender_studio@video.blender.org' },
    })
  })

  it('leaves a PeerTube playlist to the existing behaviour, having no page for it yet', async () => {
    setUp({
      platform: 'peertube',
      kind: 'playlist',
      ref: { platform: 'peertube', host: 'video.blender.org', playlistId: 'abc' },
      host: 'video.blender.org',
      id: 'abc',
    })

    expect(await resolvePeerTubeEntry('https://video.blender.org/w/p/abc')).toBeNull()
  })

  it('leaves a YouTube URL to the existing parser', async () => {
    setUp({ platform: 'youtube', kind: 'video', ref: 'dQw4w9WgXcQ' })

    expect(await resolvePeerTubeEntry('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull()
  })

  it('leaves plain search text and whatever the layer does not recognise to the existing behaviour', async () => {
    setUp(null)

    expect(await resolvePeerTubeEntry('blender open movies')).toBeNull()
    expect(await resolvePeerTubeEntry('https://example.com/some/page')).toBeNull()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('leaves a video its instance does not have to the existing behaviour, saying nothing', async () => {
    setUp(new PlatformError('notFound', 'no such video', { status: 404, host: 'video.blender.org' }))

    expect(await resolvePeerTubeEntry('https://video.blender.org/w/abcdefghijk')).toBeNull()
    expect(showToast).not.toHaveBeenCalled()
  })

  it.each(['unavailable', 'rateLimited'])('stops, saying which host it could not reach, when the host is %s', async (kind) => {
    setUp(new PlatformError(kind, 'could not ask', { host: 'down.example' }))

    expect(await resolvePeerTubeEntry(`https://down.example/w/${UUID}`)).toEqual({ route: null })
    expect(showToast).toHaveBeenCalledWith('Could not reach down.example to open this PeerTube link. Try again in a moment')
  })

  it('names the host from the input when the error does not carry one', async () => {
    setUp(new PlatformError('unavailable', 'could not ask'))

    expect(await resolvePeerTubeEntry('@someone@down.example')).toEqual({ route: null })

    expect(showToast).toHaveBeenCalledWith('Could not reach down.example to open this PeerTube link. Try again in a moment')
  })

  // An email address is typed as `name@host` too: when its host cannot say
  // whether it is PeerTube, the text is a search, as it was before PeerTube
  it.each([
    ['unreachable', new PlatformError('unavailable', 'could not be reached', { host: 'example.com' })],
    ['failing', new PlatformError('unavailable', 'server error', { status: 503, host: 'example.com' })],
    ['refusing', new PlatformError('refused', 'no', { status: 403, host: 'example.com' })],
    ['refusing to an anonymous caller', new PlatformError('refused', 'no', { status: 401, host: 'example.com' })],
    ['rate limiting', new PlatformError('rateLimited', 'slow down', { status: 429, retryAfterMs: 1000, host: 'example.com' })],
  ])('hands a bare name@host back to the search, saying nothing, when its host is %s', async (_what, error) => {
    const layer = setUp(error)

    expect(await resolvePeerTubeEntry('jane.doe@example.com')).toBeNull()
    expect(layer.resolveUrl).toHaveBeenCalledWith('jane.doe@example.com')
    expect(showToast).not.toHaveBeenCalled()
  })

  it('hands a bare name@host back to the search when its host is not PeerTube', async () => {
    setUp(null)

    expect(await resolvePeerTubeEntry('jane.doe@example.com')).toBeNull()
    expect(showToast).not.toHaveBeenCalled()
  })

  it.each([
    ['a handle with its leading @', '@blender_studio@down.example'],
    ['a channel URL', 'https://down.example/c/blender_studio'],
    ['a video URL', `https://down.example/w/${UUID}`],
  ])('still stops on %s whose host cannot be asked', async (_what, input) => {
    setUp(new PlatformError('unavailable', 'could not be reached', { host: 'down.example' }))

    expect(await resolvePeerTubeEntry(input)).toEqual({ route: null })
    expect(showToast).toHaveBeenCalledWith('Could not reach down.example to open this PeerTube link. Try again in a moment')
  })

  it.each([
    ['a refusal', new PlatformError('refused', 'private', { status: 403 })],
    ['an invalid request', new PlatformError('invalid', 'bad', { status: 400 })],
    ['any other failure', new TypeError('something broke')],
  ])('falls back to the existing behaviour on %s, never throwing', async (_what, error) => {
    setUp(error)

    expect(await resolvePeerTubeEntry(`https://video.blender.org/w/${UUID}`)).toBeNull()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('falls back on an answer it cannot route', async () => {
    setUp({ platform: 'peertube', kind: 'video', ref: null, host: 'video.blender.org', timestamp: null })

    expect(await resolvePeerTubeEntry(WATCH_URL)).toBeNull()
  })

  it.each([undefined, null, 42, '', '   '])('leaves %j alone, without asking the layer', async (input) => {
    const layer = setUp(videoAnswer())

    expect(await resolvePeerTubeEntry(input)).toBeNull()
    expect(layer.resolveUrl).not.toHaveBeenCalled()
  })
})

describe('openPeerTubeEntry', () => {
  it('opens the PeerTube page, in a new window when asked, with the search bar text', async () => {
    setUp(videoAnswer(90))

    expect(await openPeerTubeEntry(WATCH_URL, { doCreateNewWindow: true, searchQueryText: WATCH_URL })).toBe('opened')
    expect(openInternalPath).toHaveBeenCalledWith({
      path: `/peertube/watch/video.blender.org/${UUID}`,
      query: { timestamp: 90 },
      doCreateNewWindow: true,
      searchQueryText: WATCH_URL,
    })
  })

  it('opens in the same window by default', async () => {
    setUp(CHANNEL_ANSWER)

    expect(await openPeerTubeEntry('blender_studio@video.blender.org')).toBe('opened')
    expect(openInternalPath).toHaveBeenCalledWith({
      path: '/peertube/channel/blender_studio@video.blender.org',
      doCreateNewWindow: false,
      searchQueryText: null,
    })
  })

  it('opens nothing when the host could not be reached, and says the input was taken', async () => {
    setUp(new PlatformError('unavailable', 'down', { host: 'down.example' }))

    expect(await openPeerTubeEntry(`https://down.example/w/${UUID}`)).toBe('stopped')
    expect(openInternalPath).not.toHaveBeenCalled()
  })

  it('opens nothing and hands the input back for anything that is not PeerTube', async () => {
    setUp({ platform: 'youtube', kind: 'video', ref: 'dQw4w9WgXcQ' })

    expect(await openPeerTubeEntry('https://youtu.be/dQw4w9WgXcQ')).toBeNull()
    expect(openInternalPath).not.toHaveBeenCalled()
  })

  it('hands a bare name@host back when its host cannot be asked, opening nothing', async () => {
    setUp(new PlatformError('unavailable', 'down', { host: 'example.com' }))

    expect(await openPeerTubeEntry('jane.doe@example.com')).toBeNull()
    expect(openInternalPath).not.toHaveBeenCalled()
  })

  it('hands the input back while PeerTube is off', async () => {
    setUp(videoAnswer(), { enabled: false })

    expect(await openPeerTubeEntry(WATCH_URL)).toBeNull()
    expect(openInternalPath).not.toHaveBeenCalled()
  })
})
