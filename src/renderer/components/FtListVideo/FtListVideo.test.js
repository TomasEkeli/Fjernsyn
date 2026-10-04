import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import thumbnailPlaceholder from '../../assets/img/thumbnail_placeholder.svg'
import { copyToClipboard, openExternalLink, showToast } from '../../helpers/utils'
import { deArrowData, deArrowThumbnail } from '../../helpers/sponsorblock'
import { wantAiVerdict } from '../../helpers/aiMarker/index'
import { describe as describeEntity } from '../../platform/describe'
import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'
import { createTestRouter } from '../../testing/router'
import FtIconButton from '../FtIconButton/FtIconButton.vue'
import FtListVideo from './FtListVideo.vue'

// What the card reads of the settings, as the defaults have them, but with
// DeArrow and SponsorBlock on, so that a test can see they are not asked
const SETTINGS = vi.hoisted(() => ({
  getHistoryCacheById: {},
  getListType: 'grid',
  getThumbnailPreference: '',
  getBlurThumbnails: false,
  getBackendPreference: 'local',
  getBackendFallback: true,
  getCurrentInvidiousInstanceUrl: 'https://inv.example',
  getHidePlaylists: false,
  getPlaylist: () => undefined,
  getChannelsHidden: '[]',
  getUseSponsorBlock: true,
  getSponsorBlockExcludedChannels: '[]',
  getHideSharingActions: false,
  getHideVideoViews: false,
  getExternalPlayer: '',
  getDefaultViewingMode: 'default',
  getDefaultPlayback: 1,
  getWatchedProgressSavingMode: 'auto',
  getRememberHistory: false,
  getSaveVideoHistoryWithLastViewedPlaylist: true,
  getShowDistractionFreeTitles: false,
  getQuickBookmarkPlaylist: null,
  getUseDeArrowTitles: true,
  getUseDeArrowThumbnails: true,
  getDeArrowCache: {},
  getDisableChannelLinks: false,
  getAiVerdicts: {},
  getAiChannels: '[]',
  getHideAiVideos: false,
  getIsInLater: () => false,
  getIsArmed: () => false,
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

// The lookup as the tile sees it: a request on mount, and its release on unmount
vi.mock('../../helpers/aiMarker/index', () => ({
  wantAiVerdict: vi.fn(() => vi.fn()),
}))

vi.mock('../../helpers/sponsorblock', () => ({
  deArrowData: vi.fn(async () => null),
  deArrowThumbnail: vi.fn(async () => null),
}))

// The layer as the wiring builds it, from the same settings the card reads
vi.mock('../../platform/vue', async () => {
  const { describe } = await import('../../platform/describe')
  const { default: store } = await import('../../store/index')

  return {
    getPlatformLayer: () => ({
      describe: (entity, options) => describe(entity, {
        backendPreference: store.getters.getBackendPreference,
        currentInvidiousInstanceUrl: store.getters.getCurrentInvidiousInstanceUrl,
        thumbnailPreference: store.getters.getThumbnailPreference,
      }, options),
    }),
  }
})

const HOST = 'video.blender.org'
const UUID = 'b29290cc-dc51-4a12-bcb2-2aa5fece7605'
const HANDLE = 'blender@video.blender.org'
const THUMBNAIL = 'https://video.blender.org/lazy-static/previews/sprite-fright.jpg'
const WATCH_URL = `https://${HOST}/videos/watch/${UUID}`

const PEERTUBE_VIDEO = {
  type: 'video',
  videoId: UUID,
  platform: 'peertube',
  host: HOST,
  thumbnail: THUMBNAIL,
  title: 'Sprite Fright',
  author: 'Blender',
  authorId: HANDLE,
  lengthSeconds: 629,
  published: Date.parse('2021-10-29T00:00:00Z'),
  viewCount: 1234,
  liveNow: false,
}

const YOUTUBE_ID = 'dQw4w9WgXcQ'
const CHANNEL_ID = 'UCuAXFkgsw1L7xaCfnd5JJOw'

const YOUTUBE_VIDEO = {
  type: 'video',
  videoId: YOUTUBE_ID,
  title: 'Never Gonna Give You Up',
  author: 'Rick Astley',
  authorId: CHANNEL_ID,
  lengthSeconds: 213,
  published: Date.parse('2009-10-25T00:00:00Z'),
  viewCount: 1600000000,
  liveNow: false,
}

/**
 * @param {object} data
 * @param {Record<string, any>} [props]
 */
async function mountCard(data, props = {}) {
  const router = createTestRouter([{ path: '/search/:query', name: 'search' }])
  await router.push('/search/x')

  const wrapper = mountWithApp(FtListVideo, {
    store,
    router,
    props: { data, appearance: 'result', ...props },
  })

  return { wrapper, router }
}

/** @param {import('@vue/test-utils').VueWrapper} wrapper */
function optionsButton(wrapper) {
  return wrapper.findAllComponents(FtIconButton).find(button => button.classes('optionsButton'))
}

/** @param {import('@vue/test-utils').VueWrapper} wrapper */
function optionValues(wrapper) {
  return optionsButton(wrapper).props('dropdownOptions').map(option => option.value).filter(Boolean)
}

beforeEach(() => {
  window.ftElectron = { openInExternalPlayer: vi.fn() }
})

afterEach(() => {
  for (const [name, value] of Object.entries(SETTINGS)) {
    store.setGetter(name, value)
  }
  vi.clearAllMocks()
  delete window.ftElectron
})

describe('FtListVideo, a PeerTube video', () => {
  it('links to its own watch page, with its own thumbnail', async () => {
    const { wrapper, router } = await mountCard(PEERTUBE_VIDEO)

    expect(wrapper.find('a.thumbnailLink').attributes('href')).toBe(`/peertube/watch/${HOST}/${UUID}`)
    expect(wrapper.find('a.title').attributes('href')).toBe(`/peertube/watch/${HOST}/${UUID}`)
    expect(wrapper.find('img.thumbnailImage').attributes('src')).toBe(THUMBNAIL)

    await wrapper.find('a.title').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe(`/peertube/watch/${HOST}/${UUID}`)
    expect(router.currentRoute.value.query).toEqual({})
  })

  it('opens on its own from a user playlist: no playlist query', async () => {
    const { wrapper } = await mountCard(PEERTUBE_VIDEO, { playlistId: 'abc', playlistType: 'user', playlistItemId: 'item' })

    expect(wrapper.find('a.title').attributes('href')).toBe(`/peertube/watch/${HOST}/${UUID}`)
  })

  it('still shows the placeholder when thumbnails are hidden', async () => {
    store.setGetter('getThumbnailPreference', 'hidden')
    const { wrapper } = await mountCard(PEERTUBE_VIDEO)

    expect(wrapper.find('img.thumbnailImage').attributes('src')).toBe(thumbnailPlaceholder)
  })

  it('takes the same thumbnail whatever the frame preference or card size', async () => {
    store.setGetter('getThumbnailPreference', 'middle')
    store.setGetter('getListType', 'list')
    const { wrapper } = await mountCard(PEERTUBE_VIDEO)

    expect(wrapper.find('img.thumbnailImage').attributes('src')).toBe(THUMBNAIL)
  })

  it("links its channel name to the channel's PeerTube page", async () => {
    const { wrapper } = await mountCard(PEERTUBE_VIDEO)

    expect(wrapper.find('a.channelName').attributes('href')).toBe(`/peertube/channel/${HANDLE}`)
    expect(wrapper.find('a.channelName').text()).toBe('Blender')
  })

  it('does not ask DeArrow about it', async () => {
    await mountCard(PEERTUBE_VIDEO)
    await flushPromises()

    expect(deArrowData).not.toHaveBeenCalled()
    expect(deArrowThumbnail).not.toHaveBeenCalled()
  })

  it('shares its canonical links, never a YouTube or Invidious one, and has no SponsorBlock entry', async () => {
    const { wrapper } = await mountCard(PEERTUBE_VIDEO)

    expect(optionValues(wrapper)).toEqual([
      'history',
      'copyPlatformLink',
      'openPlatformLink',
      'copyPlatformChannelLink',
      'openPlatformChannelLink',
      'hideChannel',
    ])

    optionsButton(wrapper).vm.$emit('click', 'copyPlatformLink')
    expect(copyToClipboard).toHaveBeenCalledWith(WATCH_URL, { messageOnSuccess: 'Link copied' })

    optionsButton(wrapper).vm.$emit('click', 'openPlatformChannelLink')
    expect(openExternalLink).toHaveBeenCalledWith(`https://${HOST}/video-channels/blender`)
  })

  it('shares nothing when sharing actions are hidden', async () => {
    store.setGetter('getHideSharingActions', true)
    const { wrapper } = await mountCard(PEERTUBE_VIDEO)

    expect(optionValues(wrapper)).toEqual(['history', 'hideChannel'])
  })

  it('hands the external player its PeerTube watch URL, and no playlist', async () => {
    store.setGetter('getExternalPlayer', 'mpv')
    store.setGetter('getDefaultViewingMode', 'external_player')
    const { wrapper } = await mountCard(PEERTUBE_VIDEO, { playlistId: 'PLx', playlistIndex: 3 })

    await wrapper.find('a.title').trigger('click')

    expect(window.ftElectron.openInExternalPlayer).toHaveBeenCalledTimes(1)
    expect(window.ftElectron.openInExternalPlayer.mock.calls[0][0]).toMatchObject({
      videoUrl: WATCH_URL,
      playlistId: null,
      playlistIndex: null,
      startTime: 0,
      playbackRate: 1,
    })
  })
})

describe('FtListVideo, a YouTube video (today\'s behaviour, pinned)', () => {
  it('links to the YouTube watch page, with the large ytimg thumbnail on a grid', async () => {
    const { wrapper } = await mountCard(YOUTUBE_VIDEO)

    expect(wrapper.find('a.thumbnailLink').attributes('href')).toBe(`/watch/${YOUTUBE_ID}`)
    expect(wrapper.find('img.thumbnailImage').attributes('src')).toBe(`https://i.ytimg.com/vi/${YOUTUBE_ID}/hq720.jpg`)
  })

  it('takes the small ytimg thumbnail as a list card', async () => {
    store.setGetter('getListType', 'list')
    const { wrapper } = await mountCard(YOUTUBE_VIDEO)

    expect(wrapper.find('img.thumbnailImage').attributes('src')).toBe(`https://i.ytimg.com/vi/${YOUTUBE_ID}/mqdefault.jpg`)
    // describe reproduces the same rule
    expect(wrapper.find('img.thumbnailImage').attributes('src'))
      .toBe(describeEntity(YOUTUBE_VIDEO, { backendPreference: 'local', thumbnailPreference: '' }).thumbnail)
  })

  it('keeps the playlist query on the watch route', async () => {
    const { wrapper } = await mountCard(YOUTUBE_VIDEO, { playlistId: 'PLabc', playlistType: 'user', playlistItemId: 'item' })

    expect(wrapper.find('a.title').attributes('href'))
      .toBe(`/watch/${YOUTUBE_ID}?playlistId=PLabc&playlistType=user&playlistItemId=item`)
  })

  it('links its channel to /channel/UC…', async () => {
    const { wrapper } = await mountCard(YOUTUBE_VIDEO)

    expect(wrapper.find('a.channelName').attributes('href')).toBe(`/channel/${CHANNEL_ID}`)
  })

  it('asks DeArrow when DeArrow is on', async () => {
    await mountCard(YOUTUBE_VIDEO)

    expect(deArrowData).toHaveBeenCalledWith(YOUTUBE_ID)
  })

  it('keeps its YouTube and Invidious share entries and the SponsorBlock one', async () => {
    const { wrapper } = await mountCard(YOUTUBE_VIDEO)

    expect(optionValues(wrapper)).toEqual([
      'history',
      'copyYoutube',
      'copyYoutubeEmbed',
      'copyInvidious',
      'openYoutube',
      'openYoutubeEmbed',
      'openInvidious',
      'copyYoutubeChannel',
      'copyInvidiousChannel',
      'openYoutubeChannel',
      'openInvidiousChannel',
      'hideChannel',
      'markChannelAi',
      'disableSponsorBlockOnChannel',
    ])

    optionsButton(wrapper).vm.$emit('click', 'copyYoutube')
    expect(copyToClipboard).toHaveBeenCalledWith(`https://youtu.be/${YOUTUBE_ID}`, expect.anything())
  })

  it('hands the external player the video id, with no URL', async () => {
    store.setGetter('getExternalPlayer', 'mpv')
    store.setGetter('getDefaultViewingMode', 'external_player')
    const { wrapper } = await mountCard(YOUTUBE_VIDEO, { playlistId: 'PLabc', playlistIndex: 3 })

    await wrapper.find('a.title').trigger('click')

    const payload = window.ftElectron.openInExternalPlayer.mock.calls[0][0]
    expect(payload).toMatchObject({ videoId: YOUTUBE_ID, playlistId: 'PLabc', playlistIndex: 3 })
    expect(payload).not.toHaveProperty('videoUrl')
  })
})

describe('FtListVideo, the records a card writes', () => {
  const NOW = Date.parse('2026-09-27T12:00:00Z')
  const QUICK_BOOKMARK = { _id: 'favorites', playlistName: 'Favorites', videos: [] }

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    store.dispatched.length = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * @param {import('@vue/test-utils').VueWrapper} wrapper
   * @param {string} className
   */
  function clickIcon(wrapper, className) {
    wrapper.findAllComponents(FtIconButton).find(button => button.classes(className)).vm.$emit('click')
  }

  /** @param {string} type */
  function payloadsOf(type) {
    return store.dispatched.filter(action => action.type === type).map(action => action.payload)
  }

  it('marks a PeerTube video as watched with its platform, host and thumbnail, and a plain-text description', async () => {
    const { wrapper } = await mountCard({ ...PEERTUBE_VIDEO, description: '<a href="https://evil.example">Open</a> <img src=x onerror=alert(1)> movie' })

    clickIcon(wrapper, 'markWatchedIcon')

    expect(payloadsOf('updateHistory')).toStrictEqual([{
      videoId: UUID,
      title: 'Sprite Fright',
      author: 'Blender',
      authorId: HANDLE,
      published: PEERTUBE_VIDEO.published,
      description: 'Open  movie',
      viewCount: 1234,
      lengthSeconds: 629,
      watchProgress: 0,
      timeWatched: NOW,
      isLive: false,
      isStation: false,
      isPremiere: false,
      type: 'video',
      platform: 'peertube',
      host: HOST,
      thumbnail: THUMBNAIL,
    }])
  })

  it('saves a PeerTube video to a playlist with its platform, host and thumbnail', async () => {
    const { wrapper } = await mountCard(PEERTUBE_VIDEO)

    clickIcon(wrapper, 'addToPlaylistIcon')

    expect(payloadsOf('showAddToPlaylistPromptForManyVideos')).toStrictEqual([{
      videos: [{
        videoId: UUID,
        title: 'Sprite Fright',
        author: 'Blender',
        authorId: HANDLE,
        description: undefined,
        viewCount: 1234,
        lengthSeconds: 629,
        published: PEERTUBE_VIDEO.published,
        premiereDate: undefined,
        premiereTimestamp: undefined,
        platform: 'peertube',
        host: HOST,
        thumbnail: THUMBNAIL,
      }],
    }])
  })

  it('quick bookmarks a PeerTube video with its platform, host and thumbnail', async () => {
    store.setGetter('getQuickBookmarkPlaylist', QUICK_BOOKMARK)
    const { wrapper } = await mountCard(PEERTUBE_VIDEO)

    clickIcon(wrapper, 'quickBookmarkVideoIcon')

    expect(payloadsOf('addVideo')).toStrictEqual([{
      _id: 'favorites',
      videoData: {
        videoId: UUID,
        title: 'Sprite Fright',
        author: 'Blender',
        authorId: HANDLE,
        lengthSeconds: 629,
        published: PEERTUBE_VIDEO.published,
        premiereDate: undefined,
        premiereTimestamp: undefined,
        platform: 'peertube',
        host: HOST,
        thumbnail: THUMBNAIL,
      },
    }])
  })

  it('writes a YouTube history entry exactly as today, key for key', async () => {
    const { wrapper } = await mountCard({ ...YOUTUBE_VIDEO, description: '<b>bold</b>' })

    clickIcon(wrapper, 'markWatchedIcon')

    const [entry] = payloadsOf('updateHistory')
    expect(Object.keys(entry)).toEqual([
      'videoId', 'title', 'author', 'authorId', 'published', 'description', 'viewCount',
      'lengthSeconds', 'watchProgress', 'timeWatched', 'isLive', 'isStation', 'isPremiere', 'type',
    ])
    expect(entry).toStrictEqual({
      videoId: YOUTUBE_ID,
      title: 'Never Gonna Give You Up',
      author: 'Rick Astley',
      authorId: CHANNEL_ID,
      published: YOUTUBE_VIDEO.published,
      description: '<b>bold</b>',
      viewCount: 1600000000,
      lengthSeconds: 213,
      watchProgress: 0,
      timeWatched: NOW,
      isLive: false,
      isStation: false,
      isPremiere: false,
      type: 'video',
    })
  })

  it('saves a YouTube video to a playlist exactly as today, key for key', async () => {
    const { wrapper } = await mountCard(YOUTUBE_VIDEO)

    clickIcon(wrapper, 'addToPlaylistIcon')

    const [{ videos: [video] }] = payloadsOf('showAddToPlaylistPromptForManyVideos')
    expect(Object.keys(video)).toEqual([
      'videoId', 'title', 'author', 'authorId', 'description', 'viewCount',
      'lengthSeconds', 'published', 'premiereDate', 'premiereTimestamp',
    ])
    expect(video).not.toHaveProperty('platform')
  })

  it('quick bookmarks a YouTube video exactly as today, key for key', async () => {
    store.setGetter('getQuickBookmarkPlaylist', QUICK_BOOKMARK)
    const { wrapper } = await mountCard(YOUTUBE_VIDEO)

    clickIcon(wrapper, 'quickBookmarkVideoIcon')

    const [{ videoData }] = payloadsOf('addVideo')
    expect(Object.keys(videoData)).toEqual([
      'videoId', 'title', 'author', 'authorId', 'lengthSeconds', 'published', 'premiereDate', 'premiereTimestamp',
    ])
  })
})

describe('FtListVideo, the AI marker', () => {
  const MARKED = JSON.stringify([{ id: CHANNEL_ID, name: 'Rick Astley' }])

  beforeEach(() => {
    store.dispatched.length = 0
  })

  /** @param {import('@vue/test-utils').VueWrapper} wrapper */
  function aiMarker(wrapper) {
    return wrapper.findAll('.kindMarker').find(marker => marker.classes('ai'))
  }

  it('is carried by a video YouTube labels made with AI, saying the creator declared it', async () => {
    store.setGetter('getAiVerdicts', { [YOUTUBE_ID]: true })
    const { wrapper } = await mountCard(YOUTUBE_VIDEO)

    expect(aiMarker(wrapper).text()).toBe('AI')
    expect(aiMarker(wrapper).attributes('title')).toBe('The creator told YouTube this video was made with AI')
  })

  it('is carried by a video from a channel marked as AI, saying the user marked it', async () => {
    store.setGetter('getAiChannels', MARKED)
    const { wrapper } = await mountCard(YOUTUBE_VIDEO)

    expect(aiMarker(wrapper).attributes('title')).toBe('From a channel you marked as AI')
  })

  it('is not carried by a video labelled not-ai, nor by one not yet known', async () => {
    store.setGetter('getAiVerdicts', { [YOUTUBE_ID]: false })
    const { wrapper: notAi } = await mountCard(YOUTUBE_VIDEO)
    store.setGetter('getAiVerdicts', {})
    const { wrapper: unknown } = await mountCard(YOUTUBE_VIDEO)

    expect(aiMarker(notAi)).toBeUndefined()
    expect(aiMarker(unknown)).toBeUndefined()
  })

  it('arrives on a card already shown, when the verdict does', async () => {
    const { wrapper } = await mountCard(YOUTUBE_VIDEO)
    expect(aiMarker(wrapper)).toBeUndefined()

    store.setGetter('getAiVerdicts', { [YOUTUBE_ID]: true })
    await flushPromises()

    expect(aiMarker(wrapper)).toBeDefined()
  })

  it('stands beside the kind marker, not in its place', async () => {
    store.setGetter('getAiVerdicts', { [YOUTUBE_ID]: true })
    const { wrapper } = await mountCard({ ...YOUTUBE_VIDEO, type: 'shortVideo' })

    expect(wrapper.findAll('.kindMarker').map(marker => marker.text())).toEqual(['Short', 'AI'])
  })

  it('asks for the verdict on mount where the wall looks up, and lets it go on unmount', async () => {
    const { wrapper } = await mountCard(YOUTUBE_VIDEO, { lookUpAiLabel: true })

    expect(wantAiVerdict).toHaveBeenCalledWith(YOUTUBE_VIDEO)
    const release = wantAiVerdict.mock.results[0].value
    expect(release).not.toHaveBeenCalled()

    wrapper.unmount()

    expect(release).toHaveBeenCalledTimes(1)
  })

  it('asks nothing where the wall does not look up', async () => {
    await mountCard(YOUTUBE_VIDEO)

    expect(wantAiVerdict).not.toHaveBeenCalled()
  })

  it('offers to mark its channel as AI, and marks it with a toast', async () => {
    const { wrapper } = await mountCard(YOUTUBE_VIDEO)

    optionsButton(wrapper).vm.$emit('click', 'markChannelAi')

    expect(store.dispatched).toEqual([{ type: 'updateAiChannels', payload: MARKED }])
    expect(showToast).toHaveBeenCalledWith('Rick Astley marked as AI')
  })

  it('offers to unmark a marked channel, and unmarks it with a toast', async () => {
    store.setGetter('getAiChannels', MARKED)
    const { wrapper } = await mountCard(YOUTUBE_VIDEO)

    expect(optionValues(wrapper)).toContain('unmarkChannelAi')
    expect(optionValues(wrapper)).not.toContain('markChannelAi')

    optionsButton(wrapper).vm.$emit('click', 'unmarkChannelAi')

    expect(store.dispatched).toEqual([{ type: 'updateAiChannels', payload: '[]' }])
    expect(showToast).toHaveBeenCalledWith('Rick Astley no longer marked as AI')
  })

  it('offers no marking for a video whose channel is not known', async () => {
    const { authorId, ...withoutChannel } = YOUTUBE_VIDEO
    const { wrapper } = await mountCard(withoutChannel)

    expect(authorId).toBe(CHANNEL_ID)
    expect(optionValues(wrapper)).not.toContain('markChannelAi')
  })

  it('never carries the marker on a PeerTube video, nor offers marking its channel', async () => {
    store.setGetter('getAiVerdicts', { [UUID]: true })
    store.setGetter('getAiChannels', JSON.stringify([{ id: HANDLE, name: 'Blender' }]))
    const { wrapper } = await mountCard(PEERTUBE_VIDEO, { lookUpAiLabel: true })

    expect(aiMarker(wrapper)).toBeUndefined()
    expect(optionValues(wrapper)).not.toContain('markChannelAi')
    expect(optionValues(wrapper)).not.toContain('unmarkChannelAi')
  })
})

describe('FtListVideo, the Later buttons', () => {
  const NOW = Date.parse('2026-10-04T12:00:00Z')
  const UPCOMING = { ...YOUTUBE_VIDEO, isUpcoming: true, premiereDate: new Date(NOW + 60 * 60 * 1000) }

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    store.dispatched.length = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** @param {import('@vue/test-utils').VueWrapper} wrapper */
  function button(wrapper, className) {
    return wrapper.findAllComponents(FtIconButton).find(b => b.classes(className))
  }

  it('shows the clock on a YouTube card, and adds the video to Later', async () => {
    const { wrapper } = await mountCard(YOUTUBE_VIDEO)

    button(wrapper, 'laterIcon').vm.$emit('click')

    expect(store.dispatched).toEqual([{ type: 'addToLater', payload: expect.objectContaining({ videoId: YOUTUBE_ID, title: 'Never Gonna Give You Up' }) }])
    expect(button(wrapper, 'armIcon')).toBeUndefined()
  })

  it('removes a video already there', async () => {
    store.setGetter('getIsInLater', () => true)
    const { wrapper } = await mountCard(YOUTUBE_VIDEO)

    button(wrapper, 'laterIcon').vm.$emit('click')

    expect(store.dispatched).toEqual([{ type: 'removeFromLater', payload: YOUTUBE_ID }])
  })

  it('offers to arm an upcoming card whose time is ahead, for its stated time', async () => {
    const { wrapper } = await mountCard(UPCOMING)

    button(wrapper, 'armIcon').vm.$emit('click')

    expect(store.dispatched).toEqual([{ type: 'arm', payload: { video: expect.objectContaining({ videoId: YOUTUBE_ID }), at: NOW + 60 * 60 * 1000 } }])
  })

  it('does not offer to arm one whose time has passed, unless it is armed', async () => {
    const past = { ...UPCOMING, premiereDate: new Date(NOW - 1000) }
    expect(button((await mountCard(past)).wrapper, 'armIcon')).toBeUndefined()

    store.setGetter('getIsArmed', () => true)
    const { wrapper } = await mountCard(past)
    button(wrapper, 'armIcon').vm.$emit('click')
    expect(store.dispatched).toEqual([{ type: 'disarm', payload: YOUTUBE_ID }])
  })

  it('shows no clock on the Later page, and the calendar only on its queued rows', async () => {
    const queuedRow = (await mountCard(UPCOMING, { laterRow: true })).wrapper
    expect(button(queuedRow, 'laterIcon')).toBeUndefined()
    expect(button(queuedRow, 'armIcon')).toBeDefined()

    store.setGetter('getIsArmed', () => true)
    const armedRow = (await mountCard(UPCOMING, { laterRow: true })).wrapper
    expect(button(armedRow, 'armIcon')).toBeUndefined()
  })

  it('shows neither on a PeerTube card', async () => {
    const { wrapper } = await mountCard(PEERTUBE_VIDEO)
    expect(button(wrapper, 'laterIcon')).toBeUndefined()
    expect(button(wrapper, 'armIcon')).toBeUndefined()
  })

  it('gives the Later page its move and remove buttons, with no playlist in the link', async () => {
    const { wrapper } = await mountCard(YOUTUBE_VIDEO, { laterRow: true, canMoveVideoUp: true, canRemoveFromPlaylist: true, playlistItemId: YOUTUBE_ID })

    expect(button(wrapper, 'upArrowIcon')).toBeDefined()
    button(wrapper, 'trashIcon').vm.$emit('click')
    expect(wrapper.emitted('remove-from-playlist')).toEqual([[YOUTUBE_ID, YOUTUBE_ID]])
    expect(wrapper.find('a.thumbnailLink').attributes('href')).not.toContain('playlist')
  })
})
