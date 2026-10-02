import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { RouterView } from 'vue-router'

import { openExternalLink } from '../../helpers/utils'
import { describe as describeEntity } from '../../platform/describe'
import { PlatformError } from '../../platform/errors'
import { PLATFORM_LAYER_KEY, isPeerTubeEnabled } from '../../platform/vue'
import store from '../../store/index'
import { createTestI18n } from '../../testing/i18n'
import { createTestRouter } from '../../testing/router'
import LayerChannel from './LayerChannel.vue'

// The cards are the shared components' own (and under test with them); here
// the list only has to show what the view handed it. A playlist is shown by
// its real card, whose link to the app's playlist page is what a YouTube
// channel's playlists tab is for.
vi.mock('../../components/FtElementList/FtElementList.vue', async () => {
  const { defineComponent, h } = await import('vue')
  const { default: FtListPlaylist } = await import('../../components/FtListPlaylist/FtListPlaylist.vue')

  return {
    default: defineComponent({
      name: 'FtElementList',
      props: {
        data: { type: Array, required: true },
        useChannelsHiddenPreference: { type: Boolean, default: true },
      },
      setup: (props) => () => h('ul', { class: 'fakeElementList' }, props.data.map(item => item.type === 'playlist'
        ? h('li', { class: 'fakePlaylistCard' }, [h(FtListPlaylist, { data: item, appearance: 'result' })])
        : h('li', { class: 'fakeCard' }, item.title))),
    }),
  }
})

const ALL_CHANNELS = vi.hoisted(() => ({
  _id: 'allChannels',
  name: 'All Channels',
  bgColor: '#000000',
  textColor: '#FFFFFF',
  subscriptions: [],
}))

// What the view and the components it uses read of the settings
const SETTINGS = vi.hoisted(() => ({
  getHideChannelSubscriptions: false,
  getHideUnsubscribeButton: false,
  getProfileList: [ALL_CHANNELS],
  getActiveProfile: ALL_CHANNELS,
  getUnsubscriptionPopupStatus: false,
  getGeneralAutoLoadMorePaginatedItemsEnabled: false,
  getThumbnailPreference: '',
  getShowFamilyFriendlyOnly: false,
  // The playlist card's
  getListType: 'grid',
  getBlurThumbnails: false,
  getBackendPreference: 'local',
  getCurrentInvidiousInstanceUrl: '',
  getQuickBookmarkTargetPlaylistId: null,
  getExternalPlayer: '',
  getDefaultPlayback: 1,
  getDisableChannelLinks: false,
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
const HANDLE = 'blender@video.blender.org'
const CHANNEL_PATH = `/peertube/channel/${HANDLE}`
const AVATAR_SMALL = 'https://video.blender.org/lazy-static/avatars/blender-48.png'
const AVATAR_LARGE = 'https://video.blender.org/lazy-static/avatars/blender-600.png'
const BANNER = 'https://video.blender.org/lazy-static/banners/blender-1920.jpg'

/** @param {object} [overrides] */
function channelDetails(overrides = {}) {
  return {
    platform: 'peertube',
    host: HOST,
    id: HANDLE,
    handle: HANDLE,
    name: 'Blender',
    thumbnail: AVATAR_SMALL,
    url: `https://${HOST}/video-channels/blender`,
    subscriberCount: 1234,
    avatarLarge: AVATAR_LARGE,
    banner: BANNER,
    description: 'The *official* channel of the Blender project.',
    descriptionKind: 'markdown',
    support: null,
    ...overrides,
  }
}

/** A card-ready video summary, as the layer lists them */
function video(n) {
  return {
    type: 'video',
    platform: 'peertube',
    host: HOST,
    videoId: `b29290cc-dc51-4a12-bcb2-${String(n).padStart(12, '0')}`,
    title: `Video ${n}`,
    author: 'Blender',
    authorId: HANDLE,
    thumbnail: `https://${HOST}/lazy-static/thumbnails/${n}.jpg`,
    lengthSeconds: 60,
    published: Date.UTC(2024, 0, n),
    viewCount: n * 100,
    liveNow: false,
    isUpcoming: false,
    nsfw: false,
  }
}

function playlist(n) {
  const playlistId = `7243ebe1-8a4c-4d1b-9a4f-${String(n).padStart(12, '0')}`

  return {
    type: 'playlist',
    platform: 'peertube',
    host: HOST,
    playlistId,
    title: `Playlist ${n}`,
    thumbnail: `https://${HOST}/lazy-static/thumbnails/playlist-${n}.jpg`,
    videoCount: n * 3,
    url: `https://${HOST}/w/p/${playlistId}`,
    description: '',
    channelName: 'Blender',
    channelId: HANDLE,
  }
}

const layer = {
  getChannel: vi.fn(),
  listChannelVideos: vi.fn(),
  listChannelPlaylists: vi.fn(),
  describe: (entity, options) => describeEntity(entity, {}, options),
}

beforeEach(() => {
  for (const [name, value] of Object.entries(SETTINGS)) {
    store.state.fakeGetterValues[name] = value
  }
  store.setGetter('getProfileList', [{ ...ALL_CHANNELS, subscriptions: [] }])
  store.setGetter('getActiveProfile', store.getters.getProfileList[0])
  store.dispatched.length = 0
  store.committed.length = 0

  layer.getChannel.mockReset().mockResolvedValue(channelDetails())
  layer.listChannelVideos.mockReset().mockResolvedValue({ items: [video(1), video(2)], cursor: null })
  layer.listChannelPlaylists.mockReset().mockResolvedValue({ items: [playlist(1)], cursor: null })

  openExternalLink.mockClear()
  isPeerTubeEnabled.mockReset().mockReturnValue(true)
})

const openPages = []

afterEach(() => {
  for (const wrapper of openPages.splice(0)) {
    wrapper.unmount()
  }
})

/**
 * Opens the channel page as the app would host it: in a router view, with
 * the layer provided
 *
 * @param {string} [path]
 */
async function openChannelPage(path = CHANNEL_PATH) {
  const router = createTestRouter([
    { path: '/peertube/channel/:handle/:currentTab?', name: 'peertubeChannel', component: LayerChannel },
    { path: '/peertube/watch/:host/:uuid', name: 'peertubeWatch' },
    // YouTube's, unnamed as in the app's router
    { path: '/channel/:id/:currentTab?', component: LayerChannel },
    { path: '/playlist/:id' },
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

function cardTitles(wrapper) {
  return wrapper.findAll('.fakeCard').map(card => card.text())
}

function fetchMore(wrapper) {
  return wrapper.find('.getNextPage')
}

function dispatched(type) {
  return store.dispatched.filter(action => action.type === type).map(action => action.payload)
}

/**
 * A promise the test settles, for a request still in flight
 */
function deferred() {
  let settle
  const promise = new Promise((resolve) => { settle = resolve })
  return { promise, resolve: (value) => settle(value) }
}

describe('the layer channel page header', () => {
  it('asks the layer for the channel the route names', async () => {
    await openChannelPage()

    expect(layer.getChannel).toHaveBeenCalledWith(HANDLE)
  })

  it('shows the banner, the large avatar, the name, the handle and the follower count', async () => {
    const { wrapper } = await openChannelPage()

    expect(wrapper.find(`img.banner[src="${BANNER}"]`).exists()).toBe(true)
    expect(wrapper.find(`img.avatar[src="${AVATAR_LARGE}"]`).exists()).toBe(true)
    expect(wrapper.find('h1').text()).toBe('Blender')
    expect(wrapper.find('.handle').text()).toBe(HANDLE)
    expect(wrapper.find('.followerCount').text()).toBe('1,234 followers')
  })

  it('renders the description from its Markdown', async () => {
    const { wrapper } = await openChannelPage()

    expect(wrapper.find('.layerMarkdown em').text()).toBe('official')
  })

  it('has no banner when the channel has none, and no avatar image for a missing avatar', async () => {
    layer.getChannel.mockResolvedValue(channelDetails({ banner: null, avatarLarge: '' }))
    const { wrapper } = await openChannelPage()

    expect(wrapper.find('.banner').exists()).toBe(false)
    expect(wrapper.find('img.avatar').exists()).toBe(false)
  })

  it('hides the follower count when subscriber counts are hidden', async () => {
    store.setGetter('getHideChannelSubscriptions', true)
    const { wrapper } = await openChannelPage()

    expect(wrapper.find('.followerCount').exists()).toBe(false)
  })

  it('titles the window with the channel name', async () => {
    await openChannelPage()

    expect(store.committed).toContainEqual({ type: 'setAppTitle', payload: 'Blender' })
  })
})

describe('the videos tab', () => {
  it('is where the page opens, newest first', async () => {
    const { wrapper } = await openChannelPage()

    expect(layer.listChannelVideos).toHaveBeenCalledWith(HANDLE, { sort: 'newest', cursor: null })
    expect(cardTitles(wrapper)).toEqual(['Video 1', 'Video 2'])
    expect(wrapper.find('#videosTab').classes()).toContain('selectedTab')
  })

  it('hands the cards the summaries as the layer gave them', async () => {
    const { wrapper } = await openChannelPage()

    expect(wrapper.findComponent({ name: 'FtElementList' }).props()).toEqual({
      data: [video(1), video(2)],
      useChannelsHiddenPreference: false,
    })
  })

  it('asks again, sorted as chosen, and replaces the list', async () => {
    const { wrapper } = await openChannelPage()
    layer.listChannelVideos.mockResolvedValue({ items: [video(9)], cursor: null })

    await wrapper.find('select').setValue('popular')
    await flushPromises()

    expect(layer.listChannelVideos).toHaveBeenLastCalledWith(HANDLE, { sort: 'popular', cursor: null })
    expect(cardTitles(wrapper)).toEqual(['Video 9'])

    await wrapper.find('select').setValue('oldest')
    await flushPromises()

    expect(layer.listChannelVideos).toHaveBeenLastCalledWith(HANDLE, { sort: 'oldest', cursor: null })
  })

  it('offers the three sorts by their names', async () => {
    const { wrapper } = await openChannelPage()

    expect(wrapper.findAll('option').map(option => [option.element.value, option.text()])).toEqual([
      ['newest', 'Newest'],
      ['popular', 'Most Popular'],
      ['oldest', 'Oldest'],
    ])
  })

  it('ignores the answer for a sort that has since been changed', async () => {
    const { wrapper } = await openChannelPage()
    const slow = deferred()
    layer.listChannelVideos.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ items: [video(7)], cursor: null })

    await wrapper.find('select').setValue('popular')
    await wrapper.find('select').setValue('oldest')
    await flushPromises()
    slow.resolve({ items: [video(5)], cursor: null })
    await flushPromises()

    expect(cardTitles(wrapper)).toEqual(['Video 7'])
  })

  it('appends the next page, in the same sort, until the cursor is null', async () => {
    layer.listChannelVideos
      .mockResolvedValueOnce({ items: [video(1), video(2)], cursor: 2 })
      .mockResolvedValueOnce({ items: [video(3)], cursor: null })
    const { wrapper } = await openChannelPage()

    await fetchMore(wrapper).trigger('click')
    await flushPromises()

    expect(layer.listChannelVideos).toHaveBeenLastCalledWith(HANDLE, { sort: 'newest', cursor: 2 })
    expect(cardTitles(wrapper)).toEqual(['Video 1', 'Video 2', 'Video 3'])
    expect(fetchMore(wrapper).exists()).toBe(false)
  })

  it('loads the next page when the end of the list scrolls into view', async () => {
    layer.listChannelVideos
      .mockResolvedValueOnce({ items: [video(1)], cursor: 1 })
      .mockResolvedValueOnce({ items: [video(2)], cursor: null })
    const { wrapper } = await openChannelPage()

    wrapper.findComponent({ name: 'FtAutoLoadNextPageWrapper' }).vm.$emit('load-next-page')
    await flushPromises()

    expect(cardTitles(wrapper)).toEqual(['Video 1', 'Video 2'])
  })

  it('keeps going past an empty page that has a cursor, which is not the end', async () => {
    layer.listChannelVideos
      .mockResolvedValueOnce({ items: [], cursor: 24 })
      .mockResolvedValueOnce({ items: [video(25)], cursor: null })
    const { wrapper } = await openChannelPage()

    expect(wrapper.text()).not.toContain('This channel does not currently have any videos')

    await fetchMore(wrapper).trigger('click')
    await flushPromises()

    expect(layer.listChannelVideos).toHaveBeenLastCalledWith(HANDLE, { sort: 'newest', cursor: 24 })
    expect(cardTitles(wrapper)).toEqual(['Video 25'])
  })

  it('says so when the channel has no videos', async () => {
    layer.listChannelVideos.mockResolvedValue({ items: [], cursor: null })
    const { wrapper } = await openChannelPage()

    expect(wrapper.text()).toContain('This channel does not currently have any videos')
    expect(fetchMore(wrapper).exists()).toBe(false)
  })

  it('says why a page could not be loaded, and tries it again, keeping what it has', async () => {
    layer.listChannelVideos
      .mockResolvedValueOnce({ items: [video(1)], cursor: 1 })
      .mockRejectedValueOnce(new PlatformError('unavailable', 'down', { host: HOST }))
      .mockResolvedValueOnce({ items: [video(2)], cursor: null })
    const { wrapper } = await openChannelPage()

    await fetchMore(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain(`Could not reach ${HOST}.`)
    expect(cardTitles(wrapper)).toEqual(['Video 1'])

    await wrapper.find('.retryButton').trigger('click')
    await flushPromises()

    expect(layer.listChannelVideos).toHaveBeenLastCalledWith(HANDLE, { sort: 'newest', cursor: 1 })
    expect(cardTitles(wrapper)).toEqual(['Video 1', 'Video 2'])
  })
})

describe('the tabs', () => {
  it('put the tab in the route, and show its content', async () => {
    const { wrapper, router } = await openChannelPage()

    await wrapper.find('#playlistsTab').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.params).toEqual({ handle: HANDLE, currentTab: 'playlists' })
    expect(wrapper.find('#playlistsTab').classes()).toContain('selectedTab')
    expect(wrapper.find('.layerPlaylist').exists()).toBe(true)
    expect(wrapper.find('.fakeElementList').exists()).toBe(false)

    await wrapper.find('#videosTab').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.params.currentTab).toBe('videos')
    expect(cardTitles(wrapper)).toEqual(['Video 1', 'Video 2'])
    // The channel and its videos were not asked for again
    expect(layer.getChannel).toHaveBeenCalledTimes(1)
    expect(layer.listChannelVideos).toHaveBeenCalledTimes(1)
  })

  it('open on the tab the route names', async () => {
    const { wrapper } = await openChannelPage(`${CHANNEL_PATH}/playlists`)

    expect(layer.listChannelPlaylists).toHaveBeenCalledWith(HANDLE, { cursor: null })
    expect(layer.listChannelVideos).not.toHaveBeenCalled()
    expect(wrapper.find('#playlistsTab').classes()).toContain('selectedTab')
  })

  it('read an unknown tab as the videos', async () => {
    const { wrapper } = await openChannelPage(`${CHANNEL_PATH}/community`)

    expect(wrapper.find('#videosTab').classes()).toContain('selectedTab')
    expect(cardTitles(wrapper)).toEqual(['Video 1', 'Video 2'])
  })

  it('belong to the channel: another channel is loaded afresh', async () => {
    const { router } = await openChannelPage()
    layer.getChannel.mockResolvedValue(channelDetails({ id: 'other@tube.example', handle: 'other@tube.example', name: 'Other' }))

    await router.push('/peertube/channel/other@tube.example')
    await flushPromises()

    expect(layer.getChannel).toHaveBeenLastCalledWith('other@tube.example')
    expect(layer.listChannelVideos).toHaveBeenLastCalledWith('other@tube.example', { sort: 'newest', cursor: null })
  })
})

describe('the playlists tab', () => {
  it('lists each playlist with its title, thumbnail and video count', async () => {
    layer.listChannelPlaylists.mockResolvedValue({ items: [playlist(1), playlist(2)], cursor: null })
    const { wrapper } = await openChannelPage(`${CHANNEL_PATH}/playlists`)

    const playlists = wrapper.findAll('.layerPlaylist')
    expect(playlists.map(item => item.find('.playlistTitle').text())).toEqual(['Playlist 1', 'Playlist 2'])
    expect(playlists[0].find('img').attributes('src')).toBe(playlist(1).thumbnail)
    expect(playlists[1].text()).toContain('6 videos')
  })

  it('links a playlist to its page on its instance, for the app\'s external link handling, from its thumbnail too', async () => {
    const { wrapper } = await openChannelPage(`${CHANNEL_PATH}/playlists`)

    // What the app does with a click on an external link (App.vue
    // `handleLinkClick`, on the document), which reads only clicks whose
    // target is the link
    const opened = []
    const appLinkHandler = (event) => {
      if (event.target.tagName === 'A') {
        event.preventDefault()
        opened.push(event.target.href)
      }
    }
    wrapper.element.addEventListener('click', appLinkHandler)

    try {
      const link = wrapper.find('.layerPlaylist a')
      expect(link.attributes('href')).toBe(playlist(1).url)
      expect(link.attributes('title')).toBe(`Opens on ${HOST}, in your browser`)

      await wrapper.find('.layerPlaylist .playlistTitle').trigger('click')
      await wrapper.find('.layerPlaylist img').trigger('click')
    } finally {
      wrapper.element.removeEventListener('click', appLinkHandler)
    }

    expect(opened).toEqual([playlist(1).url, playlist(1).url])
    // Not opened a second time behind the app's back
    expect(openExternalLink).not.toHaveBeenCalled()
  })

  it('appends the next page until the cursor is null', async () => {
    layer.listChannelPlaylists
      .mockResolvedValueOnce({ items: [playlist(1)], cursor: 1 })
      .mockResolvedValueOnce({ items: [playlist(2)], cursor: null })
    const { wrapper } = await openChannelPage(`${CHANNEL_PATH}/playlists`)

    await fetchMore(wrapper).trigger('click')
    await flushPromises()

    expect(layer.listChannelPlaylists).toHaveBeenLastCalledWith(HANDLE, { cursor: 1 })
    expect(wrapper.findAll('.playlistTitle').map(title => title.text())).toEqual(['Playlist 1', 'Playlist 2'])
    expect(fetchMore(wrapper).exists()).toBe(false)
  })

  it('says so when the channel has no playlists', async () => {
    layer.listChannelPlaylists.mockResolvedValue({ items: [], cursor: null })
    const { wrapper } = await openChannelPage(`${CHANNEL_PATH}/playlists`)

    expect(wrapper.text()).toContain('This channel does not currently have any playlists')
  })
})

describe('instead of the channel', () => {
  it.each([
    ['notFound', `This channel does not exist on ${HOST}, or no longer does.`, false],
    ['invalid', `This channel does not exist on ${HOST}, or no longer does.`, false],
    ['unavailable', `Could not reach ${HOST}.`, true],
    ['rateLimited', `${HOST} is limiting requests, try again in a moment.`, true],
  ])('a channel the layer answers %s for says so', async (kind, message, retryable) => {
    layer.getChannel.mockRejectedValue(new PlatformError(kind, kind, { host: HOST }))
    const { wrapper } = await openChannelPage()

    expect(wrapper.text()).toContain(message)
    expect(wrapper.find('h1').exists()).toBe(false)
    expect(wrapper.find('.retryButton').exists()).toBe(retryable)
    expect(layer.listChannelVideos).not.toHaveBeenCalled()
  })

  it('names the host from the handle when the error does not', async () => {
    layer.getChannel.mockRejectedValue(new PlatformError('notFound', 'gone'))
    const { wrapper } = await openChannelPage()

    expect(wrapper.text()).toContain(`This channel does not exist on ${HOST}, or no longer does.`)
  })

  it('says it could not be loaded for anything else', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    layer.getChannel.mockRejectedValue(new TypeError('boom'))

    try {
      const { wrapper } = await openChannelPage()
      expect(wrapper.text()).toContain('This channel could not be loaded.')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('tries again when asked, and shows the channel', async () => {
    layer.getChannel.mockRejectedValueOnce(new PlatformError('unavailable', 'down', { host: HOST }))
    const { wrapper } = await openChannelPage()

    await wrapper.find('.retryButton').trigger('click')
    await flushPromises()

    expect(wrapper.find('h1').text()).toBe('Blender')
    expect(cardTitles(wrapper)).toEqual(['Video 1', 'Video 2'])
  })
})

describe('subscribing', () => {
  it('stores the PeerTube channel stub: the handle, name, small avatar, platform and host', async () => {
    const { wrapper } = await openChannelPage()

    await wrapper.find('.subscribeButton').trigger('click')
    await flushPromises()

    expect(dispatched('addChannelToProfiles')).toEqual([{
      channel: { id: HANDLE, name: 'Blender', thumbnail: AVATAR_SMALL, platform: 'peertube', host: HOST },
      profileIds: ['allChannels'],
    }])
  })

  it('stores an empty thumbnail, never none, for a channel without an avatar', async () => {
    layer.getChannel.mockResolvedValue(channelDetails({ thumbnail: '', avatarLarge: '' }))
    const { wrapper } = await openChannelPage()

    await wrapper.find('.subscribeButton').trigger('click')

    expect(dispatched('addChannelToProfiles')[0].channel.thumbnail).toBe('')
  })

  it('unsubscribes from every profile, as for YouTube', async () => {
    const stub = { id: HANDLE, name: 'Blender', thumbnail: AVATAR_SMALL, platform: 'peertube', host: HOST }
    const allChannels = { ...ALL_CHANNELS, subscriptions: [stub] }
    const music = { _id: 'music', name: 'Music', bgColor: '#111111', textColor: '#FFFFFF', subscriptions: [stub] }
    store.setGetter('getProfileList', [allChannels, music])
    store.setGetter('getActiveProfile', allChannels)
    const { wrapper } = await openChannelPage()

    expect(wrapper.find('.subscribeButton').text()).toBe('Unsubscribe')

    await wrapper.find('.subscribeButton').trigger('click')

    expect(dispatched('removeChannelFromProfiles')).toEqual([{ channelId: HANDLE, profileIds: ['allChannels', 'music'] }])
  })

  it('is not offered while PeerTube is switched off', async () => {
    isPeerTubeEnabled.mockReturnValue(false)
    const { wrapper } = await openChannelPage()

    expect(wrapper.find('.subscribeButton').exists()).toBe(false)
  })

  it('is not offered when the subscribe button is hidden', async () => {
    store.setGetter('getHideUnsubscribeButton', true)
    const { wrapper } = await openChannelPage()

    expect(wrapper.find('.subscribeButton').exists()).toBe(false)
  })
})

describe('a YouTube channel', () => {
  const YT_ID = 'UCSMOQeBJ2RAnuFungnQOxLg'
  const YT_PATH = `/channel/${YT_ID}`
  const YT_AVATAR = 'https://yt3.googleusercontent.com/blender-avatar=s160-c-k-c0x00ffffff-no-rj'
  const YT_BANNER = 'https://yt3.googleusercontent.com/blender-banner=w2560-fcrop64=1'

  /** @param {object} [overrides] */
  function youTubeChannel(overrides = {}) {
    return {
      id: YT_ID,
      name: 'Blender',
      thumbnail: YT_AVATAR,
      handle: '@BlenderOfficial',
      subscriberCount: 1234,
      url: `https://www.youtube.com/channel/${YT_ID}`,
      avatarLarge: YT_AVATAR,
      banner: YT_BANNER,
      description: 'The official channel of the Blender project.',
      descriptionKind: 'plain',
      tabs: ['videos', 'shorts', 'playlists', 'community'],
      tags: [],
      isFamilyFriendly: true,
      isArtistTopicChannel: false,
      ...overrides,
    }
  }

  /** A YouTube video summary as the layer lists them, card-ready */
  function youTubeVideo(n, sort = 'newest') {
    return {
      type: 'video',
      videoId: `${sort}-${n}`.padEnd(11, 'x'),
      title: `${sort} ${n}`,
      author: 'Blender',
      authorId: YT_ID,
      thumbnail: '',
      lengthSeconds: 60,
      liveNow: false,
      isUpcoming: false,
    }
  }

  function youTubePlaylist(id) {
    return {
      type: 'playlist',
      dataSource: 'local',
      playlistId: id,
      title: `Playlist ${id}`,
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      videoCount: 3,
      url: `https://www.youtube.com/playlist?list=${id}`,
      description: '',
      channelName: 'Blender',
      channelId: YT_ID,
    }
  }

  beforeEach(() => {
    layer.getChannel.mockResolvedValue(youTubeChannel())
    layer.listChannelVideos.mockResolvedValue({ items: [youTubeVideo(1), youTubeVideo(2)], cursor: null, sort: 'newest' })
    layer.listChannelPlaylists.mockResolvedValue({ items: [youTubePlaylist('PLown')], cursor: null, sort: 'newest' })
  })

  describe('header', () => {
    it('opens the channel the route names by its UC id, with its banner, avatar, name, handle and subscribers in YouTube\'s words', async () => {
      const { wrapper } = await openChannelPage(YT_PATH)

      expect(layer.getChannel).toHaveBeenCalledWith(YT_ID)
      expect(wrapper.find(`img.banner[src="${YT_BANNER}"]`).exists()).toBe(true)
      expect(wrapper.find(`img.avatar[src="${YT_AVATAR}"]`).exists()).toBe(true)
      expect(wrapper.find('h1').text()).toBe('Blender')
      expect(wrapper.find('.handle').text()).toBe('@BlenderOfficial')
      expect(wrapper.find('.followerCount').text()).toBe('1,234 subscribers')
      expect(store.committed).toContainEqual({ type: 'setAppTitle', payload: 'Blender' })
    })

    it('shows no handle for a channel without one, nor its id in place of it', async () => {
      layer.getChannel.mockResolvedValue(youTubeChannel({ handle: null }))
      const { wrapper } = await openChannelPage(YT_PATH)

      expect(wrapper.find('.handle').exists()).toBe(false)
    })

    it('hides the subscriber count when subscriber counts are hidden', async () => {
      store.setGetter('getHideChannelSubscriptions', true)
      const { wrapper } = await openChannelPage(YT_PATH)

      expect(wrapper.find('.followerCount').exists()).toBe(false)
    })

    it('shows only the tabs the channel has', async () => {
      layer.getChannel.mockResolvedValue(youTubeChannel({ tabs: ['videos', 'releases'] }))
      const { wrapper } = await openChannelPage(`${YT_PATH}/playlists`)

      expect(wrapper.findAll('.tab').map(tab => tab.text())).toEqual(['Videos'])
      expect(wrapper.find('#videosTab').classes()).toContain('selectedTab')
      expect(layer.listChannelPlaylists).not.toHaveBeenCalled()
    })
  })

  describe('videos tab', () => {
    it('lists newest first and appends the next page', async () => {
      layer.listChannelVideos
        .mockResolvedValueOnce({ items: [youTubeVideo(1), youTubeVideo(2)], cursor: 'next', sort: 'newest' })
        .mockResolvedValueOnce({ items: [youTubeVideo(3)], cursor: null, sort: 'newest' })
      const { wrapper } = await openChannelPage(YT_PATH)

      expect(layer.listChannelVideos).toHaveBeenCalledWith(YT_ID, { sort: 'newest', cursor: null })

      await fetchMore(wrapper).trigger('click')
      await flushPromises()

      expect(layer.listChannelVideos).toHaveBeenLastCalledWith(YT_ID, { sort: 'newest', cursor: 'next' })
      expect(cardTitles(wrapper)).toEqual(['newest 1', 'newest 2', 'newest 3'])
      expect(fetchMore(wrapper).exists()).toBe(false)
    })

    it('asks again in the sort chosen, and keeps offering the sorts when the layer applied it', async () => {
      const { wrapper } = await openChannelPage(YT_PATH)
      layer.listChannelVideos.mockResolvedValue({ items: [youTubeVideo(1, 'popular')], cursor: null, sort: 'popular' })

      await wrapper.find('select').setValue('popular')
      await flushPromises()

      expect(layer.listChannelVideos).toHaveBeenLastCalledWith(YT_ID, { sort: 'popular', cursor: null })
      expect(cardTitles(wrapper)).toEqual(['popular 1'])
      expect(wrapper.find('select').exists()).toBe(true)
    })

    it('stops offering the sorts when the first page answers another sort than the one asked', async () => {
      const { wrapper } = await openChannelPage(YT_PATH)
      // A tab without the filter, which lists newest first
      layer.listChannelVideos.mockResolvedValue({ items: [youTubeVideo(1), youTubeVideo(2)], cursor: null, sort: 'newest' })

      await wrapper.find('select').setValue('popular')
      await flushPromises()

      expect(wrapper.find('select').exists()).toBe(false)
      expect(cardTitles(wrapper)).toEqual(['newest 1', 'newest 2'])
    })

    it('offers the sorts again on the next channel', async () => {
      const { wrapper, router } = await openChannelPage(YT_PATH)
      layer.listChannelVideos.mockResolvedValue({ items: [youTubeVideo(1), youTubeVideo(2)], cursor: null, sort: 'newest' })
      await wrapper.find('select').setValue('oldest')
      await flushPromises()

      layer.getChannel.mockResolvedValue(youTubeChannel({ id: 'UCnobannernobannernoban0', name: 'Other' }))
      await router.push('/channel/UCnobannernobannernoban0')
      await flushPromises()

      expect(layer.listChannelVideos).toHaveBeenLastCalledWith('UCnobannernobannernoban0', { sort: 'newest', cursor: null })
      expect(wrapper.find('select').exists()).toBe(true)
    })
  })

  describe('playlists tab', () => {
    it('is reached from the tab, in the route', async () => {
      const { wrapper, router } = await openChannelPage(YT_PATH)

      await wrapper.find('#playlistsTab').trigger('click')
      await flushPromises()

      expect(router.currentRoute.value.path).toBe(`${YT_PATH}/playlists`)
      expect(layer.listChannelPlaylists).toHaveBeenCalledWith(YT_ID, { cursor: null })
    })

    it('opens a playlist on the app\'s own playlist page', async () => {
      const { wrapper, router } = await openChannelPage(`${YT_PATH}/playlists`)

      expect(wrapper.find('.layerPlaylist').exists()).toBe(false)

      await wrapper.find('.fakePlaylistCard a.title').trigger('click')
      await flushPromises()

      expect(router.currentRoute.value.path).toBe('/playlist/PLown')
    })
  })

  describe('instead of the channel', () => {
    it('shows an age-gated channel\'s name and avatar with the old view\'s message, and no retry', async () => {
      layer.getChannel.mockRejectedValue(new PlatformError('refused', 'This channel is age restricted', {
        reason: 'ageRestricted',
        channel: { id: YT_ID, name: 'Grown-ups only', thumbnail: YT_AVATAR },
      }))
      const { wrapper } = await openChannelPage(YT_PATH)

      expect(wrapper.find('h1').text()).toBe('Grown-ups only')
      expect(wrapper.find(`img.avatar[src="${YT_AVATAR}"]`).exists()).toBe(true)
      expect(wrapper.text()).toContain('This channel is age-restricted and currently cannot be viewed in Fjernsyn.')
      expect(wrapper.find('.retryButton').exists()).toBe(false)
      expect(layer.listChannelVideos).not.toHaveBeenCalled()
      expect(store.committed).toContainEqual({ type: 'setAppTitle', payload: 'Grown-ups only' })
    })

    it('says a channel that does not exist does not, in the old view\'s words', async () => {
      layer.getChannel.mockRejectedValue(new PlatformError('notFound', 'gone'))
      const { wrapper } = await openChannelPage(YT_PATH)

      expect(wrapper.text()).toContain('This channel does not exist')
      expect(wrapper.find('.retryButton').exists()).toBe(false)
    })

    it('shows the age-restricted placeholder for a channel YouTube does not rate family friendly, while only those are shown', async () => {
      store.setGetter('getShowFamilyFriendlyOnly', true)
      layer.getChannel.mockResolvedValue(youTubeChannel({ isFamilyFriendly: false }))
      const { wrapper } = await openChannelPage(YT_PATH)

      expect(wrapper.text()).toContain('This channel is age restricted')
      expect(wrapper.find('h1').exists()).toBe(false)
      expect(layer.listChannelVideos).not.toHaveBeenCalled()
    })

    it('shows a family friendly channel while only those are shown', async () => {
      store.setGetter('getShowFamilyFriendlyOnly', true)
      const { wrapper } = await openChannelPage(YT_PATH)

      expect(wrapper.find('h1').text()).toBe('Blender')
      expect(cardTitles(wrapper)).toEqual(['newest 1', 'newest 2'])
    })
  })
})
