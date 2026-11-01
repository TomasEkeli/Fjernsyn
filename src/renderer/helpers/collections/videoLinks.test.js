import { describe, expect, it } from 'vitest'

import { isYouTubeHost, peerTubeCandidateFromLink, uuidFromShortUuid, videoRefFromLink } from './videoLinks'

// Every shape of link the spec names, as found in real feeds where it was
// (lemmy.cafe's mealtimevideos and documentaries, 2026-11-01), and what each
// is: a YouTube video's ref, or nothing
const YOUTUBE = [
  ['https://www.youtube.com/watch?v=neGgUavFT0w', 'neGgUavFT0w'],
  ['https://youtube.com/watch?v=neGgUavFT0w', 'neGgUavFT0w'],
  ['http://www.youtube.com/watch?v=neGgUavFT0w', 'neGgUavFT0w'],
  ['https://m.youtube.com/watch?v=n9lHLdAJUDE', 'n9lHLdAJUDE'],
  ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ['https://www.youtube.com/watch?v=H8YdOF1yXfM&pp=ygUMc2NvdHQgY2FybmV5', 'H8YdOF1yXfM'],
  ['https://www.youtube.com/watch?feature=share&v=H8YdOF1yXfM', 'H8YdOF1yXfM'],
  ['https://www.youtube.com/watch?v=-tUzkF_Dp8M&t=120s', '-tUzkF_Dp8M'],
  // A video opened from a playlist is still that video
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL590L5WQmH8fJ54F369BLDSqIwcs-TCfs', 'dQw4w9WgXcQ'],
  ['https://youtu.be/vSHrY5xJsxg', 'vSHrY5xJsxg'],
  ['https://youtu.be/vSHrY5xJsxg?si=AbCdEfGh&t=42', 'vSHrY5xJsxg'],
  ['https://www.youtube.com/shorts/aqz-KE-bpKQ', 'aqz-KE-bpKQ'],
  ['https://youtube.com/shorts/aqz-KE-bpKQ?feature=share', 'aqz-KE-bpKQ'],
  ['https://www.youtube.com/live/kvEypYGj2D8?=0', 'kvEypYGj2D8'],
  ['https://m.youtube.com/live/kvEypYGj2D8?si=x', 'kvEypYGj2D8'],
  ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ['https://youtube-nocookie.com/embed/dQw4w9WgXcQ?start=10', 'dQw4w9WgXcQ'],
  ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ['https://WWW.YouTube.com/watch?v=neGgUavFT0w', 'neGgUavFT0w'],
  ['  https://youtu.be/vSHrY5xJsxg  ', 'vSHrY5xJsxg'],
  ['https://www.youtube.com/watch?v=neGgUavFT0w#t=30', 'neGgUavFT0w'],
  // A trailing slash, as some sites and hand-typed links add
  ['https://youtu.be/vSHrY5xJsxg/', 'vSHrY5xJsxg'],
  ['https://www.youtube.com/shorts/aqz-KE-bpKQ/', 'aqz-KE-bpKQ'],
  ['https://www.youtube.com/live/kvEypYGj2D8/', 'kvEypYGj2D8'],
]

const SKIPPED = [
  // A playlist is not a video
  'https://www.youtube.com/playlist?list=PL590L5WQmH8fJ54F369BLDSqIwcs-TCfs',
  // Channels and the rest of YouTube
  'https://www.youtube.com/@LastWeekTonight',
  'https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ',
  'https://www.youtube.com/',
  'https://www.youtube.com/watch',
  'https://www.youtube.com/watch?list=PL590L5WQmH8fJ54F369BLDSqIwcs-TCfs',
  // Old shapes for a video, rare in feeds, not recognised
  'https://www.youtube.com/attribution_link?u=%2Fwatch%3Fv%3DdQw4w9WgXcQ%26feature%3Dshare',
  'https://www.youtube.com/v/dQw4w9WgXcQ',
  // Not a video id
  'https://www.youtube.com/watch?v=short',
  'https://www.youtube.com/watch?v=neGgUavFT0wX',
  'https://youtu.be/',
  'https://youtu.be/vSHrY5xJsxg/extra',
  'https://www.youtube.com/shorts/',
  'https://www.youtube.com/live/',
  'https://www.youtube.com/live/kvEypYGj2D8/chat',
  // Hosts that only look like YouTube's
  'https://notyoutube.com/watch?v=neGgUavFT0w',
  'https://www.youtube.com.example.org/watch?v=neGgUavFT0w',
  'https://youtu.be.example.org/vSHrY5xJsxg',
  'https://youtube-nocookie.com/watch?v=dQw4w9WgXcQ',
  'https://gaming.youtube.com/watch?v=dQw4w9WgXcQ',
  // Hosted clips
  'https://lemmy.world/pictrs/image/718e7c0d-1963-42a0-9b2f-5fd17c231709.jpeg',
  'https://lemmy.world/pictrs/image/0b6c3a8f-5a1d-4c55-8b5e-4f0f3f3c7b1e.webm',
  'https://files.catbox.moe/abc123.webm',
  'https://www.imgchest.com/p/49ylmqjqk7x',
  'https://dn710207.ca.archive.org/0/items/huey-long-full-pbs-documentary-by-ken-burns/Huey%20Long%20%28Full%20PBS%20Documentary%20by%20Ken%20Burns%29.mp4',
  // Other video sites, until their tickets
  'https://vimeo.com/76979871',
  'https://kolektiva.media/w/17ofj7REMfkVd5QMB267Zx',
  'https://fedi.video/videos/watch/059ca8df-3049-44a3-93a9-d603327f2e74',
  // Articles, torrents, and what is not a link at all
  'https://www.theguardian.com/film/2026/oct/01/you-can-see-everything-movie-review',
  'magnet:?xt=urn%3Abtih%3A40F3761B9080949CA6FFED3522AD872BC0BEF41B&dn=The+Internets+Own+Boy',
  'ftp://www.youtube.com/watch?v=neGgUavFT0w',
  'javascript:alert(1)//youtu.be/vSHrY5xJsxg',
  'www.youtube.com/watch?v=neGgUavFT0w',
  'not a link',
  '',
]

describe('a link as a video', () => {
  it.each(YOUTUBE)('makes %s the YouTube video %s', (link, videoId) => {
    expect(videoRefFromLink(link)).toEqual({ videoId })
  })

  it.each(SKIPPED)('makes nothing of %s', (link) => {
    expect(videoRefFromLink(link)).toBe(null)
  })

  it('makes nothing of what is not a string', () => {
    expect(videoRefFromLink(null)).toBe(null)
    expect(videoRefFromLink(undefined)).toBe(null)
  })
})

// PeerTube's two shapes for a video, on any host, as found in real feeds
// (lemmy.world's peertube and lemmy.cafe's documentaries, 2026-11-01), and the
// candidate each is: the host to ask, and the video's full uuid. A short uuid
// (`/w/<22 characters>`) is the uuid in base 58, which the pairs below were
// checked against by asking each instance for the video.
const PEERTUBE = [
  ['https://tilvids.com/videos/watch/ef67ed68-de61-4c06-a9c0-90d1569bc9bf', 'tilvids.com', 'ef67ed68-de61-4c06-a9c0-90d1569bc9bf'],
  ['https://fedi.video/videos/watch/059ca8df-3049-44a3-93a9-d603327f2e74', 'fedi.video', '059ca8df-3049-44a3-93a9-d603327f2e74'],
  ['https://video.blender.org/w/309d37bf-2674-474d-a1e4-1eb05e6d9073', 'video.blender.org', '309d37bf-2674-474d-a1e4-1eb05e6d9073'],
  // A short uuid, with leading zeros (its uuid starts 00), and another
  ['https://kolektiva.media/w/17ofj7REMfkVd5QMB267Zx', 'kolektiva.media', '00e42c34-81d4-4744-a2e2-cf3b2b3c19d9'],
  ['https://fedi.video/w/1GcddTf1uzhyXscJ4ymdEG', 'fedi.video', '059ca8df-3049-44a3-93a9-d603327f2e74'],
  ['https://fedi.video/videos/watch/1GcddTf1uzhyXscJ4ymdEG', 'fedi.video', '059ca8df-3049-44a3-93a9-d603327f2e74'],
  // Upper case, a trailing slash, a start time, a fragment
  ['https://TilVids.com/videos/watch/EF67ED68-DE61-4C06-A9C0-90D1569BC9BF', 'tilvids.com', 'ef67ed68-de61-4c06-a9c0-90d1569bc9bf'],
  ['https://kolektiva.media/w/17ofj7REMfkVd5QMB267Zx/', 'kolektiva.media', '00e42c34-81d4-4744-a2e2-cf3b2b3c19d9'],
  ['https://kolektiva.media/w/17ofj7REMfkVd5QMB267Zx?start=1m2s', 'kolektiva.media', '00e42c34-81d4-4744-a2e2-cf3b2b3c19d9'],
  ['http://tilvids.com/videos/watch/ef67ed68-de61-4c06-a9c0-90d1569bc9bf#comments', 'tilvids.com', 'ef67ed68-de61-4c06-a9c0-90d1569bc9bf'],
]

// What only looks like PeerTube's shapes, or is PeerTube but not a video
const NOT_PEERTUBE = [
  // Playlists and channels
  'https://tilvids.com/w/p/4NFnnZG7WqhNpSFmzHjUcN',
  'https://tilvids.com/videos/watch/playlist/ef67ed68-de61-4c06-a9c0-90d1569bc9bf',
  'https://tilvids.com/c/edu_channel/videos',
  'https://tilvids.com/a/someone',
  // An embed is not a shape the spec names
  'https://tilvids.com/videos/embed/ef67ed68-de61-4c06-a9c0-90d1569bc9bf',
  // More after the id
  'https://tilvids.com/videos/watch/ef67ed68-de61-4c06-a9c0-90d1569bc9bf/extra',
  'https://kolektiva.media/w/17ofj7REMfkVd5QMB267Zx/comments',
  // Wikis and other sites' /w/ paths: words, page names, numbers
  'https://en.wikipedia.org/w/index.php?title=PeerTube',
  'https://wiki.example.org/w/Main_Page',
  'https://example.org/w/about',
  'https://example.org/w/12345',
  'https://example.org/w/',
  // Twenty-two characters that are base 58 but no uuid PeerTube makes (not a
  // version 4 uuid), and others that are not base 58 at all
  'https://example.org/w/1111111111111111111111',
  'https://example.org/w/zzzzzzzzzzzzzzzzzzzzzz',
  'https://example.org/w/0OIl0OIl0OIl0OIl0OIl0O',
  // Not a uuid
  'https://tilvids.com/videos/watch/ef67ed68-de61-4c06-a9c0',
  'https://tilvids.com/videos/watch/42',
  // A port, which no ref carries; a host with no dot; YouTube's and Google's hosts
  'https://tilvids.com:8443/videos/watch/ef67ed68-de61-4c06-a9c0-90d1569bc9bf',
  'https://localhost/videos/watch/ef67ed68-de61-4c06-a9c0-90d1569bc9bf',
  'https://www.youtube.com/w/17ofj7REMfkVd5QMB267Zx',
  'https://youtube.com/videos/watch/ef67ed68-de61-4c06-a9c0-90d1569bc9bf',
  'https://storage.googleapis.com/videos/watch/ef67ed68-de61-4c06-a9c0-90d1569bc9bf',
  // Links in the peertube community's feed that are no video
  'https://github.com/Chocobozzz/PeerTube/releases/tag/v8.3.2',
  'https://mstdn.social/@brothersoul/116782330848494490',
  'https://piefed.social/f/fediversevideos',
  'https://survey.btfree.org/247331',
  // YouTube's own, and what is not a link
  'https://youtu.be/vSHrY5xJsxg',
  'ftp://tilvids.com/videos/watch/ef67ed68-de61-4c06-a9c0-90d1569bc9bf',
  'tilvids.com/videos/watch/ef67ed68-de61-4c06-a9c0-90d1569bc9bf',
  'not a link',
  '',
]

describe('a link as a PeerTube candidate', () => {
  it.each(PEERTUBE)('makes %s a candidate on %s, the video %s', (link, host, videoId) => {
    expect(peerTubeCandidateFromLink(link)).toEqual({ host, videoId })
  })

  it.each(NOT_PEERTUBE)('makes nothing of %s', (link) => {
    expect(peerTubeCandidateFromLink(link)).toBe(null)
  })

  it('makes nothing of what is not a string', () => {
    expect(peerTubeCandidateFromLink(null)).toBe(null)
    expect(peerTubeCandidateFromLink(undefined)).toBe(null)
  })

  it('is never a YouTube video too: the two never claim one link', () => {
    for (const [link] of [...YOUTUBE, ...PEERTUBE]) {
      expect(videoRefFromLink(link) === null || peerTubeCandidateFromLink(link) === null).toBe(true)
    }
  })
})

describe('a short uuid', () => {
  it.each([
    ['17ofj7REMfkVd5QMB267Zx', '00e42c34-81d4-4744-a2e2-cf3b2b3c19d9'],
    ['1GcddTf1uzhyXscJ4ymdEG', '059ca8df-3049-44a3-93a9-d603327f2e74'],
  ])('%s is the uuid %s', (short, uuid) => {
    expect(uuidFromShortUuid(short)).toBe(uuid)
  })

  it.each(['', 'about', '0OIl', 'zzzzzzzzzzzzzzzzzzzzzzzz', '1111111111111111111111'])('%j is none', (short) => {
    expect(uuidFromShortUuid(short)).toBe(null)
  })
})

describe('whether a host is YouTube\'s', () => {
  it.each(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'gaming.youtube.com', 'youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com', 'WWW.YouTube.com'])('is for %s', (host) => {
    expect(isYouTubeHost(host)).toBe(true)
  })

  it.each(['notyoutube.com', 'youtube.com.example.org', 'youtu.be.example.org', 'lemmy.cafe', ''])('is not for %s', (host) => {
    expect(isYouTubeHost(host)).toBe(false)
  })
})
