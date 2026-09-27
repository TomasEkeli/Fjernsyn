import { describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'
import { createTestRouter } from '../../testing/router'
import FtSubscribeButton from '../FtSubscribeButton/FtSubscribeButton.vue'
import FtListChannel from './FtListChannel.vue'

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getCurrentInvidiousInstanceUrl: 'https://inv.example',
        getListType: 'list',
        getHideChannelSubscriptions: false,
        getHideUnsubscribeButton: false,
        getDisableChannelLinks: false,
        getBackendPreference: 'local',
        getThumbnailPreference: '',
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

const HANDLE = 'blender@video.blender.org'
const AVATAR = 'https://video.blender.org/lazy-static/avatars/blender.png'

// A PeerTube channel search result as the layer gives it (ticket 06)
const PEERTUBE_RESULT = {
  type: 'channel',
  dataSource: 'local',
  platform: 'peertube',
  host: 'video.blender.org',
  id: HANDLE,
  name: 'Blender',
  thumbnail: AVATAR,
  handle: HANDLE,
  subscribers: 12000,
  descriptionShort: 'The Blender channel',
}

const YOUTUBE_RESULT = {
  type: 'channel',
  dataSource: 'local',
  id: 'UCuAXFkgsw1L7xaCfnd5JJOw',
  name: 'Rick Astley',
  thumbnail: 'https://yt3.ggpht.com/abc=s176',
  handle: '@RickAstleyYT',
  subscribers: 4000000,
  descriptionShort: '',
}

function mountChannel(data) {
  return mountWithApp(FtListChannel, {
    store,
    router: createTestRouter(),
    props: { data, appearance: 'result' },
    stubs: { FtSubscribeButton: true },
  })
}

describe('FtListChannel', () => {
  it('links a PeerTube channel to its PeerTube page, with its avatar', () => {
    const wrapper = mountChannel(PEERTUBE_RESULT)

    const links = wrapper.findAll('a').map(link => link.attributes('href'))
    expect(links).toEqual([
      `/peertube/channel/${HANDLE}`,
      `/peertube/channel/${HANDLE}`,
      `/peertube/channel/${HANDLE}`,
    ])
    expect(wrapper.find('img').attributes('src')).toBe(AVATAR)
  })

  it('links a YouTube channel to /channel/UC…, as today', () => {
    const wrapper = mountChannel(YOUTUBE_RESULT)

    const links = wrapper.findAll('a').map(link => link.attributes('href'))
    expect(links).toEqual(Array(3).fill(`/channel/${YOUTUBE_RESULT.id}`))
    expect(wrapper.find('img').attributes('src')).toBe(YOUTUBE_RESULT.thumbnail)
  })

  it('subscribes to a PeerTube channel as its PeerTube stub: handle, name, avatar, platform and host', () => {
    const button = mountChannel(PEERTUBE_RESULT).findComponent(FtSubscribeButton)

    expect(button.props()).toMatchObject({
      channelId: HANDLE,
      channelName: 'Blender',
      channelThumbnail: AVATAR,
      channelPlatformFields: { platform: 'peertube', host: 'video.blender.org' },
    })
  })

  it('subscribes to a YouTube channel with no platform fields, as today', () => {
    const button = mountChannel(YOUTUBE_RESULT).findComponent(FtSubscribeButton)

    expect(button.props()).toMatchObject({
      channelId: YOUTUBE_RESULT.id,
      channelName: 'Rick Astley',
      channelThumbnail: YOUTUBE_RESULT.thumbnail,
      channelPlatformFields: null,
    })
  })
})
