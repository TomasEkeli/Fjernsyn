import { describe, expect, it } from 'vitest'

import { createPlatformLayer } from '../index'
import { createFakeYouTube } from './testing/fakeYouTube'

import invidiousCustom from './fixtures/invidious--channel-url-custom.json'
import invidiousHandle from './fixtures/invidious--channel-url-handle.json'
import invidiousNone from './fixtures/invidious--channel-url-none.json'
import invidiousUser from './fixtures/invidious--channel-url-user.json'
import localCustom from './fixtures/local--channel-url-custom.json'
import localHandle from './fixtures/local--channel-url-handle.json'
import localNone from './fixtures/local--channel-url-none.json'
import localUser from './fixtures/local--channel-url-user.json'

const BLENDER = 'UCSMOQeBJ2RAnuFungnQOxLg'
const YOUTUBE_CREATORS = 'UCkRfArvrzheW2E7b6SVT7vQ'

const HANDLE = 'https://www.youtube.com/@BlenderOfficial'
const CUSTOM = 'https://www.youtube.com/c/YouTubeCreators'
const USER = 'https://www.youtube.com/user/BlenderFoundation'
const NONE = 'https://www.youtube.com/@thischanneldoesnotexist-fjernsyn-xq7'

/** The URL a fixture's call was made with */
function urlOf(fixture) {
  return /'(.*)'/.exec(fixture.call)[1]
}

/**
 * A module function answering each fixture's URL with its answer, as the
 * module does, and `null` for any other (the modules answer `null` for every
 * failure)
 */
function answeringByUrl(...fixtures) {
  const answers = new Map(fixtures.map(fixture => [urlOf(fixture), fixture.answer]))
  return async url => answers.get(url) ?? null
}

/** @param {object} [config] */
function setUp(config = {}, answers = {}) {
  const fake = createFakeYouTube({
    getLocalChannelId: answeringByUrl(localHandle, localCustom, localUser, localNone),
    invidiousGetChannelId: answeringByUrl(invidiousHandle, invidiousCustom, invidiousUser, invidiousNone),
    ...answers,
  })
  const layer = createPlatformLayer({
    youtube: fake.youtube,
    config: { backendPreference: 'local', backendFallback: true, ...config },
  })

  return { layer, fake }
}

async function failure(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a failure')
}

describe('resolving a YouTube channel link by name', () => {
  describe.each([
    ['local', 'getLocalChannelId', 'invidiousGetChannelId'],
    ['invidious', 'invidiousGetChannelId', 'getLocalChannelId'],
  ])('on %s', (backend, asked, other) => {
    it.each([
      ['a handle', HANDLE, BLENDER],
      ['a /c/ URL', CUSTOM, YOUTUBE_CREATORS],
      ['a /user/ URL', USER, BLENDER],
    ])('answers the UC ref of %s, asking the preferred backend alone', async (_shape, url, ref) => {
      const { layer, fake } = setUp({ backendPreference: backend })

      expect(await layer.resolveChannel(url)).toBe(ref)
      expect(fake.callsOf(asked)).toEqual([[url]])
      expect(fake.callsOf(other)).toEqual([])
    })

    it('is notFound for a URL that resolves to nothing only once the other backend agrees', async () => {
      const { layer, fake } = setUp({ backendPreference: backend })

      expect((await failure(layer.resolveChannel(NONE))).kind).toBe('notFound')
      expect(fake.callsOf(asked)).toEqual([[NONE]])
      expect(fake.callsOf(other)).toEqual([[NONE]])
    })
  })

  it('answers the other backend\'s ref when the preferred one resolves nothing', async () => {
    const { layer } = setUp({}, { getLocalChannelId: async () => null })

    expect(await layer.resolveChannel(HANDLE)).toBe(BLENDER)
  })

  it('answers a /channel/ URL\'s own ref, without a request', async () => {
    const { layer, fake } = setUp()

    expect(await layer.resolveChannel(`https://www.youtube.com/channel/${BLENDER}/videos`)).toBe(BLENDER)
    expect(fake.calls).toEqual([])
  })

  it('rejects what is not a YouTube URL as invalid, asking nobody', async () => {
    const { layer, fake } = setUp()

    expect((await failure(layer.resolveChannel('https://video.blender.org/c/blender'))).kind).toBe('invalid')
    expect((await failure(layer.resolveChannel('@BlenderOfficial'))).kind).toBe('invalid')
    expect(fake.calls).toEqual([])
  })
})
