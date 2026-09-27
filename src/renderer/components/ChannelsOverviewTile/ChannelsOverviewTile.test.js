import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'
import { createTestRouter } from '../../testing/router'
import ChannelsOverviewTile from './ChannelsOverviewTile.vue'

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getDisableChannelLinks: false,
        getBackendPreference: 'invidious',
        getCurrentInvidiousInstanceUrl: 'https://inv.example',
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
      describe: (entity, options) => describe(entity, { backendPreference: 'invidious', currentInvidiousInstanceUrl: 'https://inv.example' }, options),
    }),
  }
})

const HANDLE = 'blender@video.blender.org'
// A path with `ggpht/` and an `=s…` size in it, which the YouTube rules would rewrite
const AVATAR = 'https://video.blender.org/lazy-static/avatars/ggpht/blender=s48-c.png'

const PEERTUBE_STUB = { id: HANDLE, name: 'Blender', thumbnail: AVATAR, platform: 'peertube', host: 'video.blender.org' }
const YOUTUBE_STUB = { id: 'UCuAXFkgsw1L7xaCfnd5JJOw', name: 'Rick Astley', thumbnail: 'https://yt3.ggpht.com/abc=s88-c-k' }

async function mountTile(channel) {
  const router = createTestRouter()
  await router.push('/subscribedchannels')

  const wrapper = mountWithApp(ChannelsOverviewTile, { store, router, props: { channel } })
  return { wrapper, router }
}

describe('ChannelsOverviewTile', () => {
  it('shows a PeerTube channel with its stored avatar as it is', async () => {
    const { wrapper } = await mountTile(PEERTUBE_STUB)

    expect(wrapper.find('img.thumbnail').attributes('src')).toBe(AVATAR)
  })

  it('links a PeerTube channel to its PeerTube page, by the icon and by a double click', async () => {
    const { wrapper, router } = await mountTile(PEERTUBE_STUB)

    const link = wrapper.find('a.channelLink')
    expect(link.attributes('href')).toBe(`#/peertube/channel/${HANDLE}`)

    await link.trigger('click', { button: 0 })
    await flushPromises()
    expect(router.currentRoute.value.path).toBe(`/peertube/channel/${HANDLE}`)

    await router.push('/subscribedchannels')
    await wrapper.find('.selectArea').trigger('dblclick')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe(`/peertube/channel/${HANDLE}`)
  })

  it('points a YouTube channel at the backend in use and its own page, as today', async () => {
    const { wrapper, router } = await mountTile(YOUTUBE_STUB)

    expect(wrapper.find('img.thumbnail').attributes('src')).toBe('https://inv.example/ggpht/abc=s176-c-k')
    expect(wrapper.find('a.channelLink').attributes('href')).toBe(`#/channel/${YOUTUBE_STUB.id}`)

    await wrapper.find('a.channelLink').trigger('click', { button: 0 })
    await flushPromises()
    expect(router.currentRoute.value.path).toBe(`/channel/${YOUTUBE_STUB.id}`)
  })
})
