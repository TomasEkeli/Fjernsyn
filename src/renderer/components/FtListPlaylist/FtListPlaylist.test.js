import { describe, expect, it, vi } from 'vitest'

import thumbnailPlaceholder from '../../assets/img/thumbnail_placeholder.svg'
import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'
import { createTestRouter } from '../../testing/router'
import FtListPlaylist from './FtListPlaylist.vue'

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getListType: 'grid',
        getBlurThumbnails: false,
        getThumbnailPreference: '',
        getBackendPreference: 'local',
        getCurrentInvidiousInstanceUrl: 'https://inv.example',
        getQuickBookmarkTargetPlaylistId: null,
        getQuickBookmarkPlaylist: null,
        getExternalPlayer: '',
        getDefaultPlayback: 1,
        getDisableChannelLinks: false,
      },
    }),
  }
})

vi.mock('../../router/index', () => ({ default: {} }))

vi.mock('../../i18n/index', async () => {
  const { createTestI18n } = await import('../../testing/i18n')
  return { default: createTestI18n() }
})

vi.mock('../../platform/vue', async () => {
  const { describe } = await import('../../platform/describe')

  return {
    getPlatformLayer: () => ({
      describe: (entity, options) => describe(entity, { backendPreference: 'local', thumbnailPreference: '' }, options),
    }),
  }
})

const THUMBNAIL = 'https://video.blender.org/lazy-static/previews/sprite-fright.jpg'

const PEERTUBE_ITEM = {
  videoId: 'b29290cc-dc51-4a12-bcb2-2aa5fece7605',
  platform: 'peertube',
  host: 'video.blender.org',
  thumbnail: THUMBNAIL,
  title: 'Sprite Fright',
  playlistItemId: 'item-1',
}

const YOUTUBE_ITEM = { videoId: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', playlistItemId: 'item-2' }

function userPlaylist(videos) {
  return { _id: 'playlist-1', playlistName: 'Mixed', videos }
}

function mountPlaylist(data) {
  return mountWithApp(FtListPlaylist, {
    store,
    router: createTestRouter(),
    props: { data, appearance: 'result' },
  })
}

describe('FtListPlaylist, a user playlist', () => {
  it("takes its cover from a PeerTube first video's own thumbnail", () => {
    const wrapper = mountPlaylist(userPlaylist([PEERTUBE_ITEM, YOUTUBE_ITEM]))

    expect(wrapper.find('img.thumbnailImage').attributes('src')).toBe(THUMBNAIL)
  })

  it('shows the placeholder for a PeerTube first video without a thumbnail', () => {
    const wrapper = mountPlaylist(userPlaylist([{ ...PEERTUBE_ITEM, thumbnail: '' }]))

    expect(wrapper.find('img.thumbnailImage').attributes('src')).toBe(thumbnailPlaceholder)
  })

  it('takes its cover from ytimg for a YouTube first video, as today', () => {
    const wrapper = mountPlaylist(userPlaylist([YOUTUBE_ITEM, PEERTUBE_ITEM]))

    expect(wrapper.find('img.thumbnailImage').attributes('src')).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg')
  })
})
