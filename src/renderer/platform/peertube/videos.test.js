import { describe, expect, it } from 'vitest'

import { PlatformError } from '../errors'
import { createPlatformLayer } from '../index'
import { createFakeFetch } from './testing/fakeFetch'

import blenderCaptions from './fixtures/video.blender.org--captions.json'
import blenderChapters from './fixtures/video.blender.org--chapters.json'
import blenderConfig from './fixtures/video.blender.org--config.json'
import blenderHls from './fixtures/video.blender.org--video-hls.json'
import blenderNotFound from './fixtures/video.blender.org--not-found.json'
import blenderStoryboards from './fixtures/video.blender.org--storyboards.json'
import blenderWebOnly from './fixtures/video.blender.org--video-web-video-only.json'
import blurtCaptions from './fixtures/blurt.media--captions.json'
import blurtConfig from './fixtures/blurt.media--config.json'
import blurtVideo from './fixtures/blurt.media--video.json'
import endedLive from './fixtures/synthesised--video-live-ended.json'
import fourD2Config from './fixtures/video.4d2.org--config.json'
import fourD2Video from './fixtures/video.4d2.org--video-split-audio.json'
import fsiCaptions from './fixtures/peertube.f-si.org--captions.json'
import fsiConfig from './fixtures/peertube.f-si.org--config.json'
import fsiVideo from './fixtures/peertube.f-si.org--video.json'
import liveConfig from './fixtures/peertube.livespotting.com--config.json'
import liveNow from './fixtures/peertube.livespotting.com--video-live.json'
import makertubeCaptions from './fixtures/makertube.net--captions.json'
import makertubeChapters from './fixtures/makertube.net--chapters.json'
import makertubeConfig from './fixtures/makertube.net--config.json'
import makertubeVideo from './fixtures/makertube.net--video.json'
import marcoConfig from './fixtures/video.marcorennmaus.de--config.json'
import marcoWaiting from './fixtures/video.marcorennmaus.de--video-live-waiting-no-download.json'
import passwordIncorrect from './fixtures/synthesised--video-password-incorrect.json'
import passwordRequired from './fixtures/synthesised--video-password-required.json'
import privateVideo from './fixtures/synthesised--video-private.json'
import scheduledConfig from './fixtures/tube.xy-space.de--config.json'
import scheduledLive from './fixtures/tube.xy-space.de--video-live-scheduled.json'
import tilvidsCaptions from './fixtures/tilvids.com--captions.json'
import tilvidsChapters from './fixtures/tilvids.com--chapters.json'
import tilvidsConfig from './fixtures/tilvids.com--config.json'
import tilvidsVideo from './fixtures/tilvids.com--video-hls-downloads.json'

const ALL_FIXTURES = [
  blenderCaptions, blenderChapters, blenderConfig, blenderHls, blenderStoryboards, blenderWebOnly,
  blurtCaptions, blurtConfig, blurtVideo,
  fourD2Config, fourD2Video,
  fsiCaptions, fsiConfig, fsiVideo,
  liveConfig, liveNow,
  makertubeCaptions, makertubeChapters, makertubeConfig, makertubeVideo,
  marcoConfig, marcoWaiting,
  scheduledConfig, scheduledLive,
  tilvidsCaptions, tilvidsChapters, tilvidsConfig, tilvidsVideo,
]

const BLENDER_UUID = blenderHls.body.uuid
const REFUSED_UUID = '11111111-2222-4333-8444-555555555555'

/**
 * @param {object} [options]
 * @param {Array<object>} [options.fixtures]
 * @param {object} [options.config]
 */
function setUp({ fixtures = ALL_FIXTURES, config } = {}) {
  const fake = createFakeFetch(fixtures)
  const layer = createPlatformLayer({ fetch: fake.fetch, config: { peertubeEnabled: true, ...config } })
  return { fake, layer }
}

/**
 * @param {{ url: string, body: any }} fixture
 */
function refOf(fixture) {
  return { platform: 'peertube', host: new URL(fixture.url).hostname, videoId: fixture.body.uuid }
}

/**
 * A copy of a recorded fixture, for a variant the recording does not have
 *
 * @template T
 * @param {T} fixture
 * @returns {T}
 */
function copy(fixture) {
  return structuredClone(fixture)
}

/**
 * @param {Promise<unknown>} promise
 * @returns {Promise<PlatformError>}
 */
async function failure(promise) {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(PlatformError)
    return error
  }
  throw new Error('expected getVideo to fail')
}

/**
 * The text of a `data:text/vtt` URI
 *
 * @param {string} uri
 */
function vttText(uri) {
  const comma = uri.indexOf(',')
  return decodeURIComponent(uri.slice(comma + 1))
}

describe('getVideo (PeerTube)', () => {
  describe('an HLS video with Web Video files too (video.blender.org, 8.2)', () => {
    it('is a summary the existing card reads, plus what the watch page shows', async () => {
      const { layer } = setUp()

      const video = await layer.getVideo(refOf(blenderHls))

      expect(video).toMatchObject({
        type: 'video',
        platform: 'peertube',
        host: 'video.blender.org',
        videoId: BLENDER_UUID,
        title: 'OVERGROWN: a feature film project by Blender Studio',
        author: 'Blender Studio',
        authorId: 'blender_studio@video.blender.org',
        lengthSeconds: 70,
        published: Date.parse('2026-07-10T14:00:16.560Z'),
        viewCount: 12697,
        liveNow: false,
        isUpcoming: false,
        nsfw: false,
        // The largest landscape thumbnail, not the square podcast one
        thumbnail: 'https://video.blender.org/lazy-static/thumbnails/057e35a6-c5b8-4fb4-8230-0f5df412ca50.jpg',

        descriptionKind: 'markdown',
        likeCount: 26,
        dislikeCount: 0,
        tags: ['b3d', 'blenderstudio', 'openmovie'],
        // "Unknown" (id null) is no value at all
        category: null,
        licence: null,
        language: null,
        url: `https://video.blender.org/videos/watch/${BLENDER_UUID}`,
        commentsEnabled: true,
        downloadEnabled: true,
        liveStatus: null,
        channel: {
          platform: 'peertube',
          host: 'video.blender.org',
          id: 'blender_studio@video.blender.org',
          handle: 'blender_studio@video.blender.org',
          name: 'Blender Studio',
          thumbnail: 'https://video.blender.org/lazy-static/avatars/e2519482-f087-4965-899b-cc8b7a2921f0.webp',
          url: 'https://video.blender.org/video-channels/blender_studio',
          subscriberCount: 33,
        },
        authorThumbnail: 'https://video.blender.org/lazy-static/avatars/e2519482-f087-4965-899b-cc8b7a2921f0.webp',
      })
      expect(video.description).toBe(blenderHls.body.description)
      expect(video).not.toHaveProperty('premiereDate')
    })

    it('plays from the HLS master playlist, with the muxed MP4s as legacy formats, highest first', async () => {
      const { layer } = setUp()

      const { playbackSource } = await layer.getVideo(refOf(blenderHls))

      expect(playbackSource).toMatchObject({
        transport: 'manifest',
        manifestUrl: 'https://video.blender.org/object-storage/streaming_playlists/hls/b29290cc-dc51-4a12-bcb2-2aa5fece7605/88b94334-5068-4008-b220-6d8b068c525e-master.m3u8',
        manifestMimeType: 'application/x-mpegurl',
        isLive: false,
        captions: [],
        chapters: [],
        chaptersSrc: null,
      })
      expect(playbackSource.legacyFormats).toEqual([
        {
          itag: 1080,
          qualityLabel: '1080p',
          fps: 24,
          bitrate: Math.round(23262402 * 8 / 70),
          mimeType: 'video/mp4',
          height: 1080,
          width: 1920,
          url: 'https://video.blender.org/object-storage/web_videos/d3f1c1fa-9b39-4049-bc5d-2ca29315fda1-1080.mp4',
        },
        {
          itag: 480,
          qualityLabel: '480p',
          fps: 24,
          bitrate: Math.round(8320545 * 8 / 70),
          mimeType: 'video/mp4',
          height: 480,
          width: 854,
          url: 'https://video.blender.org/object-storage/web_videos/709aa7d2-5d70-42a2-a963-8c87b543a6db-480.mp4',
        },
      ])
    })

    it('offers the audio-only Web Video file as audio, as video/mp4, since its HLS audio is muxed', async () => {
      const { layer } = setUp()

      const { playbackSource } = await layer.getVideo(refOf(blenderHls))

      expect(playbackSource.audio).toEqual({
        manifestUrl: 'https://video.blender.org/object-storage/web_videos/1effe9c9-882d-4eec-8469-f3445d319cd2-0.mp4',
        mimeType: 'video/mp4',
      })
    })

    it('turns the storyboard sprite into a WebVTT thumbnails track, one cue per sprite', async () => {
      const { layer } = setUp()

      const { playbackSource } = await layer.getVideo(refOf(blenderHls))

      expect(playbackSource.storyboard).toMatch(/^data:text\/vtt;charset=utf-8,/)
      const sprite = 'https://video.blender.org/lazy-static/storyboards/cd071b56-47c0-477c-8e79-d6f8b2a36e79.jpg'
      const blocks = vttText(playbackSource.storyboard).trim().split('\n\n')

      // 1920x756 of 192x108 sprites is 10 columns and 7 rows: 70 sprites of
      // one second each, covering the 70 seconds exactly
      expect(blocks[0]).toBe('WEBVTT')
      expect(blocks).toHaveLength(71)
      expect(blocks[1]).toBe(`00:00:00.000 --> 00:00:01.000\n${sprite}#xywh=0,0,192,108`)
      expect(blocks[2]).toBe(`00:00:01.000 --> 00:00:02.000\n${sprite}#xywh=192,0,192,108`)
      // The 11th sprite starts the second row
      expect(blocks[11]).toBe(`00:00:10.000 --> 00:00:11.000\n${sprite}#xywh=0,108,192,108`)
      expect(blocks[70]).toBe(`00:01:09.000 --> 00:01:10.000\n${sprite}#xywh=1728,648,192,108`)
    })

    it('stops the storyboard where its sprites end, when they cover less than the video', async () => {
      // A variant of the recording: one row of 10 one-second sprites for 70 seconds
      const storyboards = copy(blenderStoryboards)
      storyboards.body.storyboards[0].totalHeight = 108
      const { layer, fake } = setUp()
      fake.respond(storyboards.url, storyboards)

      const { playbackSource } = await layer.getVideo(refOf(blenderHls))
      const blocks = vttText(playbackSource.storyboard).trim().split('\n\n')

      expect(blocks).toHaveLength(11)
      expect(blocks[10]).toMatch(/^00:00:09\.000 --> 00:00:10\.000\n.*#xywh=1728,0,192,108$/)
    })

    it('normalises the sprite URL, so that a line break in its path cannot reach the track', async () => {
      const storyboards = copy(blenderStoryboards)
      delete storyboards.body.storyboards[0].fileUrl
      storyboards.body.storyboards[0].storyboardPath = '/lazy-static/storyboards/a\n\nb.jpg'
      const { layer, fake } = setUp()
      fake.respond(storyboards.url, storyboards)

      const { playbackSource } = await layer.getVideo(refOf(blenderHls))

      expect(vttText(playbackSource.storyboard).split('\n\n')[1])
        .toBe('00:00:00.000 --> 00:00:01.000\nhttps://video.blender.org/lazy-static/storyboards/ab.jpg#xywh=0,0,192,108')
    })

    it('has no storyboard when its sprite is not on https', async () => {
      const storyboards = copy(blenderStoryboards)
      storyboards.body.storyboards[0].fileUrl = 'http://video.blender.org/lazy-static/storyboards/x.jpg'
      delete storyboards.body.storyboards[0].storyboardPath
      const { layer, fake } = setUp()
      fake.respond(storyboards.url, storyboards)

      expect((await layer.getVideo(refOf(blenderHls))).playbackSource.storyboard).toBeNull()
    })

    it('reads the storyboard sprite from the deprecated storyboardPath when there is no fileUrl', async () => {
      const storyboards = copy(blenderStoryboards)
      delete storyboards.body.storyboards[0].fileUrl
      const { layer, fake } = setUp()
      fake.respond(storyboards.url, storyboards)

      const { playbackSource } = await layer.getVideo(refOf(blenderHls))

      expect(vttText(playbackSource.storyboard).split('\n\n')[1])
        .toBe('00:00:00.000 --> 00:00:01.000\nhttps://video.blender.org/lazy-static/storyboards/cd071b56-47c0-477c-8e79-d6f8b2a36e79.jpg#xywh=0,0,192,108')
    })

    it('asks the instance for details, captions, chapters and storyboards, and nothing else', async () => {
      const { layer, fake } = setUp()

      await layer.getVideo(refOf(blenderHls))

      expect(fake.urls().sort()).toEqual([
        'https://video.blender.org/api/v1/config',
        `https://video.blender.org/api/v1/videos/${BLENDER_UUID}`,
        `https://video.blender.org/api/v1/videos/${BLENDER_UUID}/captions`,
        `https://video.blender.org/api/v1/videos/${BLENDER_UUID}/chapters`,
        `https://video.blender.org/api/v1/videos/${BLENDER_UUID}/storyboards`,
      ])
    })

    it('still answers when captions, chapters and storyboards all fail', async () => {
      const { layer, fake } = setUp()
      fake.respond(/\/(captions|chapters|storyboards)$/, { status: 500, body: { detail: 'boom' } })

      const video = await layer.getVideo(refOf(blenderHls))

      expect(video.title).toBe('OVERGROWN: a feature film project by Blender Studio')
      expect(video.playbackSource).toMatchObject({ captions: [], chapters: [], chaptersSrc: null, storyboard: null })
      expect(video.playbackSource.manifestUrl).toMatch(/master\.m3u8$/)
    })

    it('still answers, without chapters and storyboard, when the config cannot be read', async () => {
      const { layer, fake } = setUp()
      fake.respond('https://video.blender.org/api/v1/config', new TypeError('Failed to fetch'))

      const { playbackSource } = await layer.getVideo(refOf(blenderHls))

      expect(playbackSource.storyboard).toBeNull()
      expect(fake.urls()).not.toContain(`https://video.blender.org/api/v1/videos/${BLENDER_UUID}/storyboards`)
    })
  })

  describe('an MP4-only video (video.blender.org, no streaming playlist)', () => {
    it('has no manifest, only legacy formats, highest first', async () => {
      const { layer } = setUp()

      const { playbackSource } = await layer.getVideo(refOf(blenderWebOnly))

      expect(playbackSource.manifestUrl).toBeNull()
      expect(playbackSource.manifestMimeType).toBeNull()
      expect(playbackSource.legacyFormats.map(({ qualityLabel, width, height, url }) => [qualityLabel, width, height, url])).toEqual([
        ['1080p', 1920, 1080, 'https://video.blender.org/object-storage/web_videos/39d58476-46ea-4bf3-9268-d4dbc448e776-1080.mp4'],
        ['720p', 1280, 720, 'https://video.blender.org/object-storage/web_videos/52b4e20c-50a0-453e-a900-175f8b1ee6c5-720.mp4'],
      ])
      expect(playbackSource.audio).toBeNull()
    })

    it('derives width and height from the resolution when the files do not carry them', async () => {
      // A variant of the recording: the same files without width and height,
      // as older instances send them. The video's aspectRatio is null, so 16:9
      const video = copy(blenderWebOnly)
      for (const file of video.body.files) {
        delete file.width
        delete file.height
      }
      const { layer, fake } = setUp()
      fake.respond(video.url, video)

      const { playbackSource } = await layer.getVideo(refOf(video))

      expect(playbackSource.legacyFormats.map(({ width, height }) => [width, height])).toEqual([[1920, 1080], [1280, 720]])
    })

    it('uses the aspect ratio for a portrait video, whose resolution is its width', async () => {
      // A variant of the recording: a 9:16 video without width and height
      const video = copy(blenderWebOnly)
      video.body.aspectRatio = 0.5625
      for (const file of video.body.files) {
        delete file.width
        delete file.height
      }
      const { layer, fake } = setUp()
      fake.respond(video.url, video)

      const { playbackSource } = await layer.getVideo(refOf(video))

      expect(playbackSource.legacyFormats.map(({ width, height }) => [width, height])).toEqual([[1080, 1920], [720, 1280]])
    })

    it('takes the largest of the thumbnails the video has', async () => {
      const { layer } = setUp()

      const video = await layer.getVideo(refOf(blenderWebOnly))

      expect(video.thumbnail).toBe('https://video.blender.org/lazy-static/thumbnails/201c8207-dd98-4b13-ad86-eaf1b5cc35d5.jpg')
    })
  })

  describe('split audio and video (video.4d2.org, 8.3)', () => {
    it('plays the HLS manifest, whose audio rendition also serves audio only', async () => {
      const { layer } = setUp()

      const { playbackSource } = await layer.getVideo(refOf(fourD2Video))

      expect(playbackSource.manifestUrl).toBe('https://cdn-video.4d2.org/streaming-playlists/hls/79856d94-7771-4e85-98fc-7e03152d5915/f9762888-cc67-4463-94b0-5f75bcbb5efd-master.m3u8')
      expect(playbackSource.audio).toEqual({ manifestUrl: playbackSource.manifestUrl, mimeType: 'application/x-mpegurl' })
      // The only Web Video file is audio only: nothing muxed to fall back to
      expect(playbackSource.legacyFormats).toEqual([])
    })
  })

  describe('lives', () => {
    it('plays a live that is live now from its manifest only, and asks nothing more', async () => {
      const { layer, fake } = setUp()

      const video = await layer.getVideo(refOf(liveNow))

      expect(video).toMatchObject({ liveNow: true, isUpcoming: false, liveStatus: 'live', downloadOptions: [] })
      // The card reads a missing duration as live
      expect(video).not.toHaveProperty('lengthSeconds')
      expect(video.playbackSource).toEqual({
        transport: 'manifest',
        manifestUrl: 'https://peertube.livespotting.com/static/streaming-playlists/hls/92941053-f746-431a-99fa-23301f673285/master.m3u8',
        manifestMimeType: 'application/x-mpegurl',
        legacyFormats: [],
        audio: null,
        captions: [],
        chapters: [],
        chaptersSrc: null,
        storyboard: null,
        isLive: true,
      })
      expect(fake.urls()).toEqual([`https://peertube.livespotting.com/api/v1/videos/${liveNow.body.uuid}`])
    })

    it('says a live that has not started is waiting, without a schedule, and has nothing to play', async () => {
      const { layer } = setUp()

      const video = await layer.getVideo(refOf(marcoWaiting))

      expect(video).toMatchObject({
        liveNow: false,
        isUpcoming: true,
        liveStatus: 'waiting',
        lengthSeconds: 0,
        playbackSource: null,
        downloadEnabled: false,
        downloadOptions: [],
        description: '',
        // Only the path, on 7.2: made absolute, and the preview, which is larger
        thumbnail: 'https://video.marcorennmaus.de/lazy-static/previews/566b7400-ebe4-4e9b-a9b9-e5a12e1622a8.jpg',
      })
      expect(video).not.toHaveProperty('premiereDate')
    })

    it('carries the scheduled start of a waiting live as its premiere date', async () => {
      const { layer } = setUp()

      const video = await layer.getVideo(refOf(scheduledLive))

      expect(video).toMatchObject({ liveNow: false, isUpcoming: true, liveStatus: 'waiting', playbackSource: null })
      expect(video.premiereDate).toEqual(new Date('2026-10-04T07:30:00.000Z'))
    })

    it('says an ended live has ended, and has nothing to play', async () => {
      const { layer } = setUp({ fixtures: [liveConfig, endedLive] })

      const video = await layer.getVideo(refOf(endedLive))

      expect(video).toMatchObject({ liveNow: false, isUpcoming: false, liveStatus: 'ended', playbackSource: null, downloadOptions: [] })
    })
  })

  describe('older instances and old field names', () => {
    it('reads a 6.2 video: thumbnailPath and previewPath only, commentsEnabled, files without audio and video flags', async () => {
      const { layer } = setUp()

      const video = await layer.getVideo(refOf(fsiVideo))

      expect(video).toMatchObject({
        host: 'peertube.f-si.org',
        author: 'FSiC2025',
        authorId: 'fsic2025@peertube.f-si.org',
        thumbnail: 'https://peertube.f-si.org/lazy-static/previews/4ad4047e-bdab-41bf-b247-06a319a89878.jpg',
        licence: 'Attribution - Non Commercial - No Derivatives',
        language: 'English',
        description: '',
        commentsEnabled: true,
        // The channel has no avatar; its owner account's shows beside the video
        channel: { thumbnail: '' },
        authorThumbnail: 'https://peertube.f-si.org/lazy-static/avatars/799bae49-58ba-4f9f-bda2-e8dd37fb7286.png',
      })
      expect(video.playbackSource.manifestUrl).toBe('https://peertube.f-si.org/static/streaming-playlists/hls/8934b209-5a98-4314-a143-73e567cacd1c/aa3fba85-4e01-44b6-a7e7-12a64eb27416-master.m3u8')
      expect(video.downloadOptions.map(option => [option.label, option.kind])).toEqual([['1080p', 'muxed']])
    })

    it('asks a 6.2 instance for chapters, which 6.0 and later have', async () => {
      const { layer, fake } = setUp()

      await layer.getVideo(refOf(fsiVideo))

      expect(fake.urls()).toContain(`https://peertube.f-si.org/api/v1/videos/${fsiVideo.body.uuid}/chapters`)
    })

    it('does not ask for chapters or storyboards on an instance older than 6.0', async () => {
      const config = copy(fsiConfig)
      config.body.serverVersion = '5.2.1'
      const { layer, fake } = setUp()
      fake.respond(config.url, config)

      const video = await layer.getVideo(refOf(fsiVideo))

      expect(video.title).toBe(fsiVideo.body.name)
      expect(fake.urls().filter(url => /chapters|storyboards/.test(url))).toEqual([])
    })

    it('reads a 6.3 video: avatar paths without fileUrl, caption captionPath without fileUrl', async () => {
      const { layer } = setUp()

      const video = await layer.getVideo(refOf(blurtVideo))

      expect(video).toMatchObject({
        thumbnail: 'https://blurt.media/lazy-static/previews/336869ee-2032-4a9a-b1d9-62c2b5ff6f32.jpg',
        category: 'Food',
        channel: { thumbnail: 'https://blurt.media/lazy-static/avatars/732606b4-5910-4fe3-922d-80ac921c13e3.jpg' },
        commentsEnabled: true,
      })
      expect(video.playbackSource.captions).toEqual([{
        url: 'https://blurt.media/lazy-static/video-captions/a5b1f424-46b8-49bc-9f7e-a53a2180d1a3-en.vtt',
        label: 'English',
        language: 'en',
        mimeType: 'text/vtt',
        isAutomatic: true,
      }])
    })

    it('reads a singular avatar and commentsEnabled false without commentsPolicy', async () => {
      // A variant of the blurt recording with the fields of older instances:
      // no instance recorded sends a singular `avatar` any more
      const video = copy(blurtVideo)
      const oldAvatar = { path: '/lazy-static/avatars/old.jpg' }
      delete video.body.channel.avatars
      video.body.channel.avatar = oldAvatar
      delete video.body.commentsPolicy
      video.body.commentsEnabled = false
      const { layer, fake } = setUp()
      fake.respond(video.url, video)

      const details = await layer.getVideo(refOf(video))

      expect(details.channel.thumbnail).toBe('https://blurt.media/lazy-static/avatars/old.jpg')
      expect(details.commentsEnabled).toBe(false)
    })

    it('reads commentsPolicy 2 as comments disabled', async () => {
      const video = copy(blenderHls)
      video.body.commentsPolicy = { id: 2, label: 'Disabled' }
      const { layer, fake } = setUp()
      fake.respond(video.url, video)

      expect((await layer.getVideo(refOf(video))).commentsEnabled).toBe(false)
    })
  })

  describe('audio only on a muxed HLS with an extra audio-only HLS file (blurt.media, 6.3)', () => {
    it('is not split audio: no audio source without an audio-only Web Video file', async () => {
      const { layer } = setUp()

      const { playbackSource } = await layer.getVideo(refOf(blurtVideo))

      expect(playbackSource.manifestUrl).toMatch(/master\.m3u8$/)
      expect(playbackSource.audio).toBeNull()
    })

    it('offers the audio-only Web Video file where there is one', async () => {
      // A variant of the recording with an audio-only Web Video file added
      const video = copy(blurtVideo)
      const audioFile = structuredClone(video.body.streamingPlaylists[0].files.find(file => file.resolution.id === 0))
      audioFile.fileUrl = 'https://blurt.media/static/web-videos/audio-0.mp4'
      video.body.files = [audioFile]
      const { layer, fake } = setUp()
      fake.respond(video.url, video)

      const { playbackSource } = await layer.getVideo(refOf(video))

      expect(playbackSource.audio).toEqual({ manifestUrl: 'https://blurt.media/static/web-videos/audio-0.mp4', mimeType: 'video/mp4' })
    })
  })

  describe('captions', () => {
    it('reads the absolute fileUrl where there is one (7.1 and later)', async () => {
      const { layer } = setUp()

      const { playbackSource } = await layer.getVideo(refOf(makertubeVideo))

      expect(playbackSource.captions).toEqual([{
        url: 'https://media.makertube.net/captions/ae1b7daf-3467-40a2-89f9-fba22e231636-de.vtt',
        label: 'German',
        language: 'de',
        mimeType: 'text/vtt',
        isAutomatic: true,
      }])
    })

    it("orders the user's language first, written before generated, then the rest by label", async () => {
      // Invented tracks, in the shape of the recorded makertube and blurt captions
      const captions = {
        url: `https://video.blender.org/api/v1/videos/${BLENDER_UUID}/captions`,
        status: 200,
        body: {
          total: 6,
          data: [
            { language: { id: 'fr', label: 'French' }, automaticallyGenerated: false, captionPath: '/c/fr.vtt' },
            { language: { id: 'pt-br', label: 'Portuguese (Brazil)' }, automaticallyGenerated: true, captionPath: '/c/pt-br-auto.vtt' },
            { language: { id: 'de', label: 'German' }, captionPath: '/c/de.vtt' },
            { language: { id: 'pt', label: 'Portuguese' }, automaticallyGenerated: false, captionPath: '/c/pt.vtt' },
            { language: { id: 'pt-br', label: 'Portuguese (Brazil)' }, automaticallyGenerated: false, captionPath: '/c/pt-br.vtt' },
            { language: { id: 'pt-pt', label: 'Portuguese (Portugal)' }, automaticallyGenerated: false, captionPath: '/c/pt-pt.vtt' },
          ],
        },
      }
      const { layer, fake } = setUp({ config: { locale: 'pt-BR' } })
      fake.respond(captions.url, captions)

      const { playbackSource } = await layer.getVideo(refOf(blenderHls))

      expect(playbackSource.captions.map(({ url, isAutomatic }) => [url.replace('https://video.blender.org', ''), isAutomatic])).toEqual([
        ['/c/pt-br.vtt', false],
        ['/c/pt.vtt', false],
        ['/c/pt-pt.vtt', false],
        ['/c/pt-br-auto.vtt', true],
        // The rest alphabetically by label: French, German
        ['/c/fr.vtt', false],
        ['/c/de.vtt', false],
      ])
    })
  })

  describe('instance URLs', () => {
    it('keeps only https caption URLs, whatever else the instance sends', async () => {
      // Invented tracks, in the shape of the recorded captions
      const captions = {
        url: `https://video.blender.org/api/v1/videos/${BLENDER_UUID}/captions`,
        status: 200,
        body: {
          total: 5,
          data: [
            { language: { id: 'en', label: 'English' }, fileUrl: 'javascript:alert(1)' },
            { language: { id: 'fr', label: 'French' }, fileUrl: 'data:text/vtt,WEBVTT' },
            { language: { id: 'de', label: 'German' }, fileUrl: 'http://video.blender.org/c/de.vtt' },
            { language: { id: 'nl', label: 'Dutch' }, captionPath: '/c/n\nl.vtt' },
            { language: { id: 'es', label: 'Spanish' }, fileUrl: 'https://cdn.example/c/es.vtt' },
          ],
        },
      }
      const { layer, fake } = setUp()
      fake.respond(captions.url, captions)

      const { playbackSource } = await layer.getVideo(refOf(blenderHls))

      expect(playbackSource.captions.map(caption => caption.url)).toEqual([
        'https://video.blender.org/c/nl.vtt',
        'https://cdn.example/c/es.vtt',
      ])
    })
  })

  describe('chapters', () => {
    it('gives each chapter its end, the next one\'s start, and the last the video\'s end', async () => {
      const { layer } = setUp()

      const { playbackSource } = await layer.getVideo(refOf(makertubeVideo))

      expect(playbackSource.chapters.slice(0, 2)).toEqual([
        { title: 'Intro', timestamp: '0:00', startSeconds: 0, endSeconds: 110 },
        { title: 'WERBUNG: NORDVPN', timestamp: '1:50', startSeconds: 110, endSeconds: 168 },
      ])
      expect(playbackSource.chapters.at(-1)).toEqual({ title: 'Fazit', timestamp: '19:50', startSeconds: 1190, endSeconds: 1302 })
      expect(playbackSource.chapters).toHaveLength(10)
    })

    it('hands the player the chapters as a WebVTT data URI, as the Watch view builds it', async () => {
      const { layer } = setUp()

      const { playbackSource } = await layer.getVideo(refOf(makertubeVideo))

      expect(playbackSource.chaptersSrc).toMatch(/^data:text\/vtt,/)
      const blocks = vttText(playbackSource.chaptersSrc).split('\n\n')
      expect(blocks[0]).toBe('WEBVTT')
      expect(blocks[1]).toBe('00:00:00.000 --> 00:01:50.000\nIntro')
      expect(blocks[10]).toBe('00:19:50.000 --> 00:21:42.000\nFazit\n')
    })

    it('keeps each title on one line in the track, and leaves out chapters past the end', async () => {
      // A variant of the makertube chapters: line breaks in a title, and a
      // chapter after the video's 1302 seconds
      const chapters = copy(makertubeChapters)
      chapters.body.chapters[1].title = '  WERBUNG:\n\nNORDVPN\t '
      chapters.body.chapters.push({ timecode: 5000, title: 'Beyond the end' })
      const { layer, fake } = setUp()
      fake.respond(chapters.url, chapters)

      const { playbackSource } = await layer.getVideo(refOf(makertubeVideo))

      expect(playbackSource.chapters).toHaveLength(10)
      expect(playbackSource.chapters.at(-1)).toMatchObject({ title: 'Fazit', endSeconds: 1302 })
      const blocks = vttText(playbackSource.chaptersSrc).split('\n\n')
      expect(blocks).toHaveLength(11)
      expect(blocks[2]).toBe('00:01:50.000 --> 00:02:48.000\nWERBUNG: NORDVPN')
    })

    it('never ends a chapter before it starts, when the duration is unknown', async () => {
      const video = copy(makertubeVideo)
      video.body.duration = 0
      const { layer, fake } = setUp()
      fake.respond(video.url, video)

      const { chapters } = (await layer.getVideo(refOf(video))).playbackSource

      expect(chapters.at(-1)).toMatchObject({ startSeconds: 1190, endSeconds: 1190 })
    })

    it('trims chapter titles in the track as the Watch view does', async () => {
      const { layer } = setUp()

      const { playbackSource } = await layer.getVideo(refOf(tilvidsVideo))

      expect(playbackSource.chapters[1].title).toBe('Sponsor: Joplin ')
      expect(vttText(playbackSource.chaptersSrc).split('\n\n')[2]).toBe('00:00:55.000 --> 00:02:24.000\nSponsor: Joplin')
    })
  })

  describe('an answer for another video', () => {
    it('is unavailable', async () => {
      const other = copy(blenderHls)
      other.body.uuid = blenderWebOnly.body.uuid
      const { layer, fake } = setUp()
      fake.respond(other.url, other)

      expect(await failure(layer.getVideo(refOf(blenderHls)))).toMatchObject({ kind: 'unavailable', host: 'video.blender.org' })
    })

    it('is unavailable from the origin too', async () => {
      const remote = copy(blenderHls)
      remote.url = `https://tilvids.com/api/v1/videos/${BLENDER_UUID}`
      remote.body.isLocal = false
      const other = copy(blenderHls)
      other.body.uuid = blenderWebOnly.body.uuid
      const { layer, fake } = setUp()
      fake.respond(remote.url, remote)
      fake.respond(other.url, other)

      const error = await failure(layer.getVideo({ platform: 'peertube', host: 'tilvids.com', videoId: BLENDER_UUID }))

      expect(error).toMatchObject({ kind: 'unavailable', host: 'video.blender.org' })
    })

    it('matches the uuid whatever its case', async () => {
      const upper = copy(blenderHls)
      upper.body.uuid = BLENDER_UUID.toUpperCase()
      const { layer, fake } = setUp()
      fake.respond(upper.url, upper)

      expect((await layer.getVideo(refOf(blenderHls))).videoId).toBe(BLENDER_UUID)
    })
  })

  describe('a video seen through an instance that is not its origin', () => {
    it('is fetched again from its origin, and answered as the origin has it', async () => {
      // A variant of the blender recording: the same video as tilvids.com
      // would answer for it once federated, with `isLocal: false`
      const remote = copy(blenderHls)
      remote.url = `https://tilvids.com/api/v1/videos/${BLENDER_UUID}`
      remote.body.isLocal = false
      remote.body.name = 'As tilvids.com has it'
      const { layer, fake } = setUp()
      fake.respond(remote.url, remote)

      const video = await layer.getVideo({ platform: 'peertube', host: 'tilvids.com', videoId: BLENDER_UUID })

      expect(video).toMatchObject({
        host: 'video.blender.org',
        videoId: BLENDER_UUID,
        title: 'OVERGROWN: a feature film project by Blender Studio',
      })
      expect(video.playbackSource.storyboard).not.toBeNull()
      expect(fake.urls().filter(url => url.startsWith('https://tilvids.com'))).toEqual([remote.url])
      expect(fake.urls()).toContain(`https://video.blender.org/api/v1/videos/${BLENDER_UUID}`)
    })

    it('finds the origin by the account host when the channel has none', async () => {
      // Variants of the blender recording, as tilvids.com would answer for it
      const remote = copy(blenderHls)
      remote.url = `https://tilvids.com/api/v1/videos/${BLENDER_UUID}`
      remote.body.isLocal = false
      delete remote.body.channel.host
      const { layer, fake } = setUp()
      fake.respond(remote.url, remote)

      expect((await layer.getVideo({ platform: 'peertube', host: 'tilvids.com', videoId: BLENDER_UUID })).host).toBe('video.blender.org')
      expect(fake.urls()).toContain(`https://video.blender.org/api/v1/videos/${BLENDER_UUID}`)
    })

    it('finds the origin by the video URL when neither channel nor account has a host', async () => {
      const remote = copy(blenderHls)
      remote.url = `https://tilvids.com/api/v1/videos/${BLENDER_UUID}`
      remote.body.isLocal = false
      delete remote.body.channel.host
      delete remote.body.account.host
      const { layer, fake } = setUp()
      fake.respond(remote.url, remote)

      expect((await layer.getVideo({ platform: 'peertube', host: 'tilvids.com', videoId: BLENDER_UUID })).host).toBe('video.blender.org')
    })

    it('never goes to an origin that is never PeerTube, whatever the answer names', async () => {
      const remote = copy(blenderHls)
      remote.url = `https://tilvids.com/api/v1/videos/${BLENDER_UUID}`
      remote.body.isLocal = false
      remote.body.channel.host = 'www.youtube.com'
      const { layer, fake } = setUp()
      fake.respond(remote.url, remote)

      const error = await failure(layer.getVideo({ platform: 'peertube', host: 'tilvids.com', videoId: BLENDER_UUID }))

      expect(error.kind).toBe('invalid')
      expect(fake.urls()).toEqual([remote.url])
    })

    it('fails as the origin fails', async () => {
      const remote = copy(blenderHls)
      remote.url = `https://tilvids.com/api/v1/videos/${BLENDER_UUID}`
      remote.body.isLocal = false
      const { layer, fake } = setUp()
      fake.respond(remote.url, remote)
      fake.respond(`https://video.blender.org/api/v1/videos/${BLENDER_UUID}`, { ...blenderNotFound, url: undefined })

      const error = await failure(layer.getVideo({ platform: 'peertube', host: 'tilvids.com', videoId: BLENDER_UUID }))

      expect(error).toMatchObject({ kind: 'notFound', host: 'video.blender.org' })
    })
  })

  describe('refusals and absence', () => {
    const ref = { platform: 'peertube', host: 'peertube.example', videoId: REFUSED_UUID }

    it('refuses a password-protected video, saying so', async () => {
      const { layer } = setUp({ fixtures: [passwordRequired] })

      expect(await failure(layer.getVideo(ref))).toMatchObject({ kind: 'refused', reason: 'password', status: 401 })
    })

    it('refuses on a wrong password, saying why', async () => {
      const { layer } = setUp({ fixtures: [passwordIncorrect] })

      expect(await failure(layer.getVideo(ref))).toMatchObject({ kind: 'refused', reason: 'password', status: 403 })
    })

    it('refuses a private, internal or blocked video without a reason, since the instance gives none', async () => {
      const { layer } = setUp({ fixtures: [privateVideo] })

      expect(await failure(layer.getVideo(ref))).toMatchObject({ kind: 'refused', reason: null, status: 401 })
    })

    it.each([
      ['Cannot get this private video', 'private'],
      ['Cannot get this internal video', 'internal'],
      ['This video is blocked', 'blocked'],
      ['Video is blacklisted', 'blocked'],
      ['Cannot fetch information of private/internal/blocked video', null],
    ])('reads the reason from a detail that names one: %s', async (detail, reason) => {
      // Invented bodies in the shape of the synthesised refusal
      const { layer, fake } = setUp({ fixtures: [] })
      fake.respond(/./, { status: 403, body: { detail, status: 403 } })

      expect(await failure(layer.getVideo(ref))).toMatchObject({ kind: 'refused', reason })
    })

    it('fails as not found for a video that does not exist', async () => {
      const { layer } = setUp({ fixtures: [blenderNotFound] })

      const error = await failure(layer.getVideo({ platform: 'peertube', host: 'video.blender.org', videoId: '0d5c6a3e-9a7b-4f1e-8c2d-3b4a5e6f7a8b' }))

      expect(error).toMatchObject({ kind: 'notFound', status: 404, host: 'video.blender.org' })
    })

    it.each([
      [null],
      ['b29290cc-dc51-4a12-bcb2-2aa5fece7605'],
      [{ platform: 'peertube', host: 'video.blender.org', videoId: 'o3XdtSYTnv2LYxRsf8Mndz' }],
      [{ platform: 'peertube', host: 'https://video.blender.org', videoId: BLENDER_UUID }],
    ])('refuses what is not a PeerTube video ref without a request: %j', async (badRef) => {
      const { layer, fake } = setUp()

      expect(await failure(layer.getVideo(badRef))).toMatchObject({ kind: 'invalid' })
      expect(fake.requests).toHaveLength(0)
    })
  })
})
