// The common shapes the platform layer speaks, whichever platform and backend
// produced them. Types only. See "Common shapes" and "Playback source" in
// .scratch/platform-layer/spec.md, and the field names in design.md.
//
// Field names are those the existing cards and stores already read, so that a
// summary can be handed to an existing component as it is, and a record
// written by the new path is readable by the old one. Fields are only ever
// added, never renamed or removed. A record without `platform` is YouTube.

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

/**
 * A YouTube video ref: its 11 character `videoId`.
 *
 * @typedef {string} YouTubeVideoRef
 */

/**
 * A YouTube channel ref: its `UC` id.
 *
 * @typedef {string} YouTubeChannelRef
 */

/**
 * A PeerTube video ref: its uuid on its origin host, shaped as the minimal
 * stored record, so that it can be handed to anything that reads one. Never a
 * numeric id or a short uuid.
 *
 * @typedef {object} PeerTubeVideoRef
 * @property {'peertube'} platform
 * @property {string} host the origin, a bare lower-case host name
 * @property {string} videoId the full uuid (36 characters)
 */

/**
 * A PeerTube channel ref: its `name@host` handle, host lower case.
 *
 * @typedef {string} PeerTubeChannelRef
 */

/**
 * A PeerTube playlist as a URL names it. Recognised only; nothing resolves or
 * stores it yet.
 *
 * @typedef {object} PeerTubePlaylistRef
 * @property {'peertube'} platform
 * @property {string} host
 * @property {string} playlistId as the URL carries it (uuid or short uuid)
 */

/** @typedef {YouTubeVideoRef | PeerTubeVideoRef} VideoRef */
/** @typedef {YouTubeChannelRef | PeerTubeChannelRef} ChannelRef */

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

/**
 * One video in a list: a card's worth.
 *
 * @typedef {object} VideoSummary
 * @property {'video'} type
 * @property {'youtube' | 'peertube'} [platform] absent for YouTube
 * @property {string} [host] PeerTube: the origin
 * @property {string} videoId YouTube id or PeerTube uuid
 * @property {string} title
 * @property {string} author the channel's display name
 * @property {string} authorId the channel ref (`UC` id or `name@host`)
 * @property {string} thumbnail an absolute URL; `''` where the card builds it from the id (YouTube)
 * @property {number} [lengthSeconds] absent for a live, which the card also reads as live
 * @property {number} [published] ms since the epoch
 * @property {number} [viewCount]
 * @property {boolean} liveNow `liveNow`, not `isLive`: what the cards and feed filters read
 * @property {boolean} isUpcoming
 * @property {Date} [premiereDate] only when scheduled
 * @property {boolean} [nsfw]
 */

/**
 * @typedef {object} Chapter
 * @property {string} title
 * @property {number} startSeconds
 */

/**
 * @typedef {object} CaptionTrack
 * @property {string} url a WebVTT file
 * @property {string} language BCP 47 code
 * @property {string} label
 * @property {boolean} [isAutomatic]
 */

/**
 * A WebVTT thumbnails track, as the player's storyboard input takes it.
 *
 * @typedef {object} Storyboard
 * @property {string} url usually a `data:` URI the adapter built from a sprite
 */

/**
 * One file a PeerTube video offers to download. Never yt-dlp.
 *
 * @typedef {object} DownloadOption
 * @property {string} label e.g. `1080p`, or the audio-only label
 * @property {number} resolution 0 for audio only
 * @property {number | null} size bytes, where known
 * @property {string} url the file, or the `/download/videos/generate/...` URL muxing split audio
 * @property {boolean} audioOnly
 */

/**
 * A single-file format in the Local and Invidious shape, sorted highest first.
 *
 * @typedef {object} LegacyFormat
 * @property {number | string} itag
 * @property {string} qualityLabel
 * @property {number} fps
 * @property {number} bitrate
 * @property {string} mimeType
 * @property {number} height
 * @property {number} width
 * @property {string} url
 */

/**
 * What the player needs to play from a manifest (HLS or DASH), PeerTube's and
 * the YouTube DASH and live paths alike.
 *
 * @typedef {object} ManifestPlaybackSource
 * @property {'manifest'} transport
 * @property {string | null} manifestUrl `null` when only legacy formats exist
 * @property {string} manifestMimeType e.g. `application/x-mpegurl`
 * @property {LegacyFormat[]} legacyFormats
 * @property {{ manifestUrl: string, mimeType: string } | null} audio an audio-only source, where there is one
 * @property {CaptionTrack[]} captions
 * @property {Chapter[]} chapters
 * @property {Storyboard | null} storyboard
 * @property {boolean} isLive
 */

/**
 * The existing SABR manifest and regulator data, passed through untouched.
 * The layer does not model SABR.
 *
 * @typedef {object} SabrPlaybackSource
 * @property {'sabr'} transport
 * @property {unknown} data opaque to the layer
 */

/**
 * Tagged by transport, so that the watch view never branches on platform.
 *
 * @typedef {ManifestPlaybackSource | SabrPlaybackSource} PlaybackSource
 */

/**
 * A summary plus what the watch page shows.
 *
 * @typedef {VideoSummary & {
 *   description: string,
 *   descriptionKind: 'plain' | 'markdown',
 *   likeCount: number | null,
 *   dislikeCount: number | null,
 *   tags: string[],
 *   category: string | null,
 *   licence: string | null,
 *   language: string | null,
 *   chapters: Chapter[],
 *   captions: CaptionTrack[],
 *   storyboard: Storyboard | null,
 *   playback: PlaybackSource | null,
 *   downloadOptions: DownloadOption[],
 *   state: 'available' | 'waiting' | 'ended' | null,
 * }} VideoDetails
 */

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * One channel in a list, and the stub stored in profiles.
 *
 * @typedef {object} ChannelSummary
 * @property {'youtube' | 'peertube'} [platform] absent for YouTube
 * @property {string} [host] PeerTube: the origin
 * @property {string} id the channel ref (`UC` id or `name@host`)
 * @property {string} name the display name
 * @property {string} thumbnail the avatar URL, `''` when none, never `null`
 * @property {string | null} [handle] YouTube `@handle` or PeerTube `name@host`
 * @property {number | null} [subscriberCount] followers, for PeerTube
 */

/**
 * @typedef {ChannelSummary & {
 *   banner: string | null,
 *   description: string,
 *   descriptionKind: 'plain' | 'markdown',
 * }} ChannelDetails
 */

// ---------------------------------------------------------------------------
// Comments and pages
// ---------------------------------------------------------------------------

/**
 * Read only.
 *
 * @typedef {object} Comment
 * @property {string} id
 * @property {string} author
 * @property {string} authorId
 * @property {string} authorThumbnail
 * @property {string} text
 * @property {'plain' | 'markdown' | 'html'} textKind
 * @property {number} published ms since the epoch
 * @property {number} likeCount
 * @property {number} replyCount
 * @property {boolean} isPinned
 */

/**
 * One slice of a list. The cursor is opaque: whatever the adapter needs for
 * the next slice (an offset for PeerTube, a continuation for YouTube Local, a
 * page or token for Invidious), handed back unchanged. `null` is the end.
 *
 * @template T
 * @typedef {object} Page
 * @property {T[]} items
 * @property {unknown} cursor
 */

export {}
