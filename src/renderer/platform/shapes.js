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
 * A chapter as the Watch view and the player read them.
 *
 * @typedef {object} Chapter
 * @property {string} title
 * @property {string} timestamp `m:ss` or `h:mm:ss`, as `formatDurationAsTimestamp`
 * @property {number} startSeconds
 * @property {number} endSeconds the next chapter's start, the last one's the video's end
 */

/**
 * A caption track, as the player's `captions` prop takes them. Ordered by the
 * display language first (see `sortCaptions` in `peertube/playback.js`).
 *
 * @typedef {object} CaptionTrack
 * @property {string} url a WebVTT file, absolute
 * @property {string} language BCP 47 code
 * @property {string} label the language's name, as the instance gives it
 * @property {string} mimeType `text/vtt`
 * @property {boolean} [isAutomatic] generated rather than written
 */

/**
 * One file a PeerTube video offers to download. Never yt-dlp. The file ids in
 * a `generated` URL are used for that URL only, never persisted.
 *
 * @typedef {object} DownloadOption
 * @property {string} id unique among one video's options: the resolution, or `audio`
 * @property {string} label data, not translated: `1080p`, or `Audio only`
 * @property {number} resolution 0 for audio only
 * @property {number | null} height pixels; `null` for audio only
 * @property {number | null} sizeBytes where known; for `generated`, video and audio together
 * @property {string} url absolute: the file's own download URL, or the
 *   `/download/videos/generate/{uuid}?videoFileIds=...` URL muxing split audio
 * @property {'muxed' | 'generated' | 'audio'} kind
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
 * the YouTube DASH and live paths alike. The watch view's format ring is
 * adaptive (the manifest), then legacy if any, then audio if any.
 *
 * @typedef {object} ManifestPlaybackSource
 * @property {'manifest'} transport
 * @property {string | null} manifestUrl `null` when only legacy formats or audio exist
 * @property {string | null} manifestMimeType e.g. `application/x-mpegurl`; `null` without a manifest
 * @property {LegacyFormat[]} legacyFormats
 * @property {{ manifestUrl: string, mimeType: string } | null} audio an audio-only source, where
 *   there is one: the manifest itself when its audio is a separate rendition, or
 *   an audio-only file as `video/mp4`
 * @property {CaptionTrack[]} captions
 * @property {Chapter[]} chapters for the chapter list
 * @property {string | null} chaptersSrc the chapters as a `data:text/vtt,` URI, for the
 *   player's `chaptersSrc` (built as the Watch view builds its own); `null` without chapters
 * @property {string | null} storyboard a WebVTT thumbnails track as a
 *   `data:text/vtt;charset=utf-8,` URI, for the player's `storyboardSrc`
 * @property {boolean} isLive a live that is live now
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
 * A summary plus what the watch page shows. Captions, chapters and the
 * storyboard are in the playback source, which is `null` when there is
 * nothing to play (a waiting or ended live, a video without files).
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
 *   url: string,
 *   channel: ChannelSummary | null,
 *   authorThumbnail: string,
 *   commentsEnabled: boolean,
 *   downloadEnabled: boolean,
 *   liveStatus: 'live' | 'waiting' | 'ended' | null,
 *   playbackSource: PlaybackSource | null,
 *   downloadOptions: DownloadOption[],
 * }} VideoDetails
 *
 * - `url`: the canonical URL on the origin, to share and open
 * - `authorThumbnail`: the channel's avatar, else its owner account's, `''` when neither
 * - `liveStatus`: `null` for a video that is not a live; a waiting live's
 *   scheduled start, where known, is the summary's `premiereDate`
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
 * @property {string} [url] PeerTube: the channel's canonical URL on its origin
 */

/**
 * What the channel page shows. `thumbnail` is the summary's avatar, the size
 * a stored subscription stub holds; `avatarLarge` the largest, for the page
 * header (`''` when none). For PeerTube, `banner` is the largest banner or
 * `null`, and `description` and `support` the channel's Markdown.
 *
 * @typedef {ChannelSummary & {
 *   avatarLarge: string,
 *   banner: string | null,
 *   description: string,
 *   descriptionKind: 'plain' | 'markdown',
 *   support?: string | null,
 * }} ChannelDetails
 */

/**
 * A channel in a list of results, which the existing channel card
 * (`FtListChannel`) renders as it is: it reads a Local API channel's field
 * names when `dataSource` is `'local'`, so `dataSource` names the field names
 * carried, not where the item came from. `subscribers` and `subscriberCount`
 * are the same number; `descriptionShort` is a plain-text snippet of the
 * description (about 200 characters, HTML-escaped, whitespace collapsed), since
 * the card renders it with `v-safer-html`; `description` is the whole
 * Markdown, unescaped.
 *
 * @typedef {ChannelSummary & {
 *   type: 'channel',
 *   dataSource: 'local',
 *   subscribers: number | null,
 *   videos: number | null,
 *   description: string,
 *   descriptionShort: string,
 * }} ChannelListItem
 */

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

/**
 * A playlist in a list, with the field names the existing playlist card
 * reads for a non-Invidious playlist (`title`, `thumbnail`, `channelName`,
 * `channelId`, `playlistId`, `videoCount`).
 *
 * @typedef {object} PlaylistSummary
 * @property {'playlist'} type
 * @property {'youtube' | 'peertube'} [platform] absent for YouTube
 * @property {string} [host] PeerTube: the origin
 * @property {string} playlistId PeerTube: the full uuid
 * @property {string} title
 * @property {string} thumbnail an absolute URL, `''` when none
 * @property {number | null} videoCount
 * @property {string} url the canonical URL on the origin
 * @property {string} description
 * @property {string} channelName
 * @property {string} channelId the channel ref
 */

// ---------------------------------------------------------------------------
// Comments and pages
// ---------------------------------------------------------------------------

/**
 * A comment, read only.
 *
 * - `id`: the instance's own comment id (a number on PeerTube), needed only to
 *   fetch the comment's replies; never a ref, never persisted.
 * - `threadId`: the id of the thread's first comment (its own for a thread).
 * - `text`, `textKind`: the text as stored, `markdown` (written on the
 *   platform) or `html` (federated to PeerTube from Mastodon and the like).
 *   Rendered only through the sanitising directive, Markdown with raw HTML
 *   escaped.
 * - `replyCount`: for a thread (from `getComments`), every reply in it; for a
 *   reply (from `getCommentReplies`), its direct replies, which the next
 *   `getCommentReplies` for it returns.
 * - A deleted comment is kept, since it may have replies, with its text and
 *   author empty.
 *
 * @typedef {object} Comment
 * @property {number | string} id
 * @property {number | string} threadId
 * @property {string} text
 * @property {'plain' | 'markdown' | 'html'} textKind
 * @property {string} author the display name, `''` when none
 * @property {string} authorAccount PeerTube: the author's account handle
 *   `name@host`, `''` when none. An account, not a channel: never routed or
 *   subscribed to as a channel ref
 * @property {string} authorThumbnail an absolute URL, `''` when none
 * @property {number} createdAt ms since the epoch
 * @property {boolean} isDeleted
 * @property {number} replyCount
 */

/**
 * One slice of a list. The cursor is opaque: whatever the adapter needs for
 * the next slice (an offset for PeerTube, a continuation for YouTube Local, a
 * page or token for Invidious), handed back unchanged. `null` is the end.
 *
 * An empty page with a non-null cursor is not the end: filtering (NSFW) can
 * empty a page, and the adapter follows such a page with only a few more
 * requests before handing back what it has. Ask again with the cursor.
 *
 * @template T
 * @typedef {object} Page
 * @property {T[]} items
 * @property {unknown} cursor
 */

export {}
