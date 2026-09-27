// How YouTube Local and YouTube Invidious results would map onto the common
// shapes in ../shapes.js. A sketch, not an implementation: types only, so that
// the shapes and the cursor are known to fit YouTube before phase 2 depends on
// them. See "YouTube adapters (phase 2)" and "Further Notes" in
// .scratch/platform-layer/spec.md, and ticket 17.
//
// Grounded in what the existing code reads today:
// - Local: src/renderer/helpers/api/local.js (`getLocalVideoInfo`,
//   `getLocalChannel`, `parseLocalChannelHeader`, `parseLocalListVideo`,
//   `parseLocalListPlaylist`, `getLocalSearchResults`, `parseLocalComment`,
//   `mapLocalLegacyFormat`), and the Local half of src/renderer/views/Watch/Watch.js
//   (`getVideoInformationLocal`, `buildSabrData`, `createLocalSabrManifest`,
//   `createLocalDashManifest`, `onSabrRefreshRequested`)
// - Invidious: src/renderer/helpers/api/invidious.js
//   (`invidiousGetVideoInformation`, `invidiousGetChannelInfo`,
//   `getInvidiousChannelVideos`, `getInvidiousSearchResults`,
//   `invidiousGetComments`, `mapInvidiousLegacyFormat`,
//   `youtubeImageUrlToInvidious`), and `getVideoInformationInvidious` and
//   `createInvidiousDashManifest` in Watch.js
// - The channel view's paging (src/renderer/views/Channel/Channel.vue), the
//   search page's (src/renderer/views/SearchPage/SearchPage.vue), the comment
//   section's (src/renderer/components/CommentSection/CommentSection.vue,
//   FtComment.vue), and the feed descriptors in
//   src/renderer/helpers/subscriptionFeeds/
//
// `describe` for YouTube is already built (../describe.js): routes, the
// i.ytimg.com or Invidious thumbnail, share and external player URLs. Nothing
// here changes it; where a mapping says "`''`, the card builds it", `describe`
// is what builds it.
//
// Convention in the tables below: `L:` is Local, `I:` is Invidious, `—` means
// the backend does not give it, and the common field is then absent, `null` or
// empty as its type allows. "Proposed" marks a field the phase 1 common shape
// does not have and YouTube needs; each one is optional, so adding it keeps
// every PeerTube result valid.

// ---------------------------------------------------------------------------
// Backends and cursors
// ---------------------------------------------------------------------------

/** @typedef {'local' | 'invidious'} YouTubeBackend */

/**
 * A YouTube cursor names the backend that made it, because only that backend
 * can continue it: a Local continuation is meaningless to Invidious and an
 * Invidious token or page is meaningless to Local. The fallback policy reads
 * `backend` to route "the next page" to the backend that served the first,
 * and never falls back mid-list (see the open questions).
 *
 * Local continuations are youtubei.js class instances (`YT.Channel` tabs,
 * `YT.ChannelListContinuation`, `YT.FilteredChannelList`, `YT.Search`,
 * `YT.Comments`, `YTNodes.CommentThread`, `YT.Playlist`), each carrying its
 * session's `actions`. They live in memory only: not serialisable, not
 * structured-clonable, and must never be made reactive (the old views hold
 * them in `shallowRef`). Two have a serialisable form already
 * (`extractLocalCacheableSearchContinuation`,
 * `extractLocalCacheablePlaylistContinuation`: path, payload and session
 * context as a JSON string), which the search page uses for its session
 * search history and `getLocalSearchContinuation` accepts in place of the
 * instance.
 *
 * @typedef {object} YouTubeLocalCursor
 * @property {'local'} backend
 * @property {unknown} continuation the youtubei.js instance to call
 *   `getContinuation()` on, or for search and playlists its serialised JSON
 *   string; see YouTubeCursorTable
 */

/**
 * @typedef {object} YouTubeInvidiousTokenCursor
 * @property {'invidious'} backend
 * @property {string} continuation Invidious' `continuation`, passed back as the
 *   `continuation` query parameter
 * @property {string} [sort] the sort the token was issued under, which
 *   Invidious needs repeated (`sort_by`) on every page of channel tabs and
 *   comments
 */

/**
 * @typedef {object} YouTubeInvidiousPageCursor
 * @property {'invidious'} backend
 * @property {number} page 1-based, the next page to ask for
 */

/** @typedef {YouTubeLocalCursor | YouTubeInvidiousTokenCursor | YouTubeInvidiousPageCursor} YouTubeCursor */

/**
 * What the cursor holds, per operation and backend. "End" is how the backend
 * says there is no next page, which the adapter turns into a `null` cursor.
 *
 * - `listChannelVideos` (and the shorts and live tabs)
 *   - L: the tab instance from `(await innertube.getChannel(id)).getVideos()`,
 *     after `applyFilter(filters[i])` for a sort other than newest; later
 *     pages from `getContinuation()`. End: `!has_continuation`. An artist
 *     topic channel has no videos tab: the uploads `YT.Playlist`
 *     (`getChannelPlaylistId(id, 'videos', sort)`), serialisable.
 *   - I: `continuation` string from `/channels/{id}/videos`, with `sort_by`
 *     repeated. End: no `continuation`.
 * - `listChannelPlaylists` (and releases, podcasts, courses)
 *   - L: the tab instance from `getPlaylists()`, sorted by
 *     `applySort(sort_filters[i])`. End: `!has_continuation`.
 *   - I: `continuation` string from `/channels/{id}/playlists`, with `sort_by`.
 * - `search`
 *   - L: the `YT.Search` instance (or its serialised JSON string). End: the
 *     module's own `continuationData: null`, which it also returns when a page
 *     had nothing left after filtering, so the "empty page, non-null cursor"
 *     case does not arise on Local.
 *   - I: a page number; the first call is page 1. End: Invidious never says,
 *     so an empty result ends it. The adapter must answer `null` there rather
 *     than an empty page with a cursor, or a caller following the common
 *     "ask again" rule asks forever.
 * - `getComments`
 *   - L: the `YT.Comments` instance from `getLocalComments(id)`; a sort
 *     change is `applySort('NEWEST_FIRST' | 'TOP_COMMENTS')` on the first
 *     instance, not a new request. End: `!has_continuation`.
 *   - I: `continuation` string, with `sort_by` `new` or `top`.
 * - `getCommentReplies`
 *   - L: the thread's `YTNodes.CommentThread` (`getReplies()` unless
 *     `is_prepopulated`, then `getContinuation()`), which is the reply token
 *     `parseLocalComment` puts on the comment. End: `!has_continuation`.
 *   - I: the comment's `replies.continuation`, then each answer's
 *     `continuation`.
 *
 * @typedef {never} YouTubeCursorTable
 */

// ---------------------------------------------------------------------------
// Video summary
// ---------------------------------------------------------------------------

/**
 * A YouTube video in a list. The Local list parsers already produce the
 * common field names (they are what the cards read), so on Local the summary
 * is `parseLocalListVideo`'s answer as it is. Invidious' video objects also
 * mostly carry them.
 *
 * | common          | L (`parseLocalListVideo`)                        | I (`InvidiousVideoType`)                  |
 * | --------------- | ------------------------------------------------ | ----------------------------------------- |
 * | type            | `'video'`, `'shortVideo'` from `parseShort`      | `'video'`, `'shortVideo'`                 |
 * | platform, host  | absent                                           | absent                                    |
 * | videoId         | `video_id` / `id`                                | `videoId`                                 |
 * | title           | `title.text`, trimmed                            | `title`                                   |
 * | author          | `author.name`, else the channel page's name      | `author`                                  |
 * | authorId        | `author.id`, else the channel page's id          | `authorId`, else the channel's (`normalizeManyInvidiousVideosAttributes`) |
 * | thumbnail       | `''`, the card builds it (`describe`)            | `''`, likewise; never `videoThumbnails`   |
 * | lengthSeconds   | `duration.seconds`; `''` when live or unknown    | `lengthSeconds`; 0 when live              |
 * | published       | ms, estimated from relative text ("3 days ago") by `calculatePublishedDate`; absent when unreadable | `published` s → ms (`setPublishedTimestamp`); now for a live; the premiere for upcoming |
 * | viewCount       | parsed text, `null` when none                    | `viewCount`                               |
 * | liveNow         | `is_live`, or duration text `LIVE`               | `liveNow`                                 |
 * | isUpcoming      | `is_upcoming \|\| is_premiere`                   | `isUpcoming`                              |
 * | premiereDate    | `upcoming` (a Date)                              | `new Date(premiereTimestamp * 1000)`; the card also reads `premiereTimestamp` itself |
 * | nsfw            | —                                                | —                                         |
 *
 * The badges and flags the card reads on YouTube only ride along as they are:
 * `description` (a snippet), `isPremiere`, `is4k`, `is8k`, `isNew`,
 * `isVr180`, `isVr360`, `is3d`, `hasCaptions`, `premium` (I), `isStation`.
 *
 * @typedef {Omit<import('../shapes').VideoSummary, 'type' | 'lengthSeconds'> & {
 *   type: 'video' | 'shortVideo',
 *   lengthSeconds?: number | '',
 *   description?: string,
 *   isPremiere?: boolean,
 *   premiereTimestamp?: number,
 *   is4k?: boolean,
 *   is8k?: boolean,
 *   isNew?: boolean,
 *   isVr180?: boolean,
 *   isVr360?: boolean,
 *   is3d?: boolean,
 *   hasCaptions?: boolean,
 *   premium?: boolean,
 *   isStation?: boolean,
 * }} YouTubeVideoSummary
 *
 * - `type`: proposed widening. A short is `'shortVideo'` on both backends, and
 *   the card marks and crops it by that.
 * - `lengthSeconds`: proposed widening. `''` is "unknown, not live": the card
 *   then takes the length from history. Absent means live to the card
 *   (`lengthSeconds === undefined`), so an adapter that dropped `''` would
 *   turn every Local short and every unreadable duration into a live.
 */

// ---------------------------------------------------------------------------
// Video details and playback
// ---------------------------------------------------------------------------

/**
 * A YouTube video's details. Local: the `YT.VideoInfo` in
 * `getLocalVideoInfo(id)`'s `info`, as `getVideoInformationLocal` reads it.
 * Invidious: `invidiousGetVideoInformation(id)`, as `getVideoInformationInvidious`
 * reads it.
 *
 * | common           | L (`YT.VideoInfo`)                                     | I (`/api/v1/videos/{id}`)            |
 * | ---------------- | ------------------------------------------------------ | ------------------------------------ |
 * | title            | `getLocalVideoTitle(info)` (localised, then basic)     | `title`                              |
 * | author, authorId | `basic_info.author`, `basic_info.channel_id` (then `secondary_info.owner.author`) | `author`, `authorId`   |
 * | thumbnail        | by `thumbnailPreference`: `maxres1..3.jpg`, else `basic_info.thumbnail[0].url` | by preference on the instance `/vi/`, else `videoThumbnails[0].url` |
 * | lengthSeconds    | `basic_info.duration`                                  | `lengthSeconds`                      |
 * | published        | `Date.parse(page[0].microformat.publish_date)`, else `primary_info.published` text | `published * 1000` |
 * | viewCount        | `basic_info.view_count`, else `primary_info.view_count` text | `viewCount`                    |
 * | liveNow          | `basic_info.is_live`                                   | `liveNow`                            |
 * | isUpcoming       | `basic_info.is_upcoming`                               | `isUpcoming`                         |
 * | premiereDate     | `basic_info.start_timestamp` (a Date)                  | `premiereTimestamp` s → Date         |
 * | nsfw             | `!basic_info.is_family_safe`? (see open questions)     | `!isFamilyFriendly`?                 |
 * | description      | `parseLocalTextRuns(secondary_info.description.runs)`, else `basic_info.short_description` | `descriptionHtml` (through `parseDescriptionHtml`), else `description` |
 * | descriptionKind  | `'html'` (proposed): the runs parser emits links       | `'html'` (proposed)                  |
 * | likeCount        | `basic_info.like_count`                                | `likeCount`                          |
 * | dislikeCount     | `null`: YouTube no longer gives it (the old view shows 0) | `dislikeCount`, as the instance reports it |
 * | tags             | `basic_info.keywords`                                  | `keywords`                           |
 * | category         | `basic_info.category`, trimmed, `null` when empty      | `genre`, trimmed, `null` when empty  |
 * | licence          | `secondary_info.metadata.rows` titled `License`        | — (`null`)                           |
 * | language         | — (`null`; not read today)                             | — (`null`)                           |
 * | url              | `https://www.youtube.com/watch?v={id}`                 | the same                             |
 * | channel          | id, name, `secondary_info.owner.author.best_thumbnail`, `parseLocalSubscriberCount(owner.subscriber_count.text)` | id, name, `authorThumbnails[1]` via `youtubeImageUrlToInvidious`, `parseLocalSubscriberCount(subCountText)` |
 * | authorThumbnail  | the channel's thumbnail, `''` when none                | the same                             |
 * | commentsEnabled  | unknown until comments are fetched (see open questions) | unknown                             |
 * | downloadEnabled  | `false`: YouTube downloads are yt-dlp, never download options | `false`                      |
 * | liveStatus       | `is_live` → `live`; `is_upcoming` → `waiting`; `is_post_live_dvr` → `ended`; else `null` | `liveNow`, `isUpcoming`, `isPostLiveDvr` the same way |
 * | playbackSource   | YouTubeLocalPlaybackSource                             | YouTubeInvidiousPlaybackSource       |
 * | downloadOptions  | `[]`                                                   | `[]`                                 |
 *
 * What the old watch view reads besides, which the common details lack. All
 * proposed as optional fields, absent for PeerTube:
 *
 * - `isFamilyFriendly`: L `basic_info.is_family_safe`, I `isFamilyFriendly`;
 *   the view's `showFamilyFriendlyOnly` gate. Could instead be `nsfw`
 *   inverted; see the open questions.
 * - `isUnlisted`: L `basic_info.is_unlisted`, I `!isListed`.
 * - `isLiveContent`: L `basic_info.is_live_content`; I —.
 * - `related`: the watch-next list as video summaries. L `watch_next_feed`
 *   through `parseLocalWatchNextVideo`; I `recommendedVideos` (whose
 *   `published` is an ISO string, not seconds).
 * - `liveChat`: L only, `info.getLiveChat()`, a live library instance (never
 *   reactive); I —.
 * - `chaptersKind`: `'chapters'` or `'keyMoments'` (L only: the engagement
 *   panel's auto chapters).
 * - `subscriberCountText`: the view shows the channel's count formatted; it
 *   can be formatted from `channel.subscriberCount` instead.
 *
 * Refusals are `PlatformError` `refused`, and need reasons the phase 1
 * `RefusalReason` lacks: members only (`error_screen.offer_id ===
 * 'sponsors_only_video'`), age restricted, DRM protected, private (L only
 * distinguishes it), IP block and unexplained refusal
 * (`classifyPlayabilityError`). Members only, age restricted, DRM and private
 * are final: the old view does not fall back to Invidious for them.
 *
 * @typedef {Omit<import('../shapes').VideoDetails, 'descriptionKind' | 'commentsEnabled' | 'playbackSource'> & {
 *   descriptionKind: 'plain' | 'markdown' | 'html',
 *   commentsEnabled: boolean | null,
 *   playbackSource: YouTubePlaybackSource | null,
 *   isFamilyFriendly?: boolean,
 *   isUnlisted?: boolean,
 *   isLiveContent?: boolean,
 *   related?: YouTubeVideoSummary[],
 *   liveChat?: unknown,
 *   chaptersKind?: 'chapters' | 'keyMoments',
 * }} YouTubeVideoDetails
 */

/**
 * What a YouTube playback source adds to the common manifest source. All
 * optional, so a PeerTube source needs none of them.
 *
 * - `loudnessDb`: L `player_config.audio_config.loudness_db` (`0` is a real
 *   value, `null` unknown); I — (`null`). The player's `loudnessDb` prop.
 * - `delayLoadUntilMs`: L only, `getLocalVideoInfo`'s `adEndTimeUnixMs`, the
 *   player's `delayLoadUntilUnix`: the response time plus the pre-roll ad
 *   time, which the player waits out before loading (legacy needs it).
 * - `expiresAt`: when the streaming URLs expire, so that a 403 or a legacy
 *   video error after it reads as "session expired" (`handlePlayerError`).
 *   L `streaming_data.expires`; I the `expire` parameter of the first
 *   adaptive format's URL (`extractExpiryDateFromStreamingUrl`).
 * - `vrProjection`: the first non-`RECTANGULAR` projection of a video
 *   format, L `projection_type`, I `projectionType`; `null` otherwise.
 * - `isPostLiveDvr`: a finished broadcast still served as a seekable
 *   recording. It behaves as a live in the format ring (no legacy formats,
 *   DASH and audio only) although it is not live now, which `isLive` alone
 *   cannot say.
 *
 * Captions carry what the Local caption list adds to the common track: `id`
 * (L `vss_id`) and `isAutotranslated` (the track `getTranslatedLocaleCaption`
 * adds when none is in the display language). L caption URLs carry the PO
 * token (`pot`) and so share the credentials' lifetime; I caption URLs are
 * instance-relative and made absolute. Both are ordered by `sortCaptions`
 * with the configured locale.
 *
 * Chapters may carry a `thumbnail` (L only, from the markers map and the
 * engagement panel). Chapters come from the player bar markers, then the
 * auto-chapters panel, then description timestamps (L); description
 * timestamps only (I). `hideChapters` stays the view's: the adapter always
 * returns them.
 *
 * `storyboard`: L builds a WebVTT data URI from the largest
 * `storyboards.boards` entry (`buildVTTFileLocally`; the old view takes the
 * largest at most 90px high below 500px of window width, which the layer
 * cannot see); I is a URL, `{instance}/api/v1/storyboards/{id}?height=90`,
 * answering WebVTT, not a data URI. None for lives on either.
 *
 * @typedef {object} YouTubePlaybackExtras
 * @property {number | null} [loudnessDb]
 * @property {number} [delayLoadUntilMs]
 * @property {Date | null} [expiresAt]
 * @property {'EQUIRECTANGULAR' | 'EQUIRECTANGULAR_THREED_TOP_BOTTOM' | 'MESH' | null} [vrProjection]
 * @property {boolean} [isPostLiveDvr]
 */

/**
 * A YouTube `manifest` source, per case. `audio` is the same manifest (the
 * player picks the audio-only renditions out of a DASH or SABR manifest),
 * except where noted.
 *
 * - L, ordinary video, no PO token or no SABR URL: `manifestUrl` is
 *   `data:application/dash+xml;charset=UTF-8,...` from `info.toDash()`
 *   (`createLocalDashManifest`), which needs the library instance, so the
 *   adapter builds it inside `getVideo`. No adaptive format with a URL or
 *   cipher: `manifestUrl: null`, legacy only.
 * - L, live: `selectLiveManifest(streaming_data)`: YouTube's deciphered DASH
 *   URL with the PO token, else its HLS URL (after the ANDROID client
 *   fallback in `getLocalVideoInfo`). An HLS manifest has no separate audio
 *   unless its URL contains `/demuxed/1`: `audio: null` otherwise.
 * - L, post-live DVR: a DASH data URI from `toDash({ include_thumbnails: true })`
 *   (only the last four hours), else the live manifest as above.
 * - L `legacyFormats`: `streaming_data.formats` through `mapLocalLegacyFormat`
 *   (`url` is the deciphered `freeTubeUrl`); none for lives.
 * - I, ordinary video: where the build has the Local API, a DASH data URI
 *   generated locally from `adaptiveFormats` (`convertInvidiousToLocalFormat`,
 *   `generateInvidiousDashManifestLocally`, which gains multiple audio
 *   tracks); otherwise `{instance}/api/manifest/dash/id/{id}`, with
 *   `?local=true` when proxying.
 * - I, live or post-live DVR: `hlsUrl` (`local=true` when proxying), HLS of
 *   muxed streams: `audio: null`, `legacyFormats: []`. No `hlsUrl` is no
 *   playable live (`NoPlayableLiveStreamError`).
 * - I `legacyFormats`: `formatStreams` through `mapInvidiousLegacyFormat`,
 *   URLs through `getProxyUrl` in the web build or when proxying.
 *
 * Proxying reads `proxyVideos`, which `PlatformConfig` does not yet carry.
 *
 * @typedef {import('../shapes').ManifestPlaybackSource & YouTubePlaybackExtras} YouTubeManifestPlaybackSource
 */

/**
 * The credentials half of a SABR setup, exactly `SabrData` in
 * src/renderer/views/Watch/Watch.js (`buildSabrData`), restated here so that
 * the layer does not import a view. What the player's `sabrData` prop and the
 * scheme plugin read.
 *
 * @typedef {object} YouTubeSabrData
 * @property {string} url `streaming_data.server_abr_streaming_url`, deciphered,
 *   with `alr=yes` and `cpn` set
 * @property {string} videoId
 * @property {string} poToken the content-bound PO token `getLocalVideoInfo` minted
 * @property {string} ustreamerConfig `player_config.media_common_config
 *   .media_ustreamer_request_config.video_playback_ustreamer_config`
 * @property {{ clientName: number, clientVersion: string, osName: string, osVersion: string }} clientInfo
 *   `getLocalVideoInfo`'s `clientInfo` (the WEB_EMBEDDED client's after the age bypass)
 */

/**
 * What a credential refresh or a session rebuild answers with: exactly what
 * `onSabrRefreshRequested` hands its `onResult` today. `null` when fresh
 * credentials cannot be had (no token minted, no SABR URL, the request
 * failed), and the player falls back to a reload.
 *
 * @typedef {object} YouTubeSabrRefreshResult
 * @property {YouTubeSabrData} sabrData
 * @property {string[]} formatIds the formats the new session serves, by
 *   `buildFormatId` (`itag-lastModified-xtags`)
 * @property {string} [manifestUrl] a rebuild only: a fresh SABR manifest
 *   agreeing with the new session; a refresh keeps its buffer and must not
 *   have one
 * @property {'application/sabr+json'} [manifestMimeType] a rebuild only
 */

/**
 * A YouTube Local `sabr` source: everything a `manifest` source has, so the
 * watch view reads captions, chapters, storyboard, legacy formats and the
 * audio source in one way for both transports, plus the SABR credentials and
 * a way to renew them. The watch view never branches on platform; it
 * branches on transport only to hand `sabrData` and its regulator to the
 * player.
 *
 * - `manifestUrl`: `data:application/sabr+json,...`, the project's own SABR
 *   manifest (`createLocalSabrManifest`): duration, the adaptive formats'
 *   SABR fields, and the source's own `captions`, `chapters` and
 *   `sabrStoryboards`, embedded.
 * - `manifestMimeType`: `application/sabr+json` (`MANIFEST_TYPE_SABR`).
 * - `audio`: the same manifest. The format ring treats a SABR failure as a
 *   failure of DASH and audio alike, so after one only legacy is worth trying.
 * - Chosen over DASH only when there is a PO token, a
 *   `server_abr_streaming_url` and a `media_ustreamer_request_config`; the
 *   Local adapter answers a DASH `manifest` source otherwise. Never for a
 *   live or a post-live DVR.
 *
 * The regulator is not here. ADR-0006: the watch view owns the regulator and
 * every recovery decision, so that its budgets outlive the player it
 * destroys; a source is created per load and would die with the rung. The
 * source is data plus `renew`, and `renew` decides nothing: it fetches, the
 * view's regulator decides when to call it and what to do with a `null`.
 *
 * @typedef {Omit<import('../shapes').ManifestPlaybackSource, 'transport' | 'manifestMimeType'> & YouTubePlaybackExtras & {
 *   transport: 'sabr',
 *   manifestUrl: string,
 *   manifestMimeType: 'application/sabr+json',
 *   sabrData: YouTubeSabrData,
 *   sabrStoryboards: object[],
 *   renew: (options: { reloadPlaybackContext?: object, rebuilding?: boolean }) => Promise<YouTubeSabrRefreshResult | null>,
 * }} YouTubeSabrPlaybackSource
 *
 * - `sabrStoryboards`: the SABR manifest's storyboard entries
 *   (`SabrManifest['storyboards']`), kept because they come from `/next`,
 *   which a rebuild does not re-read.
 * - `renew`: a closure over the video id and the Local module:
 *   `getLocalVideoInfo(id, { reloadPlaybackContext })`, then the credentials
 *   (`buildSabrData`) and, for `rebuilding`, a new manifest from the retained
 *   captions, chapters and `sabrStoryboards`. `reloadPlaybackContext` is the
 *   server's reload token from a `RELOAD_PLAYER_RESPONSE` part and must ride
 *   on the `/player` call. The new `expiresAt` comes back with it (see the
 *   open questions).
 */

/**
 * Local answers either transport; Invidious only `manifest`, since it cannot
 * mint a PO token or run SABR.
 *
 * @typedef {YouTubeManifestPlaybackSource | YouTubeSabrPlaybackSource} YouTubeLocalPlaybackSource
 * @typedef {YouTubeManifestPlaybackSource} YouTubeInvidiousPlaybackSource
 * @typedef {YouTubeLocalPlaybackSource} YouTubePlaybackSource
 */

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * A YouTube channel. Local: `getLocalChannel(id)` (a `YT.Channel`, or
 * `{ alert }` for a terminated channel, which is `notFound`), read through
 * `parseLocalChannelHeader`; the description needs a second request,
 * `channel.getAbout()`. Invidious: `invidiousGetChannelInfo(id)`.
 *
 * | common           | L                                                  | I                                            |
 * | ---------------- | -------------------------------------------------- | -------------------------------------------- |
 * | platform, host   | absent                                             | absent                                       |
 * | id               | header id, else `metadata.external_id`, else the ref | `authorId`                                 |
 * | name             | header name                                        | `author`                                     |
 * | thumbnail        | header `thumbnailUrl`                              | `authorThumbnails[3]` (instance-rewritten by `describe` when shown) |
 * | handle           | — on the channel page; a search `Channel` node's `subscriber_count` text when it starts with `@` | — (not read today) |
 * | subscriberCount  | `parseLocalSubscriberCount(subscriberText)`, `null` when unreadable | `subCount`                  |
 * | url              | `https://www.youtube.com/channel/{id}`             | the same                                     |
 * | avatarLarge      | the same `thumbnailUrl` (the header gives one)     | `authorThumbnails.at(-1)`                    |
 * | banner           | `bannerUrl`, `null` when none                      | `authorBanners[0]` via `youtubeImageUrlToInvidious` |
 * | description      | `about.description.text`, else `about.metadata.description` | `description`                       |
 * | descriptionKind  | `'plain'` (the view autolinks it)                  | `'plain'`                                    |
 * | support          | absent                                             | absent                                       |
 *
 * Proposed, absent for PeerTube: `tabs` (which of videos, shorts, live,
 * playlists, podcasts, releases, courses, posts exist; L from the channel
 * instance, I `tabs` with `streams` → `live`, `posts` → `community`),
 * `tags` (L `metadata.tags` and header badges, I `tags`), `isFamilyFriendly`
 * (L `metadata.is_family_safe`, I `isFamilyFriendly`), and
 * `isArtistTopicChannel` (L only: a name ending `- Topic` with
 * `metadata.music_artist_name`), which changes where its videos come from.
 * `getLocalChannel` also records channel tags as a side effect
 * (`rememberChannelTags`); phase 2 decides whether the adapter keeps it.
 *
 * @typedef {import('../shapes').ChannelDetails & {
 *   tabs?: string[],
 *   tags?: string[],
 *   isFamilyFriendly?: boolean,
 *   isArtistTopicChannel?: boolean,
 * }} YouTubeChannelDetails
 */

/**
 * A YouTube channel in search results. L: `parseListItem`'s `Channel` and
 * `GridChannel` answer already has this shape (`dataSource: 'local'`,
 * `thumbnail` with `//` made `https://`, `subscribers`, `videos`, `handle`,
 * `descriptionShort`); `GameCard` adds `isGame`. I: `InvidiousChannelObject`
 * renamed into it: `author` → `name`, `authorId` → `id`,
 * `authorThumbnails.at(-1)` → `thumbnail`, `subCount` → `subscribers` and
 * `subscriberCount`, `videoCount` → `videos`, `description` → both
 * descriptions (`descriptionShort` truncated as the common shape says).
 *
 * @typedef {import('../shapes').ChannelListItem & { isGame?: boolean }} YouTubeChannelListItem
 */

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

/**
 * A YouTube playlist in a list. L: `parseLocalListPlaylist` answers the
 * card's Local field names already, with `dataSource: 'local'`. I:
 * `InvidiousPlaylistObject` renamed into them.
 *
 * | common       | L (`parseLocalListPlaylist`)                   | I (`InvidiousPlaylistObject`)                     |
 * | ------------ | ---------------------------------------------- | ------------------------------------------------- |
 * | playlistId   | `id` / `playlistId`                            | `playlistId`                                      |
 * | title        | `title.text`                                   | `title`                                           |
 * | thumbnail    | the renderer's or `thumbnails[0].url`          | `playlistThumbnail`, with `i.ytimg.com` → the instance and `hqdefault` → `mqdefault`, as the card does for Invidious |
 * | videoCount   | number from `video_count.text`                 | `videoCount`                                      |
 * | url          | `https://www.youtube.com/playlist?list={id}`   | the same                                          |
 * | description  | `''`                                           | `''`                                              |
 * | channelName  | `author.name`, else the channel page's         | `author`                                          |
 * | channelId    | `author.id`, else the channel page's; `null` for auto-generated albums | `authorId`                |
 *
 * `dataSource: 'local'` is required, not optional: `FtListPlaylist` reads
 * the Local field names only when `dataSource === 'local'`, and otherwise
 * reads `playlistThumbnail` and fails. The common `PlaylistSummary` does not
 * carry it yet.
 *
 * @typedef {Omit<import('../shapes').PlaylistSummary, 'channelId'> & {
 *   dataSource: 'local',
 *   channelId: string | null,
 * }} YouTubePlaylistSummary
 */

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/**
 * A YouTube comment. L: `parseLocalComment(thread.comment, thread)` per
 * thread of the `YT.Comments` page. I: `parseInvidiousCommentData`, or the
 * raw `/api/v1/comments` entries under it.
 *
 * | common          | L (`YTNodes.CommentView`)                                  | I (comment entry)                         |
 * | --------------- | ---------------------------------------------------------- | ----------------------------------------- |
 * | id              | `comment_id`                                               | `commentId`                               |
 * | threadId        | the thread's first comment's `comment_id`                  | the same                                  |
 * | text            | `parseLocalTextRuns(content.runs)` (or the voice reply transcript), autolinked | `contentHtml`, instance-rewritten, autolinked |
 * | textKind        | `'html'`                                                   | `'html'`                                  |
 * | author          | `author.name`                                              | `author`                                  |
 * | authorAccount   | `''`: YouTube has no accounts apart from channels          | `''`                                      |
 * | authorThumbnail | `author.best_thumbnail.url`                                | `authorThumbnail` via `youtubeImageUrlToInvidious` |
 * | createdAt       | estimated from `published_time` text ("2 weeks ago", `(edited)` removed) | `published * 1000`, exact   |
 * | isDeleted       | `false`: neither backend reports a deleted comment         | `false`                                   |
 * | replyCount      | from `reply_count_a11y`, when the thread has replies       | `replies.replyCount`                      |
 *
 * Proposed, absent for PeerTube, all read by `FtComment` today:
 * `authorId` (a channel ref: a YouTube comment's author is a channel and the
 * comment links to it, unlike PeerTube's account), `likes`, `isPinned`,
 * `isHearted`, `isOwner`, `isMember` and `memberIconUrl`,
 * `hasOwnerReplied` (L only), and `repliesCursor`: what `getCommentReplies`
 * starts from. L the `YTNodes.CommentThread` instance; I the
 * `replies.continuation` string. The common comment's `id` is not enough on
 * either backend: Local needs the thread instance, and Invidious' reply token
 * is not derivable from the id.
 *
 * `getComments` needs a `sort` option (`newest` or `top`), which both
 * backends take and the old section offers.
 *
 * @typedef {import('../shapes').Comment & {
 *   authorId?: string,
 *   likes?: number,
 *   isPinned?: boolean,
 *   isHearted?: boolean,
 *   isOwner?: boolean,
 *   isMember?: boolean,
 *   memberIconUrl?: string,
 *   hasOwnerReplied?: boolean,
 *   repliesCursor?: YouTubeCursor | null,
 * }} YouTubeComment
 */

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * YouTube search results are wider than the common page's videos and
 * channels. L `getLocalSearchResults(query, filters, safetyMode)` and I
 * `getInvidiousSearchResults(query, page, searchSettings)` both answer
 * videos, channels, playlists and hashtags (`{ type: 'hashtag', title,
 * videoCount, channelCount }`), and L also movies and lockup views. The old
 * search page also passes filters the common `search` options
 * do not have: sort (`prioritize`), upload time, duration, type (including
 * playlist) and features, plus `safetyMode` from `showFamilyFriendlyOnly`.
 *
 * @typedef {YouTubeVideoSummary | YouTubeChannelListItem | YouTubePlaylistSummary | { type: 'hashtag', title: string, videoCount: number | null, channelCount?: number | null }} YouTubeSearchItem
 */

// ---------------------------------------------------------------------------
// Channel feed
// ---------------------------------------------------------------------------

/**
 * `fetchChannelFeed` for a YouTube channel answers the existing fetch status
 * contract exactly as `SubscriptionFeedDescriptor.fetchChannel` does
 * (src/renderer/helpers/subscriptionFeeds/index.js):
 * `{ status, entries, name?, thumbnailUrl? }`, `status` one of `FETCH_OK`,
 * `FETCH_RATE_LIMITED`, `FETCH_UNAVAILABLE`, `FETCH_FAILED`
 * (src/renderer/helpers/subscriptionFetchStatus.js). The entries are the
 * cache's own shapes, not video summaries: RSS entries marked `isRSS`, which
 * the detail back-fill enriches later, and the scraper's list videos.
 *
 * Per feed and backend, what exists today: `videos`, `shorts`, `live` choose
 * RSS by the setting (Local RSS, Local scraper, Invidious RSS, Invidious
 * scraper), with a 404 corroborated by the channel liveness probe before it
 * is `FETCH_UNAVAILABLE` (`resolveGoneVerdict`, ADR-0012); `posts` never has
 * RSS. Each reads the backend preference and fallback from the store.
 *
 * @typedef {{ status: 'ok' | 'rateLimited' | 'unavailable' | 'failed', entries: object[] | null, name?: string, thumbnailUrl?: string }} YouTubeChannelFeedStatus
 */

// ---------------------------------------------------------------------------
// Open questions for phase 2
// ---------------------------------------------------------------------------
//
// 1. Can a Local continuation be a cursor at all? It is a library instance:
//    in memory only, never reactive, never persisted. The spec's cursor is
//    "held by the caller and handed back unchanged", which an instance
//    satisfies as long as no caller stores, clones or proxies it, and a view
//    keeps it in `shallowRef` or a plain variable. Phase 2 should state that
//    rule on `Page` (cursors are not serialisable) rather than serialise:
//    only search and playlists have a serialised form today.
// 2. Does the `sabr` source hold data or a factory? The credentials are short
//    lived and the rebuild needs a fresh manifest, so it cannot be data only.
//    Sketched here as data plus `renew`, a fetch-only closure, with the
//    regulator staying in the view (ADR-0006). Alternatives: a layer
//    operation `renewSabr(ref, options)`, which keeps sources plain data at
//    the cost of the view passing the retained captions, chapters and
//    storyboards back in. `renew` must also hand back the new `expiresAt`,
//    and the new caption URLs if the token in them matters.
// 3. Where does the backend fallback policy sit relative to cursors? A Local
//    cursor cannot be handed to Invidious, so the first page chooses the
//    backend for the whole list and later pages go to the backend the cursor
//    names. A later page failing is an error, not a fallback, unless the
//    policy restarts the list from page one on the other backend, which the
//    caller would see as a reset. Refusals that are final (members only, age
//    restricted, DRM, private) must not fall back at all.
// 4. `fetchChannelFeed` for YouTube: keep RSS, the scraper choice, the
//    liveness probe and the back-fill's `isRSS` contract inside, by wrapping
//    the existing descriptors' `fetchChannel` as a dependency? They read the
//    store, which the layer must not; the spec's "a YouTube channel goes where
//    it goes today" suggests the layer's `fetchChannelFeed` stays PeerTube
//    only and the descriptors keep dispatching YouTube themselves.
// 5. The category: `VideoDetails.category` is YouTube's category on YouTube
//    and PeerTube's on PeerTube. The old view writes it to the history entry
//    as `category` when non-empty, and the Channels page reads it as the
//    watched category, which is YouTube-only by the spec. The layer watch
//    view must write it for YouTube only, or the shape needs a YouTube-only
//    field. Whether Local's `basic_info.category` and Invidious' `genre`
//    name categories the same way (both English?) is unchecked.
// 6. `nsfw` versus `isFamilyFriendly`: PeerTube's NSFW flag is filtered in the
//    layer by a PeerTube setting; YouTube's family-safe flag is filtered in
//    the views by `showFamilyFriendlyOnly`, and on Local search also passed
//    as `safetyMode`. One field inverted, or two?
// 7. `commentsEnabled`: neither YouTube backend says in the details; Local
//    finds out from `getComments` ("The comments page did not have any
//    content"). `boolean | null` (unknown), or the comments page says it.
// 8. Local `listChannelVideos` needs the `YT.Channel` instance that
//    `getChannel` fetched: without it the first page costs a second
//    `/browse` (`getLocalChannelVideos` answers no continuation). Cache it in
//    the adapter per layer instance, or accept the request?
// 9. YouTube downloads are yt-dlp, not download options: `downloadEnabled:
//    false` and `downloadOptions: []` for YouTube, and the layer watch view
//    needs another way to show the yt-dlp button when watch moves (phase 3).
// 10. Config the YouTube adapters need beyond `PlatformConfig`: `proxyVideos`,
//    `showFamilyFriendlyOnly` (search `safetyMode`), and whether the build
//    has the Local API (`SUPPORTS_LOCAL_API`, which changes how Invidious'
//    DASH manifest is made).
//
// Where a phase 1 common shape bends for YouTube (all additions or widenings,
// none a rename):
//
// - `SabrPlaybackSource` as `{ transport, data }` does not fit: the view needs
//   captions, chapters, storyboard, legacy formats and audio from a SABR
//   source just as from a manifest source, so it should share the manifest
//   source's fields and add `sabrData`, `sabrStoryboards` and `renew`.
// - `VideoSummary.type` needs `'shortVideo'`; `lengthSeconds` needs `''`
//   (unknown, not live), since absent means live to the card.
// - `VideoDetails.descriptionKind` needs `'html'`: both backends give a
//   YouTube video description as markup with links, not plain text (a
//   channel's is plain). `commentsEnabled` needs `null`; the details lack
//   `isFamilyFriendly`, `isUnlisted`, `related` and the chapters kind.
// - `ManifestPlaybackSource` lacks `loudnessDb`, `expiresAt`, `vrProjection`,
//   `delayLoadUntilMs` and `isPostLiveDvr`; its `storyboard` is typed as a
//   data URI, but Invidious' is a WebVTT URL. `CaptionTrack` lacks `id` and
//   `isAutotranslated`, `Chapter` a `thumbnail`.
// - `PlaylistSummary` needs `dataSource: 'local'` for the existing card, and
//   `channelId` may be `null`.
// - `Comment` needs a way to its replies other than `id` (`repliesCursor`),
//   the author's channel ref, and the counts and flags the comment component
//   shows; `getComments` needs a sort.
// - `ChannelDetails` lacks `tabs`, `tags` and `isFamilyFriendly`.
// - `search` returns playlists and hashtags as well, and takes filters.
// - `RefusalReason` lacks YouTube's reasons (members only, age restricted,
//   DRM, IP block, unexplained).

export {}
