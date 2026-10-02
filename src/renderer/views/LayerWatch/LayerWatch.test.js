import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import shaka from 'shaka-player'
import { h } from 'vue'
import { RouterView } from 'vue-router'

import { SabrGiveUpError } from '../../helpers/player/SabrRegulator'
import { copyToClipboard, formatScheduledTime, openExternalLink, showToast } from '../../helpers/utils'
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
        delayLoadUntilUnix: { type: Number, default: 0 },
        vrProjection: { type: String, default: null },
        platform: { type: String, default: 'youtube' },
        sabrData: { type: Object, default: null },
        sabrRegulator: { type: Object, default: null },
      },
      // Emitted by the tests, through `vm.$emit`
      // eslint-disable-next-line vue/no-unused-emit-declarations
      emits: ['error', 'loaded', 'ended', 'timeupdate', 'toggle-theatre-mode', 'playback-rate-updated', 'sabr-refresh-requested', 'player-reload-requested'],
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

// The regulator is the player's to drive, which the stand-in does not; what
// the page does with it is hand it over, and reset it
const regulators = vi.hoisted(() => [])

vi.mock('../../helpers/player/SabrRegulator', async (importOriginal) => ({
  ...(await importOriginal()),
  createSabrRegulator: vi.fn(() => {
    const regulator = { reset: vi.fn() }
    regulators.push(regulator)
    return regulator
  }),
}))

// What the view reads of the settings, as the defaults have them
const SETTINGS = vi.hoisted(() => ({
  getRememberHistory: true,
  getWatchedProgressSavingMode: 'auto',
  getHistoryCacheById: {},
  getDefaultViewingMode: 'default',
  getDefaultPlayback: 1,
  getHideChapters: false,
  getHideVideoDescription: false,
  getShowFamilyFriendlyOnly: false,
  getHideVideoViews: false,
  getHideVideoLikesAndDislikes: false,
  getHideUploader: false,
  getDisableChannelLinks: false,
  getHidePlaylists: false,
  getHideSharingActions: false,
  getExternalPlayer: '',
  getYtDlpEnabled: true,
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
  regulators.length = 0

  layer.getVideo.mockReset()
  layer.getComments.mockReset()
  layer.getCommentReplies.mockReset()
  isPeerTubeEnabled.mockReset().mockReturnValue(true)
  copyToClipboard.mockClear()
  openExternalLink.mockClear()
  showToast.mockClear()

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
    // As upstream's watch route, which has no name
    { path: '/watch/:id', component: LayerWatch },
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
      delayLoadUntilUnix: 0,
      vrProjection: null,
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

describe('a PeerTube video\'s download button', () => {
  it('is the instance\'s, never yt-dlp\'s', async () => {
    const { wrapper } = await openWatchPage(playableVideo({ downloadOptions: [{ id: '1080', label: '1080p', resolution: 1080, height: 1080, sizeBytes: 1, url: `https://${HOST}/download/x.mp4`, kind: 'muxed' }] }))

    expect(wrapper.find('.layerDownloadButton').exists()).toBe(true)
    expect(wrapper.find('.ytDlpDownloadButton').exists()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// YouTube, on upstream's `/watch/:id` route
// ---------------------------------------------------------------------------

const YT_ID = 'dQw4w9WgXcQ'
const YT_PATH = `/watch/${YT_ID}`
const YT_CHANNEL = 'UCuAXFkgsw1L7xaCfnd5JJOw'
const YT_AVATAR = 'https://yt3.ggpht.com/rick=s48-c-k-c0x00ffffff-no-rj'
const YT_THUMBNAIL = `https://i.ytimg.com/vi/${YT_ID}/maxresdefault.jpg`
const DASH_MANIFEST = 'data:application/dash+xml;charset=UTF-8,%3CMPD%2F%3E'
const HLS_LIVE = 'https://manifest.googlevideo.com/api/manifest/hls_variant/id/live/file/index.m3u8'
const SABR_MANIFEST = 'data:application/sabr+json,%7B%7D'

const YT_LEGACY_FORMATS = [
  { itag: 18, qualityLabel: '360p', fps: 25, bitrate: 500_000, mimeType: 'video/mp4', height: 360, width: 640, url: 'https://rr1---sn.googlevideo.com/videoplayback?itag=18' },
]

const YT_CAPTIONS = [
  { url: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en', language: 'en', label: 'English', mimeType: 'text/vtt' },
]

const YT_CHAPTERS = [
  { title: 'Intro', timestamp: '0:00', startSeconds: 0, endSeconds: 43 },
  { title: 'Chorus', timestamp: '0:43', startSeconds: 43, endSeconds: 213 },
]

/**
 * A YouTube video's details, as the layer answers them over DASH
 *
 * @param {object} [overrides] fields of the details
 * @param {object} [sourceOverrides] fields of the playback source
 */
function youtubeVideo(overrides = {}, sourceOverrides = {}) {
  return {
    type: 'video',
    videoId: YT_ID,
    title: 'Never Gonna Give You Up',
    author: 'Rick Astley',
    authorId: YT_CHANNEL,
    thumbnail: YT_THUMBNAIL,
    lengthSeconds: 213,
    published: Date.UTC(2009, 9, 25),
    viewCount: 1_500_000_000,
    liveNow: false,
    isUpcoming: false,
    description: 'The official video, <a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=43s">0:43</a> the chorus',
    descriptionKind: 'html',
    likeCount: 18_000_000,
    dislikeCount: null,
    tags: ['rick astley'],
    category: 'Music',
    licence: null,
    language: null,
    url: `https://www.youtube.com/watch?v=${YT_ID}`,
    channel: { id: YT_CHANNEL, name: 'Rick Astley', thumbnail: YT_AVATAR, subscriberCount: 4_000_000 },
    authorThumbnail: YT_AVATAR,
    commentsEnabled: null,
    downloadEnabled: false,
    liveStatus: null,
    isUnlisted: false,
    isFamilyFriendly: true,
    related: [],
    chaptersKind: 'chapters',
    playbackSource: {
      transport: 'manifest',
      manifestUrl: DASH_MANIFEST,
      manifestMimeType: 'application/dash+xml',
      legacyFormats: YT_LEGACY_FORMATS,
      audio: { manifestUrl: DASH_MANIFEST, mimeType: 'application/dash+xml' },
      captions: YT_CAPTIONS,
      chapters: YT_CHAPTERS,
      chaptersSrc: 'data:text/vtt,WEBVTT%20chapters',
      storyboard: 'data:text/vtt;charset=utf-8,WEBVTT%20storyboard',
      isLive: false,
      loudnessDb: -7.5,
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
      vrProjection: null,
      isPostLiveDvr: false,
      ...sourceOverrides,
    },
    downloadOptions: [],
    ...overrides,
  }
}

/** A player error for an HTTP status answered for a media request */
function badStatus(status) {
  const { Severity, Category, Code } = shaka.util.Error
  return new shaka.util.Error(Severity.CRITICAL, Category.NETWORK, Code.BAD_HTTP_STATUS, 'https://rr1---sn.googlevideo.com/videoplayback', status)
}

/** A player error for the media element failing to play what it was given */
function videoError() {
  const { Severity, Category, Code } = shaka.util.Error
  return new shaka.util.Error(Severity.CRITICAL, Category.MEDIA, Code.VIDEO_ERROR)
}

/** A YouTube live that is live, over HLS: no legacy formats, no audio only */
function youtubeLive() {
  const { lengthSeconds: _, ...video } = youtubeVideo({ liveNow: true, liveStatus: 'live' }, {
    manifestUrl: HLS_LIVE,
    manifestMimeType: 'application/x-mpegurl',
    legacyFormats: [],
    audio: null,
    chapters: [],
    chaptersSrc: null,
    storyboard: null,
    isLive: true,
  })
  return video
}

describe('a YouTube video', () => {
  it('is asked of the layer by the id the watch route names', async () => {
    await openWatchPage(youtubeVideo(), YT_PATH)

    expect(layer.getVideo).toHaveBeenCalledWith(YT_ID)
  })

  it('is not asked for when the route names no YouTube id', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo(), '/watch/not-an-id')

    expect(layer.getVideo).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('This video does not exist on YouTube, or no longer does.')
  })

  it('hands the player its DASH manifest and everything around it', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo(), YT_PATH)

    expect(findPlayer(wrapper).props()).toMatchObject({
      format: 'dash',
      manifestSrc: DASH_MANIFEST,
      manifestMimeType: 'application/dash+xml',
      legacyFormats: YT_LEGACY_FORMATS,
      captions: YT_CAPTIONS,
      chapters: YT_CHAPTERS,
      chaptersSrc: 'data:text/vtt,WEBVTT%20chapters',
      storyboardSrc: 'data:text/vtt;charset=utf-8,WEBVTT%20storyboard',
      startTime: null,
      videoId: YT_ID,
      channelId: YT_CHANNEL,
      title: 'Never Gonna Give You Up',
      thumbnail: YT_THUMBNAIL,
      platform: 'youtube',
    })
  })

  it('starts on the legacy formats when it has no manifest', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo({}, { manifestUrl: null, manifestMimeType: null, audio: null }), YT_PATH)

    expect(findPlayer(wrapper).props()).toMatchObject({ format: 'legacy', legacyFormats: YT_LEGACY_FORMATS })
    expect(findButton(wrapper, 'Audio only').exists()).toBe(false)
  })

  it('plays a live from its HLS manifest, from the live edge', async () => {
    store.setGetter('getHistoryCacheById', { [YT_ID]: { videoId: YT_ID, watchProgress: 100 } })
    const { wrapper } = await openWatchPage(youtubeLive(), `${YT_PATH}?timestamp=30`)

    expect(findPlayer(wrapper).props()).toMatchObject({
      format: 'dash',
      manifestSrc: HLS_LIVE,
      manifestMimeType: 'application/x-mpegurl',
      legacyFormats: [],
      startTime: null,
    })
  })

  it('plays a recording of an ended live, which YouTube serves', async () => {
    const recording = youtubeVideo({ liveStatus: 'ended' }, { manifestUrl: HLS_LIVE, manifestMimeType: 'application/x-mpegurl', legacyFormats: [], audio: null, isPostLiveDvr: true })
    const { wrapper } = await openWatchPage(recording, YT_PATH)

    expect(findPlayer(wrapper).props()).toMatchObject({ format: 'dash', manifestSrc: HLS_LIVE })
    expect(wrapper.text()).not.toContain('This live has ended.')
  })

  it('hands the player no regulator and no credentials over DASH', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo(), YT_PATH)

    expect(findPlayer(wrapper).props()).toMatchObject({ sabrData: null, sabrRegulator: null })
  })

  describe('over SABR', () => {
    const SABR_DATA = { url: 'https://rr1---sn.googlevideo.com/sabr', videoId: YT_ID, poToken: 'token', ustreamerConfig: 'config', clientInfo: {} }

    function sabrVideo() {
      return youtubeVideo({}, {
        transport: 'sabr',
        manifestUrl: SABR_MANIFEST,
        manifestMimeType: 'application/sabr+json',
        audio: { manifestUrl: SABR_MANIFEST, mimeType: 'application/sabr+json' },
        sabrData: SABR_DATA,
        sabrStoryboards: [],
        renew: vi.fn(),
      })
    }

    function transportError(cause) {
      const { Severity, Category, Code } = shaka.util.Error
      return new shaka.util.Error(Severity.CRITICAL, Category.NETWORK, Code.HTTP_ERROR, 'sabr://segment', cause)
    }

    it('hands the player its SABR manifest, the credentials and the page\'s one regulator', async () => {
      const { wrapper, router } = await openWatchPage(sabrVideo(), YT_PATH)

      expect(findPlayer(wrapper).props()).toMatchObject({
        format: 'dash',
        manifestSrc: SABR_MANIFEST,
        manifestMimeType: 'application/sabr+json',
        sabrData: SABR_DATA,
        sabrRegulator: regulators[0],
        legacyFormats: YT_LEGACY_FORMATS,
        captions: YT_CAPTIONS,
      })

      await findButton(wrapper, 'Audio only').trigger('click')
      expect(findPlayer(wrapper).props()).toMatchObject({ format: 'audio', manifestSrc: SABR_MANIFEST, sabrRegulator: regulators[0] })

      // The same regulator for the next video, as the page outlives the player
      await router.push(`/watch/${YT_ID}?timestamp=10`)
      await flushPromises()
      expect(regulators).toHaveLength(1)
      expect(findPlayer(wrapper).props('sabrRegulator')).toBe(regulators[0])
    })

    it('answers the player\'s rebuild through renew, and plays the rebuilt manifest from then on', async () => {
      const video = sabrVideo()
      video.playbackSource.renew.mockResolvedValue({
        sabrData: { ...SABR_DATA, poToken: 'fresh' },
        formatIds: [],
        expiresAt: null,
        manifestUrl: 'data:application/sabr+json,rebuilt',
        manifestMimeType: 'application/sabr+json',
      })
      const { wrapper } = await openWatchPage(video, YT_PATH)
      const onResult = vi.fn()

      findPlayer(wrapper).vm.$emit('sabr-refresh-requested', { onResult, rebuilding: true })
      await flushPromises()

      expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ manifestSrc: 'data:application/sabr+json,rebuilt' }))
      expect(findPlayer(wrapper).props()).toMatchObject({ manifestSrc: 'data:application/sabr+json,rebuilt', sabrData: { ...SABR_DATA, poToken: 'fresh' } })
    })

    it('tries only the legacy formats once the SABR transport has failed', async () => {
      const { wrapper } = await openWatchPage(sabrVideo(), YT_PATH)

      findPlayer(wrapper).vm.$emit('error', transportError(new Error('refused')))
      await flushPromises()
      expect(findPlayer(wrapper).props('format')).toBe('legacy')

      // Not audio, which is the same session
      findPlayer(wrapper).vm.$emit('error', new Error('legacy failed'))
      await flushPromises()
      expect(findPlayer(wrapper).exists()).toBe(false)
      expect(wrapper.text()).toContain('Fjernsyn cannot play this video.')
    })

    it('says why it cannot play at the end of the ladder, as the old watch page does, without the format ring, and trying again starts the ladder afresh', async () => {
      const { wrapper } = await openWatchPage(sabrVideo(), YT_PATH)
      regulators[0].reset.mockClear()

      findPlayer(wrapper).vm.$emit('error', transportError(new SabrGiveUpError()))
      await flushPromises()

      expect(findPlayer(wrapper).exists()).toBe(false)
      expect(wrapper.text()).toContain('YouTube is not serving this video to the current session (PO token rejected). Trying again sometimes works, otherwise wait a while or switch networks.')

      await wrapper.find('.errorRetryButton').trigger('click')
      await flushPromises()

      expect(regulators[0].reset).toHaveBeenCalledTimes(1)
      expect(findPlayer(wrapper).props('format')).toBe('dash')
    })

    it('reloads the page when the ladder asks, from where playback was, keeping the ladder\'s budgets', async () => {
      const { wrapper } = await openWatchPage(sabrVideo(), YT_PATH)
      const asking = findPlayer(wrapper).vm
      Object.assign(player, { hasLoaded: true, currentTime: 42.5 })
      regulators[0].reset.mockClear()

      asking.$emit('player-reload-requested', 'the session reload failed')
      await flushPromises()

      expect(layer.getVideo).toHaveBeenCalledTimes(2)
      expect(player.events).toContain('destroyed')
      expect(findPlayer(wrapper).vm).not.toBe(asking)
      expect(findPlayer(wrapper).props('startTime')).toBe(42)
      expect(regulators[0].reset).not.toHaveBeenCalled()
      expect(showToast).toHaveBeenCalledWith('Reloading player: the session reload failed')
    })

    it('reads a 403 against the expiry of the session renewed since, not the source\'s', async () => {
      const video = sabrVideo()
      const expired = youtubeVideo({}, { ...video.playbackSource, expiresAt: new Date(Date.now() - 1000) })
      expired.playbackSource.renew.mockResolvedValue({ sabrData: SABR_DATA, formatIds: [], expiresAt: new Date(Date.now() + 60 * 60 * 1000) })
      const { wrapper } = await openWatchPage(expired, YT_PATH)

      findPlayer(wrapper).vm.$emit('sabr-refresh-requested', { onResult: vi.fn(), rebuilding: false })
      await flushPromises()
      findPlayer(wrapper).vm.$emit('error', badStatus(403))
      await flushPromises()

      expect(wrapper.text()).toContain('[BAD_HTTP_STATUS: 403] Potential causes: IP block, streaming URL deciphering failed or music video geo-block')
    })
  })

  it('shows its description\'s markup, its timestamps seeking the player', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo(), YT_PATH)
    player.hasLoaded = true

    const timestamp = wrapper.find('.videoDescription a[data-time="43"]')
    expect(timestamp.exists()).toBe(true)
    await timestamp.trigger('click')

    expect(player.seekedTo).toEqual([43])
  })

  describe('in history', () => {
    it('is written key for key as the old watch page writes it, its YouTube category included', async () => {
      const { wrapper } = await openWatchPage(youtubeVideo(), YT_PATH)

      findPlayer(wrapper).vm.$emit('loaded')
      await flushPromises()

      const [record] = dispatched('updateHistory')
      expect(Object.keys(record).sort()).toEqual([...OLD_PATH_HISTORY_FIELDS, 'category'].sort())
      expect(record).toEqual({
        videoId: YT_ID,
        title: 'Never Gonna Give You Up',
        author: 'Rick Astley',
        authorId: YT_CHANNEL,
        published: Date.UTC(2009, 9, 25),
        description: 'The official video, 0:43 the chorus',
        viewCount: 1_500_000_000,
        lengthSeconds: 213,
        watchProgress: 0,
        timeWatched: expect.any(Number),
        isLive: false,
        type: 'video',
        category: 'Music',
      })
    })

    it('carries no category where YouTube gave none, as the old watch page leaves it out', async () => {
      const { wrapper } = await openWatchPage(youtubeVideo({ category: null }), YT_PATH)

      findPlayer(wrapper).vm.$emit('loaded')
      await flushPromises()

      expect(Object.keys(dispatched('updateHistory')[0]).sort()).toEqual([...OLD_PATH_HISTORY_FIELDS].sort())
    })

    it('holds a live\'s length as 0, as the old watch page does', async () => {
      const { wrapper } = await openWatchPage(youtubeLive(), YT_PATH)

      findPlayer(wrapper).vm.$emit('loaded')
      await flushPromises()

      expect(dispatched('updateHistory')[0].lengthSeconds).toBe(0)
    })
  })

  describe('its subscription', () => {
    it('takes the channel\'s current name and avatar, as the old watch page asks on every load', async () => {
      await openWatchPage(youtubeVideo(), YT_PATH)

      expect(dispatched('updateSubscriptionDetails')).toEqual([{
        channelThumbnailUrl: YT_AVATAR,
        channelName: 'Rick Astley',
        channelId: YT_CHANNEL,
      }])
    })

    it('keeps its avatar when the channel has none to give', async () => {
      await openWatchPage(youtubeVideo({ authorThumbnail: '' }), YT_PATH)

      expect(dispatched('updateSubscriptionDetails')[0].channelThumbnailUrl).toBeNull()
    })

    it('is left alone for a PeerTube video, as before', async () => {
      await openWatchPage(playableVideo())

      expect(dispatched('updateSubscriptionDetails')).toEqual([])
    })
  })

  describe('its download button', () => {
    beforeEach(() => {
      window.ftElectron = { ytDlpDownload: vi.fn() }
    })

    afterEach(() => {
      delete window.ftElectron
    })

    it('is yt-dlp\'s, and downloads the video by its id', async () => {
      const { wrapper } = await openWatchPage(youtubeVideo(), YT_PATH)

      expect(wrapper.find('.layerDownloadButton').exists()).toBe(false)
      await wrapper.find('.ytDlpDownloadButton button').trigger('click')

      expect(window.ftElectron.ytDlpDownload).toHaveBeenCalledWith({ videoId: YT_ID, title: 'Never Gonna Give You Up', quality: 'best', fresh: false })
    })

    it('is not there for a live, which has no end to download', async () => {
      const { wrapper } = await openWatchPage(youtubeLive(), YT_PATH)

      expect(wrapper.find('.ytDlpDownloadButton').exists()).toBe(false)
    })
  })

  describe('in the external player', () => {
    beforeEach(() => {
      window.ftElectron = { openInExternalPlayer: vi.fn() }
      store.state.fakeGetterValues.getExternalPlayer = 'mpv'
    })

    afterEach(() => {
      delete window.ftElectron
    })

    it('is handed over by its id from where playback is, and marked watched, as the old watch page does', async () => {
      const { wrapper } = await openWatchPage(youtubeVideo(), YT_PATH)
      Object.assign(player, { hasLoaded: true, currentTime: 42.5 })

      await findButton(wrapper, 'Open in mpv').trigger('click')

      expect(window.ftElectron.openInExternalPlayer).toHaveBeenCalledWith({ videoId: YT_ID, startTime: 42.5, playbackRate: 1 })
      expect(player.paused).toBe(true)
      expect(dispatched('updateHistory')).toEqual([expect.objectContaining({ videoId: YT_ID, watchProgress: 0, category: 'Music' })])
      expect(showToast).toHaveBeenCalledWith('Video has been marked as watched')
    })

    it('leaves a PeerTube video unmarked, as before', async () => {
      const { wrapper } = await openWatchPage(playableVideo())

      await findButton(wrapper, 'Open in mpv').trigger('click')

      expect(dispatched('updateHistory')).toEqual([])
    })
  })
})

describe('what the layer answers of a YouTube video, passed on', () => {
  it('hands the player its loudness, the end of the ad it waits out and its VR projection', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo({}, { delayLoadUntilMs: 1_790_000_012_345, vrProjection: 'EQUIRECTANGULAR' }), YT_PATH)

    expect(findPlayer(wrapper).props()).toMatchObject({
      loudnessDb: -7.5,
      delayLoadUntilUnix: 1_790_000_012_345,
      vrProjection: 'EQUIRECTANGULAR',
    })
  })

  it('hands the player a measured loudness of 0 as it is', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo({}, { loudnessDb: 0 }), YT_PATH)

    expect(findPlayer(wrapper).props('loudnessDb')).toBe(0)
  })

  it('labels a translated caption track in the display language, the language\'s own name where YouTube gives none', async () => {
    const translated = (language) => ({
      url: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&fmt=srt&tlang=en',
      language: 'en',
      label: `${language ?? 'en'} (translated from "German")`,
      mimeType: 'text/srt',
      isAutotranslated: true,
      translation: { language, originalLanguage: 'German' },
    })
    const { wrapper } = await openWatchPage(youtubeVideo({}, { captions: [YT_CAPTIONS[0], translated('Englisch'), translated(null)] }), YT_PATH)

    expect(findPlayer(wrapper).props('captions').map(track => track.label)).toEqual([
      'English',
      'Englisch (translated from "German")',
      'English (US) (translated from "German")',
    ])
  })

  describe('in a window narrower than 500px', () => {
    let width

    beforeEach(() => {
      width = window.innerWidth
      Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true, writable: true })
    })

    afterEach(() => {
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
    })

    it('hands the player the storyboard of the smaller board', async () => {
      const { wrapper } = await openWatchPage(youtubeVideo({}, { narrowStoryboard: 'data:text/vtt;charset=utf-8,WEBVTT%20narrow' }), YT_PATH)

      expect(findPlayer(wrapper).props('storyboardSrc')).toBe('data:text/vtt;charset=utf-8,WEBVTT%20narrow')
    })

    it('hands it no storyboard where there is no smaller board', async () => {
      const { wrapper } = await openWatchPage(youtubeVideo({}, { narrowStoryboard: null }), YT_PATH)

      expect(findPlayer(wrapper).props('storyboardSrc')).toBe('')
    })

    it('hands it the only storyboard there is where the layer answers one only', async () => {
      const { wrapper } = await openWatchPage(youtubeVideo(), YT_PATH)

      expect(findPlayer(wrapper).props('storyboardSrc')).toBe('data:text/vtt;charset=utf-8,WEBVTT%20storyboard')
    })
  })

  it('hands the player the full storyboard in a wider window', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo({}, { narrowStoryboard: 'data:text/vtt;charset=utf-8,WEBVTT%20narrow' }), YT_PATH)

    expect(findPlayer(wrapper).props('storyboardSrc')).toBe('data:text/vtt;charset=utf-8,WEBVTT%20storyboard')
  })

  it('names YouTube\'s key moments as such', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo({ chaptersKind: 'keyMoments' }), YT_PATH)

    expect(wrapper.find('.sidebarArea').text()).toContain('Key Moments')
  })

  it('names the uploader\'s chapters as chapters', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo(), YT_PATH)

    expect(wrapper.find('.sidebarArea').text()).toContain('Chapters')
    expect(wrapper.find('.sidebarArea').text()).not.toContain('Key Moments')
  })

  it('marks an unlisted video, and only an unlisted one', async () => {
    const unlisted = await openWatchPage(youtubeVideo({ isUnlisted: true }), YT_PATH)
    expect(unlisted.wrapper.find('.unlistedBadge').text()).toBe('Unlisted')

    const listed = await openWatchPage(youtubeVideo(), YT_PATH)
    expect(listed.wrapper.find('.unlistedBadge').exists()).toBe(false)
  })

  it('walks a post-live recording\'s ring from adaptive straight to audio, as it has no legacy formats to play', async () => {
    const recording = youtubeVideo({ liveStatus: 'ended' }, { isPostLiveDvr: true })
    const { wrapper } = await openWatchPage(recording, YT_PATH)

    findPlayer(wrapper).vm.$emit('error', new Error('adaptive failed'))
    await flushPromises()

    expect(findPlayer(wrapper).props('format')).toBe('audio')
  })

  it('asks for its comments top first, and newest first once chosen', async () => {
    layer.getComments.mockResolvedValue({
      items: [{ id: 'c1', threadId: 'c1', text: 'Great', textKind: 'plain', author: 'Bob', authorAccount: '', authorId: YT_CHANNEL, authorThumbnail: '', createdAt: Date.now(), isDeleted: false, replyCount: 0, repliesCursor: null }],
      cursor: null,
    })
    const { wrapper } = await openWatchPage(youtubeVideo(), YT_PATH)

    await wrapper.find('.getCommentsTitle').trigger('click')
    await flushPromises()
    expect(layer.getComments).toHaveBeenLastCalledWith(YT_ID, { cursor: null, sort: 'top' })

    await wrapper.find('.commentSort select').setValue('newest')
    await flushPromises()
    expect(layer.getComments).toHaveBeenLastCalledWith(YT_ID, { cursor: null, sort: 'newest' })
  })

  it('offers no comment sort for a PeerTube video, whose comments come newest first', async () => {
    layer.getComments.mockResolvedValue({
      items: [{ id: 1, threadId: 1, text: 'Lovely', textKind: 'markdown', author: 'Alice', authorAccount: `alice@${HOST}`, authorThumbnail: '', createdAt: Date.now(), isDeleted: false, replyCount: 0 }],
      cursor: null,
    })
    const { wrapper } = await openWatchPage(playableVideo())

    await wrapper.find('.getCommentsTitle').trigger('click')
    await flushPromises()

    expect(wrapper.find('.commentSort').exists()).toBe(false)
    expect(wrapper.find('.unlistedBadge').exists()).toBe(false)
  })
})

describe('a YouTube video\'s stream failing', () => {
  const PAST = () => new Date(Date.now() - 1000)

  it('says the watch session expired on a 403 after the streaming URLs expire, and offers to try again', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo({}, { expiresAt: PAST() }), YT_PATH)
    Object.assign(player, { hasLoaded: true, currentTime: 42.5 })

    findPlayer(wrapper).vm.$emit('error', badStatus(403))
    await flushPromises()

    expect(findPlayer(wrapper).exists()).toBe(false)
    expect(wrapper.text()).toContain('[BAD_HTTP_STATUS: 403] YouTube watch session expired.')
    expect(wrapper.find('.errorRetryButton').exists()).toBe(true)
    expect(dispatched('updateWatchProgress')).toEqual([{ videoId: YT_ID, watchProgress: 42.5 }])
  })

  it.each([
    ['a music video', 'Music', '[BAD_HTTP_STATUS: 403] Potential causes: IP block, streaming URL deciphering failed or music video geo-block'],
    ['any other video', 'Film & Animation', '[BAD_HTTP_STATUS: 403] Potential causes: IP block or streaming URL deciphering failed'],
  ])('names the likely causes of a 403 before the expiry, for %s, without trying another format or again', async (_case, category, text) => {
    const { wrapper } = await openWatchPage(youtubeVideo({ category }), YT_PATH)

    findPlayer(wrapper).vm.$emit('error', badStatus(403))
    await flushPromises()

    expect(findPlayer(wrapper).exists()).toBe(false)
    expect(wrapper.text()).toContain(text)
    expect(wrapper.find('.errorRetryButton').exists()).toBe(false)
  })

  it('reads a 403 as the address refused where the layer does not know the expiry', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo({}, { expiresAt: null }), YT_PATH)

    findPlayer(wrapper).vm.$emit('error', badStatus(403))
    await flushPromises()

    expect(wrapper.text()).toContain('[BAD_HTTP_STATUS: 403] Potential causes:')
  })

  it('says the watch session expired when a legacy format fails to play after the expiry', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo({}, { manifestUrl: null, manifestMimeType: null, audio: null, expiresAt: PAST() }), YT_PATH)
    expect(findPlayer(wrapper).props('format')).toBe('legacy')

    findPlayer(wrapper).vm.$emit('error', videoError())
    await flushPromises()

    expect(wrapper.text()).toContain('[VIDEO_ERROR] YouTube watch session expired.')
    expect(wrapper.find('.errorRetryButton').exists()).toBe(true)
  })

  it('walks the ring when a legacy format fails before the expiry', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo(), YT_PATH)
    findPlayer(wrapper).vm.$emit('error', new Error('adaptive failed'))
    await flushPromises()
    expect(findPlayer(wrapper).props('format')).toBe('legacy')

    findPlayer(wrapper).vm.$emit('error', videoError())
    await flushPromises()

    expect(findPlayer(wrapper).props('format')).toBe('audio')
  })

  it('leaves a PeerTube video\'s 403 to the ring, as before', async () => {
    const { wrapper } = await openWatchPage(playableVideo())

    findPlayer(wrapper).vm.$emit('error', badStatus(403))
    await flushPromises()

    expect(findPlayer(wrapper).props('format')).toBe('legacy')
  })
})

describe('a refused YouTube video', () => {
  it.each([
    ['private', 'Private videos cannot be watched in Fjernsyn as they require Google login and ownership of the video.'],
    ['membersOnly', 'Members-only videos cannot be watched with Fjernsyn as they require Google login and paid membership to the uploader\'s channel.'],
    ['ageRestricted', 'Age-restricted videos cannot be watched with Fjernsyn as they require Google login and using an age-verified YouTube account.'],
    ['drm', 'DRM protected videos cannot be played in Fjernsyn, as they require proprietary, closed source components.'],
    ['ipBlock', 'YouTube has blocked your IP address from watching videos. Please try switching to a different VPN or proxy.'],
    ['unexplained', 'YouTube refused playback without giving a reason. If you use a VPN or proxy, try another server or disable it.'],
  ])('refused as %s says so in the old watch page\'s words', async (reason, message) => {
    const { wrapper } = await openWatchPage(new PlatformError('refused', '[UNPLAYABLE] Video unavailable', { reason }), YT_PATH)

    expect(findPlayer(wrapper).exists()).toBe(false)
    expect(wrapper.text()).toContain(message)
    expect(wrapper.find('.errorRetryButton').exists()).toBe(false)
  })

  it('refused for no reason the layer knows shows YouTube\'s own, as the old watch page does', async () => {
    const { wrapper } = await openWatchPage(new PlatformError('refused', '[LOGIN_REQUIRED] This video may be inappropriate: Sign in to watch'), YT_PATH)

    expect(wrapper.text()).toContain('[LOGIN_REQUIRED] This video may be inappropriate: Sign in to watch')
  })
})

describe('the family-friendly gate', () => {
  beforeEach(() => {
    store.setGetter('getShowFamilyFriendlyOnly', true)
  })

  it('shows a YouTube video YouTube does not rate family friendly as age restricted, and nothing of it', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo({ isFamilyFriendly: false }), YT_PATH)

    expect(wrapper.text()).toContain('This video is age restricted')
    expect(findPlayer(wrapper).exists()).toBe(false)
    expect(wrapper.find('h1').exists()).toBe(false)
    expect(wrapper.find('.getCommentsTitle').exists()).toBe(false)
    expect(dispatched('updateSubscriptionDetails')).toEqual([])
  })

  it('plays a family-friendly YouTube video', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo(), YT_PATH)

    expect(findPlayer(wrapper).exists()).toBe(true)
    expect(wrapper.text()).not.toContain('This video is age restricted')
  })

  it('lets a PeerTube video through, which YouTube does not rate', async () => {
    const { wrapper } = await openWatchPage(playableVideo())

    expect(findPlayer(wrapper).exists()).toBe(true)
  })

  it('stays out of the way while the setting is off', async () => {
    store.setGetter('getShowFamilyFriendlyOnly', false)
    const { wrapper } = await openWatchPage(youtubeVideo({ isFamilyFriendly: false }), YT_PATH)

    expect(findPlayer(wrapper).exists()).toBe(true)
  })
})
