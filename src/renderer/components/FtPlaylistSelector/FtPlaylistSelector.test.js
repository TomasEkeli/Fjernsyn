import { afterEach, describe, expect, it, vi } from 'vitest'

import thumbnailPlaceholder from '../../assets/img/thumbnail_placeholder.svg'
import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'
import FtPlaylistSelector from './FtPlaylistSelector.vue'

const THUMBNAIL = 'https://video.blender.org/lazy-static/previews/sprite-fright.jpg'
const YOUTUBE_ID = 'dQw4w9WgXcQ'

const PEERTUBE_VIDEO = {
  videoId: 'b29290cc-dc51-4a12-bcb2-2aa5fece7605',
  title: 'Sprite Fright',
  authorId: 'blender@video.blender.org',
  platform: 'peertube',
  host: 'video.blender.org',
  thumbnail: THUMBNAIL,
}

const YOUTUBE_VIDEO = { videoId: YOUTUBE_ID, title: 'Never Gonna Give You Up', authorId: 'UCuAXFkgsw1L7xaCfnd5JJOw' }

const SETTINGS = vi.hoisted(() => ({
  getBackendPreference: 'local',
  getCurrentInvidiousInstanceUrl: 'https://inv.example',
  getToBeAddedToPlaylistVideoList: [],
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

/** @param {object[]} videos */
function coverOf(videos) {
  const wrapper = mountWithApp(FtPlaylistSelector, {
    store,
    props: {
      playlist: { _id: 'p', playlistName: 'Mixed', videos },
      selected: false,
      disabled: false,
      addingDuplicateVideosEnabled: false,
    },
  })

  return wrapper.find('img.thumbnailImage').attributes('src')
}

afterEach(() => {
  for (const [name, value] of Object.entries(SETTINGS)) {
    store.setGetter(name, value)
  }
})

describe('FtPlaylistSelector, the cover', () => {
  it("is a PeerTube first video's own thumbnail", () => {
    expect(coverOf([PEERTUBE_VIDEO, YOUTUBE_VIDEO])).toBe(THUMBNAIL)
  })

  it('is the placeholder for a PeerTube first video while thumbnails are hidden', () => {
    store.setGetter('getThumbnailPreference', 'hidden')

    expect(coverOf([PEERTUBE_VIDEO])).toBe(thumbnailPlaceholder)
  })

  it('is the ytimg thumbnail for a YouTube first video, as today', () => {
    expect(coverOf([YOUTUBE_VIDEO, PEERTUBE_VIDEO])).toBe(`https://i.ytimg.com/vi/${YOUTUBE_ID}/mqdefault.jpg`)
  })

  it('is the placeholder for an empty playlist', () => {
    expect(coverOf([])).toBe(thumbnailPlaceholder)
  })
})
