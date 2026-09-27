import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import thumbnailPlaceholder from '../../assets/img/thumbnail_placeholder.svg'
import { showToast } from '../../helpers/utils'
import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'
import { createTestRouter } from '../../testing/router'
import WatchVideoPlaylist from './WatchVideoPlaylist.vue'

const THUMBNAIL = 'https://video.blender.org/lazy-static/previews/sprite-fright.jpg'
const YOUTUBE_ID = 'dQw4w9WgXcQ'

// A user playlist with a YouTube video first and a PeerTube one second
const PLAYLIST = vi.hoisted(() => ({
  _id: 'mixed',
  playlistName: 'Mixed',
  videos: [
    { videoId: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', author: 'Rick Astley', authorId: 'UCuAXFkgsw1L7xaCfnd5JJOw', lengthSeconds: 213, playlistItemId: 'i1', timeAdded: 1 },
    {
      videoId: 'b29290cc-dc51-4a12-bcb2-2aa5fece7605',
      title: 'Sprite Fright',
      author: 'Blender',
      authorId: 'blender@video.blender.org',
      lengthSeconds: 629,
      playlistItemId: 'i2',
      timeAdded: 2,
      platform: 'peertube',
      host: 'video.blender.org',
      thumbnail: 'https://video.blender.org/lazy-static/previews/sprite-fright.jpg',
    },
  ],
}))

const SETTINGS = vi.hoisted(() => ({
  getBackendPreference: 'local',
  getBackendFallback: false,
  getCurrentInvidiousInstanceUrl: 'https://inv.example',
  getCachedPlaylist: null,
  getPlaylist: (id) => (id === 'mixed' ? PLAYLIST : undefined),
  getPlaylistsReady: true,
  getUserPlaylistSortOrder: 'custom',
  getThumbnailPreference: '',
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
  showToast: vi.fn(),
}))

vi.mock('../../platform/vue', async () => {
  const { describe } = await import('../../platform/describe')
  const { default: store } = await import('../../store/index')

  return {
    getPlatformLayer: () => ({
      describe: (entity, options) => describe(entity, { thumbnailPreference: store.getters.getThumbnailPreference }, options),
    }),
  }
})

/**
 * @param {object} [current] the item the watch page shows
 * @param {import('vue-router').Router} [router]
 */
async function mountPlaylist(current = PLAYLIST.videos[0], router = createTestRouter()) {
  const wrapper = mountWithApp(WatchVideoPlaylist, {
    store,
    router,
    props: { playlistId: 'mixed', playlistType: 'user', videoId: current.videoId, playlistItemId: current.playlistItemId, watchViewLoading: false },
    stubs: { FtListVideoNumbered: true },
  })
  await flushPromises()

  return wrapper
}

/**
 * Hovers the progress bar at a share of its width, which previews the item there
 *
 * @param {import('@vue/test-utils').VueWrapper} wrapper
 * @param {number} percent
 */
async function hoverAt(wrapper, percent) {
  const container = wrapper.find('.playlistProgressBarContainer')
  await container.trigger('mouseenter')
  await container.trigger('mousemove', { clientX: percent })
}

function previewSrc(wrapper) {
  const img = wrapper.find('img.previewThumbnail')
  return img.exists() ? img.attributes('src') : null
}

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 100, top: 0, height: 10, right: 100, bottom: 10 })
})

afterEach(() => {
  for (const [name, value] of Object.entries(SETTINGS)) {
    store.setGetter(name, value)
  }
  vi.restoreAllMocks()
})

describe('WatchVideoPlaylist, the progress bar preview', () => {
  it('previews a PeerTube item with its own thumbnail', async () => {
    const wrapper = await mountPlaylist()

    await hoverAt(wrapper, 90)

    expect(wrapper.find('.previewVideoTitle').text()).toBe('Sprite Fright')
    expect(previewSrc(wrapper)).toBe(THUMBNAIL)
  })

  it('previews a PeerTube item with the placeholder while thumbnails are hidden, never nothing', async () => {
    store.setGetter('getThumbnailPreference', 'hidden')
    const wrapper = await mountPlaylist()

    await hoverAt(wrapper, 90)

    expect(previewSrc(wrapper)).toBe(thumbnailPlaceholder)
  })

  it('previews a YouTube item with the ytimg thumbnail, as today', async () => {
    const wrapper = await mountPlaylist()

    await hoverAt(wrapper, 10)

    expect(wrapper.find('.previewVideoTitle').text()).toBe('Never Gonna Give You Up')
    expect(previewSrc(wrapper)).toBe(`https://i.ytimg.com/vi/${YOUTUBE_ID}/default.jpg`)
  })
})

const PEERTUBE_ITEM = PLAYLIST.videos[1]

/** @param {string} videoId @param {string} playlistItemId */
function youTubeItem(videoId, playlistItemId) {
  return { videoId, title: videoId, author: 'Someone', authorId: 'UCxxxxxxxxxxxxxxxxxxxxxx', lengthSeconds: 60, playlistItemId, timeAdded: 1 }
}

const FIRST = youTubeItem('aaaaaaaaaaa', 'y1')
const SECOND = youTubeItem('bbbbbbbbbbb', 'y2')
const THIRD = youTubeItem('ccccccccccc', 'y3')

/** @param {object[]} videos */
function usePlaylist(videos) {
  store.setGetter('getPlaylist', (id) => (id === 'mixed' ? { _id: 'mixed', playlistName: 'Mixed', videos } : undefined))
}

/**
 * Runs one of the playlist's own navigations, as the watch page and the media keys do
 *
 * @param {object[]} videos
 * @param {object} current
 * @param {(wrapper: import('@vue/test-utils').VueWrapper) => unknown} navigate
 * @returns {Promise<string | null>} the playlist item it opened, or `null` if it stayed
 */
async function navigateFrom(videos, current, navigate) {
  usePlaylist(videos)
  const router = createTestRouter()
  const wrapper = await mountPlaylist(current, router)

  await navigate(wrapper)
  await flushPromises()

  const route = router.currentRoute.value
  if (route.path === '/') { return null }

  expect(route.query).toMatchObject({ playlistId: 'mixed', playlistType: 'user' })
  expect(route.path).toBe(`/watch/${videos.find(video => video.playlistItemId === route.query.playlistItemId).videoId}`)
  return route.query.playlistItemId
}

/**
 * Mounts the playlist on `current`, then takes `current` out of it, as the
 * watch page sees a video removed from the playlist while it plays
 *
 * @param {object[]} videos
 * @param {object} current
 */
async function mountAndDelete(videos, current) {
  usePlaylist(videos)
  const router = createTestRouter()
  const wrapper = await mountPlaylist(current, router)

  usePlaylist(videos.filter(video => video !== current))
  await flushPromises()

  return { wrapper, router }
}

/** @param {import('vue-router').Router} router */
const openedItem = router => router.currentRoute.value.path === '/' ? null : router.currentRoute.value.query.playlistItemId

/** @param {import('@vue/test-utils').VueWrapper} wrapper */
const shuffled = wrapper => wrapper.vm.randomizedPlaylistItems.map(item => item.playlistItemId)

const next = wrapper => wrapper.vm.playNextVideo()
const previous = wrapper => wrapper.vm.playPreviousVideo()

async function toggle(wrapper, label) {
  await wrapper.find(`[aria-label="${label}"]`).trigger('click')
}

describe('WatchVideoPlaylist, playing through a mixed playlist on the YouTube watch page', () => {
  const MIXED = [FIRST, PEERTUBE_ITEM, SECOND, { ...PEERTUBE_ITEM, playlistItemId: 'p2' }]

  it('steps over a PeerTube item to the next YouTube one', async () => {
    expect(await navigateFrom(MIXED, FIRST, next)).toBe('y2')
  })

  it('steps back over a PeerTube item to the previous YouTube one', async () => {
    expect(await navigateFrom(MIXED, SECOND, previous)).toBe('y1')
  })

  it('ends the playlist at the last YouTube item, with only PeerTube items after it', async () => {
    expect(await navigateFrom(MIXED, SECOND, next)).toBeNull()
    expect(showToast).toHaveBeenCalledWith('The playlist has ended.  Enable loop to continue playing')
  })

  it('says the playlist will end at the last YouTube item', async () => {
    usePlaylist(MIXED)
    const wrapper = await mountPlaylist(SECOND)

    expect(wrapper.vm.shouldStopDueToPlaylistEnd).toBe(true)
  })

  it('loops from the last YouTube item to the first', async () => {
    expect(await navigateFrom(MIXED, SECOND, async (wrapper) => {
      await toggle(wrapper, 'Loop Playlist')
      next(wrapper)
    })).toBe('y1')
  })

  it('wraps back from the first YouTube item to the last', async () => {
    expect(await navigateFrom([PEERTUBE_ITEM, FIRST, SECOND, { ...PEERTUBE_ITEM, playlistItemId: 'p2' }], FIRST, previous)).toBe('y2')
  })

  it('shuffles the YouTube items only', async () => {
    // The shuffle that, over every item, would put the PeerTube item next
    vi.spyOn(Math, 'random').mockReturnValue(0.99)

    expect(await navigateFrom([FIRST, PEERTUBE_ITEM, SECOND], FIRST, async (wrapper) => {
      await toggle(wrapper, 'Shuffle Playlist')
      next(wrapper)
    })).toBe('y2')
  })

  it('steps back from a deleted video to the nearest YouTube item before it, over a PeerTube one, without wrapping', async () => {
    const { wrapper, router } = await mountAndDelete([FIRST, PEERTUBE_ITEM, SECOND, THIRD], SECOND)

    previous(wrapper)
    await flushPromises()

    expect(openedItem(router)).toBe('y1')
  })

  it('goes on from a deleted video to the next YouTube item after it', async () => {
    const { wrapper, router } = await mountAndDelete([FIRST, PEERTUBE_ITEM, SECOND, THIRD], SECOND)

    next(wrapper)
    await flushPromises()

    expect(openedItem(router)).toBe('y3')
  })

  it('shuffles with the current video first, once, and no PeerTube item', async () => {
    usePlaylist([FIRST, PEERTUBE_ITEM, SECOND, THIRD])
    const wrapper = await mountPlaylist(SECOND)

    await toggle(wrapper, 'Shuffle Playlist')

    const order = shuffled(wrapper)
    expect(order[0]).toBe('y2')
    expect(order.toSorted()).toEqual(['y1', 'y2', 'y3'])
  })

  it('still lists every item, the PeerTube ones included', async () => {
    usePlaylist(MIXED)
    const wrapper = await mountPlaylist(FIRST)

    expect(wrapper.findAll('.playlistItem')).toHaveLength(4)
  })
})

describe('WatchVideoPlaylist, playing through a YouTube-only playlist (as today)', () => {
  const YOUTUBE_ONLY = [FIRST, SECOND, THIRD]

  it('plays the next item', async () => {
    expect(await navigateFrom(YOUTUBE_ONLY, FIRST, next)).toBe('y2')
  })

  it('plays the previous item, wrapping from the first to the last', async () => {
    expect(await navigateFrom(YOUTUBE_ONLY, SECOND, previous)).toBe('y1')
    expect(await navigateFrom(YOUTUBE_ONLY, FIRST, previous)).toBe('y3')
  })

  it('ends at the last item, or loops to the first', async () => {
    expect(await navigateFrom(YOUTUBE_ONLY, THIRD, next)).toBeNull()
    expect(await navigateFrom(YOUTUBE_ONLY, THIRD, async (wrapper) => {
      await toggle(wrapper, 'Loop Playlist')
      next(wrapper)
    })).toBe('y1')
  })

  it('shuffles every item', async () => {
    // Over [second, third] a random number of 0 swaps them
    vi.spyOn(Math, 'random').mockReturnValue(0)

    expect(await navigateFrom(YOUTUBE_ONLY, FIRST, async (wrapper) => {
      await toggle(wrapper, 'Shuffle Playlist')
      next(wrapper)
    })).toBe('y3')
  })

  it('steps back from a deleted video to the item before it', async () => {
    const { wrapper, router } = await mountAndDelete(YOUTUBE_ONLY, SECOND)

    previous(wrapper)
    await flushPromises()

    expect(openedItem(router)).toBe('y1')
  })

  it('goes on from a deleted video to the item after it', async () => {
    const { wrapper, router } = await mountAndDelete(YOUTUBE_ONLY, SECOND)

    next(wrapper)
    await flushPromises()

    expect(openedItem(router)).toBe('y3')
  })

  it('wraps back to the last item from a deleted first video', async () => {
    const { wrapper, router } = await mountAndDelete(YOUTUBE_ONLY, FIRST)

    previous(wrapper)
    await flushPromises()

    expect(openedItem(router)).toBe('y3')
  })

  it.each([0, 0.5, 0.99])('shuffles with the current video first, once (random %s)', async (random) => {
    vi.spyOn(Math, 'random').mockReturnValue(random)
    usePlaylist(YOUTUBE_ONLY)
    const wrapper = await mountPlaylist(SECOND)

    await toggle(wrapper, 'Shuffle Playlist')

    const order = shuffled(wrapper)
    expect(order[0]).toBe('y2')
    expect(order).toHaveLength(3)
    expect(new Set(order).size).toBe(3)
  })
})
