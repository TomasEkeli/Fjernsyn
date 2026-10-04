import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App.vue'
import { openInternalPath } from './helpers/utils'
import { openPeerTubeEntry } from './platform/entryPoints'
import store from './store/index'
import { mountWithApp } from './testing/mount'
import { createTestRouter } from './testing/router'

// Only the fork's hook in the deep link handler (`enableOpenUrl`) is under
// test here: a `fjernsyn://` link goes to the PeerTube entry point first, and
// to the YouTube link handler only when that hands it back

vi.mock('./store/index', async () => {
  const { createFakeStore } = await import('./testing/store')
  return {
    default: createFakeStore({
      getters: {
        getDefaultInvidiousInstance: 'https://inv.example',
        getLaterNotices: [],
        getLaterCountdown: null,
      },
    }),
  }
})

vi.mock('./platform/entryPoints', () => ({ openPeerTubeEntry: vi.fn() }))

vi.mock('./helpers/utils', async (importOriginal) => ({
  ...await importOriginal(),
  openInternalPath: vi.fn(),
  showToast: vi.fn(),
}))

vi.mock('./i18n/index', async () => {
  const { createTestI18n } = await import('./testing/i18n')
  return { default: createTestI18n(), loadLocale: vi.fn() }
})

vi.mock('./helpers/api/local.js', () => ({ getLocalClip: vi.fn() }))
vi.mock('./helpers/api/invidious.js', () => ({ getClipInvidious: vi.fn() }))

// The children are not under test, and several fetch on mount
const { stub } = vi.hoisted(() => ({ stub: (name) => ({ default: { name, render: () => null } }) }))
vi.mock('./components/TopNav/TopNav.vue', () => stub('TopNav'))
vi.mock('./components/SideNav/SideNav.vue', () => stub('SideNav'))
vi.mock('./components/FtPrompt/FtPrompt.vue', () => stub('FtPrompt'))
vi.mock('./components/FtToast/FtToast.vue', () => stub('FtToast'))
vi.mock('./components/FtProgressBar/FtProgressBar.vue', () => stub('FtProgressBar'))
vi.mock('./components/FtPlaylistAddVideoPrompt/FtPlaylistAddVideoPrompt.vue', () => stub('FtPlaylistAddVideoPrompt'))
vi.mock('./components/FtCreatePlaylistPrompt/FtCreatePlaylistPrompt.vue', () => stub('FtCreatePlaylistPrompt'))
vi.mock('./components/FtKeyboardShortcutPrompt/FtKeyboardShortcutPrompt.vue', () => stub('FtKeyboardShortcutPrompt'))
vi.mock('./components/FtSearchFilters/FtSearchFilters.vue', () => stub('FtSearchFilters'))
vi.mock('./components/LaterCountdown/LaterCountdown.vue', () => stub('LaterCountdown'))

/** @type {((url: string) => unknown) | null} */
let openUrlHandler = null
let wrapper = null

async function mountApp() {
  const router = createTestRouter([{ path: '/subscriptions', meta: { title: 'Subscriptions' } }])
  await router.push('/subscriptions')

  wrapper = mountWithApp(App, { store, router })
  await flushPromises()

  if (openUrlHandler === null) {
    throw new Error('App did not register its deep link handler')
  }
}

/** A deep link, as main hands it over with the `fjernsyn://` stripped */
async function openUrl(url) {
  await openUrlHandler(url)
  await flushPromises()
}

const youtubeUrlInfoRequests = () => store.dispatched.filter(({ type }) => type === 'getYoutubeUrlInfo')

beforeEach(() => {
  openUrlHandler = null
  window.ftElectron = {
    handleOpenUrl: vi.fn((handler) => { openUrlHandler = handler }),
    // The Later list's: a second window, so that nothing is taken over or checked
    isMainWindow: vi.fn(async () => false),
    handleMainWindowChanged: vi.fn(),
    handleOpenLaterItem: vi.fn(),
  }
  window.matchMedia ??= () => ({ matches: false })
  store.dispatched.length = 0
  openInternalPath.mockClear()
  openPeerTubeEntry.mockReset()

  const dispatch = store.dispatch
  store.dispatch = (type, payload) => {
    const result = dispatch(type, payload)
    return type === 'getYoutubeUrlInfo' ? Promise.resolve({ urlType: 'video', videoId: 'dQw4w9WgXcQ' }) : result
  }
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  delete window.ftElectron
})

describe('the deep link handler', () => {
  it('leaves a link the PeerTube entry point took to it, without asking the YouTube parser', async () => {
    openPeerTubeEntry.mockResolvedValue('opened')
    await mountApp()

    await openUrl('https://video.blender.org/w/9c9de5e8-0a1e-484a-b099-e80766180a6d')

    expect(openPeerTubeEntry).toHaveBeenCalledWith('https://video.blender.org/w/9c9de5e8-0a1e-484a-b099-e80766180a6d')
    expect(youtubeUrlInfoRequests()).toEqual([])
  })

  it('does nothing more when the PeerTube entry point stopped', async () => {
    openPeerTubeEntry.mockResolvedValue('stopped')
    await mountApp()

    await openUrl('https://down.example/w/9c9de5e8-0a1e-484a-b099-e80766180a6d')

    expect(youtubeUrlInfoRequests()).toEqual([])
    expect(openInternalPath).not.toHaveBeenCalled()
  })

  it('hands any other link to the YouTube link handler, as before', async () => {
    openPeerTubeEntry.mockResolvedValue(null)
    await mountApp()

    await openUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')

    expect(youtubeUrlInfoRequests()).toEqual([{ type: 'getYoutubeUrlInfo', payload: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }])
    expect(openInternalPath).toHaveBeenCalledWith({ path: '/watch/dQw4w9WgXcQ', query: {}, doCreateNewWindow: false })
  })

  it('ignores an empty link, as before', async () => {
    await mountApp()

    await openUrl('')

    expect(openPeerTubeEntry).not.toHaveBeenCalled()
    expect(youtubeUrlInfoRequests()).toEqual([])
  })
})
