import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import shaka from 'shaka-player'
import { h } from 'vue'
import { RouterView } from 'vue-router'

import { SabrGiveUpError } from '../../helpers/player/SabrRegulator'
import { copyToClipboard, formatScheduledTime, openExternalLink, showToast } from '../../helpers/utils'
import { describe as describeEntity } from '../../platform/describe'
import { PlatformError } from '../../platform/errors'
import { WatchSurface } from '../../platform/routes'
import { PLATFORM_LAYER_KEY, isPeerTubeEnabled } from '../../platform/vue'
import store from '../../store/index'
import { createTestI18n } from '../../testing/i18n'
import { createTestRouter } from '../../testing/router'
import LayerWatch from './LayerWatch.vue'
import FtIconButton from '../../components/FtIconButton/FtIconButton.vue'

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
        autoplayPossible: { type: Boolean, default: false },
        autoplayEnabled: { type: Boolean, default: false },
        watchingPlaylist: { type: Boolean, default: false },
        startInFullscreen: { type: Boolean, default: false },
        startInFullwindow: { type: Boolean, default: false },
        startInPip: { type: Boolean, default: false },
        currentPlaybackRate: { type: Number, default: 1 },
        loudnessDb: { type: Number, default: null },
        heatmap: { type: Array, default: null },
        delayLoadUntilUnix: { type: Number, default: 0 },
        vrProjection: { type: String, default: null },
        platform: { type: String, default: 'youtube' },
        videoUrl: { type: String, default: '' },
        liveChat: { type: EventTarget, default: null },
        sabrData: { type: Object, default: null },
        sabrRegulator: { type: Object, default: null },
      },
      // Emitted by the tests, through `vm.$emit`
      // eslint-disable-next-line vue/no-unused-emit-declarations
      emits: ['error', 'loaded', 'ended', 'timeupdate', 'toggle-theatre-mode', 'toggle-autoplay', 'skip-to-next', 'skip-to-prev', 'playback-rate-updated', 'sabr-refresh-requested', 'player-reload-requested'],
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
  getDefaultVideoFormat: 'dash',
  getDefaultPlayback: 1,
  getHideChapters: false,
  getHideVideoDescription: false,
  getShowFamilyFriendlyOnly: false,
  // Recommendations and autoplay
  getHideRecommendedVideos: false,
  getHideLiveChat: false,
  getPlayNextVideo: false,
  getDefaultInterval: 5,
  getDefaultAutoplayInterruptionIntervalHours: 3,
  getChannelsHidden: '[]',
  getForbiddenTitles: '[]',
  getHideChannelsBasedOnText: true,
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
  // The playlist panel's
  getAutoplayPlaylists: true,
  getSaveVideoHistoryWithLastViewedPlaylist: true,
  getPlaylist: () => undefined,
  getPlaylistsReady: true,
  getCachedPlaylist: null,
  getUserPlaylistSortOrder: 'custom',
  getBackendPreference: 'local',
  getBackendFallback: false,
  getCurrentInvidiousInstanceUrl: 'https://inv.example',
  // The surface switch's, which both watch routes render in the app (WatchSurface)
  getEnableLayerSurfaces: false,
  // The Later list's
  getIsInLater: () => false,
  getIsArmed: () => false,
  getLaterFiredVideo: null,
}))

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return { default: createFakeStore({ getters: { ...SETTINGS } }) }
})

// helpers/utils imports the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

// The app's watch routes (platform/routes.js) and the other views beside them;
// upstream's watch view as a stand-in that says it is there
vi.mock('../Watch/Watch.vue', () => ({ default: { name: 'Watch', render: () => null } }))
vi.mock('../Channel/Channel.vue', () => ({ default: { name: 'Channel', render: () => null } }))
vi.mock('../LayerChannel/LayerChannel.vue', () => ({ default: { name: 'LayerChannel', render: () => null } }))
vi.mock('../LayerSearch/LayerSearch.vue', () => ({ default: { name: 'LayerSearch', render: () => null } }))

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
vi.mock('../../platform/vue', async (importOriginal) => {
  const { describe } = await import('../../platform/describe')

  return {
    ...(await importOriginal()),
    isPeerTubeEnabled: vi.fn(() => true),
    // What the shared cards and the playlist panel ask of the layer, unprovided
    getPlatformLayer: () => ({ describe: (entity, options) => describe(entity, {}, options) }),
  }
})

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
 * @param {object} [options]
 * @param {import('vue').Component} [options.watchView] what both watch routes
 *   render: this view, or as the app routes them, the surface switch
 */
async function openWatchPage(answer, path = WATCH_PATH, { watchView = LayerWatch } = {}) {
  layer.getVideo.mockImplementation(async (ref) => {
    const value = typeof answer === 'function' ? answer(ref) : answer
    if (value instanceof Error) {
      throw value
    }
    return value
  })

  const router = createTestRouter([
    { path: '/peertube/watch/:host/:uuid', name: 'peertubeWatch', component: watchView },
    // As upstream's watch route, which has no name
    { path: '/watch/:id', component: watchView },
    { path: '/peertube/channel/:handle/:currentTab?', name: 'peertubeChannel' },
    { path: '/elsewhere', name: 'elsewhere' },
    // Routes whose own guard refuses the navigation, as the PeerTube routes'
    // does while PeerTube is off: one rendering this view, one not
    { path: '/refused/watch/:host/:uuid', component: LayerWatch, beforeEnter: () => false },
    { path: '/refused', beforeEnter: () => false },
  ])
  await router.push(path)

  const wrapper = mount({ render: () => h(RouterView) }, {
    global: {
      plugins: [createTestI18n(), router, store],
      provide: { [PLATFORM_LAYER_KEY]: layer },
      directives: { 'observe-visibility': {} },
      // The playlist panel's items, whose cards are tested with the panel;
      // the live chat, which starts the handle it is given and polls YouTube
      stubs: { FtListVideoNumbered: true, WatchVideoLiveChat: true },
    },
  })
  openPages.push(wrapper)
  await flushPromises()

  return { wrapper, router }
}

function findPlayer(wrapper) {
  return wrapper.findComponent({ name: 'FtShakaVideoPlayer' })
}

/** The instance of this view the page holds, to tell whether the router kept it */
function viewInstance(wrapper) {
  return wrapper.findComponent(LayerWatch).vm.$
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

  it('hands the player the canonical PeerTube URL to copy, without the time it starts at', async () => {
    const { wrapper } = await openWatchPage(playableVideo(), `${WATCH_PATH}?timestamp=30`)

    expect(findPlayer(wrapper).props('videoUrl')).toBe(`https://${HOST}/w/3TuSBHAVmMRmg5pb1CjRNa`)
  })

  it('hands the player the watch URL on the video\'s host to copy, when the details carry no URL', async () => {
    const { wrapper } = await openWatchPage(playableVideo({ url: null }))

    expect(findPlayer(wrapper).props('videoUrl')).toBe(`https://${HOST}/videos/watch/${UUID}`)
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

  it.each([
    ['to another video', `/refused/watch/${HOST}/${OTHER_UUID}`],
    ['away from the page', '/refused'],
  ])('leaves the video playing when the target route refuses a navigation %s', async (_case, path) => {
    const { wrapper, router } = await openWatchPage(playableVideo())
    Object.assign(player, { hasLoaded: true, currentTime: 42.5 })
    const playing = findPlayer(wrapper).element

    await router.push(path)
    await flushPromises()

    expect(router.currentRoute.value.path).toBe(WATCH_PATH)
    expect(findPlayer(wrapper).element).toBe(playing)
    expect(player.events).not.toContain('destroyed')
    expect(dispatched('updateWatchProgress')).toEqual([])
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

  it('tries again from where playback stopped, as the old watch page does', async () => {
    const { wrapper } = await openWatchPage(playableVideo({}, { legacyFormats: [], audio: null }))
    Object.assign(player, { hasLoaded: true, currentTime: 42.5 })
    findPlayer(wrapper).vm.$emit('error', new Error('adaptive failed'))
    await flushPromises()

    await wrapper.find('.errorRetryButton').trigger('click')
    await flushPromises()

    expect(findPlayer(wrapper).props('startTime')).toBe(42)
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

  it.each(['ai', 'not-ai'])('records the AI label its details read, %s, with no request of its own', async (verdict) => {
    await openWatchPage(youtubeVideo({ aiVerdict: verdict }), YT_PATH)

    expect(dispatched('recordAiVerdict')).toEqual([{ videoId: YT_ID, verdict }])
    expect(layer.getVideo).toHaveBeenCalledTimes(1)
  })

  it('records nothing when its details carry no AI label (Invidious)', async () => {
    await openWatchPage(youtubeVideo({ aiVerdict: null }), YT_PATH)

    expect(dispatched('recordAiVerdict')).toEqual([])
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
      videoUrl: `https://www.youtube.com/watch?v=${YT_ID}`,
    })
  })

  it('starts on the legacy formats when it has no manifest', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo({}, { manifestUrl: null, manifestMimeType: null, audio: null }), YT_PATH)

    expect(findPlayer(wrapper).props()).toMatchObject({ format: 'legacy', legacyFormats: YT_LEGACY_FORMATS })
    expect(findButton(wrapper, 'Audio only').exists()).toBe(false)
  })

  it.each([
    ['in the default format where it has it', 'legacy', {}, 'legacy'],
    ['on the ring where it lacks the default format', 'legacy', { legacyFormats: [] }, 'dash'],
  ])('starts %s, as the old watch page does', async (_case, defaultFormat, sourceOverrides, format) => {
    store.setGetter('getDefaultVideoFormat', defaultFormat)
    const { wrapper } = await openWatchPage(youtubeVideo({}, sourceOverrides), YT_PATH)

    expect(findPlayer(wrapper).props('format')).toBe(format)
  })

  it('leaves a PeerTube video to the ring, whatever the default format', async () => {
    store.setGetter('getDefaultVideoFormat', 'legacy')
    const { wrapper } = await openWatchPage(playableVideo())

    expect(findPlayer(wrapper).props('format')).toBe('dash')
  })

  it.each([
    ['fullscreen', false],
    ['fullscreen_always_on', true],
  ])('applies the %s viewing mode to the first video, and to the next only if always on', async (mode, onNext) => {
    store.setGetter('getDefaultViewingMode', mode)
    const { wrapper, router } = await openWatchPage(ref => youtubeVideo({ videoId: ref }), YT_PATH)
    expect(findPlayer(wrapper).props('startInFullscreen')).toBe(true)

    // The player left full screen, as its destruction reports
    await router.push('/watch/pCJ9JGG0GQI')
    await flushPromises()

    expect(findPlayer(wrapper).props('startInFullscreen')).toBe(onNext)
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

    it('does not reload over another video opened while the player is being destroyed for the reload', async () => {
      const NEXT_ID = 'pCJ9JGG0GQI'
      const { wrapper, router } = await openWatchPage(ref => ({ ...sabrVideo(), videoId: ref }), YT_PATH)
      Object.assign(player, { hasLoaded: true, currentTime: 42.5 })
      let finishDestroying
      player.destroyGate = new Promise(resolve => { finishDestroying = resolve })

      findPlayer(wrapper).vm.$emit('player-reload-requested', 'the session reload failed')
      await flushPromises()
      const opening = router.push(`/watch/${NEXT_ID}`)
      await flushPromises()

      finishDestroying()
      await opening
      await flushPromises()

      expect(layer.getVideo.mock.calls).toEqual([[YT_ID], [NEXT_ID]])
      expect(findPlayer(wrapper).props()).toMatchObject({ videoId: NEXT_ID, startTime: null })
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

  it('hands the player its most replayed heatmap', async () => {
    const heatmap = [{ startSeconds: 0, endSeconds: 2.14, intensity: 1 }]
    const { wrapper } = await openWatchPage(youtubeVideo({}, { heatmap }), YT_PATH)

    expect(findPlayer(wrapper).props('heatmap')).toEqual(heatmap)
  })

  it('hands the player no heatmap where the source has none', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo(), YT_PATH)

    expect(findPlayer(wrapper).props('heatmap')).toBeNull()
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

  it('says it is rate limited on a 429, without trying another format, and offers to try again', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo(), YT_PATH)

    findPlayer(wrapper).vm.$emit('error', badStatus(429))
    await flushPromises()

    expect(findPlayer(wrapper).exists()).toBe(false)
    expect(wrapper.text()).toContain('[BAD_HTTP_STATUS: 429] Ratelimited')
    expect(wrapper.find('.errorRetryButton').exists()).toBe(true)
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

describe('recommendations', () => {
  const NEXT_IDS = ['pCJ9JGG0GQI', 'z-Xl9tGqH14', 'TMpUsykbezI']

  /** A watch-next summary, as the layer answers it */
  function recommendation(videoId, overrides = {}) {
    return { type: 'video', videoId, title: `Video ${videoId}`, author: 'Someone', authorId: 'UCsomeone', lengthSeconds: 60, ...overrides }
  }

  function withRecommendations(overrides = {}) {
    return youtubeVideo({ related: NEXT_IDS.map(id => recommendation(id)), ...overrides })
  }

  function listed(wrapper) {
    return wrapper.findComponent({ name: 'WatchVideoRecommendations' }).props('data').map(summary => summary.videoId)
  }

  it('lists a YouTube video\'s recommendations beside it, and makes theatre mode possible', async () => {
    store.setGetter('getHideChapters', true)
    const { wrapper } = await openWatchPage(withRecommendations(), YT_PATH)

    expect(wrapper.text()).toContain('Up Next')
    expect(listed(wrapper)).toEqual(NEXT_IDS)
    expect(findPlayer(wrapper).props('theatrePossible')).toBe(true)
  })

  it('lists the watched ones last, in YouTube\'s order otherwise', async () => {
    store.setGetter('getHistoryCacheById', { [NEXT_IDS[0]]: { videoId: NEXT_IDS[0], watchProgress: 10 } })
    const { wrapper } = await openWatchPage(withRecommendations(), YT_PATH)

    expect(listed(wrapper)).toEqual([NEXT_IDS[1], NEXT_IDS[2], NEXT_IDS[0]])
  })

  it('shows none, and offers no autoplay, while recommendations are hidden', async () => {
    store.setGetter('getHideRecommendedVideos', true)
    store.setGetter('getPlayNextVideo', true)
    const { wrapper } = await openWatchPage(withRecommendations(), YT_PATH)

    expect(wrapper.text()).not.toContain('Up Next')
    expect(findPlayer(wrapper).props('autoplayPossible')).toBe(false)
  })

  it('has no panel for a PeerTube video, whose details have none', async () => {
    const { wrapper } = await openWatchPage(playableVideo())

    expect(wrapper.findComponent({ name: 'WatchVideoRecommendations' }).exists()).toBe(false)
    expect(findPlayer(wrapper).props('autoplayPossible')).toBe(false)
  })
})

describe('autoplay at the end of a video', () => {
  const NEXT_ID = 'pCJ9JGG0GQI'
  const HIDDEN_ID = 'z-Xl9tGqH14'

  const withNext = () => youtubeVideo({
    related: [
      { type: 'video', videoId: HIDDEN_ID, title: 'Hidden', author: 'Hidden channel', authorId: 'UChidden', lengthSeconds: 60 },
      { type: 'video', videoId: NEXT_ID, title: 'Next', author: 'Someone', authorId: 'UCsomeone', lengthSeconds: 60 },
    ],
  })

  beforeEach(() => {
    // Not `setImmediate`, which flushPromises is made of
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    store.setGetter('getPlayNextVideo', true)
    store.setGetter('getChannelsHidden', JSON.stringify([{ name: 'UChidden', preferredName: '', icon: '' }]))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function endVideo(wrapper) {
    player.paused = true
    findPlayer(wrapper).vm.$emit('ended')
    await flushPromises()
  }

  /** The countdown toast's text, `remainingMs` before it ends */
  function countdownText(remainingMs) {
    const call = showToast.mock.calls.find(([message]) => typeof message === 'function')
    return call?.[0]({ elapsedMs: 0, remainingMs })
  }

  it('offers the player\'s toggle, on as the setting has it', async () => {
    const { wrapper } = await openWatchPage(withNext(), YT_PATH)

    expect(findPlayer(wrapper).props()).toMatchObject({ autoplayPossible: true, autoplayEnabled: true })
  })

  it('plays the next recommendation not hidden, after the countdown', async () => {
    const { wrapper, router } = await openWatchPage(withNext(), YT_PATH)

    await endVideo(wrapper)

    expect(countdownText(5000)).toBe('Playing next video in 5 seconds. Click to cancel.')
    expect(showToast).toHaveBeenCalledWith(expect.any(Function), 5000, expect.any(Function), expect.any(AbortSignal))

    await vi.advanceTimersByTimeAsync(4999)
    expect(router.currentRoute.value.path).toBe(YT_PATH)

    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()

    expect(router.currentRoute.value.path).toBe(`/watch/${NEXT_ID}`)
    expect(showToast).toHaveBeenCalledWith('Playing Next Video')
    expect(layer.getVideo).toHaveBeenLastCalledWith(NEXT_ID)
  })

  it('does not move on when the video plays again during the countdown', async () => {
    const { wrapper, router } = await openWatchPage(withNext(), YT_PATH)

    await endVideo(wrapper)
    player.paused = false
    await vi.advanceTimersByTimeAsync(5000)

    expect(router.currentRoute.value.path).toBe(YT_PATH)
  })

  it('does nothing at the end while the setting is off', async () => {
    store.setGetter('getPlayNextVideo', false)
    const { wrapper, router } = await openWatchPage(withNext(), YT_PATH)

    await endVideo(wrapper)
    await vi.advanceTimersByTimeAsync(5000)

    expect(countdownText(5000)).toBeUndefined()
    expect(router.currentRoute.value.path).toBe(YT_PATH)
  })

  it('is cancelled by the player\'s toggle, which then stays off', async () => {
    const { wrapper, router } = await openWatchPage(withNext(), YT_PATH)

    await endVideo(wrapper)
    findPlayer(wrapper).vm.$emit('toggle-autoplay')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(5000)

    expect(showToast).toHaveBeenCalledWith('Canceled next video autoplay')
    expect(router.currentRoute.value.path).toBe(YT_PATH)
    expect(findPlayer(wrapper).props('autoplayEnabled')).toBe(false)
  })

  it('is cancelled by a click on its toast', async () => {
    const { wrapper, router } = await openWatchPage(withNext(), YT_PATH)

    await endVideo(wrapper)
    const [, , cancel, signal] = showToast.mock.calls.find(([message]) => typeof message === 'function')
    cancel()
    await vi.advanceTimersByTimeAsync(5000)

    expect(signal.aborted).toBe(true)
    expect(router.currentRoute.value.path).toBe(YT_PATH)
  })

  it('is cancelled by the interruption timer after its hours of nothing touched', async () => {
    const { wrapper, router } = await openWatchPage(withNext(), YT_PATH)

    await vi.advanceTimersByTimeAsync(3 * 3_600_000)
    await endVideo(wrapper)
    await vi.advanceTimersByTimeAsync(5000)

    expect(showToast).toHaveBeenCalledWith('Autoplay canceled due to 3 hours of inactivity', 3_600_000)
    expect(router.currentRoute.value.path).toBe(YT_PATH)
  })

  it('counts the interruption interval afresh from a click', async () => {
    const { wrapper, router } = await openWatchPage(withNext(), YT_PATH)

    await vi.advanceTimersByTimeAsync(3 * 3_600_000 - 1000)
    document.dispatchEvent(new MouseEvent('click'))
    await vi.advanceTimersByTimeAsync(2000)
    await endVideo(wrapper)
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()

    expect(router.currentRoute.value.path).toBe(`/watch/${NEXT_ID}`)
  })

  it('moves on from a video hidden as not family friendly', async () => {
    store.setGetter('getShowFamilyFriendlyOnly', true)
    const { router } = await openWatchPage(youtubeVideo({ ...withNext(), isFamilyFriendly: false }), YT_PATH)

    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()

    expect(router.currentRoute.value.path).toBe(`/watch/${NEXT_ID}`)
  })

  it('skips to the next recommendation at once from the player', async () => {
    const { wrapper, router } = await openWatchPage(withNext(), YT_PATH)

    findPlayer(wrapper).vm.$emit('skip-to-next')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe(`/watch/${NEXT_ID}`)
  })
})

describe('a playlist', () => {
  const SECOND_ID = 'pCJ9JGG0GQI'
  const THIRD_ID = 'z-Xl9tGqH14'
  const USER_ID = 'mine'
  const REMOTE_ID = 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI'

  /** A stored playlist video */
  function item(videoId, playlistItemId, overrides = {}) {
    return { videoId, title: `Video ${videoId}`, author: 'Someone', authorId: 'UCsomeone', lengthSeconds: 60, playlistItemId, timeAdded: 1, ...overrides }
  }

  const peerTubeItem = (playlistItemId) => item(UUID, playlistItemId, { authorId: HANDLE, platform: 'peertube', host: HOST, thumbnail: THUMBNAIL })

  /** A user playlist of the videos, by item id `u1`, `u2`... */
  function useUserPlaylist(videos) {
    store.setGetter('getPlaylist', id => (id === USER_ID ? { _id: USER_ID, playlistName: 'Mine', videos } : undefined))
  }

  /** A YouTube playlist, as the playlist page hands it to the watch page */
  function useRemotePlaylist(videoIds) {
    const items = videoIds.map(videoId => item(videoId, undefined))
    store.setGetter('getCachedPlaylist', {
      id: REMOTE_ID, title: 'Remote', channelName: 'Someone', channelId: 'UCsomeone', totalVideoCount: items.length, videoCount: items.length, items, continuationData: null,
    })
  }

  /** Answers the video each route names, of either platform */
  const anyVideo = ref => (typeof ref === 'string' ? youtubeVideo({ videoId: ref, title: `Video ${ref}` }) : playableVideo())

  const KINDS = {
    // Three YouTube videos, the route on the first
    user: {
      setUp: () => useUserPlaylist([item(YT_ID, 'u1'), item(SECOND_ID, 'u2'), item(THIRD_ID, 'u3')]),
      path: (videoId, index) => `/watch/${videoId}?playlistId=${USER_ID}&playlistType=user&playlistItemId=u${index + 1}`,
      query: index => ({ playlistId: USER_ID, playlistType: 'user', playlistItemId: `u${index + 1}` }),
    },
    youtube: {
      setUp: () => useRemotePlaylist([YT_ID, SECOND_ID, THIRD_ID]),
      path: videoId => `/watch/${videoId}?playlistId=${REMOTE_ID}&playlistType=`,
      query: () => ({ playlistId: REMOTE_ID }),
    },
  }
  const IDS = [YT_ID, SECOND_ID, THIRD_ID]

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function open(kind, index = 0) {
    KINDS[kind].setUp()
    return openWatchPage(anyVideo, KINDS[kind].path(IDS[index], index))
  }

  function panel(wrapper) {
    return wrapper.findComponent({ name: 'WatchVideoPlaylist' })
  }

  async function endVideo(wrapper) {
    player.paused = true
    findPlayer(wrapper).vm.$emit('ended')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
  }

  async function fromPlayer(wrapper, event) {
    findPlayer(wrapper).vm.$emit(event)
    await flushPromises()
  }

  async function toggle(wrapper, label) {
    await wrapper.find(`[aria-label="${label}"]`).trigger('click')
  }

  /** @param {import('vue-router').Router} router */
  function expectOn(router, kind, index) {
    expect(router.currentRoute.value.path).toBe(`/watch/${IDS[index]}`)
    expect(router.currentRoute.value.query).toMatchObject(KINDS[kind].query(index))
    expect(layer.getVideo).toHaveBeenLastCalledWith(IDS[index])
  }

  describe.each(['user', 'youtube'])('a %s playlist', (kind) => {
    it('is listed beside the video, with the player\'s skip buttons', async () => {
      const { wrapper } = await open(kind)

      expect(panel(wrapper).props()).toMatchObject({ videoId: YT_ID, crossPlatform: true })
      expect(panel(wrapper).isVisible()).toBe(true)
      expect(findPlayer(wrapper).props('watchingPlaylist')).toBe(true)
    })

    it('skips to the next video and back from the player', async () => {
      const { wrapper, router } = await open(kind)

      await fromPlayer(wrapper, 'skip-to-next')
      expectOn(router, kind, 1)

      await fromPlayer(wrapper, 'skip-to-prev')
      expectOn(router, kind, 0)
    })

    it('autoplays the next video after the countdown, with the playlist\'s own toggle', async () => {
      store.setGetter('getPlayNextVideo', false)
      const { wrapper, router } = await open(kind)

      expect(findPlayer(wrapper).props()).toMatchObject({ autoplayPossible: true, autoplayEnabled: true })

      await endVideo(wrapper)
      expectOn(router, kind, 1)

      await fromPlayer(wrapper, 'toggle-autoplay')
      expect(findPlayer(wrapper).props('autoplayEnabled')).toBe(false)
      await endVideo(wrapper)
      expectOn(router, kind, 1)
    })

    it('ends at the last video, and loops to the first once loop is on', async () => {
      const { wrapper, router } = await open(kind, 2)

      expect(findPlayer(wrapper).props('autoplayPossible')).toBe(false)
      await endVideo(wrapper)
      expect(showToast).toHaveBeenCalledWith('The playlist has ended.  Enable loop to continue playing')
      expectOn(router, kind, 2)

      await toggle(wrapper, 'Loop Playlist')
      await endVideo(wrapper)
      expectOn(router, kind, 0)
    })

    it('shuffles, playing the next of the shuffled order', async () => {
      // Over [second, third] a random number of 0 swaps them
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const { wrapper, router } = await open(kind)

      await toggle(wrapper, 'Shuffle Playlist')
      await fromPlayer(wrapper, 'skip-to-next')

      expectOn(router, kind, 2)
      vi.mocked(Math.random).mockRestore()
    })

    it('reverses, playing the video before as the next', async () => {
      const { wrapper, router } = await open(kind, 1)

      await toggle(wrapper, 'Reverse Playlist')
      await flushPromises()
      await fromPlayer(wrapper, 'skip-to-next')

      expectOn(router, kind, 0)
    })

    it('keeps loop, shuffle and reverse from one video to the next', async () => {
      const { wrapper, router } = await open(kind, 1)

      await toggle(wrapper, 'Loop Playlist')
      await fromPlayer(wrapper, 'skip-to-next')
      expectOn(router, kind, 2)

      await endVideo(wrapper)
      expectOn(router, kind, 0)
    })

    it('keeps the playlist in the history entry, after the entry', async () => {
      const { wrapper } = await open(kind)

      findPlayer(wrapper).vm.$emit('loaded')
      await flushPromises()

      const types = store.dispatched.map(action => action.type)
      expect(types.indexOf('updateLastViewedPlaylist')).toBeGreaterThan(types.indexOf('updateHistory'))
      expect(dispatched('updateLastViewedPlaylist')).toEqual([{
        videoId: YT_ID,
        lastViewedPlaylistId: KINDS[kind].query(0).playlistId,
        lastViewedPlaylistType: kind === 'user' ? 'user' : '',
        lastViewedPlaylistItemId: kind === 'user' ? 'u1' : null,
      }])
    })

    it('keeps no playlist in the history entry while the setting is off', async () => {
      store.setGetter('getSaveVideoHistoryWithLastViewedPlaylist', false)
      const { wrapper } = await open(kind)

      findPlayer(wrapper).vm.$emit('loaded')
      await flushPromises()

      expect(dispatched('updateLastViewedPlaylist')).toEqual([])
    })
  })

  it('updates a user playlist\'s last played time when its video loads, and no YouTube playlist\'s', async () => {
    const { wrapper } = await open('user')
    findPlayer(wrapper).vm.$emit('loaded')
    await flushPromises()

    expect(dispatched('updatePlaylistLastPlayedAt')).toEqual([{ _id: USER_ID }])

    store.dispatched.length = 0
    const remote = await open('youtube')
    findPlayer(remote.wrapper).vm.$emit('loaded')
    await flushPromises()

    expect(dispatched('updatePlaylistLastPlayedAt')).toEqual([])
  })

  it('is not there for a user playlist that no longer holds the video, and the history says none', async () => {
    useUserPlaylist([item(SECOND_ID, 'u2')])
    const { wrapper } = await openWatchPage(anyVideo, KINDS.user.path(YT_ID, 0))

    findPlayer(wrapper).vm.$emit('loaded')
    await flushPromises()

    expect(panel(wrapper).exists()).toBe(false)
    expect(findPlayer(wrapper).props('watchingPlaylist')).toBe(false)
    expect(dispatched('updateLastViewedPlaylist')).toEqual([{ videoId: YT_ID, lastViewedPlaylistId: '', lastViewedPlaylistType: '', lastViewedPlaylistItemId: null }])
  })

  describe('holding both platforms', () => {
    const PEERTUBE_PATH = `/peertube/watch/${HOST}/${UUID}`

    beforeEach(() => {
      useUserPlaylist([item(YT_ID, 'u1'), peerTubeItem('u2'), item(SECOND_ID, 'u3')])
    })

    const query = index => ({ playlistId: USER_ID, playlistType: 'user', playlistItemId: `u${index + 1}` })

    function expectOnPeerTube(router) {
      expect(router.currentRoute.value.path).toBe(PEERTUBE_PATH)
      expect(router.currentRoute.value.query).toMatchObject(query(1))
      expect(layer.getVideo).toHaveBeenLastCalledWith({ platform: 'peertube', host: HOST, videoId: UUID })
    }

    function expectOnYouTube(router, videoId, index) {
      expect(router.currentRoute.value.path).toBe(`/watch/${videoId}`)
      expect(router.currentRoute.value.query).toMatchObject(query(index))
      expect(layer.getVideo).toHaveBeenLastCalledWith(videoId)
    }

    it('steps from a YouTube video to the PeerTube one on its own route, and back', async () => {
      const { wrapper, router } = await openWatchPage(anyVideo, KINDS.user.path(YT_ID, 0))

      await fromPlayer(wrapper, 'skip-to-next')
      expectOnPeerTube(router)
      expect(panel(wrapper).props('videoId')).toBe(UUID)

      await fromPlayer(wrapper, 'skip-to-prev')
      expectOnYouTube(router, YT_ID, 0)
    })

    it('is read on the PeerTube route too', async () => {
      const { wrapper, router } = await openWatchPage(anyVideo, `${PEERTUBE_PATH}?playlistId=${USER_ID}&playlistType=user&playlistItemId=u2`)

      expect(panel(wrapper).exists()).toBe(true)

      await fromPlayer(wrapper, 'skip-to-next')
      expectOnYouTube(router, SECOND_ID, 2)
    })

    it('autoplays across the platforms, the panel and its loop kept throughout', async () => {
      const { wrapper, router } = await openWatchPage(anyVideo, KINDS.user.path(YT_ID, 0))
      await toggle(wrapper, 'Loop Playlist')

      await endVideo(wrapper)
      expectOnPeerTube(router)

      // The PeerTube video's history entry, then its playlist
      findPlayer(wrapper).vm.$emit('loaded')
      await flushPromises()
      expect(dispatched('updateLastViewedPlaylist').at(-1)).toEqual({ videoId: UUID, lastViewedPlaylistId: USER_ID, lastViewedPlaylistType: 'user', lastViewedPlaylistItemId: 'u2' })

      await endVideo(wrapper)
      expectOnYouTube(router, SECOND_ID, 2)

      await endVideo(wrapper)
      expectOnYouTube(router, YT_ID, 0)
    })

    it('autoplays across the platforms on the surface switch, as the app routes them, the one view and its loop kept', async () => {
      store.setGetter('getEnableLayerSurfaces', true)
      const { wrapper, router } = await openWatchPage(anyVideo, KINDS.user.path(YT_ID, 0), { watchView: WatchSurface })
      const view = viewInstance(wrapper)
      await toggle(wrapper, 'Loop Playlist')

      await endVideo(wrapper)
      expectOnPeerTube(router)
      expect(viewInstance(wrapper)).toBe(view)

      await endVideo(wrapper)
      expectOnYouTube(router, SECOND_ID, 2)

      await endVideo(wrapper)
      expectOnYouTube(router, YT_ID, 0)
      expect(viewInstance(wrapper)).toBe(view)
    })

    it('saves the position of the video left on crossing, and destroys its player', async () => {
      player.hasLoaded = true
      player.currentTime = 42
      const { wrapper, router } = await openWatchPage(anyVideo, KINDS.user.path(YT_ID, 0))

      await fromPlayer(wrapper, 'skip-to-next')

      expectOnPeerTube(router)
      expect(dispatched('updateWatchProgress')).toEqual([{ videoId: YT_ID, watchProgress: 42 }])
      expect(player.events).toContain('destroyed')
    })
  })
})

describe('live chat', () => {
  /** A stand-in for the chat handle Local answers, of the panel's prop type */
  const HANDLE = new EventTarget()

  const waiting = () => youtubeVideo({ liveStatus: 'waiting', isUpcoming: true, playbackSource: null, liveChat: HANDLE })

  function findChat(wrapper) {
    return wrapper.findComponent({ name: 'WatchVideoLiveChat' })
  }

  it.each([
    ['a live', () => ({ ...youtubeLive(), liveChat: HANDLE })],
    ['an upcoming video', waiting],
  ])('is beside %s, opened from the very handle the layer answered', async (_what, answer) => {
    store.setGetter('getHideRecommendedVideos', true)
    const { wrapper } = await openWatchPage(answer(), YT_PATH)

    expect(findChat(wrapper).props()).toEqual({ liveChat: HANDLE, videoId: YT_ID, channelId: YT_CHANNEL })
    expect(findChat(wrapper).props('liveChat')).toBe(HANDLE)
    expect(wrapper.find('.sidebarArea').isVisible()).toBe(true)
  })

  it('is handed to the player too, to show over the video', async () => {
    store.setGetter('getHideRecommendedVideos', true)
    const { wrapper } = await openWatchPage({ ...youtubeLive(), liveChat: HANDLE }, YT_PATH)

    expect(findPlayer(wrapper).props('liveChat')).toBe(HANDLE)
  })

  it.each([
    ['without a handle, as Invidious answers', () => ({ ...youtubeLive(), liveChat: null }), () => {}],
    ['while live chat is hidden', () => ({ ...youtubeLive(), liveChat: HANDLE }), () => store.setGetter('getHideLiveChat', true)],
    ['for a video neither live nor upcoming', () => youtubeVideo({ liveChat: HANDLE }), () => {}],
    ['for a PeerTube live, whose details have none', () => playableVideo({ liveStatus: 'live' }, { isLive: true }), () => {}],
  ])('is absent %s', async (_what, answer, setUp) => {
    setUp()
    const video = answer()
    const { wrapper } = await openWatchPage(video, video.platform === 'peertube' ? WATCH_PATH : YT_PATH)

    expect(findPlayer(wrapper).exists()).toBe(true)
    expect(findChat(wrapper).exists()).toBe(false)
    expect(findPlayer(wrapper).props('liveChat')).toBeNull()
  })
})

describe('theatre mode', () => {
  const NEXT_ID = 'pCJ9JGG0GQI'
  const USER_ID = 'mine'

  const SIDE_PANELS = {
    // A PeerTube video's details have no recommendations
    chapters: {
      answer: () => playableVideo(),
      path: WATCH_PATH,
    },
    recommendations: {
      answer: () => youtubeVideo({ related: [{ type: 'video', videoId: NEXT_ID, title: 'Next', author: 'Someone', authorId: 'UCsomeone', lengthSeconds: 60 }] }, { chapters: [] }),
      path: YT_PATH,
    },
    playlist: {
      setUp: () => {
        store.setGetter('getHideRecommendedVideos', true)
        store.setGetter('getPlaylist', id => (id === USER_ID
          ? { _id: USER_ID, playlistName: 'Mine', videos: [{ videoId: YT_ID, title: 'Mine', author: 'Someone', authorId: 'UCsomeone', lengthSeconds: 60, playlistItemId: 'u1', timeAdded: 1 }] }
          : undefined))
      },
      answer: () => youtubeVideo({}, { chapters: [] }),
      path: `${YT_PATH}?playlistId=${USER_ID}&playlistType=user&playlistItemId=u1`,
    },
    'live chat': {
      setUp: () => { store.setGetter('getHideRecommendedVideos', true) },
      answer: () => ({ ...youtubeLive(), liveChat: new EventTarget() }),
      path: YT_PATH,
    },
  }

  it.each(Object.keys(SIDE_PANELS))('is offered with %s as the only side panel, and toggles from the player', async (name) => {
    const { setUp, answer, path } = SIDE_PANELS[name]
    setUp?.()
    store.setGetter('getDefaultViewingMode', 'theatre')
    const { wrapper } = await openWatchPage(answer(), path)

    expect(wrapper.find('.sidebarArea').isVisible()).toBe(true)
    expect(findPlayer(wrapper).props()).toMatchObject({ theatrePossible: true, useTheatreMode: true })
    expect(wrapper.find('.videoLayout').classes()).toContain('useTheatreMode')

    findPlayer(wrapper).vm.$emit('toggle-theatre-mode')
    await flushPromises()

    expect(wrapper.find('.videoLayout').classes()).not.toContain('useTheatreMode')
  })

  it('is not offered without a side panel', async () => {
    store.setGetter('getDefaultViewingMode', 'theatre')
    const { wrapper } = await openWatchPage(playableVideo({}, { chapters: [] }))

    expect(wrapper.find('.sidebarArea').exists()).toBe(false)
    expect(findPlayer(wrapper).props()).toMatchObject({ theatrePossible: false, useTheatreMode: false })
  })
})

describe('a waiting YouTube premiere', () => {
  const HOUR = 60 * 60 * 1000

  function waitingVideo(premiereDate, { trailer = false } = {}) {
    const overrides = { liveStatus: 'waiting', isUpcoming: true, ...(premiereDate ? { premiereDate } : {}) }
    return trailer ? youtubeVideo(overrides) : youtubeVideo({ ...overrides, playbackSource: null })
  }

  /** The date as the countdown gives it, by its month and day */
  const dayOf = date => date.toLocaleString('en-US', { month: 'long', day: 'numeric' })

  it.each([
    [30 * 1000, 'Premieres in less than a minute'],
    [90.5 * 60 * 1000, 'Premieres in 90 minutes'],
    [3.5 * HOUR, 'Premieres in 3 hours'],
    [2.5 * 24 * HOUR, 'Premieres in 2 days'],
  ])('says over its thumbnail when it premieres, %i ms ahead, in the old watch page\'s words', async (ahead, text) => {
    const start = new Date(Date.now() + ahead)
    const { wrapper } = await openWatchPage(waitingVideo(start), YT_PATH)

    expect(findPlayer(wrapper).exists()).toBe(false)
    expect(wrapper.find('.videoThumbnail').attributes('src')).toBe(YT_THUMBNAIL)
    const premiere = wrapper.find('.premiereDate')
    expect(premiere.classes()).not.toContain('trailer')
    expect(premiere.find('.premiereTextTimeLeft').text()).toBe(text)
    expect(premiere.find('.premiereTextTimestamp').text()).toContain(dayOf(start))
    expect(wrapper.text()).not.toContain('This live has not started yet.')
  })

  it('says it starts soon without a scheduled time', async () => {
    const { wrapper } = await openWatchPage(waitingVideo(null), YT_PATH)

    expect(wrapper.find('.premiereDate').text()).toBe('Starting soon, please refresh the page to check again')
  })

  it('says it below the trailer while the trailer plays', async () => {
    const start = new Date(Date.now() + 3.5 * HOUR)
    const { wrapper } = await openWatchPage(waitingVideo(start, { trailer: true }), YT_PATH)

    expect(findPlayer(wrapper).exists()).toBe(true)
    const premiere = wrapper.find('.premiereDate')
    expect(premiere.classes()).toContain('trailer')
    expect(premiere.find('.premiereTextTimeLeft').text()).toBe('Premieres in 3 hours')
  })
})

describe('on the surface switch, as the app routes both watch routes (WatchSurface)', () => {
  const OTHER_YT_ID = 'pCJ9JGG0GQI'

  /** @param {import('@vue/test-utils').VueWrapper} wrapper */
  function renders(wrapper) {
    return [
      ...(wrapper.findComponent({ name: 'Watch' }).exists() ? ['Watch'] : []),
      ...(wrapper.findComponent(LayerWatch).exists() ? ['LayerWatch'] : []),
    ]
  }

  it('takes another YouTube video for this view while the switch is on: the one left saved and its player destroyed, the next loaded', async () => {
    store.setGetter('getEnableLayerSurfaces', true)
    const { wrapper, router } = await openWatchPage(ref => youtubeVideo({ videoId: ref }), YT_PATH, { watchView: WatchSurface })
    const view = viewInstance(wrapper)
    Object.assign(player, { hasLoaded: true, currentTime: 55 })

    await router.push(`/watch/${OTHER_YT_ID}?timestamp=30`)
    await flushPromises()

    expect(viewInstance(wrapper)).toBe(view)
    expect(dispatched('updateWatchProgress')).toEqual([{ videoId: YT_ID, watchProgress: 55 }])
    expect(player.events).toContain('destroyed')
    expect(layer.getVideo).toHaveBeenLastCalledWith(OTHER_YT_ID)
    expect(findPlayer(wrapper).props()).toMatchObject({ videoId: OTHER_YT_ID, startTime: 30 })
  })

  it('crosses to the PeerTube route as the same view while the switch is on', async () => {
    store.setGetter('getEnableLayerSurfaces', true)
    const { wrapper, router } = await openWatchPage(ref => (typeof ref === 'string' ? youtubeVideo({ videoId: ref }) : playableVideo()), YT_PATH, { watchView: WatchSurface })
    const view = viewInstance(wrapper)

    await router.push(WATCH_PATH)
    await flushPromises()

    expect(viewInstance(wrapper)).toBe(view)
    expect(layer.getVideo).toHaveBeenLastCalledWith({ platform: 'peertube', host: HOST, videoId: UUID })
    expect(findPlayer(wrapper).props('videoId')).toBe(UUID)
  })

  it('renders upstream\'s view on a YouTube route while the switch is off, and this one on a PeerTube route', async () => {
    const { wrapper, router } = await openWatchPage(playableVideo(), YT_PATH, { watchView: WatchSurface })

    expect(renders(wrapper)).toEqual(['Watch'])
    expect(layer.getVideo).not.toHaveBeenCalled()

    await router.push(WATCH_PATH)
    await flushPromises()

    expect(renders(wrapper)).toEqual(['LayerWatch'])
    expect(layer.getVideo).toHaveBeenLastCalledWith({ platform: 'peertube', host: HOST, videoId: UUID })
  })

  it('leaves for upstream\'s view on a YouTube route while the switch is off, saving the position and destroying the player', async () => {
    const { wrapper, router } = await openWatchPage(playableVideo(), WATCH_PATH, { watchView: WatchSurface })
    Object.assign(player, { hasLoaded: true, currentTime: 55 })

    await router.push(YT_PATH)
    await flushPromises()

    expect(renders(wrapper)).toEqual(['Watch'])
    expect(dispatched('updateWatchProgress')).toEqual([{ videoId: UUID, watchProgress: 55 }])
    expect(player.events).toEqual(['position read', 'destroyed', 'unmounted'])
    expect(layer.getVideo).toHaveBeenCalledTimes(1)
  })
})

describe('the Later list on the watch page', () => {
  /** @param {import('@vue/test-utils').VueWrapper} wrapper */
  function button(wrapper, className) {
    return wrapper.findAllComponents(FtIconButton).find(b => b.classes(className))
  }

  it('adds the video with its clock button', async () => {
    const { wrapper } = await openWatchPage(youtubeVideo(), YT_PATH)

    button(wrapper, 'laterButton').vm.$emit('click')

    expect(dispatched('addToLater')).toEqual([expect.objectContaining({ videoId: YT_ID, title: 'Never Gonna Give You Up', authorId: YT_CHANNEL })])
    expect(button(wrapper, 'armButton')).toBeUndefined()
  })

  it('offers to arm an upcoming video, for its stated time', async () => {
    const at = Date.now() + 60 * 60 * 1000
    const { wrapper } = await openWatchPage(youtubeVideo({ isUpcoming: true, premiereDate: new Date(at) }), YT_PATH)

    button(wrapper, 'armButton').vm.$emit('click')

    expect(dispatched('arm')).toEqual([{ video: expect.objectContaining({ videoId: YT_ID }), at }])
  })

  it('adds a PeerTube video with its clock button, with what the Later page needs to render and route it', async () => {
    const { wrapper } = await openWatchPage(playableVideo())

    button(wrapper, 'laterButton').vm.$emit('click')

    expect(dispatched('addToLater')).toEqual([expect.objectContaining({
      videoId: UUID, title: 'Sprite Fright', authorId: HANDLE, platform: 'peertube', host: HOST, thumbnail: THUMBNAIL,
    })])
  })

  it('removes a PeerTube video already there, and never offers to arm one', async () => {
    store.setGetter('getIsInLater', id => id === UUID)
    const { wrapper } = await openWatchPage(liveVideo('waiting', { isUpcoming: true, premiereDate: new Date(Date.now() + 60 * 60 * 1000) }))

    expect(button(wrapper, 'armButton')).toBeUndefined()

    button(wrapper, 'laterButton').vm.$emit('click')
    expect(dispatched('removeFromLater')).toEqual([UUID])
  })

  it('takes a PeerTube item off the list when played to its end', async () => {
    store.setGetter('getIsInLater', id => id === UUID)
    const { wrapper } = await openWatchPage(playableVideo())

    findPlayer(wrapper).vm.$emit('ended')

    expect(dispatched('removeFromLater')).toEqual([UUID])
  })

  it('takes a queued item off the list when played to its end, and not an armed one', async () => {
    store.setGetter('getIsInLater', () => true)
    const { wrapper } = await openWatchPage(youtubeVideo(), YT_PATH)

    findPlayer(wrapper).vm.$emit('ended')
    expect(dispatched('removeFromLater')).toEqual([YT_ID])

    store.dispatched.length = 0
    store.setGetter('getIsArmed', () => true)
    findPlayer(wrapper).vm.$emit('ended')
    expect(dispatched('removeFromLater')).toEqual([])
  })

  it('takes nothing off for leaving halfway', async () => {
    store.setGetter('getIsInLater', () => true)
    const { router } = await openWatchPage(youtubeVideo(), YT_PATH)

    await router.push('/elsewhere')
    await flushPromises()

    expect(dispatched('removeFromLater')).toEqual([])
  })
})

describe('an armed Later item gone live on its own page', () => {
  it('reloads into the stream when the store says it fired', async () => {
    await openWatchPage(youtubeVideo({ isUpcoming: true, liveStatus: 'waiting', premiereDate: new Date(Date.now() + 60_000) }), YT_PATH)
    expect(layer.getVideo).toHaveBeenCalledTimes(1)

    layer.getVideo.mockResolvedValue(youtubeLive())
    store.setGetter('getLaterFiredVideo', { videoId: YT_ID, at: 1 })
    await flushPromises()

    expect(layer.getVideo).toHaveBeenCalledTimes(2)
  })

  it('does not reload for another video', async () => {
    await openWatchPage(youtubeVideo(), YT_PATH)

    store.setGetter('getLaterFiredVideo', { videoId: 'otherVideo1', at: 1 })
    await flushPromises()

    expect(layer.getVideo).toHaveBeenCalledTimes(1)
  })
})
