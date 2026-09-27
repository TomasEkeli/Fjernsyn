# PeerTube fixtures

Real responses recorded once, on 2026-09-27 between 14:22 and 14:28 UTC, from
live instances, anonymously, with the User-Agent
`Fjernsyn/0.0.1 (+https://github.com/TomasEkeli/Fjernsyn)`. Each file is
`{ recordedAt, url, status, headers, body }`; `headers` keeps only
`content-type`, `retry-after` and `x-ratelimit-*`. Files named
`synthesised--*` were not recorded: they carry `"synthesised": true` and a
`note` naming the source of their shape.

The recorder (`.scratch/platform-layer/record-fixtures.mjs`, with its request
log `requests.log`) and the synthesiser (`synthesise-fixtures.mjs`) live in the
git-ignored `.scratch/platform-layer/`. Bodies are unedited, so they contain
instance-supplied text, including the JavaScript and CSS in every `config`
(`instance.customizations`), which the adapter must ignore.

## video.blender.org (8.2.4; HLS and Web Videos both on)

| File | What it exhibits |
|---|---|
| `video.blender.org--config.json` | 8.2 config: no `splitAudioAndVideo`, trending algorithms, `search.remoteUri.anonymous: false` |
| `video.blender.org--video-hls.json` | `b29290cc-…`: HLS playlist (1080, 480, each `hasAudio`/`hasVideo` true) plus 3 Web Video MP4s, `downloadEnabled: true`, `thumbnails[]` and `thumbnailPath`, `commentsPolicy` |
| `video.blender.org--video-web-video-only.json` | `7243ebe1-fd97-476d-8601-e73d272b849b` (2021): MP4 only, `files[]` 1080 and 720, `streamingPlaylists: []` |
| `video.blender.org--captions.json` | `{ total: 0, data: [] }` (the video has none) |
| `video.blender.org--chapters.json` | `{ chapters: [] }` |
| `video.blender.org--storyboards.json` | one sprite: `fileUrl`, deprecated `storyboardPath`, 1920x756 total, 192x108 sprites, `spriteDuration: 1` |
| `video.blender.org--comment-threads.json` | count 5, one thread, no replies |
| `video.blender.org--comment-threads-with-replies.json` | Spring (`3d95fb3d-…`), `sort=-totalReplies`, 11 threads, two with 2 replies |
| `video.blender.org--comment-thread-tree.json` | thread 7175, 8.2 tree: nodes are `{ comment, children }`, no `totalChildren` |
| `video.blender.org--channel.json` | `blender_studio@video.blender.org` |
| `video.blender.org--channel-videos-newest.json` | `sort=-publishedAt`, start 0 |
| `video.blender.org--channel-videos-newest-page2.json` | `sort=-publishedAt`, start 5 |
| `video.blender.org--channel-videos-views.json` | `sort=-views` |
| `video.blender.org--channel-videos-oldest.json` | `sort=publishedAt` |
| `video.blender.org--channel-playlists.json` | channel `video-playlists`, count 5 |
| `video.blender.org--search-videos.json` | the instance's own search, `search=spring&sort=-match&nsfw=false`; all `isLocal: true` |
| `video.blender.org--not-found.json` | real 404 for a random uuid, `application/problem+json` |

## tilvids.com (8.2.4; HLS only, downloads enabled)

| File | What it exhibits |
|---|---|
| `tilvids.com--config.json` | `hls.enabled`, `web_videos.enabled: false` |
| `tilvids.com--video-hls-downloads.json` | `1ed60f7c-1c42-45dc-9eb9-9006964e5ae9`: `files: []`, HLS 720/360/144, `downloadEnabled: true`, each HLS file has `fileDownloadUrl` `…/download/streaming-playlists/hls/videos/<uuid>-<res>-fragmented.mp4` |
| `tilvids.com--chapters.json` | 16 chapters `{ timecode, title }` (from the description's timestamps) |
| `tilvids.com--captions.json` | empty |

## makertube.net (8.3.0; HLS only, transcription on)

| File | What it exhibits |
|---|---|
| `makertube.net--config.json` | 8.3 config: `transcoding.hls.splitAudioAndVideo: false`, `alwaysTranscodePodcastOptimizedAudio` |
| `makertube.net--video.json` | `cb6fa58d-4981-4a4b-9a28-8af37d40f271`, 8.3 details |
| `makertube.net--captions.json` | auto-generated German caption with `captionPath`, `fileUrl` (object storage host) and `m3u8Url: null` |
| `makertube.net--chapters.json` | chapters |
| `makertube.net--comment-threads.json` | `sort=-totalReplies`, 89 threads |
| `makertube.net--comment-thread-tree.json` | thread 34707, 8.3 tree: nodes carry `totalChildren` |
| `makertube.net--comment-thread-tree-truncated.json` | same thread with `repliesPerLevel=1&maxDepth=1`: `totalChildren: 2`, `children.length: 1` |
| `makertube.net--comment-replies.json` | 8.3 `GET /videos/{id}/comments/34707/replies?start=0&count=5`: `{ total, data: [{ comment, children, totalChildren }] }` |

## video.4d2.org (8.3.0; split audio and video)

| File | What it exhibits |
|---|---|
| `video.4d2.org--config.json` | `transcoding.hls.splitAudioAndVideo: true` |
| `video.4d2.org--video-split-audio.json` | `79856d94-7771-4e85-98fc-7e03152d5915`: HLS files 1080/720/480/240 with `hasAudio: false, hasVideo: true`, plus resolution `{ id: 0, label: "Audio only" }` with `hasAudio: true, hasVideo: false`, width/height 0; `files[]` holds one audio-only MP4 (resolution 0, the podcast-optimised audio) |
| `video.4d2.org--video-split-audio-master-m3u8.json` | master playlist as a string: one `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio"` rendition (`…-0.m3u8`), four `EXT-X-STREAM-INF` variants with `AUDIO="audio"` |

## Older instances

| File | What it exhibits |
|---|---|
| `peertube.f-si.org--config.json` | 6.2.0, HLS only, no `splitAudioAndVideo` |
| `peertube.f-si.org--video.json` | `8934b209-5a98-4314-a143-73e567cacd1c`: `thumbnailPath` only (no `thumbnails[]`), `commentsEnabled` and `commentsPolicy` both present |
| `peertube.f-si.org--captions.json` | empty |
| `peertube.f-si.org--comment-threads.json` | empty (`total: 0`) |
| `peertube.f-si.org--channel.json` | `fsic2025@peertube.f-si.org` |
| `peertube.f-si.org--channel-videos-newest.json` | its newest 5; 6.2 list items have no `comments` count |
| `peertube.f-si.org--bad-request-sort.json` | real 400: 6.2 rejects `sort=-comments` (`invalid-params.sort`, deprecated `error` field) |
| `blurt.media--config.json` | 6.3.3 |
| `blurt.media--video.json` | `9bcc834c-3f60-44a2-9f7a-818c3f2d53e4`: `thumbnailPath` only, `commentsEnabled` and `commentsPolicy`, HLS only |
| `blurt.media--captions.json` | caption with `captionPath` only, no `fileUrl` (pre-7.1) |
| `blurt.media--comment-threads.json` | two threads, no replies |
| `blurt.media--channel.json` | the video's channel |
| `blurt.media--channel-videos-newest.json` | its newest 5 |

No instance of those recorded sends a singular `avatar`; all use `avatars[]`.

## Lives

| File | What it exhibits |
|---|---|
| `peertube.livespotting.com--config.json` | 8.3.0, `hls.enabled: false`, `web_videos.enabled: true` (lives still use HLS) |
| `peertube.livespotting.com--video-live.json` | `92941053-f746-431a-99fa-23301f673285`: live now, `isLive: true`, `state.id: 1`, live `master.m3u8` with empty `files[]` |
| `tube.xy-space.de--config.json` | 8.2.0 |
| `tube.xy-space.de--video-live-scheduled.json` | `221b3d31-e0c2-45cb-a757-4c57a9a23df4`: `state.id: 4`, `liveSchedules: [{ startAt: "2026-10-04T07:30:00.000Z" }]` |
| `video.marcorennmaus.de--config.json` | 7.2.0 |
| `video.marcorennmaus.de--video-live-waiting-no-download.json` | `125c3a12-2565-40e9-b80c-f93c303923fe`: `state.id: 4` without schedule, `downloadEnabled: false` |
| `synthesised--video-live-ended.json` | **synthesised** `state.id: 5`, from the livespotting live |

## SepiaSearch (sepiasearch.org)

| File | What it exhibits |
|---|---|
| `sepiasearch.org--search-videos.json` | `search=blender&count=5&nsfw=false` |
| `sepiasearch.org--search-videos-page2.json` | same, `start=5` |
| `sepiasearch.org--search-channels.json` | `search/video-channels?search=blender`: `url`, `name`, `host`, `avatars[]`, `displayName`, `videosCount`, `ownerAccount` |
| `sepiasearch.org--search-videos-nsfw-both.json` | `search=horror&count=10&nsfw=both`: 3 of 10 have `nsfw: true` with `nsfwFlags` 1 or 3, one with `nsfwSummary` |

Video results carry origin `url` (`/videos/watch/<uuid>`), `uuid`, `shortUUID`,
`embedUrl`, `isLocal: false`, absolute `thumbnailUrl` and `previewUrl` next to
the paths, `thumbnails[]` with absolute `fileUrl`, `account.host` and
`channel.host` with `avatars[]`, `nsfw`, `nsfwFlags`, `nsfwSummary`, `isLive`,
`comments`, plus index-only `score`, `hotScore`, `rawHotScore`. No `state` and
no files.

## Synthesised

| File | Stands for |
|---|---|
| `synthesised--video-password-required.json` | anonymous GET of a password video: 401, `code: video_requires_password` |
| `synthesised--video-password-incorrect.json` | wrong `x-peertube-video-password`: 403, `code: incorrect_video_password` |
| `synthesised--video-private.json` | anonymous GET of a private, internal or blocked video: 401 "Authentication is required", no `code` |
| `synthesised--rate-limited.json` | 429, `retry-after` seconds, `x-ratelimit-*`, plain-text body |
| `synthesised--video-live-ended.json` | see Lives |
