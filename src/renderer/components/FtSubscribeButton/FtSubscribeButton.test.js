import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'
import FtSubscribeButton from './FtSubscribeButton.vue'

// Upstream's subscribe button, for the one prop the fork adds to it: YouTube
// callers pass nothing and must dispatch exactly what they always have

const ALL_CHANNELS = vi.hoisted(() => ({
  _id: 'allChannels',
  name: 'All Channels',
  bgColor: '#000000',
  textColor: '#FFFFFF',
  subscriptions: [],
}))

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getProfileList: [ALL_CHANNELS],
        getActiveProfile: ALL_CHANNELS,
        getHideChannelSubscriptions: false,
        getUnsubscriptionPopupStatus: false,
        getProfilePictures: {},
      },
    }),
  }
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

beforeEach(() => {
  store.dispatched.length = 0
  store.setGetter('getProfileList', [{ ...ALL_CHANNELS, subscriptions: [] }])
  store.setGetter('getActiveProfile', store.getters.getProfileList[0])
  store.setGetter('getProfilePictures', {})
})

function dispatched(type) {
  return store.dispatched.filter(action => action.type === type).map(action => action.payload)
}

describe('the subscribe button', () => {
  it('stores a YouTube channel as it always has: id, name and thumbnail only', async () => {
    const wrapper = mountWithApp(FtSubscribeButton, {
      store,
      props: {
        channelId: 'UCSMOQeBJ2RAnuFungnQOxLg',
        channelName: 'Blender',
        channelThumbnail: 'https://yt3.ggpht.com/blender=s176',
      },
    })

    await wrapper.find('.subscribeButton').trigger('click')
    await flushPromises()

    expect(dispatched('addChannelToProfiles')).toEqual([{
      channel: {
        id: 'UCSMOQeBJ2RAnuFungnQOxLg',
        name: 'Blender',
        thumbnail: 'https://yt3.ggpht.com/blender=s176',
      },
      profileIds: ['allChannels'],
    }])
    expect(Object.keys(dispatched('addChannelToProfiles')[0].channel)).toEqual(['id', 'name', 'thumbnail'])
  })

  it('stores the fields another platform gives it beside them, never over them', async () => {
    const wrapper = mountWithApp(FtSubscribeButton, {
      store,
      props: {
        channelId: 'blender@video.blender.org',
        channelName: 'Blender',
        channelThumbnail: 'https://video.blender.org/lazy-static/avatars/blender.png',
        channelPlatformFields: { platform: 'peertube', host: 'video.blender.org', id: 'overridden' },
      },
    })

    await wrapper.find('.subscribeButton').trigger('click')
    await flushPromises()

    expect(dispatched('addChannelToProfiles')).toEqual([{
      channel: {
        id: 'blender@video.blender.org',
        name: 'Blender',
        thumbnail: 'https://video.blender.org/lazy-static/avatars/blender.png',
        platform: 'peertube',
        host: 'video.blender.org',
      },
      profileIds: ['allChannels'],
    }])
  })
})

describe('the profile dropdown', () => {
  const CHANNEL = { id: 'UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender', thumbnail: '' }
  const IMAGE_SRC = 'data:image/webp;base64,UklGRhYAAABXRUJQVlA4TAoAAAAvAAAAAEX/I/of'

  it('draws a profile\'s picture in its row, and a subscribed row\'s checkmark on the plain colour', async () => {
    const allChannels = { ...ALL_CHANNELS, subscriptions: [CHANNEL] }
    const music = { _id: 'music', name: 'Music', bgColor: '#3F51B5', textColor: '#FFFFFF', subscriptions: [] }

    store.setGetter('getProfileList', [allChannels, music])
    store.setGetter('getActiveProfile', allChannels)
    store.setGetter('getProfilePictures', {
      allChannels: { kind: 'symbol', text: '★' },
      music: { kind: 'image', src: IMAGE_SRC },
    })

    const wrapper = mountWithApp(FtSubscribeButton, {
      store,
      props: { channelId: CHANNEL.id, channelName: CHANNEL.name },
    })

    await wrapper.find('.profileDropdownToggle').trigger('click')

    const rows = wrapper.findAll('.profile')
    const subscribedRow = rows.find(row => row.attributes('aria-checked') === 'true')
    const musicRow = rows.find(row => row.text().includes('Music'))

    expect(musicRow.find('.initial').text()).toBe('')
    expect(musicRow.find('.colorOption').attributes('style')).toContain(IMAGE_SRC)

    expect(subscribedRow.find('.initial').text()).toBe('✓')
    expect(subscribedRow.find('.colorOption').attributes('style')).not.toContain('url(')
    expect(subscribedRow.find('.colorOption').element.style.backgroundColor).toBe('rgb(0, 0, 0)')
  })
})
