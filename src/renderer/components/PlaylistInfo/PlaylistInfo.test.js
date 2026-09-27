import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { writeFileWithPicker } from '../../helpers/utils'
import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'
import { createTestRouter } from '../../testing/router'
import FtIconButton from '../FtIconButton/FtIconButton.vue'
import FtPrompt from '../FtPrompt/FtPrompt.vue'
import PlaylistInfo from './PlaylistInfo.vue'

const HOST = 'video.blender.org'
const UUID = 'b29290cc-dc51-4a12-bcb2-2aa5fece7605'
const THUMBNAIL = 'https://video.blender.org/lazy-static/previews/sprite-fright.jpg'
const YOUTUBE_ID = 'dQw4w9WgXcQ'

const PEERTUBE_VIDEO = {
  videoId: UUID,
  title: 'Sprite Fright',
  author: 'Blender',
  authorId: 'blender@video.blender.org',
  lengthSeconds: 629,
  playlistItemId: 'i1',
  platform: 'peertube',
  host: HOST,
  thumbnail: THUMBNAIL,
}

const YOUTUBE_VIDEO = {
  videoId: YOUTUBE_ID,
  title: 'Never Gonna Give You Up',
  author: 'Rick Astley',
  authorId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
  lengthSeconds: 213,
  playlistItemId: 'i2',
}

const SETTINGS = vi.hoisted(() => ({
  getAllPlaylists: [],
  getBackendPreference: 'local',
  getBlurThumbnails: false,
  getCurrentInvidiousInstanceUrl: 'https://inv.example',
  getDisableChannelLinks: false,
  getHidePlaylists: false,
  getHideSharingActions: false,
  getHideVideoViews: false,
  getHistoryCacheById: {},
  getPlaylist: () => ({ _id: 'mixed', playlistName: 'Mixed', protected: false, videos: [] }),
  getQuickBookmarkPlaylist: null,
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
  writeFileWithPicker: vi.fn(async () => true),
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

/** @param {object[]} videos */
function mountInfo(videos) {
  return mountWithApp(PlaylistInfo, {
    store,
    router: createTestRouter(),
    props: {
      id: 'mixed',
      firstVideoId: videos[0].videoId,
      firstVideoPlaylistItemId: videos[0].playlistItemId,
      playlistThumbnail: '',
      title: 'Mixed',
      channelThumbnail: '',
      channelName: '',
      videoCount: videos.length,
      videos,
      sortedVideos: videos,
      viewCount: 0,
      totalPlaylistDuration: 0,
      isDurationApproximate: false,
      description: '',
      infoSource: 'user',
      moreVideoDataAvailable: false,
      searchVideoModeAllowed: false,
      searchQueryText: '',
    },
    stubs: { FtShareButton: true, FtPrompt: true },
  })
}

afterEach(() => {
  for (const [name, value] of Object.entries(SETTINGS)) {
    store.setGetter(name, value)
  }
  vi.clearAllMocks()
})

describe('PlaylistInfo, a playlist whose first video is a PeerTube one', () => {
  it("has that video's thumbnail as its cover, linking to its own watch page", () => {
    const cover = mountInfo([PEERTUBE_VIDEO, YOUTUBE_VIDEO]).find('.playlistThumbnail')

    expect(cover.find('img').attributes('src')).toBe(THUMBNAIL)
    expect(cover.find('a').attributes('href')).toBe(`/peertube/watch/${HOST}/${UUID}`)
  })

  it('exports each video as a URL on its own platform', async () => {
    const wrapper = mountInfo([PEERTUBE_VIDEO, YOUTUBE_VIDEO])

    await wrapper.findAllComponents(FtIconButton).find(button => button.props('title') === 'Export This Playlist').vm.$emit('click')
    wrapper.findComponent(FtPrompt).vm.$emit('click', 'urls')
    await flushPromises()

    expect(writeFileWithPicker).toHaveBeenCalledTimes(1)
    expect(writeFileWithPicker.mock.calls[0][1]).toBe(`https://${HOST}/videos/watch/${UUID}\nhttps://www.youtube.com/watch?v=${YOUTUBE_ID}\n`)
  })
})

describe('PlaylistInfo, a playlist whose first video is a YouTube one (as today)', () => {
  it('has the ytimg cover, linking to the YouTube watch page in the playlist', () => {
    const cover = mountInfo([YOUTUBE_VIDEO, PEERTUBE_VIDEO]).find('.playlistThumbnail')

    expect(cover.find('img').attributes('src')).toBe(`https://i.ytimg.com/vi/${YOUTUBE_ID}/mqdefault.jpg`)
    expect(cover.find('a').attributes('href')).toBe(`/watch/${YOUTUBE_ID}?playlistId=mixed&playlistType=user&playlistItemId=i2`)
  })
})
