import { describe, expect, it } from 'vitest'

import { failure, getProxyUrl, INSTANCE, localInstance, localWith, setUp } from './testing/videoLayer'

import invidiousLive from './fixtures/invidious--video-live.json'
import invidiousMultipleAudio from './fixtures/invidious--video-multiple-audio.json'
import invidiousOrdinary from './fixtures/invidious--video-ordinary.json'
import invidiousPostLiveDvr from './fixtures/invidious--video-post-live-dvr.json'
import invidiousUpcoming from './fixtures/invidious--video-upcoming.json'
import localLive from './fixtures/local--video-live.json'
import localMultipleAudio from './fixtures/local--video-multiple-audio.json'
import localOrdinary from './fixtures/local--video-ordinary.json'
import localPostLiveDvr from './fixtures/local--video-post-live-dvr.json'
import localShort from './fixtures/local--video-short.json'
import localUpcoming from './fixtures/local--video-upcoming.json'

const DASH = 'application/dash+xml'
const HLS = 'application/x-mpegurl'
const EXPIRES = new Date('2026-10-02T23:59:59.000Z')
const MUXED_MIME = 'video/mp4; codecs="avc1.42001E, mp4a.40.2"'

const dashUri = xml => `data:${DASH};charset=UTF-8,${encodeURIComponent(xml)}`
const decoded = uri => decodeURIComponent(uri.slice(uri.indexOf(',') + 1))
const muxed = (itag, width, height, url) => ({ itag, qualityLabel: '360p', fps: 25, bitrate: 500000, mimeType: MUXED_MIME, height, width, url })

/**
 * @param {object} [options]
 * @param {any} [options.local] the Local answer, a fixture or a function
 * @param {any} [options.invidious]
 * @param {object} [options.config]
 */
async function sourceOf({ local, invidious, config = {} }) {
  const answers = local
    ? { getLocalVideoInfo: typeof local === 'function' ? local : localInstance(local) }
    : { invidiousGetVideoInformation: invidious }
  const { layer, fake } = setUp({ answers, config: { backendPreference: local ? 'local' : 'invidious', ...config } })
  const id = (local?.answer ?? invidious?.answer)?.info?.basic_info?.id ?? invidious?.answer?.videoId ?? 'dQw4w9WgXcQ'
  const video = await layer.getVideo(id)

  return { video, source: video.playbackSource, fake }
}

describe('a YouTube video\'s playback source from Local', () => {
  const LIVE_HLS = 'https://manifest.googlevideo.com/api/manifest/hls_variant/id/ODio2-1aFa8'
  const DVR_HLS = 'https://manifest.googlevideo.com/api/manifest/hls_variant/id/jfKfPfyJRdk'

  it.each([
    ['a video as DASH, with one audio track', localOrdinary, {
      manifestUrl: dashUri('<MPD thumbnails="false"></MPD>'),
      manifestMimeType: DASH,
      audio: { manifestUrl: dashUri('<MPD thumbnails="false"></MPD>'), mimeType: DASH },
      legacyFormats: [muxed(18, 640, 360, 'https://rr1---sn.googlevideo.com/videoplayback?itag=18&expire=1790000000')],
      isLive: false,
      loudnessDb: -7.25,
      delayLoadUntilMs: 1790000012345,
      expiresAt: EXPIRES,
      vrProjection: null,
      isPostLiveDvr: false,
    }],
    ['a video as DASH, with an adaptation set per audio track', localMultipleAudio, {
      manifestUrl: dashUri('<MPD thumbnails="false"><Label>English original</Label><Label>German</Label></MPD>'),
      manifestMimeType: DASH,
      legacyFormats: [],
      captions: [],
      chapters: [],
      chaptersSrc: null,
      storyboard: null,
      // `0` is a measured loudness, not an unknown one
      loudnessDb: 0,
      vrProjection: 'EQUIRECTANGULAR',
    }],
    ['a video with no adaptive format to stream, as legacy formats only', localShort, {
      manifestUrl: null,
      manifestMimeType: null,
      audio: null,
      legacyFormats: [muxed(18, 360, 640, 'https://rr2---sn.googlevideo.com/videoplayback?itag=18')],
      loudnessDb: null,
      expiresAt: null,
    }],
    ['a live from YouTube\'s HLS of muxed streams, with no audio only and no legacy', localLive, {
      manifestUrl: LIVE_HLS,
      manifestMimeType: HLS,
      audio: null,
      legacyFormats: [],
      captions: [],
      storyboard: null,
      isLive: true,
      loudnessDb: -3,
      expiresAt: EXPIRES,
      vrProjection: null,
      isPostLiveDvr: false,
    }],
    ['a post-live DVR as DASH of its formats, with the storyboard\'s thumbnails', localPostLiveDvr, {
      manifestUrl: dashUri('<MPD thumbnails="true"></MPD>'),
      manifestMimeType: DASH,
      legacyFormats: [],
      isLive: false,
      isPostLiveDvr: true,
    }],
  ])('plays %s', async (_what, local, expected) => {
    const { source } = await sourceOf({ local })

    expect(source).toMatchObject({ transport: 'manifest', ...expected })
  })

  it.each([
    ['YouTube\'s DASH before its HLS', { dash_manifest_url: 'https://manifest.googlevideo.com/dash', hls_manifest_url: LIVE_HLS }, { manifestUrl: 'https://manifest.googlevideo.com/dash', manifestMimeType: DASH, audio: { manifestUrl: 'https://manifest.googlevideo.com/dash', mimeType: DASH } }],
    ['a demuxed HLS, with audio only', { hls_manifest_url: `${LIVE_HLS}/demuxed/1` }, { manifestUrl: `${LIVE_HLS}/demuxed/1`, manifestMimeType: HLS, audio: { manifestUrl: `${LIVE_HLS}/demuxed/1`, mimeType: HLS } }],
  ])('plays a live from %s', async (_what, manifests, expected) => {
    const live = localWith(localLive, (info) => {
      delete info.streaming_data.hls_manifest_url
      Object.assign(info.streaming_data, manifests)
    })

    expect((await sourceOf({ local: live })).source).toMatchObject(expected)
  })

  it.each([
    ['youtubei.js cannot build its DASH manifest', localInstance(localPostLiveDvr, () => ({ toDash: async () => { throw new Error('no DASH for you') } }))],
    ['it has no adaptive format to stream', localInstance(localWith(localPostLiveDvr, (info) => { info.streaming_data.adaptive_formats = [] }))],
  ])('plays a post-live DVR from YouTube\'s live manifest where %s', async (_what, local) => {
    expect((await sourceOf({ local })).source).toMatchObject({ manifestUrl: DVR_HLS, manifestMimeType: HLS, audio: null, isPostLiveDvr: true })
  })

  it('reads a live with no manifest as unavailable, and tries it on Invidious when fallback is on', async () => {
    const noManifest = localInstance(localWith(localLive, (info) => { delete info.streaming_data.hls_manifest_url }))

    const { layer } = setUp({ answers: { getLocalVideoInfo: noManifest } })
    expect((await failure(layer.getVideo('ODio2-1aFa8'))).kind).toBe('unavailable')

    const fallback = setUp({ answers: { getLocalVideoInfo: noManifest, invidiousGetVideoInformation: invidiousLive }, config: { backendFallback: true } })
    expect((await fallback.layer.getVideo('ODio2-1aFa8')).playbackSource.manifestUrl).toBe(invidiousLive.answer.hlsUrl)
  })

  it.each([
    ['a waiting live', localUpcoming],
    ['a video without streaming data (region locked, or the like)', localWith(localOrdinary, (info) => { delete info.streaming_data })],
  ])('has nothing to play for %s', async (_what, local) => {
    expect((await sourceOf({ local })).source).toBeNull()
  })

  it('plays a premiere\'s trailer where YouTube answered one in its place', async () => {
    const trailer = localWith(localUpcoming, (info) => {
      info.playability_status = { status: 'OK' }
      info.streaming_data = localOrdinary.answer.info.streaming_data
    })

    const { video, source } = await sourceOf({ local: trailer })

    expect(video.liveStatus).toBe('waiting')
    expect(source).toMatchObject({ manifestMimeType: DASH, legacyFormats: [muxed(18, 640, 360, 'https://rr1---sn.googlevideo.com/videoplayback?itag=18&expire=1790000000')] })
  })

  it('leaves out the ad delay where Local did not count one', async () => {
    const { info } = localOrdinary.answer
    const { source } = await sourceOf({ local: { ...localOrdinary, answer: { info } } })

    expect(source).not.toHaveProperty('delayLoadUntilMs')
  })
})

describe('a YouTube video\'s playback source from Invidious', () => {
  const PROXIED_LEGACY = [muxed('18', 640, 360, getProxyUrl('https://inv.example/videoplayback?itag=18&id=dQw4w9WgXcQ'))]
  const LEGACY = [muxed('18', 640, 360, 'https://inv.example/videoplayback?itag=18&id=dQw4w9WgXcQ')]
  const WEB_MANIFEST = `${INSTANCE}/api/manifest/dash/id/dQw4w9WgXcQ`

  it('plays a video as DASH generated from the instance\'s formats where the build has the Local API', async () => {
    const { source } = await sourceOf({ invidious: invidiousOrdinary })

    expect(source).toMatchObject({
      transport: 'manifest',
      manifestMimeType: DASH,
      legacyFormats: LEGACY,
      isLive: false,
      expiresAt: new Date(1790000000 * 1000),
      vrProjection: null,
      isPostLiveDvr: false,
    })
    expect(source.manifestUrl).toMatch(/^data:application\/dash\+xml;charset=UTF-8,/)
    expect(decoded(source.manifestUrl)).toContain('<Representation id="137"')
    expect(source.audio).toEqual({ manifestUrl: source.manifestUrl, mimeType: DASH })
  })

  it('gives each audio track its own adaptation set, labelled as Local labels them', async () => {
    const { source } = await sourceOf({ invidious: invidiousMultipleAudio })
    const manifest = decoded(source.manifestUrl)

    expect(manifest).toContain('English original')
    expect(manifest).toContain('German')
    expect(source.vrProjection).toBe('EQUIRECTANGULAR')
  })

  it.each([
    ['Electron, not proxying', { supportsLocalApi: true, proxyVideos: false }, LEGACY, 'generated'],
    ['Electron, proxying', { supportsLocalApi: true, proxyVideos: true }, PROXIED_LEGACY, 'generated'],
    ['the web build, not proxying', { supportsLocalApi: false, proxyVideos: false }, PROXIED_LEGACY, WEB_MANIFEST],
    ['the web build, proxying', { supportsLocalApi: false, proxyVideos: true }, PROXIED_LEGACY, `${WEB_MANIFEST}?local=true`],
  ])('in %s, streams legacy formats and the manifest as it should', async (_what, config, legacyFormats, manifest) => {
    const { source } = await sourceOf({ invidious: invidiousOrdinary, config })

    expect(source.legacyFormats).toEqual(legacyFormats)
    if (manifest === 'generated') {
      expect(source.manifestUrl).toMatch(/^data:application\/dash\+xml/)
    } else {
      expect(source.manifestUrl).toBe(manifest)
    }
  })

  it.each([
    ['a live', invidiousLive, false, { isLive: true, isPostLiveDvr: false, expiresAt: new Date(1790000500 * 1000) }],
    ['a live, proxying', invidiousLive, true, { isLive: true }],
    ['a post-live DVR', invidiousPostLiveDvr, false, { isLive: false, isPostLiveDvr: true, expiresAt: null }],
    ['a post-live DVR, proxying', invidiousPostLiveDvr, true, { isLive: false, isPostLiveDvr: true }],
  ])('plays %s from the instance\'s HLS of muxed streams', async (_what, invidious, proxyVideos, expected) => {
    const { source } = await sourceOf({ invidious, config: { proxyVideos } })
    const hls = new URL(invidious.answer.hlsUrl)

    if (proxyVideos) {
      hls.searchParams.set('local', 'true')
    }

    expect(source).toMatchObject({
      manifestUrl: hls.toString(),
      manifestMimeType: HLS,
      audio: null,
      legacyFormats: [],
      storyboard: null,
      vrProjection: null,
      ...expected,
    })
  })

  it('reads a live with no HLS manifest as unavailable', async () => {
    const live = structuredClone(invidiousLive)
    delete live.answer.hlsUrl
    const { layer } = setUp({ answers: { invidiousGetVideoInformation: live }, config: { backendPreference: 'invidious' } })

    expect((await failure(layer.getVideo('ODio2-1aFa8'))).kind).toBe('unavailable')
  })

  it('has nothing to play for a waiting live', async () => {
    expect((await sourceOf({ invidious: invidiousUpcoming })).source).toBeNull()
  })

  it('has no loudness and no ad delay, which only Local knows', async () => {
    const { source } = await sourceOf({ invidious: invidiousOrdinary })

    expect(source).not.toHaveProperty('loudnessDb')
    expect(source).not.toHaveProperty('delayLoadUntilMs')
  })
})

describe('a YouTube video\'s captions', () => {
  const timedText = query => `https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&${query}`
  const EN_GB = { id: '.en-GB', url: timedText('lang=en-GB&fmt=vtt'), label: 'English (United Kingdom)', language: 'en-GB', mimeType: 'text/vtt', isAutomatic: false }
  const EN_AUTO = { id: 'a.en', url: timedText('lang=en&kind=asr&fmt=vtt'), label: 'English (auto-generated)', language: 'en', mimeType: 'text/vtt', isAutomatic: true }
  const DE = { id: '.de', url: timedText('lang=de&fmt=vtt'), label: 'German', language: 'de', mimeType: 'text/vtt', isAutomatic: false }
  const translated = (code, language) => ({
    id: `a.en.${code}`,
    url: timedText(`lang=en&kind=asr&fmt=srt&tlang=${code}`),
    label: `${language ?? code} (translated from "English (auto-generated)")`,
    language: code,
    mimeType: 'text/srt',
    isAutotranslated: true,
    translation: { language, originalLanguage: 'English (auto-generated)' },
  })

  it.each([
    // The display language's, written before generated, then the rest
    ['en-US', [EN_GB, EN_AUTO, DE]],
    ['de-DE', [EN_GB, EN_AUTO, DE]],
    // None in the display language: YouTube's translation of the generated
    // track, by the name YouTube gives the language, ordered by its label
    ['fr', [EN_GB, EN_AUTO, translated('fr', 'French'), DE]],
    ['nb-NO', [EN_GB, EN_AUTO, DE, translated('nb', 'Norwegian Bokmål')]],
    // A language YouTube does not name: the view names it (`Locale Name`)
    ['ja', [EN_GB, EN_AUTO, DE, translated('ja', null)]],
  ])('on Local, for the display language %s', async (locale, captions) => {
    // `sortCaptions` orders by the app's own display language, en-US in tests
    expect((await sourceOf({ local: localOrdinary, config: { locale } })).source.captions).toEqual(captions)
  })

  it('on Invidious, on the instance, in the same order', async () => {
    const caption = (label, language) => ({ url: `${INSTANCE}/api/v1/captions/dQw4w9WgXcQ?label=${label}`, label: decodeURIComponent(label.replaceAll('+', ' ')), language, mimeType: 'text/vtt' })

    expect((await sourceOf({ invidious: invidiousOrdinary })).source.captions).toEqual([
      caption('English', 'en'),
      caption('English+%28auto-generated%29', 'en'),
      caption('Deutsch', 'de'),
    ])
  })
})

describe('a YouTube video\'s chapters', () => {
  const thumbnail = ms => ({ url: `https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault_${ms}.jpg`, width: 168, height: 94 })
  const keyMomentsPanel = {
    panel_identifier: 'engagement-panel-macro-markers-auto-chapters',
    content: {
      contents: [
        { type: 'MacroMarkersListItem', title: { text: 'Start' }, time_description: { text: '0:00' }, thumbnail: [thumbnail(0)] },
        { type: 'ContinuationItem' },
        { type: 'MacroMarkersListItem', title: { text: 'Late' }, time_description: { text: '1:02' } },
      ],
    },
  }

  it.each([
    ['the player bar\'s markers first', localOrdinary, 'chapters', [
      { title: 'Intro', timestamp: '0:00', startSeconds: 0, endSeconds: 43, thumbnail: thumbnail(0) },
      { title: 'Chorus', timestamp: '0:43', startSeconds: 43, endSeconds: 213, thumbnail: thumbnail(43000) },
    ]],
    ['YouTube\'s key moments next', localWith(localOrdinary, (info) => {
      delete info.player_overlays
      info.page[1] = { engagement_panels: [{ panel_identifier: 'other' }, keyMomentsPanel] }
    }), 'keyMoments', [
      { title: 'Start', timestamp: '0:00', startSeconds: 0, endSeconds: 62, thumbnail: thumbnail(0) },
      { title: 'Late', timestamp: '1:02', startSeconds: 62, endSeconds: 213 },
    ]],
    ['the description\'s timestamps last', localWith(localOrdinary, (info) => {
      delete info.player_overlays
      info.basic_info.short_description = 'Hello\n0:00 Start\n1:00:05 - Much later'
    }), 'chapters', [
      { title: 'Start', timestamp: '0:00', startSeconds: 0, endSeconds: 3605 },
      { title: 'Much later', timestamp: '1:00:05', startSeconds: 3605, endSeconds: 213 },
    ]],
  ])('on Local, from %s', async (_what, local, chaptersKind, chapters) => {
    const { video, source } = await sourceOf({ local })

    expect(video.chaptersKind).toBe(chaptersKind)
    expect(source.chapters).toEqual(chapters)
  })

  it('on Invidious, from the description, a repeated start replacing the one before', async () => {
    const { video, source } = await sourceOf({ invidious: invidiousOrdinary })

    expect(video.chaptersKind).toBe('chapters')
    expect(source.chapters).toEqual([
      { title: 'Intro', timestamp: '0:00', startSeconds: 0, endSeconds: 43 },
      { title: 'Chorus, again', timestamp: '0:43', startSeconds: 43, endSeconds: 180 },
      { title: 'Outro', timestamp: '3:00', startSeconds: 180, endSeconds: 213 },
    ])
  })

  it('as the player\'s WebVTT chapters track, as PeerTube\'s', async () => {
    const { source } = await sourceOf({ local: localOrdinary })

    expect(source.chaptersSrc).toBe(`data:text/vtt,${encodeURIComponent('WEBVTT\n\n00:00:00.000 --> 00:00:43.000\nIntro\n\n00:00:43.000 --> 00:03:33.000\nChorus\n')}`)
  })
})

describe('a YouTube video\'s most replayed heatmap', () => {
  const marker = (start, duration, intensity) => ({
    type: 'HeatMarker',
    time_range_start_millis: start,
    marker_duration_millis: duration,
    heat_marker_intensity_score_normalized: intensity,
  })
  const withHeatmap = markers => localWith(localOrdinary, (info) => {
    info.heat_map = { type: 'Heatmap', max_height_dp: 40, min_height_dp: 4, heat_markers: markers }
  })

  it('on Local, is youtubei.js\' markers in seconds, in order', async () => {
    const { source } = await sourceOf({ local: withHeatmap([marker(2140, 2140, 0.42), marker(0, 2140, 1)]) })

    expect(source.heatmap).toEqual([
      { startSeconds: 0, endSeconds: 2.14, intensity: 1 },
      { startSeconds: 2.14, endSeconds: 4.28, intensity: 0.42 },
    ])
  })

  it('on Local, leaves out a marker that is not a number and holds the intensity between 0 and 1', async () => {
    const { source } = await sourceOf({
      local: withHeatmap([marker(0, 1000, 1.5), marker(1000, 1000, -0.2), marker(2000, Number.NaN, 0.5), { type: 'HeatMarker' }]),
    })

    expect(source.heatmap).toEqual([
      { startSeconds: 0, endSeconds: 1, intensity: 1 },
      { startSeconds: 1, endSeconds: 2, intensity: 0 },
    ])
  })

  it.each([
    ['youtubei.js found none', localOrdinary],
    ['its markers are empty', withHeatmap([])],
  ])('on Local, is none where %s', async (_what, local) => {
    expect((await sourceOf({ local })).source.heatmap).toBeNull()
  })

  it('carries over SABR as over DASH', async () => {
    const local = withHeatmap([marker(0, 2140, 1)])
    local.answer.poToken = 'po-token'
    const { source } = await sourceOf({ local })

    expect(source.transport).toBe('sabr')
    expect(source.heatmap).toEqual([{ startSeconds: 0, endSeconds: 2.14, intensity: 1 }])
  })

  it('on Invidious, is absent, which only Local knows', async () => {
    expect((await sourceOf({ invidious: invidiousOrdinary })).source).not.toHaveProperty('heatmap')
  })
})

describe('a YouTube video\'s storyboard', () => {
  it('on Local, is a WebVTT data URI of the largest board', async () => {
    const { source } = await sourceOf({ local: localOrdinary })

    expect(source.storyboard).toMatch(/^data:text\/vtt;charset=utf-8,/)
    expect(decoded(source.storyboard)).toMatch(/^WEBVTT\n\n00:00:00\.000 --> 00:00:02\.000\nhttps:\/\/i\.ytimg\.com\/sb\/dQw4w9WgXcQ\/storyboard3_L2\/M0\.jpg\?sigh=c#xywh=0,0,160,90\n/)
  })

  it('on Local, is none without storyboards', async () => {
    expect((await sourceOf({ local: localWith(localOrdinary, (info) => { delete info.storyboards }) })).source.storyboard).toBeNull()
  })

  it('on Local, comes for a narrow window too, from the largest board at most 90px high', async () => {
    const { source } = await sourceOf({
      local: localWith(localOrdinary, (info) => {
        info.storyboards.boards.push({ ...info.storyboards.boards[1], template_url: 'https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L3/M$M.jpg?sigh=d', thumbnail_width: 320, thumbnail_height: 180 })
      }),
    })

    expect(decoded(source.storyboard)).toContain('storyboard3_L3/M0.jpg?sigh=d#xywh=0,0,320,180')
    expect(decoded(source.narrowStoryboard)).toContain('storyboard3_L2/M0.jpg?sigh=c#xywh=0,0,160,90')
  })

  it('on Local, has none for a narrow window when every board is larger', async () => {
    const { source } = await sourceOf({
      local: localWith(localOrdinary, (info) => {
        info.storyboards.boards = info.storyboards.boards.map(board => ({ ...board, thumbnail_height: 180 }))
      }),
    })

    expect(source.storyboard).not.toBeNull()
    expect(source.narrowStoryboard).toBeNull()
  })

  it('on Invidious, is the instance\'s storyboard track', async () => {
    expect((await sourceOf({ invidious: invidiousOrdinary })).source.storyboard).toBe(`${INSTANCE}/api/v1/storyboards/dQw4w9WgXcQ?height=90`)
  })
})
