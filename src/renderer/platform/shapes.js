// The common shapes the platform layer speaks, whichever platform and backend
// produced them. Types only. See "Common shapes" and "Playback source" in
// .scratch/platform-layer/spec.md, and the field names in design.md.
//
// Field names are those the existing cards and stores already read, so that a
// summary can be handed to an existing component as it is, and a record
// written by the new path is readable by the old one. Fields are only ever
// added, never renamed or removed. A record without `platform` is YouTube.
//
// How YouTube Local and Invidious map onto these, and where they bend: youtube/types.js.

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
 * @property {'video' | 'shortVideo'} type `'shortVideo'` is a YouTube short
 *   in a list (Local's short parser, Invidious' shorts), which the card marks
 *   and crops by this; PeerTube has no shorts
 * @property {'youtube' | 'peertube'} [platform] absent for YouTube
 * @property {string} [host] PeerTube: the origin
 * @property {string} videoId YouTube id or PeerTube uuid
 * @property {string} title
 * @property {string} author the channel's display name
 * @property {string} authorId the channel ref (`UC` id or `name@host`)
 * @property {string} thumbnail an absolute URL; `''` where the card builds it from the id (YouTube)
 * @property {number | ''} [lengthSeconds] absent for a live, which the card
 *   also reads as live. `''` is "not known, and not a live" (a YouTube Local
 *   list item whose duration text does not read): the existing card then
 *   takes the length from history, where dropping the field would make it a
 *   live
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
 * @property {{ url: string, width?: number, height?: number }} [thumbnail] YouTube
 *   Local only: the frame its player bar and key-moments panel show for the
 *   chapter, which the chapter list shows; neither PeerTube nor Invidious has one
 */

/**
 * A caption track, as the player's `captions` prop takes them. Ordered by the
 * display language first (see `sortCaptions` in `peertube/playback.js`).
 *
 * @typedef {object} CaptionTrack
 * @property {string} url a WebVTT file, absolute
 * @property {string} language BCP 47 code
 * @property {string} label the language's name, as the instance gives it
 * @property {string} mimeType `text/vtt`; `text/srt` for a YouTube Local
 *   translated track, since YouTube answers a translation asked for as WebVTT
 *   with HTTP 429
 * @property {boolean} [isAutomatic] generated rather than written
 * @property {string} [id] YouTube Local: the track's own id (`vss_id`, with
 *   the target language for a translation), which the player keys tracks by
 *   and the SABR manifest carries
 * @property {boolean} [isAutotranslated] YouTube Local: a track YouTube
 *   translates on request into the display language, added when no track is
 *   in it, and ordered after written and generated ones
 * @property {{ language: string | null, originalLanguage: string }} [translation]
 *   YouTube Local, on a translated track: what its label is made of, because
 *   the label is a translated template (`Video.Player.TranslatedCaptionTemplate`)
 *   that the layer, without i18n, cannot fill. `language` is the target
 *   language's name, `null` when YouTube has no name for it, which the old view
 *   fills with the display language's own name (`Locale Name`);
 *   `originalLanguage` the translated track's name. `label` holds the English
 *   template filled in, with the language code for a missing name
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
 * @property {string | null} storyboard a WebVTT thumbnails track, for the
 *   player's `storyboardSrc`: a `data:text/vtt;charset=utf-8,` URI built by the
 *   layer (PeerTube, YouTube Local), or any URL answering one (YouTube
 *   Invidious' `/api/v1/storyboards/{id}`, which the layer cannot build since
 *   the instance has the sprites' layout)
 * @property {boolean} isLive a live that is live now
 * @property {number | null} [loudnessDb] YouTube Local only: the loudness
 *   YouTube measured, for the player's normalisation (`0` is a real value,
 *   `null` unknown); absent where the backend never says (Invidious, PeerTube)
 * @property {number} [delayLoadUntilMs] YouTube Local only: when the
 *   pre-roll ad time YouTube counts against the response is over (ms since the
 *   epoch), which the player waits out before loading, or legacy formats fail
 * @property {Date | null} [expiresAt] YouTube: when the stream URLs expire, so
 *   that a failure after it reads as an expired session rather than a broken
 *   video; `null` when the backend did not say
 * @property {'EQUIRECTANGULAR' | 'EQUIRECTANGULAR_THREED_TOP_BOTTOM' | 'MESH' | null} [vrProjection]
 *   YouTube: the first video format's projection when it is not rectangular,
 *   for the player's VR mode; `null` for a flat video
 * @property {boolean} [isPostLiveDvr] YouTube: a finished broadcast served as
 *   a seekable recording, which plays as a live does (no legacy formats) while
 *   not live now, which `isLive` alone cannot say
 */

/**
 * The SABR credentials of one session (YouTube Local only), exactly what the
 * player's `sabrData` prop and the `sabr://` scheme plugin read.
 *
 * @typedef {object} SabrData
 * @property {string} url the SABR streaming URL, deciphered, with `alr=yes`
 *   and the response's `cpn`
 * @property {string} videoId
 * @property {string} poToken the content-bound PO token the response was made with
 * @property {string} ustreamerConfig the response's
 *   `video_playback_ustreamer_config`
 * @property {{ clientName: number, clientVersion: string, osName: string, osVersion: string }} clientInfo
 *   the client the response was asked as
 */

/**
 * What a SABR source's `renew` answers: the credentials of a fresh player
 * response, and for a rebuild a manifest agreeing with them. A refresh keeps
 * its buffer, so its formats must be the ones playing, and has no manifest.
 *
 * @typedef {object} SabrRenewResult
 * @property {SabrData} sabrData
 * @property {string[]} formatIds the formats the fresh session serves, as the
 *   manifest parser names them (`itag-lastModified-xtags`)
 * @property {Date | null} expiresAt when the fresh streaming URLs expire;
 *   `null` where the response does not say
 * @property {string} [manifestUrl] a rebuild only
 * @property {'application/sabr+json'} [manifestMimeType] a rebuild only
 */

/**
 * A YouTube Local video over SABR (ADR-0016). Every `ManifestPlaybackSource`
 * field, so that the watch view reads captions, chapters, storyboard, legacy
 * formats, audio and the extras one way for both transports, and branches on
 * transport only to hand `sabrData` and its regulator to the player:
 *
 * - `manifestUrl`: the project's own SABR manifest (formats, and the source's
 *   captions, chapters and `sabrStoryboards`) as a `data:` URI
 * - `audio`: the same manifest, since a SABR failure is one of adaptive and
 *   audio alike
 * - `sabrStoryboards`: the storyboards the manifest embeds, kept because they
 *   come from `/next`, which a rebuild does not re-read
 * - `renew`: fetches a fresh player response, passing the server's reload
 *   token on, and answers its credentials (and for `rebuilding` a manifest
 *   built from this source's captions, chapters and `sabrStoryboards`), or
 *   `null` when none can be had. The one function a shape holds. It decides
 *   nothing, and never changes the source: the regulator that calls it is the
 *   watch view's (ADR-0006), as are the current credentials and expiry
 *
 * The source is frozen.
 *
 * @typedef {Omit<ManifestPlaybackSource, 'transport' | 'manifestUrl' | 'manifestMimeType'> & {
 *   transport: 'sabr',
 *   manifestUrl: string,
 *   manifestMimeType: 'application/sabr+json',
 *   sabrData: SabrData,
 *   sabrStoryboards: object[],
 *   renew: (options?: { reloadPlaybackContext?: object, rebuilding?: boolean }) => Promise<SabrRenewResult | null>,
 * }} SabrPlaybackSource
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
 *   descriptionKind: 'plain' | 'markdown' | 'html',
 *   likeCount: number | null,
 *   dislikeCount: number | null,
 *   tags: string[],
 *   category: string | null,
 *   licence: string | null,
 *   language: string | null,
 *   url: string,
 *   channel: ChannelSummary | null,
 *   authorThumbnail: string,
 *   commentsEnabled: boolean | null,
 *   downloadEnabled: boolean,
 *   liveStatus: 'live' | 'waiting' | 'ended' | null,
 *   playbackSource: PlaybackSource | null,
 *   downloadOptions: DownloadOption[],
 *   isFamilyFriendly?: boolean,
 *   isUnlisted?: boolean,
 *   related?: VideoSummary[],
 *   chaptersKind?: 'chapters' | 'keyMoments',
 * }} VideoDetails
 *
 * - `url`: the canonical URL on the origin, to share and open
 * - `authorThumbnail`: the channel's avatar, else its owner account's, `''` when neither
 * - `liveStatus`: `null` for a video that is not a live; a waiting live's
 *   scheduled start, where known, is the summary's `premiereDate`
 * - `descriptionKind`: `'html'` is markup with its text escaped, rendered
 *   only through the sanitising directive: a YouTube video's description
 *   comes as markup with links from both backends (Local's text runs,
 *   Invidious' `descriptionHtml`), not as plain text
 * - `commentsEnabled`: `null` is "not known", which both YouTube backends
 *   answer, since neither says in the details; the comments page says
 * - `isFamilyFriendly`: YouTube's own rating (Local `is_family_safe`,
 *   Invidious `isFamilyFriendly`), which the views check against
 *   `showFamilyFriendlyOnly`; absent for PeerTube, whose flag is the
 *   summary's `nsfw`
 * - `isUnlisted`: YouTube only, shown on the watch page; absent for PeerTube
 * - `chaptersKind`: YouTube only: `'keyMoments'` when the source's chapters
 *   are YouTube's automatic key moments (Local's engagement panel) rather
 *   than the uploader's, which the chapter list names differently
 * - `related`: YouTube's watch-next list, as summaries; absent for PeerTube,
 *   which has none
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
 * YouTube adds these, absent for PeerTube (phase 2; `hasSearch` phase 3):
 * - `tabs`: which content lists the channel has (`videos`, `shorts`, `live`,
 *   `releases`, `podcasts`, `courses`, `playlists`, `community`), since a
 *   YouTube channel shows only the tabs it has, and the old view asks the
 *   backend which.
 * - `tags`: the channel's keywords, which the page shows.
 * - `isFamilyFriendly`: YouTube's own rating, which the view checks against
 *   `showFamilyFriendlyOnly` as the old one does (spec, Q6). PeerTube's flag
 *   is `nsfw`, on list items.
 * - `isArtistTopicChannel`: an artist's auto-generated `- Topic` channel
 *   (Local only), which has no videos tab and whose videos may be other
 *   channels', so the view treats it apart.
 * - `hasSearch`: whether the channel can be searched (`searchChannel`), so
 *   that the page offers its search box where the old view does: Local's
 *   `has_search`, always on Invidious, which does not say.
 *
 * @typedef {ChannelSummary & {
 *   avatarLarge: string,
 *   banner: string | null,
 *   description: string,
 *   descriptionKind: 'plain' | 'markdown',
 *   support?: string | null,
 *   tabs?: string[],
 *   tags?: string[],
 *   isFamilyFriendly?: boolean,
 *   isArtistTopicChannel?: boolean,
 *   hasSearch?: boolean,
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
 * @property {string | null} channelId the channel ref; `null` where YouTube
 *   names no channel, as for an auto-generated album (phase 2)
 * @property {'local'} [dataSource] YouTube's, always (phase 2): `FtListPlaylist`
 *   reads these field names only when `dataSource` is `'local'`, and otherwise
 *   reads Invidious' (`playlistThumbnail`). Absent for PeerTube, whose card
 *   path does not depend on it, so that it keeps the path it has.
 */

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

/**
 * An image in its sizes, as YouTube gives one: the post component shows the
 * widest.
 *
 * @typedef {{ url: string, width: number, height: number }[]} PostImage
 */

/**
 * What a post carries besides its text, tagged by `type`. YouTube only (both
 * backends unless said); `null` on the post for a text post.
 *
 * - `image`: one image, `content` its sizes
 * - `multiImage`: several, `content` one `PostImage` each (the post component
 *   shows them as a slider)
 * - `poll`: `content` the choices, each `{ text, image? }` (`image` a
 *   `PostImage`, where the choice has one), and `totalVotes`
 * - `quiz`: a poll whose choices also say `isCorrect`
 * - `video`: a shared video, `content` the existing video card's input as the
 *   backend's module answers it: Local `parseLocalListVideo`'s, Invidious the
 *   API's own video object (`videoThumbnails`, `lengthText`, ...), which the
 *   card reads too
 * - `playlist`: a shared playlist, `content` the existing playlist card's
 *   input likewise: Local `parseLocalListPlaylist`'s (`dataSource: 'local'`),
 *   Invidious the API's playlist object
 * - `error`: Invidious only, where the shared video is gone (made private),
 *   `message` its words; Local leaves such a post with `null`
 *
 * @typedef {{ type: 'image', content: PostImage }
 *   | { type: 'multiImage', content: PostImage[] }
 *   | { type: 'poll', totalVotes: number, content: { text: string, image?: PostImage }[] }
 *   | { type: 'quiz', totalVotes: number, content: { text: string, isCorrect: boolean, image?: PostImage }[] }
 *   | { type: 'video', content: object }
 *   | { type: 'playlist', content: object }
 *   | { type: 'error', message: string }} PostContent
 */

/**
 * A channel's post (YouTube's community posts; PeerTube has none). The field
 * names are those the existing post component (`FtCommunityPost`, through
 * `FtElementList`) reads, and those the posts feed caches (spec, "Phase 3
 * decisions", C4 and C9), so a post is handed to either as it is. Both
 * YouTube backends fill every field, through the modules' own parsers
 * (Local `parseLocalCommunityPosts`, Invidious `invidiousGetCommunityPosts`);
 * where they differ it is said.
 *
 * - `postText`: the text as markup, links made anchors, rendered only through
 *   the sanitising directive. Local: the text runs, escaped and autolinked;
 *   `''` for a post without text. Invidious: the API's `contentHtml`, its
 *   site-relative links made app routes (`#/...`)
 * - `authorThumbnails`: the channel's avatar in its sizes, absolute.
 *   Invidious' are on the current instance already; Local's on YouTube, which
 *   the post component moves onto the instance where Invidious is preferred
 * - `publishedTime`: ms since the epoch, estimated from YouTube's relative
 *   text ("2 weeks ago") on both; absent when there is none
 * - `voteCount`: the likes. Local: 0 where YouTube hides the count, which it
 *   does at zero
 * - `commentCount`: the replies. Local: `null` where YouTube shows no reply
 *   button; Invidious: 0 where the API gives no count
 * - `postContent`: what it carries besides its text, `null` for none
 *
 * @typedef {object} Post
 * @property {'community'} type what `FtElementList` picks the post component by
 * @property {string} postId YouTube's post id, which `/post/:id` opens
 * @property {string} postText
 * @property {string} author the channel's display name
 * @property {string} authorId the channel ref
 * @property {PostImage} authorThumbnails
 * @property {number} [publishedTime]
 * @property {number} voteCount
 * @property {number | null} commentCount
 * @property {PostContent | null} postContent
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
 * - YouTube's (both backends) add what the comment component shows and
 *   PeerTube does not have, so the fields are optional: `authorId`, the
 *   author's channel ref, since a YouTube commenter is a channel the comment
 *   links to, unlike PeerTube's account; `likes`; the flags `isPinned`,
 *   `isHearted`, `isOwner`, `isMember` with `memberIconUrl`, and
 *   `hasOwnerReplied` (Local only, Invidious does not say); and
 *   `repliesCursor`, what `getCommentReplies` starts from (Local's thread
 *   instance, Invidious' reply token, `null` without replies), because
 *   neither backend can reach the replies from `id` alone. A cursor like any
 *   other: held as it is, never stored or cloned.
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
 * @property {string} [authorId] YouTube: the author's channel ref
 * @property {number} [likes] YouTube
 * @property {boolean} [isPinned] YouTube
 * @property {boolean} [isHearted] YouTube: hearted by the video's channel
 * @property {boolean} [isOwner] YouTube: written by the video's channel
 * @property {boolean} [isMember] YouTube: a member of the video's channel
 * @property {string} [memberIconUrl] YouTube: the member badge, `''` when none
 * @property {boolean} [hasOwnerReplied] YouTube, Local only
 * @property {unknown} [repliesCursor] YouTube: `null` when there are no replies
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
 * `commentsEnabled: false` is on a first page of comments only, when the
 * platform answered that the video's comments are off rather than that there
 * are none (YouTube; spec, "Phase 2 decisions", Q7). Absent otherwise.
 *
 * `sort` is on a channel list's page, the sort the adapter applied, where it
 * knows it (spec, "Phase 3 decisions", C1): YouTube Invidious the sort asked,
 * YouTube Local `newest` on the first page of a tab that has no filter for
 * the sort asked, which lists newest first. A view reads the first page's.
 * Absent where the adapter does not say, which is the sort asked: PeerTube
 * always applies it, and an empty page for a tab a channel lacks applied
 * none. Absent too on a list that takes no sort (YouTube's releases,
 * podcasts and courses). A YouTube channel's own playlists are `newest` or
 * `last` (by the last video added).
 *
 * @template T
 * @typedef {object} Page
 * @property {T[]} items
 * @property {unknown} cursor
 * @property {boolean} [commentsEnabled]
 * @property {'newest' | 'popular' | 'oldest' | 'last'} [sort]
 */

export {}
