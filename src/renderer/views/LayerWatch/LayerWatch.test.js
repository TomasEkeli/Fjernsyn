import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import shaka from 'shaka-player'
import { h } from 'vue'
import { RouterView } from 'vue-router'

import { copyToClipboard, formatScheduledTime, openExternalLink } from '../../helpers/utils'
import { describe as describeEntity } from '../../platform/describe'
import { PlatformError } from '../../platform/errors'
import { PLATFORM_LAYER_KEY, isPeerTubeEnabled } from '../../platform/vue'
import store from '../../store/index'
import { createTestI18n } from '../../testing/i18n'
import { createTestRouter } from '../../testing/router'
import LayerWatch from './LayerWatch.vue'

// The player cannot run in a simulated DOM. The stand-in declares the props
// and events the watch view uses, and plays back what a test tells it. `events`
// is the order in which its position was read, it was destroyed and it was
// unmounted; `destroyGate`, when a test sets it, holds destruction open until
// it resolves
const player = vi.hoisted(() => ({ hasLoaded: false, currentTime: 0, seekedTo: [], paused: false, events: [], destroyGate: undefined }))

vi.mock('../../components/ft-shaka-video-player/ft-shaka-video-player.vue', async () => {
  const { defineComponent, h, onBeforeUnmount } = await import('vue')

  return {
    default: defineComponent({
      name: 'FtShakaVideoPlayer',
      props: {
        format: { type: String, required: true },
        manifestSrc: { type: String, default: null },
        manifestMimeType: { type: String, required: true },
        legacyFormats: { type: Array, default: () => [] },
        startTime: { type: Number, default: null },
        captions: { type: Array, default: () => [] },
        chapters: { type: Array, default: () => [] },
        currentChapterIndex: { type: Number, default: 0 },
        chaptersSrc: { type: String, default: '' },
        storyboardSrc: { type: String, default: '' },
        videoId: { type: String, default: '' },
        channelId: { type: String, default: '' },
        title: { type: String, default: '' },
        thumbnail: { type: String, default: '' },
        theatrePossible: { type: Boolean, default: false },
        useTheatreMode: { type: Boolean, default: false },
        startInFullscreen: { type: Boolean, default: false },
        startInFullwindow: { type: Boolean, default: false },
        startInPip: { type: Boolean, default: false },
        currentPlaybackRate: { type: Number, default: 1 },
        loudnessDb: { type: Number, default: null },
        platform: { type: String, default: 'youtube' },
      },
      // Emitted by the tests, through `vm.$emit`
      // eslint-disable-next-line vue/no-unused-emit-declarations
      emits: ['error', 'loaded', 'ended', 'timeupdate', 'toggle-theatre-mode', 'playback-rate-updated'],
      setup(_props, { expose }) {
        expose({
          get hasLoaded() { return player.hasLoaded },
          getCurrentTime: () => {
            player.events.push('position read')
            return player.currentTime
          },
          setCurrentTime: (seconds) => { player.seekedTo.push(seconds) },
          pause: () => { player.paused = true },
          isPaused: () => player.paused,
          destroyPlayer: async () => {
            await player.destroyGate
            player.events.push('destroyed')
            return { startNextVideoInFullscreen: false, startNextVideoInFullwindow: false, startNextVideoInPip: false }
          },
        })
        onBeforeUnmount(() => { player.events.push('unmounted') })
        return () => h('div', { class: 'fakePlayer' })
      },
    }),
  }
})

// What the view reads of the settings, as the defaults have them
const SETTINGS = vi.hoisted(() => ({
  getRememberHistory: true,
  getWatchedProgressSavingMode: 'auto',
  getHistoryCacheById: {},
  getDefaultViewingMode: 'default',
  getDefaultPlayback: 1,
  getHideChapters: false,
  getHideVideoDescription: false,
  getHideVideoViews: false,
  getHideVideoLikesAndDislikes: false,
  getHideUploader: false,
  getDisableChannelLinks: false,
  getHidePlaylists: false,
  getHideSharingActions: false,
  getExternalPlayer: '',
  // The comments'
  getHideComments: false,
  getHideCommentPhotos: false,
  getCommentAutoLoadEnabled: false,
  getGeneralAutoLoadMorePaginatedItemsEnabled: false,
  // The subscribe button's
  getHideUnsubscribeButton: false,
  getHideChannelSubscriptions: false,
  getUnsubscriptionPopupStatus: false,
  getProfileList: [{ _id: 'allChannels', name: 'All Channels', bgColor: '#000000', textColor: '#FFFFFF', subscriptions: [] }],
  getActiveProfile: { _id: 'allChannels', name: 'All Channels', bgColor: '#000000', textColor: '#FFFFFF', subscriptions: [] },
}))

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return { default: createFakeStore({ getters: { ...SETTINGS } }) }
})

// helpers/utils imports the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

vi.mock('../../i18n/index', async () => {
  const { createTestI18n } = await import('../../testing/i18n')
  return { default: createTestI18n() }
})

vi.mock('../../helpers/utils', async (importOriginal) => ({
  ...(await importOriginal()),
  copyToClipboard: vi.fn(),
  openExternalLink: vi.fn(),
  showToast: vi.fn(),
}))

// Whether PeerTube is switched on is the store's, which the wiring reads; the
// view is mounted without the wiring
vi.mock('../../platform/vue', async (importOriginal) => ({
  ...(await importOriginal()),
  isPeerTubeEnabled: vi.fn(() => true),
}))

const HOST = 'video.blender.org'
const UUID = 'b29290cc-dc51-4a12-bcb2-2aa5fece7605'
const OTHER_UUID = '7243ebe1-8a4c-4d1b-9a4f-0c3a1a0e1f11'
const WATCH_PATH = `/peertube/watch/${HOST}/${UUID}`
const HANDLE = 'blender@video.blender.org'
const AVATAR = 'https://video.blender.org/lazy-static/avatars/blender.png'
const THUMBNAIL = 'https://video.blender.org/lazy-static/previews/sprite-fright.jpg'
const MANIFEST = 'https://video.blender.org/static/streaming-playlists/hls/b29290cc/master.m3u8'
const AUDIO_FILE = 'https://video.blender.org/static/web-videos/b29290cc-0.mp4'

// The history record the old path writes (Watch.js `addToHistory`), by name
const OLD_PATH_HISTORY_FIELDS = [
  'videoId', 'title', 'author', 'authorId', 'published', 'description', 'viewCount',
  'lengthSeconds', 'watchProgress', 'timeWatched', 'isLive', 'type',
]

// A description an instance could send: HTML that the old list card, which
// renders a record's description through the strict sanitiser (it allows
// `<a href>` and `<img src style>`), would make live
const HOSTILE_DESCRIPTION = 'Watch <img src=x style=position:fixed;inset:0 onerror=steal()> & <a href="https://evil.example">win</a> 1 < 2'
const PLAIN_HOSTILE_DESCRIPTION = 'Watch  &amp; win 1 &lt; 2'

const LEGACY_FORMATS = [
  { itag: 1080, qualityLabel: '1080p', fps: 24, bitrate: 4_000_000, mimeType: 'video/mp4', height: 1080, width: 1920, url: 'https://video.blender.org/static/web-videos/b29290cc-1080.mp4' },
  { itag: 720, qualityLabel: '720p', fps: 24, bitrate: 2_000_000, mimeType: 'video/mp4', height: 720, width: 1280, url: 'https://video.blender.org/static/web-videos/b29290cc-720.mp4' },
]

const CAPTIONS = [
  { url: 'https://video.blender.org/lazy-static/video-captions/en.vtt', language: 'en', label: 'English', mimeType: 'text/vtt' },
]

const CHAPTERS = [
  { title: 'Into the woods', timestamp: '0:00', startSeconds: 0, endSeconds: 120 },
  { title: 'The spriggans', timestamp: '2:00', startSeconds: 120, endSeconds: 629 },
]

/**
 * A playable video's details, as the layer answers them
 *
 * @param {object} [overrides] fields of the details
 * @param {object} [sourceOverrides] fields of the playback source
 */
function playableVideo(overrides = {}, sourceOverrides = {}) {
  return {
    type: 'video',
    platform: 'peertube',
    host: HOST,
    videoId: UUID,
    title: 'Sprite Fright',
    author: 'Blender',
    authorId: HANDLE,
    thumbnail: THUMBNAIL,
    lengthSeconds: 629,
    published: Date.UTC(2021, 9, 29),
    viewCount: 12345,
    liveNow: false,
    isUpcoming: false,
    nsfw: false,
    description: 'An *open* movie by the Blender Studio.',
    descriptionKind: 'markdown',
    likeCount: 800,
    dislikeCount: 3,
    tags: ['blender', 'open movie'],
    category: 'Films',
    licence: 'Attribution',
    language: 'English',
    url: `https://${HOST}/w/3TuSBHAVmMRmg5pb1CjRNa`,
    channel: { platform: 'peertube', host: HOST, id: HANDLE, name: 'Blender', thumbnail: AVATAR },
    authorThumbnail: AVATAR,
    commentsEnabled: true,
    downloadEnabled: true,
    liveStatus: null,
    playbackSource: {
      transport: 'manifest',
      manifestUrl: MANIFEST,
      manifestMimeType: 'application/x-mpegurl',
      legacyFormats: LEGACY_FORMATS,
      audio: { manifestUrl: AUDIO_FILE, mimeType: 'video/mp4' },
      captions: CAPTIONS,
      chapters: CHAPTERS,
      chaptersSrc: 'data:text/vtt,WEBVTT',
      storyboard: 'data:text/vtt;charset=utf-8,WEBVTT',
      isLive: false,
      ...sourceOverrides,
    },
    downloadOptions: [],
    ...overrides,
  }
}

/** A live that has not started, or has ended: nothing to play */
function liveVideo(liveStatus, overrides = {}) {
  const { lengthSeconds: _, ...video } = playableVideo({ liveStatus, playbackSource: null, ...overrides })
  return video
}

const layer = {
  getVideo: vi.fn(),
  getComments: vi.fn(),
  getCommentReplies: vi.fn(),
  describe: (entity, options) => describeEntity(entity, {}, options),
}

beforeEach(() => {
  for (const [name, value] of Object.entries(SETTINGS)) {
    store.state.fakeGetterValues[name] = value
  }
  store.dispatched.length = 0

  Object.assign(player, { hasLoaded: false, currentTime: 0, seekedTo: [], paused: false, events: [], destroyGate: undefined })

  layer.getVideo.mockReset()
  layer.getComments.mockReset()
  layer.getCommentReplies.mockReset()
  isPeerTubeEnabled.mockReset().mockReturnValue(true)
  copyToClipboard.mockClear()
  openExternalLink.mockClear()

  window.scrollTo = vi.fn()
})

/** The pages a test opened, closed after it so that none listens on into the next */
const openPages = []

afterEach(() => {
  for (const wrapper of openPages.splice(0)) {
    wrapper.unmount()
  }
})

/**
 * Opens the watch page on a video the layer answers with, as the app would
 * host it: in a router view, with the layer provided
 *
 * @param {object | Error | ((ref: object) => object)} answer the details, or an error to reject with
 * @param {string} [path]
 */
async function openWatchPage(answer, path = WATCH_PATH) {
  layer.getVideo.mockImplementation(async (ref) => {
    const value = typeof answer === 'function' ? answer(ref) : answer
    if (value instanceof Error) {
      throw value
    }
    return value
  })

  const router = createTestRouter([
    { path: '/peertube/watch/:host/:uuid', name: 'peertubeWatch', component: LayerWatch },
    { path: '/peertube/channel/:handle/:currentTab?', name: 'peertubeChannel' },
    { path: '/elsewhere', name: 'elsewhere' },
  ])
  await router.push(path)

  const wrapper = mount({ render: () => h(RouterView) }, {
    global: {
      plugins: [createTestI18n(), router, store],
      provide: { [PLATFORM_LAYER_KEY]: layer },
      directives: { 'observe-visibility': {} },
    },
  })
  openPages.push(wrapper)
  await flushPromises()

  return { wrapper, router }
}

function findPlayer(wrapper) {
  return wrapper.findComponent({ name: 'FtShakaVideoPlayer' })
}

/**
 * @param {import('@vue/test-utils').VueWrapper} wrapper
 * @param {string} title
 */
function findButton(wrapper, title) {
  return wrapper.find(`button[title="${title}"]`)
}

function dispatched(type) {
  return store.dispatched.filter(action => action.type === type).map(action => action.payload)
}

describe('the layer watch page, for a playable video', () => {
  it('asks the layer for the video the route names', async () => {
    await openWatchPage(playableVideo())

    expect(layer.getVideo).toHaveBeenCalledWith({ platform: 'peertube', host: HOST, videoId: UUID })
  })

  it('hands the player the playback source, with the YouTube-only features off', async () => {
    const { wrapper } = await openWatchPage(playableVideo())

    expect(findPlayer(wrapper).props()).toMatchObject({
      format: 'dash',
      manifestSrc: MANIFEST,
      manifestMimeType: 'application/x-mpegurl',
      legacyFormats: LEGACY_FORMATS,
      captions: CAPTIONS,
      chapters: CHAPTERS,
      chaptersSrc: 'data:text/vtt,WEBVTT',
      storyboardSrc: 'data:text/vtt;charset=utf-8,WEBVTT',
      startTime: null,
      videoId: UUID,
      channelId: HANDLE,
      title: 'Sprite Fright',
      thumbnail: THUMBNAIL,
      platform: 'peertube',
      loudnessDb: null,
      currentPlaybackRate: 1,
    })
  })

  it('hands the player empty strings for a video without chapters or a storyboard', async () => {
    const { wrapper } = await openWatchPage(playableVideo({}, { chapters: [], chaptersSrc: null, storyboard: null }))

    expect(findPlayer(wrapper).props()).toMatchObject({ chapters: [], chaptersSrc: '', storyboardSrc: '' })
  })

  it('starts on the legacy formats when the video has no manifest', async () => {
    const { wrapper } = await openWatchPage(playableVideo({}, { manifestUrl: null, manifestMimeType: null }))

    expect(findPlayer(wrapper).props()).toMatchObject({ format: 'legacy', legacyFormats: LEGACY_FORMATS })
  })

  it('shows the title, channel, date, views, likes, dislikes, tags, category, licence and language', async () => {
    const { wrapper } = await openWatchPage(playableVideo())
    const text = wrapper.text()

    expect(wrapper.find('h1').text()).toBe('Sprite Fright')
    expect(text).toContain('Blender')
    expect(text).toContain('Published on')
    expect(text).toContain('2021')
    expect(text).toContain('12,345 views')
    expect(text).toContain('800')
    expect(text).toContain('3')
    expect(text).toContain('blender')
    expect(text).toContain('open movie')
    expect(text).toContain('Films')
    expect(text).toContain('Attribution')
    expect(text).toContain('English')
  })

  it('renders the description from its Markdown', async () => {
    const { wrapper } = await openWatchPage(playableVideo())

    expect(wrapper.find('.layerMarkdown em').text()).toBe('open')
  })

  it('links the channel to its PeerTube channel page, with its avatar', async () => {
    const { wrapper, router } = await openWatchPage(playableVideo())

    expect(wrapper.find(`img[src="${AVATAR}"]`).exists()).toBe(true)

    await wrapper.find('a.channelName').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('peertubeChannel')
    expect(router.currentRoute.value.params.handle).toBe(HANDLE)
  })

  it('subscribes to the video\'s channel, storing its PeerTube stub with the small avatar', async () => {
    const { wrapper } = await openWatchPage(playableVideo())

    await wrapper.find('.subscribeButton').trigger('click')
    await flushPromises()

    expect(dispatched('addChannelToProfiles')).toEqual([{
      channel: { id: HANDLE, name: 'Blender', thumbnail: AVATAR, platform: 'peertube', host: HOST },
      profileIds: ['allChannels'],
    }])
  })

  it('offers no subscribing while PeerTube is switched off', async () => {
    isPeerTubeEnabled.mockReturnValue(false)
    const { wrapper } = await openWatchPage(playableVideo())

    expect(wrapper.find('.subscribeButton').exists()).toBe(false)
  })

  it('copies and opens the canonical PeerTube URL', async () => {
    const { wrapper } = await openWatchPage(playableVideo())

    await findButton(wrapper, 'Copy link').trigger('click')
    await findButton(wrapper, 'Open in browser').trigger('click')

    expect(copyToClipboard).toHaveBeenCalledWith(`https://${HOST}/w/3TuSBHAVmMRmg5pb1CjRNa`, expect.anything())
    expect(openExternalLink).toHaveBeenCalledWith(`https://${HOST}/w/3TuSBHAVmMRmg5pb1CjRNa`)
  })

  it('offers the video to a playlist, in the shape the old path gives it, plus its platform, host and thumbnail', async () => {
    const { wrapper } = await openWatchPage(playableVideo())

    await findButton(wrapper, 'Add to Playlist').trigger('click')

    expect(dispatched('showAddToPlaylistPromptForManyVideos')).toEqual([{
      videos: [{
        videoId: UUID,
        title: 'Sprite Fright',
        author: 'Blender',
        authorId: HANDLE,
        description: 'An *open* movie by the Blender Studio.',
        viewCount: 12345,
        lengthSeconds: 629,
        published: Date.UTC(2021, 9, 29),
        premiereDate: undefined,
        platform: 'peertube',
        host: HOST,
        thumbnail: THUMBNAIL,
      }],
    }])
  })

  it('offers a live to a playlist without a duration, which is how the card knows it for a live', async () => {
    const live = playableVideo({ liveNow: true, liveStatus: 'live', lengthSeconds: undefined }, { isLive: true })
    const { wrapper } = await openWatchPage(live)

    await findButton(wrapper, 'Add to Playlist').trigger('click')

    const [{ videos: [video] }] = dispatched('showAddToPlaylistPromptForManyVideos')
    expect(video.lengthSeconds).toBeUndefined()
  })

  it('offers the description to a playlist as plain text, which no card can turn into HTML', async () => {
    const { wrapper } = await openWatchPage(playableVideo({ description: HOSTILE_DESCRIPTION }))

    await findButton(wrapper, 'Add to Playlist').trigger('click')

    const [{ videos: [video] }] = dispatched('showAddToPlaylistPromptForManyVideos')
    expect(video.description).toBe(PLAIN_HOSTILE_DESCRIPTION)
  })
})

describe('the external player', () => {
  beforeEach(() => {
    window.ftElectron = { openInExternalPlayer: vi.fn() }
    store.state.fakeGetterValues.getExternalPlayer = 'mpv'
  })

  afterEach(() => {
    delete window.ftElectron
  })

  it('starts from where playback is, and pauses the player here', async () => {
    const { wrapper } = await openWatchPage(playableVideo())
    Object.assign(player, { hasLoaded: true, currentTime: 42.5 })

    await findButton(wrapper, 'Open in mpv').trigger('click')

    expect(window.ftElectron.openInExternalPlayer).toHaveBeenCalledWith({
      videoUrl: `https://${HOST}/videos/watch/${UUID}`,
      startTime: 42.5,
      playbackRate: 1,
    })
    expect(player.paused).toBe(true)
  })

  it('starts from the beginning before the player has loaded', async () => {
    const { wrapper } = await openWatchPage(playableVideo())

    await findButton(wrapper, 'Open in mpv').trigger('click')

    expect(window.ftElectron.openInExternalPlayer.mock.calls[0][0].startTime).toBe(0)
  })
})

describe('the format ring', () => {
  it('walks from adaptive to legacy to audio, then says the video cannot be played', async () => {
    const { wrapper } = await openWatchPage(playableVideo())

    findPlayer(wrapper).vm.$emit('error', new Error('adaptive failed'))
    await flushPromises()
    expect(findPlayer(wrapper).props()).toMatchObject({ format: 'legacy', legacyFormats: LEGACY_FORMATS })

    findPlayer(wrapper).vm.$emit('error', new Error('legacy failed'))
    await flushPromises()
    expect(findPlayer(wrapper).props()).toMatchObject({ format: 'audio', manifestSrc: AUDIO_FILE, manifestMimeType: 'video/mp4' })

    findPlayer(wrapper).vm.$emit('error', new Error('audio failed'))
    await flushPromises()
    expect(findPlayer(wrapper).exists()).toBe(false)
    expect(wrapper.text()).toContain('Fjernsyn cannot play this video.')
  })

  it('goes straight to audio when there are no legacy formats', async () => {
    const { wrapper } = await openWatchPage(playableVideo({}, { legacyFormats: [] }))

    findPlayer(wrapper).vm.$emit('error', new Error('adaptive failed'))
    await flushPromises()

    expect(findPlayer(wrapper).props('format')).toBe('audio')
  })

  it('says the video cannot be played when there is neither a legacy format nor audio', async () => {
    const { wrapper } = await openWatchPage(playableVideo({}, { legacyFormats: [], audio: null }))

    findPlayer(wrapper).vm.$emit('error', new Error('adaptive failed'))
    await flushPromises()

    expect(findPlayer(wrapper).exists()).toBe(false)
    expect(wrapper.text()).toContain('Fjernsyn cannot play this video.')
  })

  it('stays on the format while the connection is down, as the player resumes by itself', async () => {
    const { wrapper } = await openWatchPage(playableVideo())
    const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)

    try {
      findPlayer(wrapper).vm.$emit('error', new shaka.util.Error(
        shaka.util.Error.Severity.RECOVERABLE,
        shaka.util.Error.Category.NETWORK,
        shaka.util.Error.Code.HTTP_ERROR,
        MANIFEST,
        new TypeError('Failed to fetch'),
      ))
      await flushPromises()
    } finally {
      offline.mockRestore()
    }

    expect(findPlayer(wrapper).props()).toMatchObject({ format: 'dash', manifestSrc: MANIFEST })
  })

  it('saves the position and destroys the player before the message replaces it, once nothing plays', async () => {
    const { wrapper } = await openWatchPage(playableVideo({}, { legacyFormats: [], audio: null }))
    Object.assign(player, { hasLoaded: true, currentTime: 42.5 })
    let finishDestroying
    player.destroyGate = new Promise(resolve => { finishDestroying = resolve })

    findPlayer(wrapper).vm.$emit('error', new Error('adaptive failed'))
    await flushPromises()

    // Still being destroyed: the message waits for it
    expect(findPlayer(wrapper).exists()).toBe(true)
    expect(dispatched('updateWatchProgress')).toEqual([{ videoId: UUID, watchProgress: 42.5 }])

    finishDestroying()
    await flushPromises()

    expect(player.events).toEqual(['position read', 'destroyed', 'unmounted'])
    expect(findPlayer(wrapper).exists()).toBe(false)
    expect(wrapper.text()).toContain('Fjernsyn cannot play this video.')
  })

  it('plays a video opened while the failed player is still being destroyed', async () => {
    const { wrapper, router } = await openWatchPage(ref => playableVideo({ videoId: ref.videoId }, { legacyFormats: [], audio: null }))
    let finishDestroying
    player.destroyGate = new Promise(resolve => { finishDestroying = resolve })

    findPlayer(wrapper).vm.$emit('error', new Error('adaptive failed'))
    await flushPromises()

    // Leaving waits for the destruction under way rather than starting another
    player.destroyGate = undefined
    const opening = router.push(`/peertube/watch/${HOST}/${OTHER_UUID}`)
    await flushPromises()

    finishDestroying()
    await opening
    await flushPromises()

    expect(findPlayer(wrapper).props()).toMatchObject({ videoId: OTHER_UUID, format: 'dash' })
    expect(wrapper.text()).not.toContain('Fjernsyn cannot play this video.')
  })

  it.each([
    ['another video is opened', `/peertube/watch/${HOST}/${OTHER_UUID}`],
    ['the page is left', '/elsewhere'],
  ])('keeps the position saved at the failure when %s while the failed player is being destroyed', async (_case, path) => {
    const { wrapper, router } = await openWatchPage(ref => playableVideo({ videoId: ref.videoId }, { legacyFormats: [], audio: null }))
    Object.assign(player, { hasLoaded: true, currentTime: 42.5 })
    let finishDestroying
    player.destroyGate = new Promise(resolve => { finishDestroying = resolve })

    findPlayer(wrapper).vm.$emit('error', new Error('adaptive failed'))
    await flushPromises()

    // shaka has unloaded the video by now, so the element reads 0
    player.currentTime = 0
    const leaving = router.push(path)
    await flushPromises()
    finishDestroying()
    await leaving
    await flushPromises()

    expect(dispatched('updateWatchProgress')).toEqual([{ videoId: UUID, watchProgress: 42.5 }])
    // Destroyed once: a second ui.destroy() on a player on its way out
    expect(player.events.filter(event => event === 'destroyed')).toEqual(['destroyed'])
  })

  it('offers to try again once nothing plays, asking the layer afresh', async () => {
    const { wrapper } = await openWatchPage(playableVideo({}, { legacyFormats: [], audio: null }))
    const failedPlayer = findPlayer(wrapper).vm
    findPlayer(wrapper).vm.$emit('error', new Error('adaptive failed'))
    await flushPromises()

    await wrapper.find('.errorRetryButton').trigger('click')
    await flushPromises()

    expect(layer.getVideo).toHaveBeenCalledTimes(2)
    // A fresh player, not the one destroyed
    expect(findPlayer(wrapper).vm).not.toBe(failedPlayer)
    expect(findPlayer(wrapper).props('format')).toBe('dash')
  })

  it('carries on from where playback was', async () => {
    const { wrapper } = await openWatchPage(playableVideo())
    Object.assign(player, { hasLoaded: true, currentTime: 42.5 })

    findPlayer(wrapper).vm.$emit('error', new Error('adaptive failed'))
    await flushPromises()

    expect(findPlayer(wrapper).props('startTime')).toBe(42.5)
  })
})

describe('audio only', () => {
  it('is offered where the video has an audio rendition, and switches to it and back', async () => {
    const { wrapper } = await openWatchPage(playableVideo())

    await findButton(wrapper, 'Audio only').trigger('click')
    expect(findPlayer(wrapper).props()).toMatchObject({ format: 'audio', manifestSrc: AUDIO_FILE, manifestMimeType: 'video/mp4' })

    await findButton(wrapper, 'Play video').trigger('click')
    expect(findPlayer(wrapper).props()).toMatchObject({ format: 'dash', manifestSrc: MANIFEST })
  })

  it('is not offered where there is no audio rendition', async () => {
    const { wrapper } = await openWatchPage(playableVideo({}, { audio: null }))

    expect(findButton(wrapper, 'Audio only').exists()).toBe(false)
  })
})

describe('instead of a broken player', () => {
  it.each([
    ['private', `This video is private on ${HOST}.`],
    ['internal', `This video is only shown to people signed in on ${HOST}.`],
    ['password', 'This video needs a password, which Fjernsyn cannot give yet.'],
    ['blocked', `${HOST} has blocked this video.`],
    [null, `${HOST} refused to show this video.`],
  ])('a video refused as %s says so', async (reason, message) => {
    const { wrapper } = await openWatchPage(new PlatformError('refused', 'refused', { status: 401, reason, host: HOST }))

    expect(findPlayer(wrapper).exists()).toBe(false)
    expect(wrapper.text()).toContain(message)
  })

  it.each([
    ['notFound', {}, `This video does not exist on ${HOST}, or no longer does.`],
    ['unavailable', {}, `Could not reach ${HOST}.`],
    ['rateLimited', { retryAfterMs: 5000 }, `${HOST} is limiting requests, try again in a moment.`],
  ])('a video the layer answers %s for says so', async (kind, details, message) => {
    const { wrapper } = await openWatchPage(new PlatformError(kind, kind, { host: HOST, ...details }))

    expect(findPlayer(wrapper).exists()).toBe(false)
    expect(wrapper.text()).toContain(message)
  })

  it.each([
    ['unavailable', {}],
    ['rateLimited', { retryAfterMs: 5000 }],
  ])('offers to try again when the layer answers %s, and does', async (kind, details) => {
    const { wrapper } = await openWatchPage(new PlatformError(kind, kind, { host: HOST, ...details }))
    layer.getVideo.mockResolvedValue(playableVideo())

    await wrapper.find('.errorRetryButton').trigger('click')
    await flushPromises()

    expect(findPlayer(wrapper).exists()).toBe(true)
  })

  it('a waiting live says when it starts, exactly and relatively', async () => {
    const start = new Date(Date.now() + 3 * 60 * 60 * 1000)
    const { wrapper } = await openWatchPage(liveVideo('waiting', { liveNow: false, isUpcoming: true, premiereDate: start }))

    expect(findPlayer(wrapper).exists()).toBe(false)
    expect(wrapper.text()).toContain('This live has not started yet.')
    expect(wrapper.text()).toContain(`Starts ${formatScheduledTime(start.getTime())}`)
    expect(formatScheduledTime(start.getTime())).toMatch(/\(.+\)$/)
  })

  it('a waiting live without a scheduled time says it has not started', async () => {
    const { wrapper } = await openWatchPage(liveVideo('waiting', { isUpcoming: true }))

    expect(findPlayer(wrapper).exists()).toBe(false)
    expect(wrapper.text()).toContain('This live has not started yet.')
    expect(wrapper.text()).not.toContain('Starts')
  })

  it('an ended live says it has ended', async () => {
    const { wrapper } = await openWatchPage(liveVideo('ended'))

    expect(findPlayer(wrapper).exists()).toBe(false)
    expect(wrapper.text()).toContain('This live has ended.')
    // What it was is still shown
    expect(wrapper.find('h1').text()).toBe('Sprite Fright')
  })

  it('a video with nothing to play says it cannot be played', async () => {
    const { wrapper } = await openWatchPage(playableVideo({ playbackSource: null }))

    expect(findPlayer(wrapper).exists()).toBe(false)
    expect(wrapper.text()).toContain('Fjernsyn cannot play this video.')
  })
})

describe('history', () => {
  it('is written when the player has loaded, with the old path\'s fields plus the platform, host, thumbnail and PeerTube category', async () => {
    const { wrapper } = await openWatchPage(playableVideo())
    expect(dispatched('updateHistory')).toEqual([])

    findPlayer(wrapper).vm.$emit('loaded')
    await flushPromises()

    const [record] = dispatched('updateHistory')
    expect(Object.keys(record).sort()).toEqual(
      [...OLD_PATH_HISTORY_FIELDS, 'platform', 'host', 'thumbnail', 'authorThumbnail', 'peertubeCategory'].sort()
    )
    expect(record).toEqual({
      videoId: UUID,
      title: 'Sprite Fright',
      author: 'Blender',
      authorId: HANDLE,
      published: Date.UTC(2021, 9, 29),
      description: 'An *open* movie by the Blender Studio.',
      viewCount: 12345,
      lengthSeconds: 629,
      watchProgress: 0,
      timeWatched: expect.any(Number),
      isLive: false,
      type: 'video',
      platform: 'peertube',
      host: HOST,
      thumbnail: THUMBNAIL,
      authorThumbnail: AVATAR,
      peertubeCategory: 'Films',
    })
    // YouTube's category field is the profile suggestions', never PeerTube's
    expect(record).not.toHaveProperty('category')
  })

  it('carries no category at all for a PeerTube video without one', async () => {
    const { wrapper } = await openWatchPage(playableVideo({ category: null }))

    findPlayer(wrapper).vm.$emit('loaded')
    await flushPromises()

    const [record] = dispatched('updateHistory')
    expect(record).not.toHaveProperty('category')
    expect(record).not.toHaveProperty('peertubeCategory')
  })

  it('is written once per video, however often the player loads', async () => {
    const { wrapper } = await openWatchPage(playableVideo())

    findPlayer(wrapper).vm.$emit('loaded')
    findPlayer(wrapper).vm.$emit('loaded')
    await flushPromises()

    expect(dispatched('updateHistory')).toHaveLength(1)
  })

  it('keeps the progress already stored, or takes the timestamp asked for', async () => {
    store.setGetter('getHistoryCacheById', { [UUID]: { videoId: UUID, watchProgress: 100 } })
    const stored = await openWatchPage(playableVideo())
    findPlayer(stored.wrapper).vm.$emit('loaded')

    const asked = await openWatchPage(playableVideo(), `${WATCH_PATH}?timestamp=30`)
    findPlayer(asked.wrapper).vm.$emit('loaded')
    await flushPromises()

    expect(dispatched('updateHistory').map(record => record.watchProgress)).toEqual([100, 30])
  })

  it('holds the description as plain text, which the old list card cannot turn into HTML', async () => {
    const { wrapper } = await openWatchPage(playableVideo({ description: HOSTILE_DESCRIPTION }))

    findPlayer(wrapper).vm.$emit('loaded')
    await flushPromises()

    const [record] = dispatched('updateHistory')
    expect(record.description).toBe(PLAIN_HOSTILE_DESCRIPTION)
  })

  it('holds a live\'s length as a number, as the old path does', async () => {
    const live = playableVideo({ liveNow: true, liveStatus: 'live', lengthSeconds: undefined }, { isLive: true })
    const { wrapper } = await openWatchPage(live)

    findPlayer(wrapper).vm.$emit('loaded')
    await flushPromises()

    expect(dispatched('updateHistory')[0].lengthSeconds).toBe(0)
  })

  it('is not written when history is not remembered', async () => {
    store.setGetter('getRememberHistory', false)
    const { wrapper } = await openWatchPage(playableVideo())

    findPlayer(wrapper).vm.$emit('loaded')
    await flushPromises()

    expect(dispatched('updateHistory')).toEqual([])
  })
})

describe('resuming', () => {
  it('starts from the position stored in history', async () => {
    store.setGetter('getHistoryCacheById', { [UUID]: { videoId: UUID, watchProgress: 100 } })
    const { wrapper } = await openWatchPage(playableVideo())

    expect(findPlayer(wrapper).props('startTime')).toBe(100)
  })

  it('starts from the timestamp asked for, before the stored position', async () => {
    store.setGetter('getHistoryCacheById', { [UUID]: { videoId: UUID, watchProgress: 100 } })
    const { wrapper } = await openWatchPage(playableVideo(), `${WATCH_PATH}?timestamp=30`)

    expect(findPlayer(wrapper).props('startTime')).toBe(30)
  })

  it('starts from the beginning of a video watched to its end', async () => {
    store.setGetter('getHistoryCacheById', { [UUID]: { videoId: UUID, watchProgress: 628 } })
    const { wrapper } = await openWatchPage(playableVideo())

    expect(findPlayer(wrapper).props('startTime')).toBeNull()
  })

  it('does not read a stored position while saving progress is switched off', async () => {
    store.setGetter('getHistoryCacheById', { [UUID]: { videoId: UUID, watchProgress: 100 } })
    store.setGetter('getWatchedProgressSavingMode', 'never')
    const { wrapper } = await openWatchPage(playableVideo())

    expect(findPlayer(wrapper).props('startTime')).toBeNull()
  })
})

describe('saving the watch position', () => {
  it('saves it on leaving the page', async () => {
    const { router } = await openWatchPage(playableVideo())
    Object.assign(player, { hasLoaded: true, currentTime: 55 })

    await router.push('/elsewhere')
    await flushPromises()

    expect(dispatched('updateWatchProgress')).toEqual([{ videoId: UUID, watchProgress: 55 }])
  })

  it('saves it when the page is unmounted', async () => {
    const { wrapper } = await openWatchPage(playableVideo())
    Object.assign(player, { hasLoaded: true, currentTime: 55 })

    openPages.splice(openPages.indexOf(wrapper), 1)
    wrapper.unmount()

    expect(dispatched('updateWatchProgress')).toEqual([{ videoId: UUID, watchProgress: 55 }])
  })

  it('saves it when the window is closed', async () => {
    await openWatchPage(playableVideo())
    Object.assign(player, { hasLoaded: true, currentTime: 12 })

    window.dispatchEvent(new Event('beforeunload'))

    expect(dispatched('updateWatchProgress')).toEqual([{ videoId: UUID, watchProgress: 12 }])
  })

  it('saves it for the video left when another one is opened, and opens that one', async () => {
    const { wrapper, router } = await openWatchPage(ref => playableVideo({ videoId: ref.videoId }))
    Object.assign(player, { hasLoaded: true, currentTime: 55 })

    await router.push(`/peertube/watch/${HOST}/${OTHER_UUID}`)
    await flushPromises()

    expect(dispatched('updateWatchProgress')).toEqual([{ videoId: UUID, watchProgress: 55 }])
    expect(layer.getVideo).toHaveBeenLastCalledWith({ platform: 'peertube', host: HOST, videoId: OTHER_UUID })
    expect(findPlayer(wrapper).props('videoId')).toBe(OTHER_UUID)
  })

  it('does not save it automatically unless saving is automatic', async () => {
    store.setGetter('getWatchedProgressSavingMode', 'semi-auto')
    const { router } = await openWatchPage(playableVideo())
    Object.assign(player, { hasLoaded: true, currentTime: 55 })

    await router.push('/elsewhere')
    await flushPromises()

    expect(dispatched('updateWatchProgress')).toEqual([])
  })

  it('saves it at the end of the video unless saving is switched off', async () => {
    store.setGetter('getWatchedProgressSavingMode', 'semi-auto')
    const { wrapper } = await openWatchPage(playableVideo())
    Object.assign(player, { hasLoaded: true, currentTime: 629 })

    findPlayer(wrapper).vm.$emit('ended')

    expect(dispatched('updateWatchProgress')).toEqual([{ videoId: UUID, watchProgress: 629 }])
  })

  it('does not save it for a live', async () => {
    const live = playableVideo({ liveNow: true, liveStatus: 'live', lengthSeconds: undefined }, { isLive: true })
    const { router } = await openWatchPage(live)
    Object.assign(player, { hasLoaded: true, currentTime: 55 })

    await router.push('/elsewhere')
    await flushPromises()

    expect(dispatched('updateWatchProgress')).toEqual([])
  })
})

describe('chapters and theatre mode', () => {
  it('lists the chapters, and a click on one seeks the player there', async () => {
    const { wrapper } = await openWatchPage(playableVideo())
    player.hasLoaded = true

    const chapters = wrapper.findAll('.chapter')
    expect(chapters.map(chapter => chapter.find('.chapterTitle').text())).toEqual(['Into the woods', 'The spriggans'])

    await chapters[1].trigger('click')

    expect(player.seekedTo).toEqual([120])
  })

  it('hides the chapters everywhere when chapters are hidden, and theatre mode with them', async () => {
    store.setGetter('getHideChapters', true)
    const { wrapper } = await openWatchPage(playableVideo())

    expect(wrapper.find('.chapter').exists()).toBe(false)
    expect(findPlayer(wrapper).props()).toMatchObject({ chapters: [], chaptersSrc: '', theatrePossible: false })
  })

  it('follows the current chapter as the video plays', async () => {
    const { wrapper } = await openWatchPage(playableVideo())

    findPlayer(wrapper).vm.$emit('timeupdate', 130)
    await flushPromises()

    expect(findPlayer(wrapper).props('currentChapterIndex')).toBe(1)
  })

  it('starts in theatre mode when that is the default, and toggles it from the player', async () => {
    store.setGetter('getDefaultViewingMode', 'theatre')
    const { wrapper } = await openWatchPage(playableVideo())

    expect(findPlayer(wrapper).props()).toMatchObject({ theatrePossible: true, useTheatreMode: true })

    findPlayer(wrapper).vm.$emit('toggle-theatre-mode')
    await flushPromises()

    expect(findPlayer(wrapper).props('useTheatreMode')).toBe(false)
  })

  it('follows the playback rate the player reports', async () => {
    const { wrapper } = await openWatchPage(playableVideo())

    findPlayer(wrapper).vm.$emit('playback-rate-updated', 1.5)
    await flushPromises()

    expect(findPlayer(wrapper).props('currentPlaybackRate')).toBe(1.5)
  })
})

describe('comments', () => {
  it('are offered below the description, and load from the video\'s ref when asked', async () => {
    layer.getComments.mockResolvedValue({
      items: [{ id: 1, threadId: 1, text: 'Lovely *film*', textKind: 'markdown', author: 'Alice', authorAccount: `alice@${HOST}`, authorThumbnail: '', createdAt: Date.now(), isDeleted: false, replyCount: 0 }],
      cursor: null,
    })
    const { wrapper } = await openWatchPage(playableVideo())
    expect(layer.getComments).not.toHaveBeenCalled()

    await wrapper.find('.getCommentsTitle').trigger('click')
    await flushPromises()

    expect(layer.getComments).toHaveBeenCalledWith({ platform: 'peertube', host: HOST, videoId: UUID }, { cursor: null })
    expect(wrapper.find('.comment .commentText em').text()).toBe('film')
  })

  it('say they are turned off when the video has them off', async () => {
    const { wrapper } = await openWatchPage(playableVideo({ commentsEnabled: false }))

    expect(wrapper.text()).toContain('Comments are turned off')
    expect(wrapper.find('.getCommentsTitle').exists()).toBe(false)
  })

  it('are not shown for a live that is live, as the old watch page does not show them', async () => {
    const live = playableVideo({ liveNow: true, liveStatus: 'live', lengthSeconds: undefined }, { isLive: true })
    const { wrapper } = await openWatchPage(live)

    expect(wrapper.find('.getCommentsTitle').exists()).toBe(false)
  })

  it('are not shown when comments are hidden', async () => {
    store.setGetter('getHideComments', true)
    const { wrapper } = await openWatchPage(playableVideo())

    expect(wrapper.find('.getCommentsTitle').exists()).toBe(false)
  })
})

describe('the download button', () => {
  const OPTIONS = [
    { id: '1080', label: '1080p', resolution: 1080, height: 1080, sizeBytes: 1_000_000, url: `https://${HOST}/download/web-videos/${UUID}-1080.mp4`, kind: 'muxed' },
  ]

  beforeEach(() => {
    window.ftElectron = { peerTubeDownload: vi.fn() }
  })

  afterEach(() => {
    delete window.ftElectron
  })

  it('is among the video\'s actions when it has download options, and downloads the best', async () => {
    const { wrapper } = await openWatchPage(playableVideo({ downloadOptions: OPTIONS }))

    await wrapper.find('.layerDownloadButton button').trigger('click')

    expect(window.ftElectron.peerTubeDownload).toHaveBeenCalledWith({
      key: `peertube:${HOST}:${UUID}`,
      url: OPTIONS[0].url,
      title: 'Sprite Fright',
      label: '1080p',
      resolution: 1080,
      audioOnly: false,
      videoUrl: `https://${HOST}/w/3TuSBHAVmMRmg5pb1CjRNa`,
    })
  })

  it('is not there without download options', async () => {
    const { wrapper } = await openWatchPage(playableVideo({ downloadOptions: [] }))

    expect(wrapper.find('.layerDownloadButton').exists()).toBe(false)
  })
})
