import shaka from 'shaka-player'
import { effectScope, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SabrGiveUpError } from '../../helpers/player/SabrRegulator'
import { showToast } from '../../helpers/utils'
import { useSabrHosting } from './useSabrHosting'

// The regulator is the player's to drive and the ladder's to decide; what is
// asked of it here is only to be created, and to be reset
const regulators = vi.hoisted(() => [])

vi.mock('../../helpers/player/SabrRegulator', async (importOriginal) => ({
  ...(await importOriginal()),
  createSabrRegulator: vi.fn((options) => {
    const regulator = { options, reset: vi.fn() }
    regulators.push(regulator)
    return regulator
  }),
}))

// helpers/utils imports the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

vi.mock('../../helpers/utils', async (importOriginal) => ({
  ...(await importOriginal()),
  showToast: vi.fn(),
}))

const VIDEO_ID = 'dQw4w9WgXcQ'
const OTHER_ID = 'jNQXAC9IVRw'

function credentials(videoId, token) {
  return { url: `https://rr1---sn.googlevideo.com/sabr?token=${token}`, videoId, poToken: token, ustreamerConfig: 'config', clientInfo: {} }
}

/**
 * A `sabr` source, with a fake `renew`
 *
 * @param {string} [videoId]
 */
function sabrSource(videoId = VIDEO_ID) {
  return Object.freeze({
    transport: 'sabr',
    manifestUrl: `data:application/sabr+json,first-${videoId}`,
    manifestMimeType: 'application/sabr+json',
    audio: { manifestUrl: `data:application/sabr+json,first-${videoId}`, mimeType: 'application/sabr+json' },
    legacyFormats: [],
    captions: [],
    chapters: [],
    isLive: false,
    expiresAt: new Date('2026-10-02T12:00:00Z'),
    sabrData: credentials(videoId, 'first'),
    sabrStoryboards: [],
    renew: vi.fn(),
  })
}

const FRESH_EXPIRY = new Date('2026-10-02T18:00:00Z')

const scopes = []

afterEach(() => {
  for (const scope of scopes.splice(0)) {
    scope.stop()
  }
})

beforeEach(() => {
  regulators.length = 0
  showToast.mockClear()
})

/**
 * Hosts the regulator for a source the test changes, as the view would
 *
 * @param {object | null} initial
 * @param {{ position?: number | null, isRegulated?: () => boolean }} [options]
 */
function host(initial, { position = null, isRegulated = () => false } = {}) {
  const source = shallowRef(initial)
  const reload = vi.fn()
  const scope = effectScope()
  scopes.push(scope)

  const hosting = scope.run(() => useSabrHosting(source, { isRegulated, currentPosition: () => position, reload }))

  return { source, reload, hosting, regulator: regulators.at(-1) }
}

/** What the player is answered, for one request */
async function ask(hosting, request = {}) {
  let answer
  await hosting.onSabrRefreshRequested({ ...request, onResult: (result) => { answer = result } })
  return answer
}

describe('the regulator', () => {
  it('is created once, raw, and handed over; it reads the regulated streaming setting when it asks', () => {
    let regulated = false
    const { source, hosting, regulator } = host(sabrSource(), { isRegulated: () => regulated })

    source.value = sabrSource(OTHER_ID)

    expect(regulators).toHaveLength(1)
    expect(hosting.regulator).toBe(regulator)
    expect(regulator.__v_skip).toBe(true)

    regulated = true
    expect(regulator.options.isRegulated()).toBe(true)
  })
})

describe('the credentials', () => {
  it('are the source\'s to begin with, with its manifest and expiry', () => {
    const playing = sabrSource()
    const { hosting } = host(playing)

    expect(hosting.sabrData.value).toBe(playing.sabrData)
    expect(hosting.manifestUrl.value).toBe(playing.manifestUrl)
    expect(hosting.manifestMimeType.value).toBe('application/sabr+json')
    expect(hosting.expiresAt.value).toBe(playing.expiresAt)
  })

  it('are none for a source that is not sabr', () => {
    const { hosting } = host({ transport: 'manifest', manifestUrl: 'data:application/dash+xml,', legacyFormats: [] })

    expect(hosting.sabrData.value).toBeNull()
    expect(hosting.manifestUrl.value).toBeNull()
  })
})

describe('a refresh', () => {
  it('is answered through renew, with the server\'s reload token, and the new credentials and expiry are held', async () => {
    const playing = sabrSource()
    playing.renew.mockResolvedValue({ sabrData: credentials(VIDEO_ID, 'fresh'), formatIds: ['137-1-'], expiresAt: FRESH_EXPIRY })
    const { hosting } = host(playing)
    const reloadPlaybackContext = { token: 'reload' }

    const answer = await ask(hosting, { reloadPlaybackContext })

    expect(playing.renew).toHaveBeenCalledWith({ reloadPlaybackContext, rebuilding: false })
    expect(answer).toEqual({ sabrData: credentials(VIDEO_ID, 'fresh'), formatIds: ['137-1-'] })
    expect(hosting.sabrData.value).toEqual(credentials(VIDEO_ID, 'fresh'))
    expect(hosting.expiresAt.value).toBe(FRESH_EXPIRY)
    // A refresh keeps its buffer, and so its manifest
    expect(hosting.manifestUrl.value).toBe(playing.manifestUrl)
  })
})

describe('a rebuild', () => {
  it('is answered through renew with its new manifest, which is held with the credentials', async () => {
    const playing = sabrSource()
    playing.renew.mockResolvedValue({
      sabrData: credentials(VIDEO_ID, 'fresh'),
      formatIds: ['137-2-'],
      expiresAt: FRESH_EXPIRY,
      manifestUrl: 'data:application/sabr+json,rebuilt',
      manifestMimeType: 'application/sabr+json',
    })
    const { hosting } = host(playing)

    const answer = await ask(hosting, { rebuilding: true })

    expect(playing.renew).toHaveBeenCalledWith({ reloadPlaybackContext: undefined, rebuilding: true })
    expect(answer).toEqual({
      sabrData: credentials(VIDEO_ID, 'fresh'),
      formatIds: ['137-2-'],
      manifestSrc: 'data:application/sabr+json,rebuilt',
      manifestMimeType: 'application/sabr+json',
    })
    expect(hosting.manifestUrl.value).toBe('data:application/sabr+json,rebuilt')
    expect(hosting.sabrData.value).toEqual(credentials(VIDEO_ID, 'fresh'))
    expect(hosting.expiresAt.value).toBe(FRESH_EXPIRY)
  })
})

describe('a renew answering null', () => {
  it.each([
    ['a refresh', false],
    ['a rebuild', true],
  ])('answers the player null for %s, and keeps what it held', async (_case, rebuilding) => {
    const playing = sabrSource()
    playing.renew.mockResolvedValue(null)
    const { hosting } = host(playing)

    expect(await ask(hosting, { rebuilding })).toBeNull()
    expect(hosting.sabrData.value).toBe(playing.sabrData)
    expect(hosting.manifestUrl.value).toBe(playing.manifestUrl)
  })

  it('is what the player hears when the video changed while renew was out, and the old credentials are not held', async () => {
    const playing = sabrSource()
    let answerRenew
    playing.renew.mockReturnValue(new Promise(resolve => { answerRenew = resolve }))
    const { source, hosting } = host(playing)

    const asking = ask(hosting)
    const next = sabrSource(OTHER_ID)
    source.value = next
    answerRenew({ sabrData: credentials(VIDEO_ID, 'fresh'), formatIds: [], expiresAt: FRESH_EXPIRY })

    expect(await asking).toBeNull()
    expect(hosting.sabrData.value).toBe(next.sabrData)
  })
})

describe('the end of the ladder', () => {
  it('is the give-up error, and only that', () => {
    const { hosting } = host(sabrSource())
    const { Severity, Category, Code } = shaka.util.Error

    const giveUp = new shaka.util.Error(Severity.CRITICAL, Category.NETWORK, Code.HTTP_ERROR, 'sabr://segment', new SabrGiveUpError())
    const other = new shaka.util.Error(Severity.CRITICAL, Category.NETWORK, Code.HTTP_ERROR, 'sabr://segment', new Error('refused'))

    expect(hosting.isEndOfLadder(giveUp)).toBe(true)
    expect(hosting.isEndOfLadder(other)).toBe(false)
    expect(hosting.isEndOfLadder(new Error('adaptive failed'))).toBe(false)
    // Both are failures of the transport, which the format ring reads
    expect(hosting.isTransportFailure(giveUp)).toBe(true)
    expect(hosting.isTransportFailure(other)).toBe(true)
    expect(hosting.isTransportFailure(new shaka.util.Error(Severity.CRITICAL, Category.NETWORK, Code.HTTP_ERROR, 'https://example.com/a.mp4'))).toBe(false)
  })
})

describe('the regulator\'s reset', () => {
  it('comes on a new video, after a source that was not sabr too, and not for the gap between loads', () => {
    const { source, regulator } = host(sabrSource())
    expect(regulator.reset).toHaveBeenCalledTimes(1)

    source.value = null
    expect(regulator.reset).toHaveBeenCalledTimes(1)

    source.value = sabrSource(OTHER_ID)
    source.value = { transport: 'manifest', manifestUrl: 'data:application/dash+xml,', legacyFormats: [] }
    source.value = sabrSource(OTHER_ID)

    expect(regulator.reset).toHaveBeenCalledTimes(4)
    // Forgetting the last video, so the next session is a new video's to the
    // regulator: a full budget, and the setting read again
    expect(regulator.reset).toHaveBeenLastCalledWith(null)
  })
})

describe('the page reload the ladder asks for', () => {
  it('reloads from where playback was, and says why', async () => {
    const { hosting, reload } = host(sabrSource(), { position: 42.7 })

    await hosting.onPlayerReloadRequested('the session reload failed: no fresh credentials')

    expect(reload).toHaveBeenCalledWith(42)
    expect(showToast).toHaveBeenCalledWith('Reloading player: the session reload failed: no fresh credentials')
  })

  it('reloads from the start where playback had not begun, with a reason where none was sent', async () => {
    const { hosting, reload } = host(sabrSource(), { position: null })

    await hosting.onPlayerReloadRequested()

    expect(reload).toHaveBeenCalledWith(null)
    expect(showToast).toHaveBeenCalledWith('Reloading player: a SABR request')
  })

  it('keeps the ladder\'s budgets across it, where any other load resets them', async () => {
    const { source, hosting, reload, regulator } = host(sabrSource())
    reload.mockImplementation(async () => { source.value = null; source.value = sabrSource() })
    regulator.reset.mockClear()

    await hosting.onPlayerReloadRequested('a SABR request')
    expect(regulator.reset).not.toHaveBeenCalled()

    // The viewer trying again, once the ladder is spent
    source.value = sabrSource()
    expect(regulator.reset).toHaveBeenCalledTimes(1)
  })
})
