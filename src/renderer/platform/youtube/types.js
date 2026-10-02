// How YouTube Local and YouTube Invidious results map onto the common shapes
// in ../shapes.js, field by field. Written in phase 1 as the sketch the
// shapes were checked against (ticket 17), and now implemented: details in
// `./videos.js` and `./videoDetails.js`, playback sources in `./playback.js`
// and `./sabr.js`, channels, their lists, playlists and posts in `./channels.js`,
// comments in `./comments.js`, search in `./search.js`. Which backend answers
// is `./policy.js`, how its failures read is `./errors.js` (ADR-0015). Kept as
// the reference table the modules point to; where a module and this file
// disagree, the module and its tests are right, and this file is to be
// corrected.
//
// Where a typedef here had to become a common shape, the shape is in
// ../shapes.js and only a pointer is left here.
//
// Grounded in what the existing code reads:
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
// The adapters call those module functions unedited, through the `youtube`
// dependency object listed in `./deps.js`.
//
// `describe` for YouTube (../describe.js) builds routes, the i.ytimg.com or
// Invidious thumbnail, share and external player URLs. Nothing here changes
// it; where a mapping says "`''`, the card builds it", `describe` is what
// builds it.
//
// Convention in the tables below: `L:` is Local, `I:` is Invidious, `—` means
// the backend does not give it, and the common field is then absent, `null` or
// empty as its type allows.

// ---------------------------------------------------------------------------
// Backends and cursors
// ---------------------------------------------------------------------------

// `YouTubeBackend` is in `./policy.js`.

/**
 * A YouTube cursor names the backend that made it, because only that backend
 * can continue it: a Local continuation is meaningless to Invidious and an
 * Invidious token or page is meaningless to Local. The policy (`./policy.js`,
 * ADR-0015) reads `backend` to route a later page to the backend that served
 * the first, never falls back mid-list, and rejects a cursor naming a backend
 * this build lacks as `invalid`.
 *
 * Local continuations are youtubei.js class instances (`YT.Channel` tabs and
 * their continuations, `YT.Playlist`, `YT.Search`, `YT.Comments`,
 * `YTNodes.CommentThread`), each carrying its session's `actions`. They live
 * in memory only: not serialisable, not structured-clonable, and never to be
 * made reactive. The `Page` typedef says so (spec, "Phase 2 decisions", Q1):
 * a caller holds a cursor in a `shallowRef` or a plain variable and hands it
 * back as it is.
 *
 * A channel list's cursor also names its list (`kind`), so a later page uses
 * the first page's kind and sort whatever the options say, and a cursor of
 * another list is `invalid`.
 *
 * @typedef {object} YouTubeLocalCursor
 * @property {'local'} backend
 * @property {any} continuation the youtubei.js instance to continue; see
 *   YouTubeCursorTable
 * @property {'tab' | 'playlist' | 'topicReleases'} [from] channel lists: a
 *   channel tab, an artist topic channel's uploads playlist standing in for
 *   its videos tab, or the releases read off its page
 * @property {'videos' | 'shorts' | 'live' | 'playlists' | 'releases' | 'podcasts' | 'courses' | 'community'} [kind] channel lists
 * @property {any} [channel] an artist topic channel's releases: the
 *   `YT.Channel`, whose session alone can call the continuation node
 * @property {{ id: string, name: string } | null} [owner] channel tabs: whose
 *   items the page holds, named after the channel where the page leaves them
 *   unnamed; `null` for a channel showing other channels' items, whose items
 *   are left unattributed
 */

/**
 * @typedef {object} YouTubeInvidiousTokenCursor
 * @property {'invidious'} backend
 * @property {string} continuation Invidious' `continuation`, passed back as the
 *   `continuation` query parameter
 * @property {string | null} [sort] the sort the token was issued under, which
 *   Invidious needs repeated (`sort_by`) on every page: `newest`, `popular`
 *   or `oldest` for channel video lists, `newest` or `last` for a channel's
 *   own playlists, `null` for its releases, podcasts, courses and posts, `top` or
 *   `newest` for comments; absent for replies
 * @property {'videos' | 'shorts' | 'live' | 'playlists' | 'releases' | 'podcasts' | 'courses' | 'community'} [kind] channel lists
 */

/**
 * @typedef {object} YouTubeInvidiousPageCursor
 * @property {'invidious'} backend
 * @property {number} page 1-based, the next page to ask for
 */

/** @typedef {YouTubeLocalCursor | YouTubeInvidiousTokenCursor | YouTubeInvidiousPageCursor} YouTubeCursor */

/**
 * What the cursor holds, per operation and backend. Implemented in
 * `./channels.js`, `./comments.js` and `./search.js`. "End" is how the backend
 * says there is no next page, which the adapter turns into a `null` cursor.
 *
 * - `listChannelVideos` (`kind` `videos`, `shorts` or `live`)
 *   - L: the tab instance from `getVideos()`, `getShorts()` or
 *     `getLiveStreams()` on the `YT.Channel`, after `applyFilter(filters[i])`
 *     for a sort other than newest (a tab without that filter lists newest
 *     first); later pages from `getContinuation()`. `{ backend, continuation,
 *     from: 'tab', kind, owner }`. End: `!has_continuation`. The live tab's
 *     first page follows up to 3 empty pages, as the old view does. An artist
 *     topic channel has no videos tab: its uploads `YT.Playlist`
 *     (`getLocalPlaylist(getChannelPlaylistId(id, 'videos', sort))`, newest or
 *     popular only, `oldest` is `invalid`), continued with
 *     `getLocalPlaylistContinuation`. `{ backend, continuation,
 *     from: 'playlist', kind }`. End: `!has_continuation`, or `null` from the
 *     continuation.
 *   - I: `continuation` string from `getInvidiousChannelVideos`,
 *     `getInvidiousChannelShorts` or `getInvidiousChannelLive` (`/videos`,
 *     `/shorts`, `/streams`), with the sort repeated. `{ backend,
 *     continuation, sort, kind }`. End: no `continuation`.
 *   - A channel without the tab is an empty page: L reads the channel's
 *     `has_*` flags, I the `tabs` `getChannel` cached on this layer, and
 *     otherwise asks the tab.
 * - `listChannelPlaylists` (`kind` `playlists`, `releases`, `podcasts` or
 *   `courses`): the channel's own playlists `newest` first or by the `last`
 *   video added; the other kinds in YouTube's one order, no sort.
 *   - L: the tab instance from `getPlaylists()`, narrowed to "Created
 *     playlists" (`view=1`) where YouTube offers other categories, then
 *     `applySort(sort_filters[1])` for `last` where the tab has two sorts and
 *     more than one playlist (the old view's rule; else newest, said so);
 *     `getReleases()`, `getPodcasts()`, `getCourses()`. `{ backend,
 *     continuation, from: 'tab', kind, owner }`. End: `!has_continuation`.
 *     An artist topic channel's releases: `getLocalArtistTopicChannelReleases
 *     (channel)`, continued by `getLocalArtistTopicChannelReleasesContinuation
 *     (channel, continuation)`. `{ backend, continuation, from:
 *     'topicReleases', kind, channel }`. End: no `continuationData`.
 *   - I: `continuation` string from `getInvidiousChannelPlaylists` with the
 *     sort repeated, or from `getInvidiousChannelReleases`, `…Podcasts`,
 *     `…Courses`, which take none. `{ backend, continuation, sort, kind }`,
 *     `sort` `null` for the unsorted kinds.
 *   - A channel without the tab is an empty page, as for the video lists.
 * - `listChannelPosts` (the list `kind` `community`), YouTube's one order
 *   - L: the tab instance from `getCommunity()`, its `posts` read by
 *     `parseLocalCommunityPosts`. `{ backend, continuation, from: 'tab',
 *     kind, owner }`. End: `!has_continuation`. Every page, first or later,
 *     follows up to 3 empty pages, as the old view does (without its bound).
 *   - I: `continuation` string from `invidiousGetCommunityPosts(id,
 *     continuation)`. `{ backend, continuation, sort: null, kind }`.
 *   - A channel without the tab is an empty page, as for the video lists.
 * - `search`
 *   - L: the `YT.Search` instance `getLocalSearchResults` answers as
 *     `continuationData`, continued by `getLocalSearchContinuation`.
 *     `{ backend, continuation }`. End: the module's own `continuationData:
 *     null`, which it also answers when a page had nothing left after
 *     filtering, so the "empty page, non-null cursor" case does not arise on
 *     Local. The module's serialised form of a search continuation is the
 *     search page's, for its session history, outside the `Page` contract.
 *   - I: a page number; the first call is page 1. `{ backend, page }`. End:
 *     Invidious never says, so an empty result ends it: the adapter answers
 *     `null` there rather than an empty page with a cursor, or a caller
 *     following the common "ask again" rule would ask forever.
 * - `getComments` (`sort` `top`, the default, or `newest`)
 *   - L: the `YT.Comments` instance from `getLocalComments(id)`, after
 *     `applySort('NEWEST_FIRST' | 'TOP_COMMENTS')` when YouTube's header says
 *     the other sort is selected. `{ backend, continuation }`. End:
 *     `!has_continuation`.
 *   - I: `continuation` string from `invidiousGetComments`, with the sort it
 *     was issued under. `{ backend, continuation, sort }`.
 * - `getCommentReplies`: starts from the comment's `repliesCursor` and pages
 *   on from each page's cursor, both through `policy.later`, so replies never
 *   fall back.
 *   - L: the thread's `YTNodes.CommentThread` (`getReplies()` unless
 *     `is_prepopulated`), then `getContinuation()` on what answered last.
 *     End: no replies or `!has_continuation`.
 *   - I: the comment's reply token, then each answer's `continuation`, both
 *     through `invidiousGetComments` (see the comments section). `{ backend,
 *     continuation }`, no sort.
 *
 * @typedef {never} YouTubeCursorTable
 */

// ---------------------------------------------------------------------------
// Video summary
// ---------------------------------------------------------------------------

/**
 * A YouTube video in a list. Implemented in `./channels.js` for a channel's
 * videos, shorts and lives; `./search.js` hands the modules' items on as they
 * are (see the search section). The Local list parsers already produce the
 * common field names (they are what the cards read), so on Local the summary
 * is `parseLocalListVideo`'s answer as it is. Invidious' video objects also
 * mostly carry them.
 *
 * | common          | L (`parseLocalListVideo`)                        | I (`InvidiousVideoType`)                  |
 * | --------------- | ------------------------------------------------ | ----------------------------------------- |
 * | type            | `'video'`; `'shortVideo'` from `parseShort`      | `'video'`; `'shortVideo'` on the shorts tab and in search |
 * | platform, host  | absent                                           | absent                                    |
 * | videoId         | `video_id` / `id`                                | `videoId`                                 |
 * | title           | `title.text`, trimmed                            | `title`                                   |
 * | author          | `author.name`, else the channel page's name      | `author`                                  |
 * | authorId        | `author.id`, else the channel page's id          | `authorId`, else the channel's (`normalizeManyInvidiousVideosAttributes`) |
 * | thumbnail       | `''` in channel lists, the card builds it (`describe`) | `''` in channel lists likewise, not `videoThumbnails` |
 * | lengthSeconds   | `duration.seconds`; `''` when live or unknown, and for every short | `lengthSeconds`; 0 when live; `''` for a short with none or 0 |
 * | published       | ms, estimated from relative text ("3 days ago") by `calculatePublishedDate`; absent when unreadable | `published` s → ms (`setPublishedTimestamp`); now for a live; the premiere for upcoming; absent on the shorts tab |
 * | viewCount       | parsed text, `null` when none                    | `viewCount`                               |
 * | liveNow         | `is_live`, or duration text `LIVE`               | `liveNow`                                 |
 * | isUpcoming      | `is_upcoming \|\| is_premiere`                   | `isUpcoming`; `false` on the shorts tab   |
 * | premiereDate    | `upcoming` (a Date)                              | `new Date(premiereTimestamp * 1000)`; the card also reads `premiereTimestamp` itself |
 * | nsfw            | —                                                | —                                         |
 *
 * `type` and `lengthSeconds` are the common `VideoSummary`'s, widened for
 * YouTube (see ../shapes.js): `''` is "unknown, not live", which the card
 * reads as a plain video, where an absent length reads as a live.
 *
 * The badges and flags the card reads on YouTube only ride along as they are:
 * `description` (a snippet), `isPremiere`, `is4k`, `is8k`, `isNew`,
 * `isVr180`, `isVr360`, `is3d`, `hasCaptions`, `premium` (I), `isStation`.
 *
 * @typedef {import('../shapes').VideoSummary & {
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
 */

// ---------------------------------------------------------------------------
// Video details and playback
// ---------------------------------------------------------------------------

/**
 * A YouTube video's details, the common `VideoDetails` (../shapes.js, which
 * took every field YouTube needed). Implemented in `./videoDetails.js` (read)
 * and `./videos.js` (fetched). Local: the `YT.VideoInfo` in
 * `getLocalVideoInfo(id)`'s `info`, as `getVideoInformationLocal` reads it.
 * Invidious: `invidiousGetVideoInformation(id)`, as
 * `getVideoInformationInvidious` reads it.
 *
 * | common           | L (`YT.VideoInfo`)                                     | I (`/api/v1/videos/{id}`)            |
 * | ---------------- | ------------------------------------------------------ | ------------------------------------ |
 * | type             | `'video'`: neither backend marks a short in a video's details | `'video'`                   |
 * | title            | `getLocalVideoTitle(info)` (localised, then basic)     | `title`                              |
 * | author, authorId | `basic_info.author`, `basic_info.channel_id` (then `secondary_info.owner.author`) | `author`, `authorId`   |
 * | thumbnail        | by `thumbnailPreference`: `maxres1..3.jpg` on i.ytimg.com, else `basic_info.thumbnail[0].url`, else `maxresdefault.jpg` | by preference on the instance `/vi/`, else `videoThumbnails[0].url`, made absolute on the instance where relative |
 * | lengthSeconds    | `basic_info.duration`, `''` when unknown; absent for a live | `lengthSeconds`, the same        |
 * | published        | `Date.parse(page[0].microformat.publish_date)`, else `Date.parse` of the `primary_info.published` text; absent when neither reads | `published * 1000` |
 * | viewCount        | `basic_info.view_count`, else `primary_info.view_count` text (`extractNumberFromString`); absent when neither reads | `viewCount` |
 * | liveNow          | `basic_info.is_live`                                   | `liveNow`                            |
 * | isUpcoming       | `basic_info.is_upcoming`                               | `isUpcoming`                         |
 * | premiereDate     | `basic_info.start_timestamp` (a Date), when upcoming   | `premiereTimestamp` s → Date, when upcoming |
 * | nsfw             | — (YouTube's rating is `isFamilyFriendly`, Q6)          | —                                    |
 * | description      | `parseLocalTextRuns(secondary_info.description.runs)`, else `basic_info.short_description` escaped | `descriptionHtml` cleaned as `WatchVideoDescription.vue` cleans it (`cleanInvidiousDescriptionHtml`), else `description` escaped |
 * | descriptionKind  | `'html'`: the runs parser emits escaped markup with links | `'html'`                          |
 * | likeCount        | `basic_info.like_count`, `null` when unknown           | `likeCount`, `null` when unknown     |
 * | dislikeCount     | `null`: YouTube no longer gives it (the old view shows 0) | `dislikeCount`, as the instance reports it, else `null` |
 * | tags             | `basic_info.keywords`                                  | `keywords`                           |
 * | category         | `basic_info.category`, trimmed, `null` when empty; in the backend's language | `genre`, the same     |
 * | licence          | `secondary_info.metadata.rows` titled `License`        | — (`null`)                           |
 * | language         | — (`null`)                                             | — (`null`)                           |
 * | url              | `https://www.youtube.com/watch?v={id}`                 | the same                             |
 * | channel          | id, name, `secondary_info.owner.author.best_thumbnail.url`, `parseLocalSubscriberCount(owner.subscriber_count.text)`; `null` without an id | id, name, `authorThumbnails[1]` via `youtubeImageUrlToInvidious`, `parseLocalSubscriberCount(subCountText)`; the same |
 * | authorThumbnail  | the channel's thumbnail, `''` when none                | the same                             |
 * | commentsEnabled  | `null`: not known until comments are fetched (Q7)      | `null`                               |
 * | downloadEnabled  | `false`: YouTube downloads are yt-dlp, never download options (Q9) | `false`                  |
 * | liveStatus       | `is_live` → `live`; `is_upcoming` → `waiting`; `is_post_live_dvr` → `ended`; else `null` | `liveNow`, `isUpcoming`, `isPostLiveDvr` the same way |
 * | playbackSource   | a `manifest` or `sabr` source (below); `null` for a waiting live, unless Local answered a playable trailer in its place, and without streaming data | a `manifest` source; `null` for a waiting live |
 * | downloadOptions  | `[]`                                                   | `[]`                                 |
 * | isFamilyFriendly | `basic_info.is_family_safe`, absent when not a boolean | `isFamilyFriendly`, the same         |
 * | isUnlisted       | `basic_info.is_unlisted`                               | `isListed === false`                 |
 * | related          | `watch_next_feed` (`CompactVideo`, `CompactMovie`, and `LockupView` of a video or station) through `parseLocalWatchNextVideo` | `recommendedVideos` as `type: 'video'`, their ISO `published` made ms |
 * | chaptersKind     | `'keyMoments'` when the chapters are the engagement panel's auto chapters, else `'chapters'` (`./playback.js`) | `'chapters'` |
 *
 * Not carried, and the old view's still: `isLiveContent` (L only), the live
 * chat (L `info.getLiveChat()`, a library instance), and the channel's
 * formatted subscriber count, which the view can format from
 * `channel.subscriberCount`. So are hiding likes and chapters, the
 * `showFamilyFriendlyOnly` gate and putting watched recommendations last.
 *
 * Refusals and other failures are classified in `./errors.js`: Local's from
 * the playability status (`classifyLocalPlayability`, a removed video
 * `notFound`), Invidious' from the error message, into `PlatformError` kinds
 * and YouTube's `RefusalReason`s (`private`, `membersOnly`, `ageRestricted`,
 * `drm`, `ipBlock`, `unexplained`). A refusal about the video is final; an
 * `ipBlock`, `unexplained` or reasonless one falls back (ADR-0015, ADR-0019).
 *
 * @typedef {never} YouTubeVideoDetailsTable
 */

/**
 * What a YouTube playback source adds to the common manifest source: the
 * optional fields of `ManifestPlaybackSource` in ../shapes.js, which says what
 * each means. Where each comes from, implemented in `./playback.js`:
 *
 * - `loudnessDb`: L `player_config.audio_config.loudness_db` (`0` is a real
 *   value, `null` unknown); I absent. The player's `loudnessDb` prop.
 * - `delayLoadUntilMs`: L only, `getLocalVideoInfo`'s `adEndTimeUnixMs`, the
 *   player's `delayLoadUntilUnix`: the response time plus the pre-roll ad
 *   time, which the player waits out before loading (legacy needs it).
 * - `expiresAt`: L `streaming_data.expires`; I the `expire` parameter of the
 *   first adaptive format's URL (for a live, else the HLS URL's); `null` when
 *   neither says.
 * - `vrProjection`: the first non-`RECTANGULAR` projection of a video format,
 *   L `projection_type` (for a video played from its formats only), I
 *   `projectionType`; `null` otherwise, and for every live.
 * - `isPostLiveDvr`: L `basic_info.is_post_live_dvr`, I `isPostLiveDvr`. Such
 *   a broadcast plays as a live in the format ring (no legacy formats, DASH
 *   and audio only) although it is not live now, which `isLive` alone cannot
 *   say.
 *
 * Captions: L from `info.captions.caption_tracks`, as WebVTT (`fmt=vtt`), with
 * `id` (`vss_id`) and `isAutomatic` (`kind === 'asr'`). When no track is in
 * the display language, a translated track is added as the old view's
 * `getTranslatedLocaleCaption` makes it: SRT (YouTube answers a translation
 * asked for as WebVTT with HTTP 429), `id` `{vss_id}.{language}`,
 * `isAutotranslated`, and `translation: { language, originalLanguage }` for
 * the view's localised label, since the layer has no i18n and `label` is the
 * English form. `config.locale` decides only that track's language. L caption
 * URLs carry the PO token (`pot`), which `getLocalVideoInfo` sets, and are
 * kept from the first load across a SABR renew. I caption URLs are
 * instance-relative and made absolute on the instance. Both are ordered by
 * `sortCaptions`, which reads the app's display language. A Local live has no
 * captions (the old view reads them for a video only); an Invidious live
 * keeps its own.
 *
 * Chapters may carry a `thumbnail` (L only, from the markers map and the
 * engagement panel). Chapters come from the player bar markers, then the
 * auto-chapters panel (`chaptersKind: 'keyMoments'`), then description
 * timestamps (L); description timestamps only (I). `hideChapters` stays the
 * view's: the adapter always returns them. `chaptersSrc` is built by
 * `chaptersSrcOf` in ../peertube/playback.js.
 *
 * `storyboard`: L builds a WebVTT data URI from the largest
 * `storyboards.boards` entry (`buildVTTFileLocally`); the old view takes the
 * largest at most 90px high below 500px of window width, which the layer
 * cannot see and stays the view's. I is a URL,
 * `{instance}/api/v1/storyboards/{id}?height=90`, answering WebVTT, not a
 * data URI. None for lives on either.
 *
 * @typedef {Pick<import('../shapes').ManifestPlaybackSource, 'loudnessDb' | 'delayLoadUntilMs' | 'expiresAt' | 'vrProjection' | 'isPostLiveDvr'>} YouTubePlaybackExtras
 */

/**
 * A YouTube `manifest` source, per case, implemented in `./playback.js`.
 * `audio` is the same manifest (the player picks the audio-only renditions out
 * of a DASH manifest), except where noted.
 *
 * - L, ordinary video that cannot play over SABR (see the `sabr` source):
 *   `manifestUrl` is `data:application/dash+xml;charset=UTF-8,...` from
 *   `info.toDash()` (`createLocalDashManifest`), which needs the library
 *   instance, so the adapter builds it inside `getVideo`. When the first
 *   adaptive format has neither a URL nor a cipher: `manifestUrl: null`,
 *   legacy only.
 * - L, live: `selectLiveManifest(streaming_data)`: YouTube's deciphered DASH
 *   URL with the PO token, else its HLS URL (after the ANDROID client
 *   fallback in `getLocalVideoInfo`). An HLS manifest has no separate audio
 *   unless its URL contains `/demuxed/1`: `audio: null` otherwise. No legacy
 *   formats, storyboard or captions.
 * - L, post-live DVR: a DASH data URI from `toDash({ include_thumbnails: true })`
 *   (only the last four hours), else the live manifest as above.
 * - L `legacyFormats`: `streaming_data.formats` through `mapLocalLegacyFormat`
 *   (`url` is the deciphered `freeTubeUrl`); none for lives.
 * - I, ordinary video: where the build has the Local API
 *   (`config.supportsLocalApi`), a DASH data URI generated here from copies of
 *   `adaptiveFormats` (`convertInvidiousToLocalFormat`,
 *   `generateInvidiousDashManifestLocally`, which gains multiple audio
 *   tracks), `null` without adaptive formats; otherwise
 *   `{instance}/api/manifest/dash/id/{id}`, with `?local=true` when proxying.
 * - I, live or post-live DVR: `hlsUrl` (`local=true` when proxying), HLS of
 *   muxed streams: `audio: null`, `legacyFormats: []`.
 * - I `legacyFormats`: `formatStreams` through `mapInvidiousLegacyFormat`,
 *   URLs through `getProxyUrl` in the web build or when proxying.
 * - A live or post-live DVR with no playable manifest (L no live manifest, I
 *   no `hlsUrl`) rejects as `unavailable`, the old view's retryable
 *   `NoPlayableLiveStreamError`, which falls back.
 *
 * Proxying reads `config.proxyVideos`; `getProxyUrl` is a `youtube`
 * dependency (spec, "Phase 2 decisions", Q10).
 *
 * @typedef {import('../shapes').ManifestPlaybackSource} YouTubeManifestPlaybackSource
 */

// `YouTubeSabrData` is `SabrData`, and `YouTubeSabrRefreshResult` is
// `SabrRenewResult`, in ../shapes.js.

/**
 * A YouTube Local `sabr` source (ADR-0016), the common `SabrPlaybackSource`
 * in ../shapes.js, implemented in `./sabr.js`: everything a `manifest` source
 * has, so the watch view reads captions, chapters, storyboard, legacy formats
 * and the audio source in one way for both transports, plus the SABR
 * credentials and a way to renew them. The watch view never branches on
 * platform; it branches on transport only to hand `sabrData` and its
 * regulator to the player.
 *
 * - Chosen over DASH only when `getLocalVideoInfo` answered a PO token, a
 *   `server_abr_streaming_url`, a `media_ustreamer_request_config` and
 *   adaptive formats (`canPlaySabr`); the Local adapter answers a DASH
 *   `manifest` source otherwise. Never for a live or a post-live DVR.
 * - `manifestUrl`: `data:application/sabr+json,...`, the project's own SABR
 *   manifest (`createLocalSabrManifest`): duration (the shortest format's),
 *   the adaptive formats' SABR fields, and the source's own `captions`,
 *   `chapters` and `sabrStoryboards`, embedded.
 * - `manifestMimeType`: `application/sabr+json` (`MANIFEST_TYPE_SABR`,
 *   restated as `SABR_MIME_TYPE`, since its module imports shaka).
 * - `audio`: the same manifest. The format ring treats a SABR failure as a
 *   failure of DASH and audio alike, so after one only legacy is worth trying.
 * - `sabrData`: the old view's `buildSabrData`: the SABR URL with `alr=yes`
 *   and the response's `cpn`, the video id, the PO token, the
 *   `video_playback_ustreamer_config`, and `getLocalVideoInfo`'s `clientInfo`.
 * - `sabrStoryboards`: the SABR manifest's storyboard entry, from the board
 *   the storyboard track is built from (`[]` without one), kept because it
 *   comes from `/next`, which a rebuild does not re-read.
 * - `renew({ reloadPlaybackContext, rebuilding })`: a closure over the video
 *   id and the Local module: `getLocalVideoInfo(id, { reloadPlaybackContext })`,
 *   then `{ sabrData, formatIds, expiresAt }` (`formatIds` by `buildFormatId`,
 *   `expiresAt` `null` when the fresh response has no `streaming_data.expires`)
 *   and, for `rebuilding`, a new manifest from this source's captions,
 *   chapters and `sabrStoryboards`. `reloadPlaybackContext` is the server's
 *   reload token from a `RELOAD_PLAYER_RESPONSE` part and must ride on the
 *   `/player` call. `null` when the fresh response lacks a token, a SABR URL
 *   or a ustreamer config, or the request fails: it never throws. It does not
 *   read the backend preference: a `sabr` source only ever comes from Local.
 *
 * The regulator is not here. ADR-0006: the watch view owns the regulator and
 * every recovery decision, so that its budgets outlive the player it
 * destroys; a source is created per load and would die with the rung. The
 * source is data plus `renew`, and `renew` decides nothing: it fetches, the
 * view's regulator decides when to call it and what to do with a `null`. The
 * source is frozen (its arrays are not) and `renew` writes nothing to it: the
 * view holds the current credentials and expiry.
 *
 * @typedef {import('../shapes').SabrPlaybackSource} YouTubeSabrPlaybackSource
 */

// The union of the two is `PlaybackSource` in ../shapes.js: Local answers
// either transport, Invidious only `manifest`, since it cannot mint a PO
// token or run SABR.

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * A YouTube channel, the common `ChannelDetails` (../shapes.js, which took
 * `tabs`, `tags`, `isFamilyFriendly` and `isArtistTopicChannel`). Implemented
 * in `./channels.js`. Local: `getLocalChannel(id)` (a `YT.Channel`, or
 * `{ alert }` for a terminated channel, which is `notFound`; an age gate is
 * `refused`, `ageRestricted`), read through `parseLocalChannelHeader`; the
 * description needs a second request, `channel.getAbout()`. Invidious:
 * `invidiousGetChannelInfo(id)`.
 *
 * | common               | L                                                  | I                                            |
 * | -------------------- | -------------------------------------------------- | -------------------------------------------- |
 * | platform, host       | absent                                             | absent                                       |
 * | id                   | header id, else `metadata.external_id`, else the ref | `authorId`, else the ref                   |
 * | name                 | header name, else `metadata.title`                 | `author`                                     |
 * | thumbnail            | header `thumbnailUrl`, `//` made `https:`          | `authorThumbnails[3]`, else the last, as a subscription stores it (`describe` moves it onto the instance when shown) |
 * | handle               | the `@handle` `metadata.vanity_channel_url` ends in, `null` without | `null` (not read)           |
 * | subscriberCount      | `parseLocalSubscriberCount(subscriberText)`, `null` when unreadable | `subCount`, `null` when not a number |
 * | url                  | `https://www.youtube.com/channel/{id}`             | the same                                     |
 * | avatarLarge          | the same `thumbnailUrl` (the header gives one)     | `authorThumbnails.at(-1)` via `youtubeImageUrlToInvidious` |
 * | banner               | `bannerUrl`, `null` when none                      | `authorBanners[0]` via `youtubeImageUrlToInvidious`, `null` when none |
 * | description          | `getAbout()`'s `description.text` (`ChannelAboutFullMetadata`), else `metadata.description`; `''` without `has_about` | `description` |
 * | descriptionKind      | `'plain'` (the view autolinks it)                  | `'plain'`                                    |
 * | support              | absent                                             | absent                                       |
 * | tabs                 | by the `has_*` flags; an artist topic channel also `videos` and `releases` | `tabs`, as the module maps them (`streams` → `live`, `posts` → `community`) |
 * | tags                 | header tags and `metadata.tags`, without repeats   | `tags`, without repeats                      |
 * | isFamilyFriendly     | `metadata.is_family_safe === true`                 | `isFamilyFriendly === true`                  |
 * | isArtistTopicChannel | a name ending `- Topic` with `metadata.music_artist_name`, which changes where its videos come from | absent |
 *
 * `tabs` uses the old view's names in its order (`videos`, `shorts`, `live`,
 * `releases`, `podcasts`, `courses`, `playlists`, `community`), without home
 * or about, and with no hide settings applied. Channel tags are recorded by
 * the modules themselves (`rememberChannelTags` in `getLocalChannel` and
 * `invidiousGetChannelInfo`), so the adapter does not.
 *
 * The Local `YT.Channel` instances `getChannel` fetched are kept in an LRU of
 * 5 per layer instance (Q8), so a first page of a channel list does not cost
 * a second `/browse`; a miss fetches the channel again.
 *
 * @typedef {never} YouTubeChannelDetailsTable
 */

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

/**
 * A YouTube playlist in a list, implemented in `./channels.js` for a
 * channel's own playlists, releases, podcasts and courses. L: `parseLocalListPlaylist` answers the card's
 * Local field names already, with `dataSource: 'local'`. I:
 * `InvidiousPlaylistObject` renamed into them.
 *
 * | common       | L (`parseLocalListPlaylist`)                   | I (`InvidiousPlaylistObject`)                     |
 * | ------------ | ---------------------------------------------- | ------------------------------------------------- |
 * | playlistId   | `id` / `playlistId`                            | `playlistId`                                      |
 * | title        | `title.text`                                   | `title`                                           |
 * | thumbnail    | the renderer's or `thumbnails[0].url`          | `playlistThumbnail`, with `i.ytimg.com` → the instance and `hqdefault` → `mqdefault`, as the card does for Invidious |
 * | videoCount   | number from `video_count.text`                 | `videoCount`, `null` when not a number            |
 * | url          | `https://www.youtube.com/playlist?list={id}`   | the same                                          |
 * | description  | `''`                                           | `''`                                              |
 * | channelName  | `author.name`, else the channel page's; `''` when none | `author`, `''` when none                  |
 * | channelId    | `author.id`, else the channel page's; `null` for auto-generated albums and stations | `authorId`, `null` when empty |
 *
 * `dataSource: 'local'` is on every YouTube playlist, from either backend:
 * `FtListPlaylist` reads the Local field names only when `dataSource ===
 * 'local'`, and otherwise reads `playlistThumbnail` and fails.
 *
 * @typedef {import('../shapes').PlaylistSummary & { dataSource: 'local' }} YouTubePlaylistSummary
 */

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

/**
 * A YouTube channel's post, the common `Post` (../shapes.js), implemented in
 * `./channels.js`. Not mapped: both modules' parsers answer the post
 * component's field names already, which is what `Post` is, and the adapter
 * hands their answer on, with `postContent` `null` where a parser left an
 * attachment it does not know `undefined`. L: `parseLocalCommunityPosts` on a
 * page of `getCommunity()`'s `posts` (`YTNodes.BackstagePost`, `Post`,
 * `SharedPost`), which drops a shared post and the post it repeats. I:
 * `invidiousGetCommunityPosts(id, continuation)`'s `posts`.
 *
 * | common           | L (`BackstagePost`)                                   | I (`/api/v1/channels/{id}/community` entry)        |
 * | ---------------- | ----------------------------------------------------- | -------------------------------------------------- |
 * | postId           | `id`                                                  | `commentId`                                        |
 * | postText         | `parseLocalTextRuns(content.runs)`, autolinked; `''` when empty | `contentHtml`, `href="/` made `href="#/`  |
 * | author, authorId | `author.name`, `author.id`                            | `author`, `authorId`                               |
 * | authorThumbnails | `author.thumbnails`, `//` made `https:`               | `authorThumbnails` via `youtubeImageUrlToInvidious` |
 * | publishedTime    | `calculatePublishedDate(published.text)`              | `calculatePublishedDate(publishedText)`            |
 * | voteCount        | from `vote_count.text`, 0 when YouTube hides it       | `likeCount`                                        |
 * | commentCount     | from `action_buttons.reply_button.text`, `null` without one | `replyCount`, else 0                         |
 * | postContent      | from `attachment`: `BackstageImage` → `image`, `PostMultiImage` → `multiImage`, `Poll` → `poll`, `Quiz` → `quiz`, `Video` → `video` (`parseLocalListVideo`, `null` for an unavailable one), `Playlist` → `playlist` (`parseLocalListPlaylist`) | from `attachment`: `image`, `multiImage`, `poll`, `quiz` with images on the instance, `video` and `playlist` as the API gives them, `error` for a gone video |
 *
 * @typedef {import('../shapes').Post} YouTubePost
 */

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/**
 * A YouTube comment, implemented in `./comments.js`. Mapped from what the
 * modules parsed, except the time. L: `parseLocalComment(thread.comment,
 * thread)` per thread of the `YT.Comments` page. I: `invidiousGetComments`'s
 * `commentData`, with the time from the raw `/api/v1/comments` entries in its
 * `response`. Both modules answer the time as localised relative text, which
 * is why it is read apart.
 *
 * | common          | L (`YTNodes.CommentView`)                                  | I (comment entry)                         |
 * | --------------- | ---------------------------------------------------------- | ----------------------------------------- |
 * | id              | `comment_id`                                               | `commentId`                               |
 * | threadId        | its own id for a thread; the thread's for a reply          | the same                                  |
 * | text            | `parseLocalTextRuns(content.runs)` (or the voice reply transcript), autolinked | `contentHtml`, instance-rewritten, autolinked |
 * | textKind        | `'html'`                                                   | `'html'`                                  |
 * | author          | `author.name`                                              | `author`                                  |
 * | authorAccount   | `''`: YouTube has no accounts apart from channels          | `''`                                      |
 * | authorThumbnail | `author.best_thumbnail.url`                                | `authorThumbnail` via `youtubeImageUrlToInvidious` |
 * | createdAt       | estimated from `published_time` ("2 weeks ago", `(edited)` removed) by `calculatePublishedDate`; 0 when unreadable | `published * 1000`, exact; 0 when missing |
 * | isDeleted       | `false`: neither backend reports a deleted comment         | `false`                                   |
 * | replyCount      | from `reply_count_a11y`, when the thread has replies       | `replies.replyCount`                      |
 *
 * The optional YouTube fields of the common `Comment`, all read by
 * `FtComment`: `authorId`, `likes`, `isPinned`, `isHearted`, `isOwner`,
 * `isMember` and `memberIconUrl` on both; `hasOwnerReplied` on Local only;
 * and `repliesCursor`, what `getCommentReplies` starts from: L
 * `{ backend: 'local', continuation }` around the `YTNodes.CommentThread`, I
 * `{ backend: 'invidious', continuation }` around `replies.continuation`,
 * `null` without replies. The comment's `id` is not enough on either
 * backend: Local needs the thread instance, and Invidious' reply token is not
 * derivable from the id.
 *
 * Invidious replies go through `invidiousGetComments` with the reply token as
 * `nextPageToken`, not `invidiousGetCommentReplies`: only the former hands
 * back the raw entries with their exact `published`. It is meant to be the
 * same request (Invidious ignores `sort_by` with a continuation), not
 * confirmed against a live instance.
 *
 * `getComments` takes a `sort`, `top` (the default) or `newest`. When the
 * backend says the video's comments are off (Local "The comments page did not
 * have any content", Invidious "Comments not found"), the first page is
 * `{ items: [], cursor: null, commentsEnabled: false }` (Q7); on a later page
 * it is an ordinary error.
 *
 * @typedef {import('../shapes').Comment & {
 *   repliesCursor: YouTubeLocalCursor | YouTubeInvidiousTokenCursor | null,
 * }} YouTubeComment
 */

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * YouTube search, implemented in `./search.js`. The items are the modules'
 * own list items, handed on as they are, as the old search page's cards read
 * them; not mapped into the common shapes. L `getLocalSearchResults(query,
 * filters, safetyMode)` answers `parseListItem`'s videos, channels (with
 * `dataSource: 'local'`, so `FtListChannel` reads the Local field names, as
 * the common `ChannelListItem` says), playlists, movies and lockup views. I
 * `getInvidiousSearchResults(query, page, filters)` answers the API's video,
 * channel and playlist objects, after the module's own normalising of videos.
 * Hashtags, which both answer, are dropped by the adapter.
 *
 * Filters come from the layer's search query (../search/query.js):
 * `youtubeFilters` turns it into the `{ prioritize, time, type, duration,
 * features }` both modules take, sending only what YouTube honours
 * (../search/capabilities.js), and `safetyMode` on Local is
 * `config.showFamilyFriendlyOnly`. Every search failure is `unavailable`:
 * nothing refuses a search, so each falls back on a first page (ADR-0015).
 *
 * @typedef {never} YouTubeSearchTable
 */

// ---------------------------------------------------------------------------
// Channel feed
// ---------------------------------------------------------------------------

// `fetchChannelFeed` stays PeerTube only (spec, "Phase 2 decisions", Q4). A
// YouTube channel's feeds go where they go today: the subscription feed
// descriptors (src/renderer/helpers/subscriptionFeeds/) keep dispatching
// YouTube themselves, with their store reads, RSS choice, liveness probe
// (ADR-0012) and the back-fill's `isRSS` contract untouched. The layer's
// `fetchChannelFeed` answers `failed` with an `invalid` error for a YouTube
// ref, which is the documented contract.

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

// The open questions this file ended with in phase 1 are settled in the
// spec's "Phase 2 decisions" (.scratch/platform-layer/spec.md), ADR-0015
// (backend fallback and cursors) and ADR-0016 (the `sabr` source). What the
// implementation changed on the way is dated in the amendments at the end of
// .scratch/platform-layer/design.md.

export {}
