import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { describe as describeEntity } from '../../platform/describe'
import { PLATFORM_LAYER_KEY } from '../../platform/vue'
import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'
import { createTestRouter } from '../../testing/router'
import LayerVideoInfo from './LayerVideoInfo.vue'

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getHideVideoViews: false,
        getHideVideoLikesAndDislikes: false,
        getHideUploader: false,
        getHideSharingActions: false,
        getDisableChannelLinks: false,
        getHidePlaylists: false,
        getWatchedProgressSavingMode: 'auto',
        getExternalPlayer: 'mpv',
        getDefaultPlayback: 1.25,
      },
    }),
  }
})

vi.mock('../../router/index', () => ({ default: {} }))

vi.mock('../../i18n/index', async () => {
  const { createTestI18n } = await import('../../testing/i18n')
  return { default: createTestI18n() }
})

const HOST = 'video.blender.org'
const UUID = 'b29290cc-dc51-4a12-bcb2-2aa5fece7605'

const VIDEO = {
  videoId: UUID,
  platform: 'peertube',
  host: HOST,
  title: 'Sprite Fright',
  author: 'Blender',
  authorId: 'blender@video.blender.org',
  thumbnail: 'https://video.blender.org/lazy-static/previews/sprite-fright.jpg',
  published: Date.parse('2021-10-29T00:00:00Z'),
  viewCount: 1234,
  lengthSeconds: 629,
}

const fakeLayer = { describe: (entity, options) => describeEntity(entity, {}, options) }

function mountInfo(props = {}) {
  return mountWithApp(LayerVideoInfo, {
    store,
    router: createTestRouter(),
    provide: { [PLATFORM_LAYER_KEY]: fakeLayer },
    props: { video: VIDEO, ...props },
  })
}

function externalPlayerButton(wrapper) {
  return wrapper.find('.externalPlayerButton')
}

beforeEach(() => {
  window.ftElectron = { openInExternalPlayer: vi.fn() }
})

afterEach(() => {
  store.setGetter('getExternalPlayer', 'mpv')
  delete window.ftElectron
})

describe('LayerVideoInfo, the external player button', () => {
  it('opens the PeerTube watch URL in the external player, from where playback is', async () => {
    const wrapper = mountInfo({ getTimestamp: () => 42.5 })

    expect(externalPlayerButton(wrapper).find('button').attributes('title')).toBe('Open in mpv')
    await externalPlayerButton(wrapper).find('button').trigger('click')

    expect(window.ftElectron.openInExternalPlayer).toHaveBeenCalledWith({
      videoUrl: `https://${HOST}/videos/watch/${UUID}`,
      startTime: 42.5,
      playbackRate: 1.25,
    })
    expect(wrapper.emitted('pause-player')).toHaveLength(1)
  })

  it('starts from the beginning when the view gives no position', async () => {
    const wrapper = mountInfo()

    await externalPlayerButton(wrapper).find('button').trigger('click')

    expect(window.ftElectron.openInExternalPlayer.mock.calls[0][0].startTime).toBe(0)
  })

  it('is not there when no external player is set', () => {
    store.setGetter('getExternalPlayer', '')

    expect(externalPlayerButton(mountInfo()).exists()).toBe(false)
  })

  it('hands a YouTube video over by its id, as the old watch page does, and says it has', async () => {
    const { platform: _, host: __, ...youtube } = { ...VIDEO, videoId: 'dQw4w9WgXcQ' }
    const wrapper = mountInfo({ video: youtube, getTimestamp: () => 42.5 })

    await externalPlayerButton(wrapper).find('button').trigger('click')

    expect(window.ftElectron.openInExternalPlayer).toHaveBeenCalledWith({
      videoId: 'dQw4w9WgXcQ',
      startTime: 42.5,
      playbackRate: 1.25,
    })
    expect(wrapper.emitted('opened-in-external-player')).toHaveLength(1)
  })
})
