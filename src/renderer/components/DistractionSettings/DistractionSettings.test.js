import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import settingsModule from '../../store/modules/settings'
import { mountWithApp } from '../../testing/mount'
import { createTestRouter } from '../../testing/router'

const MARKED = [
  { id: 'UCaaaaaaaaaaaaaaaaaaaaaa', name: 'Synthetic Sounds' },
  { id: 'UCbbbbbbbbbbbbbbbbbbbbbb', name: 'Generated Gardens' },
]

// What the section reads of the settings, as the defaults have them
const SETTINGS = vi.hoisted(() => ({
  getBackendFallback: false,
  getBackendPreference: 'local',
  getChannelsHidden: '[]',
  getForbiddenTitles: '[]',
  getHideAiVideos: false,
  getAiChannels: '[]',
  getHideChannelCommunity: false,
  getHideChannelCourses: false,
  getHideChannelHome: false,
  getHideChannelPlaylists: false,
  getHideChannelPodcasts: false,
  getHideChannelReleases: false,
  getHideChannelShorts: false,
  getHideChannelSubscriptions: false,
  getHideChapters: false,
  getHideCommentLikes: false,
  getHideCommentPhotos: false,
  getHideComments: false,
  getHideExplore: false,
  getHideFeaturedChannels: false,
  getHideLiveChat: false,
  getHideLiveStreams: false,
  getHidePlaylists: false,
  getHidePopularVideos: false,
  getHideRecommendedVideos: false,
  getHideSharingActions: false,
  getHideUpcomingPremieres: false,
  getHideVideoDescription: false,
  getHideVideoLikesAndDislikes: false,
  getHideVideoViews: false,
  getHideWatchedSubs: false,
  getShowAddedChannelsHidden: true,
  getShowAddedForbiddenTitles: true,
  getShowDistractionFreeTitles: false,
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

beforeEach(() => {
  for (const [name, value] of Object.entries(SETTINGS)) {
    store.setGetter(name, value)
  }
  store.dispatched.length = 0
})

async function mountSettings() {
  const { default: DistractionSettings } = await import('./DistractionSettings.vue')
  const router = createTestRouter([{ path: '/channel/:id', name: 'channel' }, { path: '/', name: 'home' }])

  return mountWithApp(DistractionSettings, { store, router })
}

function toggleLabelled(wrapper, label) {
  return wrapper.findAll('.switch-ctn')
    .find(toggle => toggle.find('.switch-label-text').text() === label)
}

/** @param {import('@vue/test-utils').VueWrapper} wrapper */
function markedChannelList(wrapper) {
  return wrapper.findAll('.ft-input-tags-component')
    .find(tags => tags.text().includes('Channels Marked as AI'))
}

describe('Distraction Free settings, videos made with AI', () => {
  it('shows them by default, and a settings export carries both settings', () => {
    expect(settingsModule.state.hideAiVideos).toBe(false)
    expect(settingsModule.state.aiChannels).toBe('[]')
  })

  it('switches the setting the AI pill on every wall is pressed against', async () => {
    const toggle = toggleLabelled(await mountSettings(), 'Hide Videos Made with AI')

    expect(toggle.find('input').element.checked).toBe(false)

    await toggle.find('input').setValue(true)

    expect(store.dispatched).toEqual([{ type: 'updateHideAiVideos', payload: true }])
  })

  it('lists each marked channel by name', async () => {
    store.setGetter('getAiChannels', JSON.stringify(MARKED))
    const list = markedChannelList(await mountSettings())

    expect(list.findAll('li').map(item => item.text())).toEqual(['Synthetic Sounds', 'Generated Gardens'])
  })

  it('unmarks a channel removed from the list, everywhere, leaving the rest', async () => {
    store.setGetter('getAiChannels', JSON.stringify(MARKED))
    const list = markedChannelList(await mountSettings())

    await list.findAll('li')[0].find('button.removeTagButton').trigger('click')
    await flushPromises()

    expect(store.dispatched).toEqual([{ type: 'updateAiChannels', payload: JSON.stringify([MARKED[1]]) }])
  })
})
