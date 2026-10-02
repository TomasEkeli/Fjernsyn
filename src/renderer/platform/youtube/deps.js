// The `youtube` dependency object: the existing YouTube module functions the
// layer's YouTube adapters call, handed in by the wiring (`../vue.js`) and by
// tests (`./testing/fakeYouTube.js`). The adapters call them unedited and
// import none of them, since the modules read the store and the layer must
// not (ADR-0014). Settings are not here: they are `PlatformConfig` values.
//
// Every function is optional to the layer as a whole: an operation calls only
// the ones it needs, and a test hands in only those. Each is named as its
// module exports it, so the wiring is a list of names.
//
// From `src/renderer/helpers/api/local.js` (Local):
// - videos: `getLocalVideoInfo(id, { reloadPlaybackContext })`,
//   `parseLocalTextRuns`, `parseLocalSubscriberCount`, `parseLocalWatchNextVideo`,
//   `mapLocalLegacyFormat`
// - channels: `getLocalChannel(id)` (a `YT.Channel`, or `{ alert }` for a
//   terminated channel), `parseLocalChannelHeader`, `parseLocalChannelVideos`,
//   `parseLocalChannelShorts`, `parseLocalListVideo`, `parseLocalListPlaylist`,
//   `getLocalPlaylist`, `getLocalPlaylistContinuation`, and
//   `parseLocalPlaylistVideos` for an artist topic channel's uploads playlist
// - comments: `getLocalComments(id)` (a `YT.Comments`), `parseLocalComment`
// - search: `getLocalSearchResults`, `getLocalSearchContinuation`
//
// From `src/renderer/helpers/api/invidious.js` (Invidious):
// - videos: `invidiousGetVideoInformation(id)`, `mapInvidiousLegacyFormat`,
//   `convertInvidiousToLocalFormat`, `generateInvidiousDashManifestLocally`,
//   `youtubeImageUrlToInvidious`, and `getProxyUrl(url)`, which rewrites a
//   stream URL onto the current instance when proxying (`proxyVideos`)
// - channels: `invidiousGetChannelInfo(id)`, `getInvidiousChannelVideos`,
//   `getInvidiousChannelShorts`, `getInvidiousChannelLive`,
//   `getInvidiousChannelPlaylists`, `invidiousImageUrlToInvidious`
// - comments: `invidiousGetComments`, `invidiousGetCommentReplies`
// - search: `getInvidiousSearchResults`
//
// From the player and utility helpers, which import i18n or shaka and so are
// not imported by the layer either: `sortCaptions`
// (`helpers/player/utils.js`), `buildVTTFileLocally`,
// `formatDurationAsTimestamp`, `extractNumberFromString`, `getChannelPlaylistId`
// (`helpers/utils.js`; the last names a channel's auto-generated uploads
// playlist), `buildFormatId` (`helpers/player/SabrManifestParser.js`).
//
// And `resolveUrl(url)`, the existing YouTube URL parser (`../vue.js`).

/** @typedef {Record<string, (...args: any[]) => any>} YouTubeDeps */

/** Every name the wiring hands in, so that the wiring and this contract are one list */
export const YOUTUBE_DEP_NAMES = Object.freeze({
  local: Object.freeze([
    'getLocalVideoInfo',
    'parseLocalTextRuns',
    'parseLocalSubscriberCount',
    'parseLocalWatchNextVideo',
    'mapLocalLegacyFormat',
    'getLocalChannel',
    'parseLocalChannelHeader',
    'parseLocalChannelVideos',
    'parseLocalChannelShorts',
    'parseLocalListVideo',
    'parseLocalListPlaylist',
    'getLocalPlaylist',
    'getLocalPlaylistContinuation',
    'parseLocalPlaylistVideos',
    'getLocalComments',
    'parseLocalComment',
    'getLocalSearchResults',
    'getLocalSearchContinuation',
  ]),
  invidious: Object.freeze([
    'invidiousGetVideoInformation',
    'mapInvidiousLegacyFormat',
    'convertInvidiousToLocalFormat',
    'generateInvidiousDashManifestLocally',
    'youtubeImageUrlToInvidious',
    'invidiousImageUrlToInvidious',
    'getProxyUrl',
    'invidiousGetChannelInfo',
    'getInvidiousChannelVideos',
    'getInvidiousChannelShorts',
    'getInvidiousChannelLive',
    'getInvidiousChannelPlaylists',
    'invidiousGetComments',
    'invidiousGetCommentReplies',
    'getInvidiousSearchResults',
  ]),
  playerUtils: Object.freeze(['sortCaptions']),
  utils: Object.freeze(['buildVTTFileLocally', 'formatDurationAsTimestamp', 'extractNumberFromString', 'getChannelPlaylistId']),
  sabrManifest: Object.freeze(['buildFormatId']),
})
