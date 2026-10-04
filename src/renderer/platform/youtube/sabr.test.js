import { describe, expect, it } from 'vitest'

import { localInstance, localWith, setUp } from './testing/videoLayer'

import localLive from './fixtures/local--video-live.json'
import localOrdinary from './fixtures/local--video-ordinary.json'
import localPostLiveDvr from './fixtures/local--video-post-live-dvr.json'

const ID = 'dQw4w9WgXcQ'
const SABR = 'application/sabr+json'
const CLIENT_INFO = localOrdinary.answer.clientInfo

/** The fixture as `getLocalVideoInfo` answers it once it minted a PO token, which Node cannot */
function withToken(fixture, poToken = 'po-token') {
  const copy = structuredClone(fixture)
  copy.answer.poToken = poToken
  return copy
}

const sabrManifestOf = url => JSON.parse(decodeURIComponent(url.slice(`data:${SABR},`.length)))

/** What a source holds, without `renew`, to show it unchanged */
const snapshot = ({ renew: _renew, ...data }) => structuredClone(data)

/**
 * @param {any} local the Local answer, a fixture
 * @param {object} [config]
 */
async function sourceOf(local, config = {}) {
  const { layer, fake } = setUp({ answers: { getLocalVideoInfo: localInstance(local) }, config })
  const video = await layer.getVideo(local.answer.info.basic_info.id)

  return { source: video.playbackSource, fake }
}

describe('a YouTube Local video over SABR', () => {
  it('plays over SABR where the response has a token, a SABR URL and a ustreamer config, with what DASH would have besides', async () => {
    const { source } = await sourceOf(withToken(localOrdinary))
    const { source: dash } = await sourceOf(localOrdinary)

    expect(dash.transport).toBe('manifest')
    expect(source).toMatchObject({ transport: 'sabr', manifestMimeType: SABR, audio: { manifestUrl: source.manifestUrl, mimeType: SABR } })
    for (const field of ['legacyFormats', 'captions', 'chapters', 'chaptersSrc', 'storyboard', 'isLive', 'loudnessDb', 'delayLoadUntilMs', 'expiresAt', 'vrProjection', 'isPostLiveDvr', 'heatmap']) {
      expect(source[field], field).toEqual(dash[field])
    }
    expect(Object.isFrozen(source)).toBe(true)
  })

  it('carries the credentials and the storyboards, and a manifest embedding the formats, captions, chapters and storyboards', async () => {
    const { source } = await sourceOf(withToken(localOrdinary))
    const manifest = sabrManifestOf(source.manifestUrl)

    expect(source.sabrData).toEqual({
      url: `https://rr1---sn.googlevideo.com/videoplayback?id=${ID}&sabr=1&alr=yes&cpn=cpnFromTheResponse`,
      videoId: ID,
      poToken: 'po-token',
      ustreamerConfig: `ustreamer-config-${ID}`,
      clientInfo: CLIENT_INFO,
    })
    expect(source.sabrStoryboards).toEqual([{
      templateUrl: 'https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L2/M$M.jpg?sigh=c',
      mimeType: 'image/webp',
      columns: 5,
      rows: 5,
      thumbnailCount: 107,
      thumbnailWidth: 160,
      thumbnailHeight: 90,
      storyboardCount: 5,
      interval: 2,
    }])
    // The shortest format's duration
    expect(manifest.duration).toBe(213.04)
    expect(manifest.formats.map(format => [format.itag, format.mimeType, format.lastModified, format.xtags ?? null])).toEqual([
      [137, 'video/mp4; codecs="avc1.640028"', '1700000000000000', null],
      [140, 'audio/mp4; codecs="mp4a.40.2"', '1700000000000000', 'CggKA2RyYxIBMQ'],
    ])
    expect(manifest.formats[1]).toMatchObject({ language: 'en', isOriginal: true, audioChannels: 2, initRange: { start: 0, end: 740 } })
    expect(manifest.captions).toEqual(JSON.parse(JSON.stringify(source.captions)))
    expect(manifest.chapters).toEqual(JSON.parse(JSON.stringify(source.chapters)))
    expect(manifest.storyboards).toEqual(source.sabrStoryboards)
  })

  it.each([
    ['no token was minted', localOrdinary],
    ['there is no SABR URL', localWith(withToken(localOrdinary), (info) => { delete info.streaming_data.server_abr_streaming_url })],
    ['there is no ustreamer config', localWith(withToken(localOrdinary), (info) => { delete info.player_config.media_common_config })],
  ])('plays DASH where %s', async (_what, local) => {
    expect((await sourceOf(local)).source).toMatchObject({ transport: 'manifest', manifestMimeType: 'application/dash+xml' })
  })

  it.each([
    ['a live', localWith(withToken(localLive), (info) => { info.streaming_data.adaptive_formats = localOrdinary.answer.info.streaming_data.adaptive_formats })],
    ['a post-live DVR', withToken(localPostLiveDvr)],
  ])('never plays %s over SABR', async (_what, local) => {
    expect((await sourceOf(local)).source.transport).toBe('manifest')
  })
})

describe('renewing a SABR source', () => {
  /** A later player response: a new token, URL, cpn, expiry, and a new format */
  const fresh = localWith(withToken(localOrdinary, 'fresh-token'), (info) => {
    info.cpn = 'freshCpn'
    info.streaming_data.server_abr_streaming_url = `https://rr9---sn.googlevideo.com/videoplayback?id=${ID}&sabr=1&fresh=1`
    info.streaming_data.expires = '2026-10-03T05:00:00.000Z'
    info.streaming_data.adaptive_formats[0].itag = 248
    info.player_config.media_common_config.media_ustreamer_request_config.video_playback_ustreamer_config = 'fresh-ustreamer'
    // A rebuild must not read these: the source's own are embedded
    delete info.captions
    delete info.storyboards
    delete info.player_overlays
  })

  const FRESH_SABR_DATA = {
    url: `https://rr9---sn.googlevideo.com/videoplayback?id=${ID}&sabr=1&fresh=1&alr=yes&cpn=freshCpn`,
    videoId: ID,
    poToken: 'fresh-token',
    ustreamerConfig: 'fresh-ustreamer',
    clientInfo: CLIENT_INFO,
  }
  const FRESH_FORMAT_IDS = ['248-1700000000000000-', '140-1700000000000000-CggKA2RyYxIBMQ']

  async function renewable(answer = localInstance(fresh)) {
    const { source, fake } = await sourceOf(withToken(localOrdinary))
    const before = snapshot(source)
    fake.respond('getLocalVideoInfo', answer)

    return { source, fake, before }
  }

  it('answers a refresh with the fresh credentials and expiry, and no manifest', async () => {
    const { source, before } = await renewable()

    expect(await source.renew()).toEqual({
      sabrData: FRESH_SABR_DATA,
      formatIds: FRESH_FORMAT_IDS,
      expiresAt: new Date('2026-10-03T05:00:00.000Z'),
    })
    expect(snapshot(source)).toEqual(before)
  })

  it('answers a rebuild with a manifest of the fresh formats embedding the source\'s own captions, chapters and storyboards', async () => {
    const { source, before } = await renewable()

    const result = await source.renew({ rebuilding: true })
    const manifest = sabrManifestOf(result.manifestUrl)

    expect(result).toMatchObject({ sabrData: FRESH_SABR_DATA, formatIds: FRESH_FORMAT_IDS, manifestMimeType: SABR })
    expect(manifest.formats.map(format => format.itag)).toEqual([248, 140])
    expect(manifest.captions).toEqual(JSON.parse(JSON.stringify(source.captions)))
    expect(manifest.captions).not.toEqual([])
    expect(manifest.chapters).toEqual(JSON.parse(JSON.stringify(source.chapters)))
    expect(manifest.storyboards).toEqual(source.sabrStoryboards)
    expect(snapshot(source)).toEqual(before)
  })

  it('passes the server\'s reload token on to the module', async () => {
    const { source, fake } = await renewable()
    const reloadPlaybackContext = { reloadPlaybackParams: { token: 'from the server' } }

    await source.renew({ reloadPlaybackContext })

    expect(fake.callsOf('getLocalVideoInfo').at(-1)).toEqual([ID, { reloadPlaybackContext }])
  })

  it.each([
    ['no token was minted', localInstance(localOrdinary)],
    ['there is no SABR URL', localInstance(localWith(fresh, (info) => { delete info.streaming_data.server_abr_streaming_url }))],
    ['there is no ustreamer config', localInstance(localWith(fresh, (info) => { delete info.player_config.media_common_config }))],
    ['the request failed', new Error('Request to https://www.youtube.com/youtubei/v1/player failed with status code 403')],
  ])('answers null where %s, for a refresh and a rebuild alike', async (_what, answer) => {
    const { source, before } = await renewable(answer)

    expect(await source.renew()).toBeNull()
    expect(await source.renew({ rebuilding: true })).toBeNull()
    expect(snapshot(source)).toEqual(before)
  })
})

describe('the layer and the regulator', () => {
  it('never refers to the regulator, which is the watch view\'s', () => {
    const modules = import.meta.glob(['../**/*.js', '!../**/*.test.js'], { query: '?raw', import: 'default', eager: true })

    expect(Object.keys(modules).length).toBeGreaterThan(20)
    for (const [path, text] of Object.entries(modules)) {
      expect(/SabrRegulator|createSabrRegulator/.test(text), path).toBe(false)
    }
  })
})
