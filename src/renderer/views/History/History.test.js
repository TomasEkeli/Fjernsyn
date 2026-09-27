import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'
import { createTestRouter } from '../../testing/router'
import FtElementList from '../../components/FtElementList/FtElementList.vue'
import FtInput from '../../components/FtInput/FtInput.vue'
import History from './History.vue'

// Upstream's history view, for what its search finds: a PeerTube entry is
// matched on its title and channel name like any other

const PEERTUBE_ENTRY = {
  videoId: 'b29290cc-dc51-4a12-bcb2-2aa5fece7605',
  title: 'Sprite Fright',
  author: 'Blender Studio',
  authorId: 'blender@video.blender.org',
  timeWatched: 2,
  platform: 'peertube',
  host: 'video.blender.org',
  thumbnail: 'https://video.blender.org/lazy-static/previews/sprite-fright.jpg',
}

const YOUTUBE_ENTRY = {
  videoId: 'dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up',
  author: 'Rick Astley',
  authorId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
  timeWatched: 1,
}

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getHistoryCacheSorted: [],
        getUserHistorySortBy: 'latest_played_first',
        getListDensity: 'standard',
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

afterEach(() => {
  vi.useRealTimers()
})

/** @param {string} [path] */
async function mountHistory(path = '/history') {
  store.setGetter('getHistoryCacheSorted', [PEERTUBE_ENTRY, YOUTUBE_ENTRY])
  const router = createTestRouter([{ path: '/history', name: 'history' }])
  await router.push(path)
  await router.isReady()

  const wrapper = mountWithApp(History, {
    store,
    router,
    stubs: { FtElementList: true, FtDensitySwitch: true, FtSelect: true, FtToggleSwitch: true, FtAutoLoadNextPageWrapper: true },
  })
  await flushPromises()

  return wrapper
}

/** @param {import('@vue/test-utils').VueWrapper} wrapper */
function listed(wrapper) {
  return wrapper.findComponent(FtElementList).props('data').map(entry => entry.videoId)
}

describe('History, searching', () => {
  it('lists a PeerTube entry with the rest', async () => {
    expect(listed(await mountHistory())).toEqual([PEERTUBE_ENTRY.videoId, YOUTUBE_ENTRY.videoId])
  })

  it('finds a PeerTube entry by its title', async () => {
    vi.useFakeTimers()
    const wrapper = await mountHistory()

    wrapper.findComponent(FtInput).vm.$emit('input', 'sprite')
    vi.advanceTimersByTime(500)
    await flushPromises()

    expect(listed(wrapper)).toEqual([PEERTUBE_ENTRY.videoId])
  })

  it('finds a PeerTube entry by its channel name, from the search kept in the route', async () => {
    expect(listed(await mountHistory('/history?searchQueryText=Blender%20Studio'))).toEqual([PEERTUBE_ENTRY.videoId])
  })

  it('finds a YouTube entry as today', async () => {
    expect(listed(await mountHistory('/history?searchQueryText=astley'))).toEqual([YOUTUBE_ENTRY.videoId])
  })
})
