// Expected YouTube values are today's, read from the components that build
// them: FtListVideo.vue (`thumbnail`, `watchVideoRouterLink`, the copy and
// open share options), FtListChannel.vue (the Invidious channel thumbnail),
// ChannelsOverviewTile.vue (a stored channel's thumbnail) and
// src/main/externalPlayer.js (the URL handed to the external player).

import { describe as group, expect, it } from 'vitest'

import { describe } from './describe'

const LOCAL = { backendPreference: 'local', currentInvidiousInstanceUrl: 'https://inv.example', thumbnailPreference: '' }
const INVIDIOUS = { ...LOCAL, backendPreference: 'invidious' }

const YOUTUBE_ID = 'dQw4w9WgXcQ'
const CHANNEL_ID = 'UCuAXFkgsw1L7xaCfnd5JJOw'
const UUID = 'b29290cc-5c6d-4b9e-8d64-2f6f3b3a1e11'

const NOTHING = { route: null, thumbnail: null, shareUrl: null, externalPlayerUrl: null }

group('describe', () => {
  group('a YouTube video', () => {
    // A history entry, a playlist item and a fetched summary alike: no `platform`
    const video = { videoId: YOUTUBE_ID, title: 'x', author: 'y', authorId: CHANNEL_ID }

    it('routes to the watch page, shares the short link and plays the watch URL externally', () => {
      expect(describe(video, LOCAL)).toEqual({
        route: { path: `/watch/${YOUTUBE_ID}` },
        thumbnail: `https://i.ytimg.com/vi/${YOUTUBE_ID}/mqdefault.jpg`,
        shareUrl: `https://youtu.be/${YOUTUBE_ID}`,
        externalPlayerUrl: `https://www.youtube.com/watch?v=${YOUTUBE_ID}`,
      })
    })

    it.each([
      ['', 'mqdefault', 'hq720'],
      ['default', 'mqdefault', 'hq720'],
      ['start', 'mq1', 'hq720_1'],
      ['middle', 'mq2', 'hq720_2'],
      ['end', 'mq3', 'hq720_3'],
    ])('takes the %j thumbnail, small or large', (thumbnailPreference, small, large) => {
      const config = { ...LOCAL, thumbnailPreference }

      expect(describe(video, config).thumbnail).toBe(`https://i.ytimg.com/vi/${YOUTUBE_ID}/${small}.jpg`)
      expect(describe(video, config, { large: true }).thumbnail).toBe(`https://i.ytimg.com/vi/${YOUTUBE_ID}/${large}.jpg`)
    })

    it('takes the thumbnail from the Invidious instance when Invidious is preferred', () => {
      expect(describe(video, INVIDIOUS).thumbnail).toBe(`https://inv.example/vi/${YOUTUBE_ID}/mqdefault.jpg`)
      expect(describe(video, { ...INVIDIOUS, thumbnailPreference: 'end' }, { large: true }).thumbnail)
        .toBe(`https://inv.example/vi/${YOUTUBE_ID}/hq720_3.jpg`)
    })

    it('has no thumbnail when thumbnails are hidden, leaving the placeholder to the card', () => {
      expect(describe(video, { ...LOCAL, thumbnailPreference: 'hidden' }).thumbnail).toBeNull()
    })

    it('reads an explicit youtube platform the same as none', () => {
      expect(describe({ ...video, platform: 'youtube' }, LOCAL)).toEqual(describe(video, LOCAL))
    })
  })

  group('a YouTube channel', () => {
    it('routes to the channel page and shares the channel URL', () => {
      const stub = { id: CHANNEL_ID, name: 'x', thumbnail: 'https://yt3.ggpht.com/abc=s88-c-k-c0x00ffffff-no-rj' }

      expect(describe(stub, LOCAL)).toEqual({
        route: { path: `/channel/${CHANNEL_ID}` },
        thumbnail: 'https://yt3.ggpht.com/abc=s88-c-k-c0x00ffffff-no-rj',
        shareUrl: `https://youtube.com/channel/${CHANNEL_ID}`,
        externalPlayerUrl: null,
      })
    })

    it('points a stored thumbnail at the backend in use', () => {
      const googleStub = { id: CHANNEL_ID, name: 'x', thumbnail: '//yt3.googleusercontent.com/abc=s88' }
      const invidiousStub = { id: CHANNEL_ID, name: 'x', thumbnail: 'https://old.invidious.example/ggpht/abc=s88' }

      expect(describe(googleStub, LOCAL).thumbnail).toBe('https://yt3.googleusercontent.com/abc=s88')
      expect(describe(googleStub, INVIDIOUS).thumbnail).toBe('https://inv.example/ggpht/abc=s88')
      expect(describe(invidiousStub, LOCAL).thumbnail).toBe('https://yt3.ggpht.com/abc=s88')
      expect(describe(invidiousStub, INVIDIOUS).thumbnail).toBe('https://inv.example/ggpht/abc=s88')
    })

    it('has no thumbnail for a stored channel without one, or with one that is not a URL', () => {
      expect(describe({ id: CHANNEL_ID, name: 'x', thumbnail: '' }, LOCAL).thumbnail).toBeNull()
      expect(describe({ id: CHANNEL_ID, name: 'x', thumbnail: '/ggpht/abc' }, LOCAL).thumbnail).toBeNull()
    })

    it('keeps a Local search result thumbnail as it came, whatever the backend', () => {
      const local = { type: 'channel', dataSource: 'local', id: CHANNEL_ID, name: 'x', thumbnail: 'https://yt3.ggpht.com/abc=s176' }

      expect(describe(local, INVIDIOUS).thumbnail).toBe('https://yt3.ggpht.com/abc=s176')
    })

    it('rewrites an Invidious search result thumbnail onto the current instance', () => {
      const invidious = {
        type: 'channel',
        author: 'x',
        authorId: CHANNEL_ID,
        authorThumbnails: [
          { url: '//yt3.ggpht.com/abc=s32' },
          { url: '//yt3.ggpht.com/abc=s48' },
          { url: '//yt3.ggpht.com/abc=s76' },
        ],
      }

      expect(describe(invidious, LOCAL)).toEqual({
        route: { path: `/channel/${CHANNEL_ID}` },
        thumbnail: 'https://inv.example/ggpht/abc=s76',
        shareUrl: `https://youtube.com/channel/${CHANNEL_ID}`,
        externalPlayerUrl: null,
      })

      const ytimg = { ...invidious, authorThumbnails: [{}, {}, { url: 'https://i9.ytimg.com/abc.jpg' }] }
      expect(describe(ytimg, INVIDIOUS).thumbnail).toBe('https://inv.example/ggpht/abc.jpg')
    })
  })

  group('a PeerTube video', () => {
    const video = {
      videoId: UUID,
      platform: 'peertube',
      host: 'video.blender.org',
      thumbnail: 'https://video.blender.org/lazy-static/thumbnails/a.jpg',
      title: 'Spring',
      author: 'Blender Studio',
      authorId: 'blender_studio@video.blender.org',
    }

    it('routes to the PeerTube watch page and shares the canonical watch URL', () => {
      expect(describe(video, LOCAL)).toEqual({
        route: { path: `/peertube/watch/video.blender.org/${UUID}` },
        thumbnail: 'https://video.blender.org/lazy-static/thumbnails/a.jpg',
        shareUrl: `https://video.blender.org/videos/watch/${UUID}`,
        externalPlayerUrl: `https://video.blender.org/videos/watch/${UUID}`,
      })
    })

    it('keeps its stored thumbnail whatever the backend, frame or size', () => {
      const thumbnail = 'https://video.blender.org/lazy-static/thumbnails/a.jpg'

      expect(describe(video, { ...INVIDIOUS, thumbnailPreference: 'start' }, { large: true }).thumbnail).toBe(thumbnail)
    })

    it('has no thumbnail when thumbnails are hidden, or when the stored one is not https', () => {
      expect(describe(video, { ...LOCAL, thumbnailPreference: 'hidden' }).thumbnail).toBeNull()
      expect(describe({ ...video, thumbnail: 'javascript:alert(1)' }, LOCAL).thumbnail).toBeNull()
      expect(describe({ ...video, thumbnail: 'http://video.blender.org/lazy-static/thumbnails/a.jpg' }, LOCAL).thumbnail).toBeNull()
      expect(describe({ ...video, thumbnail: 'data:image/png;base64,AAAA' }, LOCAL).thumbnail).toBeNull()
      expect(describe({ ...video, thumbnail: undefined }, LOCAL).thumbnail).toBeNull()
    })

    it('describes nothing for a record without a valid host or uuid', () => {
      expect(describe({ ...video, host: undefined }, LOCAL)).toEqual(NOTHING)
      expect(describe({ ...video, host: 'evil.example/../x' }, LOCAL)).toEqual(NOTHING)
      expect(describe({ ...video, videoId: '1234' }, LOCAL)).toEqual(NOTHING)
    })
  })

  group('a PeerTube channel', () => {
    const stub = {
      id: 'blender_studio@video.blender.org',
      name: 'Blender Studio',
      thumbnail: 'https://video.blender.org/lazy-static/avatars/b.png',
      platform: 'peertube',
      host: 'video.blender.org',
    }

    it('routes to the PeerTube channel page and shares the channel URL on its origin', () => {
      expect(describe(stub, LOCAL)).toEqual({
        route: { path: '/peertube/channel/blender_studio@video.blender.org' },
        thumbnail: 'https://video.blender.org/lazy-static/avatars/b.png',
        shareUrl: 'https://video.blender.org/video-channels/blender_studio',
        externalPlayerUrl: null,
      })
    })

    it('has no thumbnail when it has no avatar, or one that is not https', () => {
      expect(describe({ ...stub, thumbnail: '' }, LOCAL).thumbnail).toBeNull()
      expect(describe({ ...stub, thumbnail: 'http://video.blender.org/lazy-static/avatars/b.png' }, LOCAL).thumbnail).toBeNull()
      expect(describe({ ...stub, thumbnail: 'javascript:alert(1)' }, LOCAL).thumbnail).toBeNull()
    })

    it('describes nothing for a stub whose id is not a handle', () => {
      expect(describe({ ...stub, id: 'blender_studio' }, LOCAL)).toEqual(NOTHING)
    })
  })

  it('describes nothing it cannot recognise, and never throws', () => {
    expect(describe(null, LOCAL)).toEqual(NOTHING)
    expect(describe(undefined, LOCAL)).toEqual(NOTHING)
    expect(describe({}, LOCAL)).toEqual(NOTHING)
    expect(describe({ videoId: 42 }, LOCAL)).toEqual(NOTHING)
    expect(describe({ type: 'channel', authorThumbnails: 'nope', authorId: CHANNEL_ID }, LOCAL).route)
      .toEqual({ path: `/channel/${CHANNEL_ID}` })
    expect(describe({ videoId: YOUTUBE_ID })).toMatchObject({ route: { path: `/watch/${YOUTUBE_ID}` } })
  })
})
