# The platform layer

The layer is what the new views talk to instead of the services. It speaks one
set of shapes for videos, channels, playlists, comments and playback sources,
whichever platform (YouTube or PeerTube) and backend (Local or Invidious)
produced them. It sits beside upstream's views and leaves them unedited. It is
framework-free: no Vue, Vuex, router, store or i18n here, except in the
wiring. The terms are defined under "Platforms" in the project's glossary
(`docs/CONTEXT.md`), and the decision to build it is ADR-0014.

## Layout

- `index.js`: `createPlatformLayer(deps)`, the public interface, and
  `PlatformConfig`, the settings as plain values. It routes a ref to its
  platform: an 11 character id or a `UC` channel id goes to YouTube, anything
  else to PeerTube.
- `refs.js`: platform constants and ref helpers.
- `describe.js`: the pure `describe` (routes, thumbnails, share and external
  player URLs) for any stored or fetched record.
- `shapes.js`: JSDoc typedefs of the common shapes.
- `errors.js`: `PlatformError`, with a `kind` and, for refusals, a `reason`.
- `peertube/`: the PeerTube adapter, one module per concern.
- `youtube/`: the YouTube adapters (below).
- `search/`: the search query, its operators and the capability table both
  platforms' search arms read.
- `vue.js`: the wiring. Builds the layer from the store, provides it, and
  rebuilds it when a setting it reads changes. `cards.js` and `entryPoints.js`
  are hooks for upstream's components and also reach the app; `records.js`,
  `routes.js` and `subscriptionExchange.js` are pure helpers for upstream's
  code.

## The YouTube adapters

`youtube/index.js` builds them; the layer routes a YouTube ref there. Each
module wraps the existing YouTube modules (`helpers/api/local.js`,
`helpers/api/invidious.js` and a few helpers) and calls them unedited. It
imports none of them, since they read the store. They arrive as the `youtube`
dependency object, whose names are listed in `youtube/deps.js`
(`YOUTUBE_DEP_NAMES`). The wiring loads those modules on the first call of any
of them.

- `policy.js`: which backend answers (see below).
- `errors.js`: how each backend's failures read as `PlatformError` kinds, one
  table per backend.
- `videos.js`: `getVideo`, the details read in `videoDetails.js` and the
  playback source built in `playback.js`.
- `playback.js`: the `manifest` source: DASH, HLS for lives, legacy formats,
  captions, chapters, storyboard and proxying, on either backend.
- `sabr.js`: the Local `sabr` source (see below).
- `channels.js`: `getChannel`, `listChannelVideos` (`kind` `videos`, `shorts`
  or `live`), `listChannelPlaylists` (`kind` `playlists`, sorted `newest`
  or `last`, or `releases`, `podcasts` or `courses`, unsorted) and
  `listChannelPosts` (the community tab, as the post component reads
  posts; PeerTube answers none) and `searchChannel` (its videos and
  playlists matching a query, where `hasSearch`; PeerTube is `invalid`). Keeps the last 5 Local `YT.Channel`
  instances per layer, so a first page does not fetch the channel again. A
  page says the sort it applied (`Page.sort`); an age-gated channel is
  `refused`/`ageRestricted`, carrying the name and avatar YouTube still shows
  as the error's `channel`.
- `comments.js`: `getComments` (sort `top` or `newest`) and
  `getCommentReplies`. Says when a video's comments are off.
- `search.js`: YouTube search, from the layer's search query.
- `types.js`: the field-by-field mapping of each backend onto the common
  shapes, kept as the reference table the modules point to.

`fetchChannelFeed` stays PeerTube only. YouTube subscription feeds go through
the existing feed descriptors, as before.

## Backend policy

ADR-0015 and ADR-0019, in `youtube/policy.js`:

- A first page goes to the preferred backend. When fallback is on and the
  build has both backends, a failure of kind `notFound`, `unavailable` or
  `rateLimited` is tried once on the other backend, in either direction.
- So is a `refused` whose reason is `ipBlock` or `unexplained`, or which has
  no reason. Such a refusal may be about the address asking, and Local asks
  YouTube from the user's address while an Invidious instance asks from its
  own.
- `private`, `membersOnly`, `ageRestricted` and `drm` are final: those are
  about the video, and the other backend would repeat them. `invalid` is
  final too.
- A cursor names the backend that made it, and a later page goes there. A
  failure on a later page is an error. The policy never falls back mid-list
  and never restarts a list.
- The web build has no Local API, so it uses Invidious only.

Search classifies every failure as `unavailable`, since nothing refuses a
search. Cursors are in-memory values, often youtubei.js instances: hold them
in a `shallowRef` or a plain variable, and never store or clone them.

## The SABR source

ADR-0016, in `youtube/sabr.js`. A Local video that can play over SABR gets a
`sabr` source: every field of a `manifest` source, plus `sabrData`,
`sabrStoryboards` and `renew`. `renew` fetches a fresh player response and
answers new credentials, and for a rebuild a new manifest, or `null`. It
decides nothing and never changes the source. The regulator and every recovery
decision stay in the watch view (ADR-0006).

## Fixtures and fakes

Tests never touch the network.

- PeerTube: `peertube/fixtures/<host>--<what>.json`, one recorded response per
  file, each `{ recordedAt, url, status, headers, body }`. `createFakeFetch`
  in `peertube/testing/fakeFetch.js` answers from them by URL and records
  every request.
- YouTube: `youtube/fixtures/<backend>--<what>.json`, backend `local` or
  `invidious`, one module answer per file, each
  `{ recordedAt, source, call, answer, notes? }`. `source` is `recorded`
  (from the live service, trimmed to the fields the adapters read) or
  `synthesised` (written from the module's documented shape). `call` is the
  module call as written. `createFakeYouTube` in `youtube/testing/fakeYouTube.js`
  is a `youtube` deps object that answers each function from a fixture (a
  fresh copy), an Error (rejects) or a function, and records every call. An
  unregistered function throws, naming itself. `withMethods` adds the methods
  an adapter calls on a library instance. `youtube/testing/videoLayer.js` sets
  up a layer with the real helpers for the video tests.

## Running the tests

```
pnpm test
npx vitest run src/renderer/platform
npx eslint src/renderer/platform
```

Tests sit beside the module they test, as `*.test.js`. They drive the public
entry points and assert on what a caller sees.
