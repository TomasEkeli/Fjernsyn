import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import thumbnailPlaceholder from '../../assets/img/thumbnail_placeholder.svg'
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

vi.mock('../../platform/vue', async () => {
  const { describe } = await import('../../platform/describe')
  const { default: store } = await import('../../store/index')

  return {
    getPlatformLayer: () => ({
      describe: (entity, options) => describe(entity, { thumbnailPreference: store.getters.getThumbnailPreference }, options),
    }),
  }
})

async function mountPlaylist() {
  const wrapper = mountWithApp(WatchVideoPlaylist, {
    store,
    router: createTestRouter(),
    props: { playlistId: 'mixed', playlistType: 'user', videoId: YOUTUBE_ID, playlistItemId: 'i1', watchViewLoading: false },
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
