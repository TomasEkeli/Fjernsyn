// A YouTube video's `manifest` playback source and the kind of its chapters,
// one builder per backend. The specification is the playback source section
// of `./types.js` (`YouTubePlaybackExtras`, `YouTubeManifestPlaybackSource`);
// the building is the old watch view's (`getVideoInformationLocal`,
// `getVideoInformationInvidious`, `createLocalDashManifest`,
// `createInvidiousDashManifest`, `getTranslatedLocaleCaption`,
// `extractChaptersFromDescription`, `addChaptersEndSeconds` in
// `views/Watch/Watch.js`), re-implemented here so the view stays unedited.
//
// - A waiting live has nothing to play (`null`), except on Local where YouTube
//   answered a trailer in its place and marked it playable, which plays as a
//   video does.
// - A live, or a post-live DVR, plays from a live manifest alone: no legacy
//   formats, no storyboard, and on Local no captions (the old view reads them
//   for a video only). With no manifest to play it is `unavailable`, which the
//   old view shows as a retryable error and falls back from.
// - Anything else plays from a DASH manifest, legacy formats (`null` manifest
//   when only those exist), captions, chapters and a storyboard; on Local over
//   SABR instead of DASH where the response allows it (`./sabr.js`), with the
//   same fields around the SABR manifest.
//
// What stays the view's: hiding chapters (`hideChapters`, the adapter always
// answers them), choosing the storyboard's smaller board below 500px of window
// width (the layer cannot see the window: on Local it answers the largest
// board and, as `narrowStoryboard`, the largest at most 90px high), whether
// the active format can be used, and every toast.

import { selectLiveManifest } from '../../helpers/player/liveManifest'
import { PlatformError } from '../errors'
import { chaptersSrcOf } from '../peertube/playback'
import { canPlaySabr, sabrSource } from './sabr'
import { dateOf, isNumber, onInstance } from './videoDetails'

export const DASH_MIME_TYPE = 'application/dash+xml'
export const HLS_MIME_TYPE = 'application/x-mpegurl'

const VTT_MIME_TYPE = 'text/vtt'

/** @typedef {import('../shapes').ManifestPlaybackSource} ManifestPlaybackSource */
/** @typedef {import('../shapes').Chapter} Chapter */
/** @typedef {import('../shapes').CaptionTrack} CaptionTrack */
/** @typedef {'live' | 'waiting' | 'ended' | null} LiveStatus */
/** @typedef {{ playbackSource: import('../shapes').PlaybackSource | null, chaptersKind: 'chapters' | 'keyMoments' }} Playback */

/**
 * @typedef {object} PlaybackDeps
 * @property {import('./deps').YouTubeDeps} youtube
 * @property {Readonly<import('../index').PlatformConfig>} config
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * @param {string} xml
 */
function dashDataUri(xml) {
  return `data:${DASH_MIME_TYPE};charset=UTF-8,${encodeURIComponent(xml)}`
}

/**
 * The audio-only source of a manifest: the manifest itself where its audio is
 * a separate rendition, which a DASH manifest's always is, and an HLS one's
 * only when YouTube demuxed it (`/demuxed/1` in its URL).
 *
 * @param {string | null} manifestUrl
 * @param {string | null} mimeType
 * @returns {ManifestPlaybackSource['audio']}
 */
function audioOf(manifestUrl, mimeType) {
  if (!manifestUrl || !mimeType) {
    return null
  }

  if (mimeType === HLS_MIME_TYPE && !manifestUrl.includes('/demuxed/1')) {
    return null
  }

  return { manifestUrl, mimeType }
}

/**
 * The whole source, in the order of the common shape, the extras after.
 *
 * @param {Partial<ManifestPlaybackSource>} fields
 * @returns {ManifestPlaybackSource}
 */
export function manifestSource({
  manifestUrl = null,
  manifestMimeType = null,
  legacyFormats = [],
  captions = [],
  chapters = [],
  storyboard = null,
  isLive = false,
  ...extras
}) {
  return {
    transport: 'manifest',
    manifestUrl,
    manifestMimeType: manifestUrl ? manifestMimeType : null,
    legacyFormats,
    audio: audioOf(manifestUrl, manifestMimeType),
    captions,
    chapters,
    chaptersSrc: chaptersSrcOf(chapters),
    storyboard,
    isLive,
    ...extras,
  }
}

/**
 * youtubei.js' `Utils.timeToSeconds`, re-implemented rather than importing
 * youtubei.js into the layer for six lines: `s`, `m:ss` or `h:mm:ss`, digits
 * only; `0` for anything else.
 *
 * @param {string} text
 */
function timeToSeconds(text) {
  const parts = text.split(':').map(part => Number.parseInt(part.replaceAll(/\D/g, ''), 10))

  if (parts.length > 3 || parts.some(part => Number.isNaN(part))) {
    return 0
  }

  return parts.reduce((seconds, part) => seconds * 60 + part, 0)
}

/** `[h:]m:ss Title`, with an optional end time and separator, one per line */
const DESCRIPTION_CHAPTER = /^(?<timestamp>((?<hours>\d+):)?(?<minutes>\d+):(?<seconds>\d+))(\s*[–—-]\s*(?:\d+:){1,2}\d+)?\s+([–—•-]\s*)?(?<title>.+)$/gm

/**
 * The chapters an uploader wrote as timestamps in the description, as the old
 * view's `extractChaptersFromDescription`: a later line starting at the same
 * time replaces the one before.
 *
 * @param {unknown} description
 * @returns {Chapter[]}
 */
export function chaptersFromDescription(description) {
  if (typeof description !== 'string') {
    return []
  }

  /** @type {Chapter[]} */
  const chapters = []

  for (const { groups } of description.matchAll(DESCRIPTION_CHAPTER)) {
    const start = 3600 * Number(groups.hours ?? 0) + 60 * Number(groups.minutes) + Number(groups.seconds)

    if (chapters.at(-1)?.startSeconds === start) {
      chapters.pop()
    }

    chapters.push({ title: groups.title.trim(), timestamp: groups.timestamp, startSeconds: start, endSeconds: 0 })
  }

  return chapters
}

/**
 * Each chapter ends where the next starts, the last at the end of the video,
 * as the old view's `addChaptersEndSeconds`.
 *
 * @param {Chapter[]} chapters
 * @param {unknown} lengthSeconds
 * @returns {Chapter[]}
 */
function withEnds(chapters, lengthSeconds) {
  chapters.forEach((chapter, index) => {
    chapter.endSeconds = index + 1 < chapters.length
      ? chapters[index + 1].startSeconds
      : (isNumber(lengthSeconds) ? lengthSeconds : 0)
  })

  return chapters
}

// ---------------------------------------------------------------------------
// Local
// ---------------------------------------------------------------------------

/** The languages YouTube may name the display language by, as the old view lists them */
function displayLanguages(locale) {
  const languages = new Set([locale, locale.split('-')[0]])

  // "no" is the macro language of "nb" and "nn"; "iw" YouTube's old code for Hebrew
  if (locale === 'nn' || locale === 'nb-NO') {
    languages.add('no')
  } else if (locale === 'he') {
    languages.add('iw')
  }

  return languages
}

/**
 * The track YouTube translates into the display language, as the old view's
 * `getTranslatedLocaleCaption`: a written track in the language of the
 * generated one if there is one, else the generated one, else the first
 * translatable, else the first. YouTube answers a translation asked for as
 * WebVTT with HTTP 429, so it is asked for as SRT.
 *
 * @param {any} captions the `PlayerCaptionsTracklist`
 * @param {Set<string>} languages
 * @returns {CaptionTrack | null}
 */
function translatedCaption(captions, languages) {
  const tracks = captions.caption_tracks
  const target = captions.translation_languages?.find(language => languages.has(language.language_code))
  const languageCode = target?.language_code ?? languages.values().next().value
  // The old view fills a missing name with the display language's own
  // (`Locale Name`), which only the view can translate
  const languageName = target ? (target.language_name?.text ?? target.language_code) : null

  const generated = tracks.find(track => track.kind === 'asr')
  const source = generated
    ? (tracks.find(track => track.kind !== 'asr' && track.language_code === generated.language_code) ?? generated)
    : (tracks.find(track => track.is_translatable) ?? tracks[0])

  if (typeof source?.base_url !== 'string') {
    return null
  }

  const url = new URL(source.base_url)
  url.searchParams.set('fmt', 'srt')
  url.searchParams.set('tlang', languageCode)

  const originalLanguage = source.name?.text ?? source.language_code

  return {
    id: `${source.vss_id}.${languageCode}`,
    url: url.toString(),
    // `Video.Player.TranslatedCaptionTemplate` in English; `translation` is
    // for the view's own
    label: `${languageName ?? languageCode} (translated from "${originalLanguage}")`,
    language: languageCode,
    mimeType: 'text/srt',
    isAutotranslated: true,
    translation: { language: languageName, originalLanguage },
  }
}

/**
 * The caption tracks as WebVTT, plus a translation into the display language
 * when none is in it, in the order of the old view's `sortCaptions`.
 *
 * @param {any} info
 * @param {PlaybackDeps} deps
 * @returns {CaptionTrack[]}
 */
function localCaptions(info, { youtube, config }) {
  const captions = info.captions
  const tracks = Array.isArray(captions?.caption_tracks) ? captions.caption_tracks : []

  /** @type {CaptionTrack[]} */
  const result = tracks
    .filter(track => typeof track?.base_url === 'string')
    .map((track) => {
      const url = new URL(track.base_url)
      url.searchParams.set('fmt', 'vtt')

      return {
        id: track.vss_id,
        url: url.toString(),
        label: track.name?.text ?? track.language_code,
        language: track.language_code,
        mimeType: VTT_MIME_TYPE,
        isAutomatic: track.kind === 'asr',
      }
    })

  if (result.length === 0) {
    return []
  }

  const languages = displayLanguages(config.locale || 'en-US')

  if (!result.some(track => languages.has(track.language))) {
    const translated = translatedCaption(captions, languages)

    if (translated) {
      result.push(translated)
    }
  }

  return youtube.sortCaptions(result)
}

/**
 * The chapters, from the first of: the player bar's chapter markers, the
 * key-moments panel (YouTube's own, `keyMoments`), the description's
 * timestamps. Markers and key moments carry the frame they show.
 *
 * @param {any} info
 * @param {import('./deps').YouTubeDeps} youtube
 * @returns {{ chapters: Chapter[], chaptersKind: 'chapters' | 'keyMoments' }}
 */
function localChapters(info, youtube) {
  const basic = info.basic_info ?? {}
  const markers = info.player_overlays?.decorated_player_bar?.player_bar?.markers_map
    ?.find(marker => marker?.marker_key === 'DESCRIPTION_CHAPTERS')?.value?.chapters

  if (Array.isArray(markers) && markers.length > 0) {
    const chapters = markers.map((marker) => {
      const start = marker.time_range_start_millis / 1000
      return withThumbnail({
        title: marker.title?.text ?? '',
        timestamp: youtube.formatDurationAsTimestamp(start),
        startSeconds: start,
        endSeconds: 0,
      }, marker.thumbnail)
    })

    return { chapters: withEnds(chapters, basic.duration), chaptersKind: 'chapters' }
  }

  const keyMoments = info.page?.[1]?.engagement_panels
    ?.find(panel => panel?.panel_identifier === 'engagement-panel-macro-markers-auto-chapters')?.content

  if (keyMoments) {
    const contents = Array.isArray(keyMoments.contents) ? keyMoments.contents : []
    const chapters = contents
      .filter(item => item?.type === 'MacroMarkersListItem')
      .map((item) => {
        const timestamp = item.time_description?.text ?? ''
        return withThumbnail({
          title: item.title?.text ?? '',
          timestamp,
          startSeconds: timeToSeconds(timestamp),
          endSeconds: 0,
        }, item.thumbnail)
      })

    return { chapters: withEnds(chapters, basic.duration), chaptersKind: 'keyMoments' }
  }

  const description = basic.short_description ?? info.secondary_info?.description?.text ?? ''
  return { chapters: withEnds(chaptersFromDescription(description), basic.duration), chaptersKind: 'chapters' }
}

/**
 * @param {Chapter} chapter
 * @param {any} thumbnails youtubei.js' `Thumbnail[]`
 * @returns {Chapter}
 */
function withThumbnail(chapter, thumbnails) {
  const thumbnail = Array.isArray(thumbnails) ? thumbnails[0] : null

  if (typeof thumbnail?.url === 'string') {
    chapter.thumbnail = thumbnail
  }

  return chapter
}

/**
 * The storyboard's boards, smallest first, as youtubei.js answers them.
 *
 * @param {any} info
 * @returns {any[]} youtubei.js' `StoryboardData[]`
 */
function localStoryboardBoards(info) {
  if (info.storyboards?.type !== 'PlayerStoryboardSpec' || !Array.isArray(info.storyboards.boards)) {
    return []
  }

  return info.storyboards.boards
}

/**
 * The storyboard board the source is built from: the largest. The old view
 * takes the largest at most 90px high when the window is narrower than 500px,
 * which only the view can see (`narrowStoryboard`).
 *
 * @param {any} info
 * @returns {any | null} youtubei.js' `StoryboardData`
 */
function localStoryboardBoard(info) {
  return localStoryboardBoards(info).at(-1) ?? null
}

/**
 * The board the old view takes in a window narrower than 500px: the largest
 * at most 90px high.
 *
 * @param {any} info
 * @returns {any | null} youtubei.js' `StoryboardData`
 */
function localNarrowStoryboardBoard(info) {
  return localStoryboardBoards(info).filter(board => board.thumbnail_height <= 90).at(-1) ?? null
}

/**
 * The first video format's projection when it is not rectangular.
 *
 * @param {any[]} formats
 * @param {(format: any) => boolean} isVideo
 * @param {string} field
 */
function vrProjectionOf(formats, isVideo, field) {
  const format = formats.find(format => isVideo(format) && typeof format[field] === 'string' && format[field] !== 'RECTANGULAR')
  return format?.[field] ?? null
}

/**
 * What Local adds to the common source. `vrProjection` only for a video
 * played from its formats, as the old view reads it.
 *
 * @param {{ info: any, adEndTimeUnixMs?: number }} answer
 * @param {boolean} playable
 */
function localExtras({ info, adEndTimeUnixMs }, playable) {
  const loudness = info.player_config?.audio_config?.loudness_db
  const adaptive = Array.isArray(info.streaming_data?.adaptive_formats) ? info.streaming_data.adaptive_formats : []

  /** @type {Partial<ManifestPlaybackSource>} */
  const extras = {
    loudnessDb: isNumber(loudness) ? loudness : null,
    expiresAt: dateOf(info.streaming_data?.expires),
    vrProjection: playable ? vrProjectionOf(adaptive, format => !!format.has_video, 'projection_type') : null,
    isPostLiveDvr: !!info.basic_info?.is_post_live_dvr,
  }

  if (isNumber(adEndTimeUnixMs)) {
    extras.delayLoadUntilMs = adEndTimeUnixMs
  }

  return extras
}

/**
 * @param {any} streamingData
 */
function hasStreamableAdaptiveFormats(streamingData) {
  const first = streamingData?.adaptive_formats?.[0]
  return !!(first?.url || first?.signature_cipher || first?.cipher)
}

/**
 * YouTube's own DASH manifest of the video, from youtubei.js (`toDash`),
 * which builds an adaptation set per audio track where there are several.
 *
 * @param {any} info the `YT.VideoInfo` instance
 * @param {boolean} includeThumbnails
 */
async function localDashManifest(info, includeThumbnails) {
  return dashDataUri(await info.toDash({ manifest_options: { include_thumbnails: includeThumbnails } }))
}

/**
 * Everything of a video played from its formats but the manifest and the
 * chapters (`localChapters`): legacy formats, captions, the storyboard (and
 * the board it came from), and the extras.
 *
 * @param {{ info: any, adEndTimeUnixMs?: number }} answer
 * @param {PlaybackDeps} deps
 */
function localPlayableParts(answer, deps) {
  const { info } = answer
  const formats = Array.isArray(info.streaming_data?.formats) ? info.streaming_data.formats : []
  const storyboardBoard = localStoryboardBoard(info)
  const narrowBoard = localNarrowStoryboardBoard(info)
  /** @param {any} board */
  const storyboardOf = board => board
    ? `data:text/vtt;charset=utf-8,${encodeURIComponent(deps.youtube.buildVTTFileLocally(board, info.basic_info?.duration))}`
    : null
  const storyboard = storyboardOf(storyboardBoard)

  return {
    legacyFormats: formats.map(format => deps.youtube.mapLocalLegacyFormat(format)),
    captions: localCaptions(info, deps),
    storyboard,
    narrowStoryboard: narrowBoard === storyboardBoard ? storyboard : storyboardOf(narrowBoard),
    storyboardBoard,
    extras: localExtras(answer, true),
  }
}

/**
 * A live's or a post-live DVR's manifest: for a post-live DVR, a DASH manifest
 * of the formats (the last four hours only, with the storyboard's thumbnails)
 * where youtubei.js can build one, else YouTube's live manifest, DASH before
 * HLS.
 *
 * @param {string} id
 * @param {any} info
 * @returns {Promise<{ manifestUrl: string, manifestMimeType: string }>}
 */
async function localLiveManifest(id, info) {
  if (info.basic_info?.is_post_live_dvr && hasStreamableAdaptiveFormats(info.streaming_data)) {
    try {
      return { manifestUrl: await localDashManifest(info, true), manifestMimeType: DASH_MIME_TYPE }
    } catch {
      // YouTube's own manifest, below, as the old view falls back to it
    }
  }

  const live = selectLiveManifest(info.streaming_data)

  if (!live) {
    throw new PlatformError('unavailable', `No playable livestream source for ${id}`)
  }

  return { manifestUrl: live.src, manifestMimeType: live.mimeType }
}

/**
 * @param {string} id
 * @param {{ info: any, adEndTimeUnixMs?: number }} answer what `getLocalVideoInfo` answered
 * @param {PlaybackDeps} deps
 * @param {LiveStatus} liveStatus
 * @returns {Promise<Playback>}
 */
export async function localPlayback(id, answer, deps, liveStatus) {
  const { info } = answer
  const { chapters, chaptersKind } = localChapters(info, deps.youtube)

  if (liveStatus === 'live' || liveStatus === 'ended') {
    const manifest = await localLiveManifest(id, info)

    return {
      playbackSource: manifestSource({ ...manifest, chapters, isLive: liveStatus === 'live', ...localExtras(answer, false) }),
      chaptersKind,
    }
  }

  // A waiting live plays only a trailer `getLocalVideoInfo` swapped in, and
  // a video without streaming data (region locked, or the like) nothing
  if ((liveStatus === 'waiting' && info.playability_status?.status !== 'OK') || !info.streaming_data) {
    return { playbackSource: null, chaptersKind }
  }

  const { legacyFormats, captions, storyboard, narrowStoryboard, storyboardBoard, extras } = localPlayableParts(answer, deps)
  /**
   * @param {string | null} manifestUrl
   * @param {string} manifestMimeType
   */
  const around = (manifestUrl, manifestMimeType) =>
    manifestSource({ manifestUrl, manifestMimeType, legacyFormats, captions, chapters, storyboard, narrowStoryboard, ...extras })

  if (canPlaySabr(answer)) {
    return { playbackSource: sabrSource(id, answer, deps.youtube, { captions, chapters, storyboardBoard }, around), chaptersKind }
  }

  const manifestUrl = hasStreamableAdaptiveFormats(info.streaming_data) ? await localDashManifest(info, false) : null

  return { playbackSource: around(manifestUrl, DASH_MIME_TYPE), chaptersKind }
}

// ---------------------------------------------------------------------------
// Invidious
// ---------------------------------------------------------------------------

/**
 * When a stream URL expires: its `expire` parameter, in seconds.
 *
 * @param {unknown} url
 * @returns {Date | null}
 */
function expiryOf(url) {
  if (typeof url !== 'string') {
    return null
  }

  try {
    const expire = Number.parseInt(new URL(url).searchParams.get('expire') ?? '', 10)
    return Number.isNaN(expire) ? null : new Date(expire * 1000)
  } catch {
    return null
  }
}

/**
 * The audio track youtubei.js' DASH generator labels a track by, as the old
 * view's `generateAudioTrackFieldInvidious` makes it: YouTube's own id numbers
 * and English names, as Local's answer has them.
 *
 * @param {any} format a `Misc.Format`, which gains its `audio_track`
 * @param {Intl.DisplayNames} languageNames
 */
function addAudioTrack(format, languageNames) {
  /** @type {[string, number]} */
  let kind = [' alternative', -1]

  if (format.is_descriptive) {
    kind = [' descriptive', 2]
  } else if (format.is_dubbed) {
    kind = ['', 3]
  } else if (format.is_original) {
    kind = [' original', 4]
  } else if (format.is_secondary) {
    kind = [' secondary', 6]
  } else if (format.is_auto_dubbed) {
    kind = ['', 10]
  }

  const [type, idNumber] = kind

  format.audio_track = {
    audio_is_default: !!format.is_original,
    id: `${format.language}.${idNumber}`,
    display_name: `${languageNames.of(format.language)}${type}`,
  }
}

/**
 * The DASH manifest: where the build has the Local API, generated here from
 * the instance's adaptive formats with youtubei.js, which also gives the audio
 * tracks Invidious' own manifest lacks (`null` without formats); otherwise
 * the instance's manifest URL, served through the instance when proxying.
 *
 * @param {string} id
 * @param {any} video
 * @param {PlaybackDeps} deps
 * @returns {Promise<string | null>}
 */
async function invidiousDashManifest(id, video, { youtube, config }) {
  if (!config.supportsLocalApi) {
    const url = `${config.currentInvidiousInstanceUrl}/api/manifest/dash/id/${id}`
    return config.proxyVideos ? `${url}?local=true` : url
  }

  const adaptive = Array.isArray(video.adaptiveFormats) ? video.adaptiveFormats : []

  if (adaptive.length === 0) {
    return null
  }

  // What the old view's `getAdaptiveFormatsInvidious` writes onto the answer,
  // on copies: the number the generator reads, and the size as width and height
  const formats = adaptive.map((format) => {
    const copy = { ...format, bitrate: Number.parseInt(format.bitrate, 10) }

    // Audio streams have no size
    if (typeof format.size === 'string') {
      const [width, height] = format.size.split('x')
      copy.width = Number.parseInt(width, 10)
      copy.height = Number.parseInt(height, 10)
    }

    return youtube.convertInvidiousToLocalFormat(copy)
  })

  const audio = formats.filter(format => format.has_audio)

  if (audio.some(format => format.is_dubbed || format.is_descriptive || format.is_secondary || format.is_auto_dubbed)) {
    const languageNames = new Intl.DisplayNames('en-US', { type: 'language', languageDisplay: 'standard' })
    audio.forEach(format => addAudioTrack(format, languageNames))
  }

  return dashDataUri(await youtube.generateInvidiousDashManifestLocally(formats))
}

/**
 * @param {string} id
 * @param {any} video what `invidiousGetVideoInformation` answered
 * @param {PlaybackDeps} deps
 * @param {LiveStatus} liveStatus
 * @returns {Promise<Playback>}
 */
export async function invidiousPlayback(id, video, deps, liveStatus) {
  const { youtube, config } = deps
  const instance = config.currentInvidiousInstanceUrl

  if (liveStatus === 'waiting') {
    return { playbackSource: null, chaptersKind: 'chapters' }
  }

  const adaptive = Array.isArray(video.adaptiveFormats) ? video.adaptiveFormats : []
  const chapters = withEnds(chaptersFromDescription(video.description), video.lengthSeconds)
  const captions = youtube.sortCaptions((Array.isArray(video.captions) ? video.captions : [])
    .filter(caption => typeof caption?.url === 'string')
    .map(caption => ({
      url: onInstance(instance, caption.url),
      label: caption.label,
      language: caption.language_code,
      mimeType: VTT_MIME_TYPE,
    })))

  if (liveStatus === 'live' || liveStatus === 'ended') {
    // The live DASH manifest stops answering within a minute and cannot be
    // proxied, so a live plays the HLS of muxed streams: no audio only, no legacy
    if (typeof video.hlsUrl !== 'string' || video.hlsUrl === '') {
      throw new PlatformError('unavailable', `No playable livestream source for ${id}`)
    }

    let manifestUrl = video.hlsUrl

    if (config.proxyVideos) {
      const hls = new URL(manifestUrl)
      hls.searchParams.set('local', 'true')
      manifestUrl = hls.toString()
    }

    return {
      playbackSource: manifestSource({
        manifestUrl,
        manifestMimeType: HLS_MIME_TYPE,
        captions,
        chapters,
        isLive: liveStatus === 'live',
        expiresAt: expiryOf(adaptive[0]?.url ?? video.hlsUrl),
        vrProjection: null,
        isPostLiveDvr: !!video.isPostLiveDvr,
      }),
      chaptersKind: 'chapters',
    }
  }

  // The web build plays every stream through the instance, Electron when proxying
  const proxied = !config.supportsLocalApi || config.proxyVideos
  const legacyFormats = (Array.isArray(video.formatStreams) ? video.formatStreams : [])
    .map(format => youtube.mapInvidiousLegacyFormat(format))
    .map(format => proxied ? { ...format, url: youtube.getProxyUrl(format.url) } : format)

  return {
    playbackSource: manifestSource({
      manifestUrl: await invidiousDashManifest(id, video, deps),
      manifestMimeType: DASH_MIME_TYPE,
      legacyFormats,
      captions,
      chapters,
      storyboard: `${instance}/api/v1/storyboards/${id}?height=90`,
      expiresAt: expiryOf(adaptive[0]?.url),
      vrProjection: vrProjectionOf(adaptive, () => true, 'projectionType'),
      isPostLiveDvr: false,
    }),
    chaptersKind: 'chapters',
  }
}
