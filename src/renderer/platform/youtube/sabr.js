// A YouTube Local video's `sabr` playback source (ADR-0016): every field of
// its `manifest` source around the project's own SABR manifest, plus the SABR
// credentials (`sabrData`), the storyboards the manifest embeds
// (`sabrStoryboards`), and `renew`. The specification is
// `YouTubeSabrPlaybackSource` in `./types.js`; the building is the old watch
// view's (`buildSabrData`, `createLocalSabrManifest`, its storyboards entry
// and `onSabrRefreshRequested` in `views/Watch/Watch.js`), re-implemented here
// so the view stays unedited.
//
// - SABR is chosen over DASH only when `getLocalVideoInfo` minted a PO token
//   and the player response has a SABR streaming URL and a ustreamer config:
//   without a token a SABR session is walled from its first request. Never for
//   a live or a post-live DVR, which `./playback.js` never asks about.
// - `renew` fetches a fresh player response and answers new credentials, and
//   for a rebuild a new manifest built from this source's own captions,
//   chapters and storyboards (which come from `/next`, not re-read). It
//   answers `null` where fresh credentials cannot be had, and never throws.
//   It decides nothing: when to call it, and what a `null` means, is the
//   regulator's, which stays in the watch view (ADR-0006).
// - The source never changes: it is frozen, and `renew` writes nothing to it.
//   The view holds the current credentials and expiry, as the old view does.

import { dateOf } from './videoDetails'

/**
 * The SABR manifest's MIME type, `MANIFEST_TYPE_SABR` in
 * `helpers/player/SabrManifestParser.js`, which registers the player's parser
 * for it. Restated, since that module imports shaka and the layer must not.
 */
export const SABR_MIME_TYPE = 'application/sabr+json'

/** @typedef {import('../shapes').SabrData} SabrData */
/** @typedef {import('../shapes').SabrRenewResult} SabrRenewResult */
/** @typedef {import('../shapes').SabrPlaybackSource} SabrPlaybackSource */

/**
 * Whether a player response can play over SABR: a token, a SABR URL and a
 * ustreamer config, and adaptive formats to play.
 *
 * @param {{ info: any, poToken?: string }} answer what `getLocalVideoInfo` answered
 */
export function canPlaySabr({ info, poToken }) {
  return !!poToken &&
    !!info?.streaming_data?.server_abr_streaming_url &&
    !!info.player_config?.media_common_config?.media_ustreamer_request_config &&
    Array.isArray(info.streaming_data.adaptive_formats) &&
    info.streaming_data.adaptive_formats.length > 0
}

/**
 * The credentials half, as the old view's `buildSabrData`: the deciphered
 * SABR URL with `alr` and the response's `cpn` set.
 *
 * @param {string} id
 * @param {{ info: any, poToken?: string, clientInfo?: SabrData['clientInfo'] }} answer
 * @returns {SabrData}
 */
function sabrDataOf(id, { info, poToken, clientInfo }) {
  const url = new URL(info.streaming_data.server_abr_streaming_url)
  url.searchParams.set('alr', 'yes')
  url.searchParams.set('cpn', info.cpn)

  return {
    url: url.toString(),
    videoId: id,
    poToken: /** @type {string} */ (poToken),
    ustreamerConfig: info.player_config.media_common_config.media_ustreamer_request_config.video_playback_ustreamer_config,
    clientInfo: /** @type {SabrData['clientInfo']} */ (clientInfo),
  }
}

/**
 * The storyboard board as the SABR manifest embeds it, `[]` without one.
 *
 * @param {any} board youtubei.js' `StoryboardData`, the one the source's
 *   storyboard track is built from
 * @returns {object[]}
 */
export function sabrStoryboardsOf(board) {
  if (!board) {
    return []
  }

  return [{
    templateUrl: board.template_url,
    mimeType: 'image/webp',
    columns: board.columns,
    rows: board.rows,
    thumbnailCount: board.thumbnail_count,
    thumbnailWidth: board.thumbnail_width,
    thumbnailHeight: board.thumbnail_height,
    storyboardCount: board.storyboard_count,
    interval: board.interval > 0 ? board.interval / 1000 : 0,
  }]
}

/**
 * The project's SABR manifest (`SabrManifest` in
 * `helpers/player/SabrManifestParser.js`) as a `data:` URI: the response's
 * adaptive formats, and the captions, chapters and storyboards given.
 *
 * @param {any} info
 * @param {{ captions: object[], chapters: object[], sabrStoryboards: object[] }} retained
 */
function sabrManifestUrlOf(info, { captions, chapters, sabrStoryboards }) {
  const formats = info.streaming_data.adaptive_formats

  const manifest = {
    // The formats' durations differ, and a timeline longer than the shortest
    // leaves the player stuck at the end
    duration: Math.min(...formats.map(format => format.approx_duration_ms)) / 1000,
    formats: formats.map(format => ({
      itag: format.itag,
      lastModified: format.last_modified_ms,
      mimeType: format.mime_type,
      xtags: format.xtags,
      bitrate: format.bitrate,
      initRange: format.init_range,
      indexRange: format.index_range,
      width: format.width,
      height: format.height,
      frameRate: format.fps,
      quality: format.quality,
      language: format.language,
      audioSampleRate: format.audio_sample_rate,
      audioChannels: format.audio_channels,
      isDrc: format.is_drc,
      isVoiceBoost: format.is_vb,
      isOriginal: format.is_original,
      isDubbed: format.is_dubbed,
      isAutoDubbed: format.is_auto_dubbed,
      isDescriptive: format.is_descriptive,
      isSecondary: format.is_secondary,
      spatialAudio: !!format.spatial_audio_type,
      label: format.audio_track?.display_name,
      colorTransferCharacteristics: format.color_info?.transfer_characteristics,
      colorPrimaries: format.color_info?.primaries,
    })),
    captions,
    chapters,
    storyboards: sabrStoryboards,
  }

  return `data:${SABR_MIME_TYPE},${encodeURIComponent(JSON.stringify(manifest))}`
}

/**
 * The formats a session serves, by the manifest parser's own identifier
 * (`buildFormatId`), so the two never drift.
 *
 * @param {any} info
 * @param {import('./deps').YouTubeDeps} youtube
 * @returns {string[]}
 */
function formatIdsOf(info, youtube) {
  return info.streaming_data.adaptive_formats.map(format => youtube.buildFormatId({
    itag: format.itag,
    lastModified: format.last_modified_ms,
    xtags: format.xtags,
  }))
}

/**
 * The SABR manifest's fields over a manifest source's: the same captions,
 * chapters, storyboard, legacy formats and extras.
 *
 * @param {string} id
 * @param {{ info: any, poToken?: string, clientInfo?: SabrData['clientInfo'] }} answer a SABR-capable answer (`canPlaySabr`)
 * @param {import('./deps').YouTubeDeps} youtube
 * @param {{ captions: import('../shapes').CaptionTrack[], chapters: import('../shapes').Chapter[], storyboardBoard: any }} parts
 *   the source's captions and chapters, which the manifest embeds, and the
 *   storyboard board its storyboard track is built from
 * @param {(manifestUrl: string, manifestMimeType: string) => import('../shapes').ManifestPlaybackSource} manifestSourceAround
 *   the manifest source the video has around a given manifest
 * @returns {SabrPlaybackSource}
 */
export function sabrSource(id, answer, youtube, { captions, chapters, storyboardBoard }, manifestSourceAround) {
  const sabrStoryboards = sabrStoryboardsOf(storyboardBoard)
  const manifestUrl = sabrManifestUrlOf(answer.info, { captions, chapters, sabrStoryboards })

  /**
   * Fresh credentials, and for a rebuild a manifest agreeing with them; see
   * the module comment.
   *
   * @param {{ reloadPlaybackContext?: object, rebuilding?: boolean }} [options]
   *   `reloadPlaybackContext` is the server's reload token from a
   *   `RELOAD_PLAYER_RESPONSE` part, which must ride on the `/player` call or
   *   the response describes the playback context just left
   * @returns {Promise<SabrRenewResult | null>}
   */
  async function renew({ reloadPlaybackContext, rebuilding = false } = {}) {
    try {
      const fresh = await youtube.getLocalVideoInfo(id, { reloadPlaybackContext })

      // No token: `getLocalVideoInfo` could not mint one even with retries,
      // and a session with none is walled from its first request
      if (!fresh?.poToken ||
        !fresh.info?.streaming_data?.server_abr_streaming_url ||
        !fresh.info.player_config?.media_common_config?.media_ustreamer_request_config) {
        return null
      }

      /** @type {SabrRenewResult} */
      const result = {
        sabrData: sabrDataOf(id, fresh),
        formatIds: formatIdsOf(fresh.info, youtube),
        expiresAt: dateOf(fresh.info.streaming_data.expires),
      }

      if (rebuilding) {
        result.manifestUrl = sabrManifestUrlOf(fresh.info, source)
        result.manifestMimeType = SABR_MIME_TYPE
      }

      return result
    } catch {
      return null
    }
  }

  /** @type {SabrPlaybackSource} */
  const source = Object.freeze({
    ...manifestSourceAround(manifestUrl, SABR_MIME_TYPE),
    transport: /** @type {'sabr'} */ ('sabr'),
    manifestUrl,
    manifestMimeType: SABR_MIME_TYPE,
    sabrData: sabrDataOf(id, answer),
    sabrStoryboards,
    renew,
  })

  return source
}
