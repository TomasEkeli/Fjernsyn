import { enableAutoUnmount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { communitiesCrawlProgress, startCommunitiesCrawl } from '../../helpers/communities/crawlRunner'
import { mountWithApp } from '../../testing/mount'
import FtElementList from '../../components/FtElementList/FtElementList.vue'
import FtLoader from '../../components/FtLoader/FtLoader.vue'
import FtRefreshWidget from '../../components/FtRefreshWidget/FtRefreshWidget.vue'
import FtToggleChip from '../../components/FtToggleChip/FtToggleChip.vue'
import Communities from './Communities.vue'
import CommunitiesVoteBadge from '../../components/CommunitiesVoteBadge/CommunitiesVoteBadge.vue'
import { ThumbnailBadgeProbe } from '../../testing/thumbnailBadgeProbe'

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getCommunitiesReady: false,
        getCommunitiesLoading: false,
        getCommunitiesLoadFailed: false,
        getCommunitySources: [],
        getCommunityShares: [],
        getCommunityVideos: {},
        getCommunitiesGrabFailed: false,
        getCommunitiesRefreshing: false,
        getCommunitiesRefreshProgress: { done: 0, total: 0 },
        getCommunitiesLastRefreshAt: null,
        getCommunitiesRefreshFailures: [],
        getCommunitiesSourcesHidden: [],
        getCommunitiesSort: 'votes',
        getCommunitiesSortDescending: true,
        getHideWatchedSubs: false,
        getHistoryCacheById: {},
        getHideAiVideos: false,
        getAiVerdicts: {},
        getAiChannels: '[]',
        getPeerTubeShowNsfw: false,
        getCommunitySource: () => undefined,
        getCommunityShare: () => undefined,
        getCommunitySourceData: () => undefined,
      },
    }),
  }
})

// The bundle's taxonomy, for an installation that has none kept
vi.mock('../../helpers/communities/hackertubeBundle', () => ({
  shippedHackerTubeTaxonomy: vi.fn(() => new Promise(() => {})),
}))

// The crawl itself is tested in helpers/communities; here, only whether the
// page starts it and shows how far it has got
vi.mock('../../helpers/communities/crawlRunner', async () => {
  const { reactive } = await import('vue')
  return {
    communitiesCrawlProgress: reactive({ state: 'idle', requests: 0 }),
    startCommunitiesCrawl: vi.fn(),
  }
})

// helpers/utils imports the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

const HACKERTUBE = { _id: 'hackertube', kind: 'hackertube', url: 'https://hackertube.org', name: 'HackerTube' }

/**
 * @param {number} index
 * @param {number} votes
 */
function share(index, votes) {
  const videoId = `video${String(index).padStart(6, '0')}`
  return { _id: `hackertube|${videoId}`, sourceId: 'hackertube', videoId, title: `Title ${index}`, author: 'Channel', votes, sharedAt: 0 }
}

/**
 * @param {object} [options]
 * @param {import('vue').Component | true} [options.list] what stands in for the wall's list
 */
function mountCommunities({ list = true } = {}) {
  return mountWithApp(Communities, {
    store,
    stubs: { FtElementList: list, FtAutoLoadNextPageWrapper: false },
  })
}

/** @param {import('@vue/test-utils').VueWrapper} wrapper */
function listed(wrapper) {
  return wrapper.findComponent(FtElementList).props('data')
}

enableAutoUnmount(afterEach)

describe('Communities', () => {
  beforeEach(() => {
    sessionStorage.clear()
    store.dispatched.length = 0
    store.setGetter('getCommunitiesReady', false)
    store.setGetter('getCommunitiesLoading', false)
    store.setGetter('getCommunitiesLoadFailed', false)
    store.setGetter('getCommunitySources', [HACKERTUBE])
    store.setGetter('getCommunityShares', [])
    store.setGetter('getCommunityVideos', {})
    store.setGetter('getCommunitiesGrabFailed', false)
    store.setGetter('getCommunitiesRefreshing', false)
    store.setGetter('getCommunitiesRefreshProgress', { done: 0, total: 0 })
    store.setGetter('getCommunitiesLastRefreshAt', null)
    store.setGetter('getCommunitiesRefreshFailures', [])
    store.setGetter('getCommunitiesSourcesHidden', [])
    store.setGetter('getCommunitiesSort', 'votes')
    store.setGetter('getCommunitiesSortDescending', true)
    store.setGetter('getHideWatchedSubs', false)
    store.setGetter('getHistoryCacheById', {})
    store.setGetter('getHideAiVideos', false)
    store.setGetter('getAiVerdicts', {})
    store.setGetter('getPeerTubeShowNsfw', false)
    communitiesCrawlProgress.state = 'idle'
    vi.mocked(startCommunitiesCrawl).mockClear()
  })

  afterEach(() => {
    store.setGetter('getCommunitySource', () => undefined)
    store.setGetter('getCommunityShare', () => undefined)
    store.setGetter('getCommunitySourceData', () => undefined)
  })

  it('gives every card the vote badge, saying on hover each source\'s votes, and none to a video without votes', async () => {
    const LEMMY = { _id: 'lemmy:talks@programming.dev', kind: 'lemmy', url: 'https://programming.dev/c/talks', name: 'talks@programming.dev' }
    const shares = [
      share(1, 11.5),
      { ...share(1, 6), _id: `${LEMMY._id}|video000001`, sourceId: LEMMY._id },
      share(2, null),
    ]
    store.setGetter('getCommunitiesReady', true)
    store.setGetter('getCommunitySources', [HACKERTUBE, LEMMY])
    store.setGetter('getCommunityShares', shares)
    store.setGetter('getCommunitySource', id => [HACKERTUBE, LEMMY].find(source => source._id === id))
    store.setGetter('getCommunityShare', id => shares.find(each => each._id === id))

    const wrapper = mountCommunities({ list: ThumbnailBadgeProbe })
    await flushPromises()

    const badges = wrapper.findAllComponents(CommunitiesVoteBadge)
    expect(badges.map(badge => [badge.props('video').videoId, badge.props('sourceId')])).toEqual([
      ['video000001', null],
      ['video000002', null],
    ])
    expect(wrapper.find('[data-video-id="video000001"] button.votes').text()).toBe('▲ 17.5')
    await wrapper.find('[data-video-id="video000001"] .communitiesVoteBadge').trigger('pointerenter')
    expect(wrapper.findAll('[data-video-id="video000001"] .source').map(row => row.text())).toEqual(['HackerTube▲ 11.5', 'talks@programming.dev▲ 6'])
    expect(wrapper.find('[data-video-id="video000002"] .communitiesVoteBadge').exists()).toBe(false)
  })

  it('opens Communities once the datastore has loaded, and not before', async () => {
    const wrapper = mountCommunities()
    await flushPromises()

    expect(store.dispatched.map(({ type }) => type)).toEqual([])
    expect(wrapper.findComponent(FtLoader).exists()).toBe(true)

    store.setGetter('getCommunitiesReady', true)
    await flushPromises()

    expect(store.dispatched.map(({ type }) => type)).toEqual(['openCommunities', 'refreshCommunitiesIfDue'])
  })

  it('leaves a PeerTube video its uploader marked NSFW off the wall unless NSFW is shown, and gives the card its thumbnail', async () => {
    const uuid = '9c9de5e8-0a1e-484a-b099-e80766180a6d'
    const key = `${uuid}@framatube.org`
    const peerTube = { _id: `hackertube|${key}`, sourceId: 'hackertube', videoId: uuid, platform: 'peertube', host: 'framatube.org', title: 'Shared', author: '', votes: 5, sharedAt: 0 }
    store.setGetter('getCommunitiesReady', true)
    store.setGetter('getCommunityShares', [peerTube, share(1, 1)])
    store.setGetter('getCommunityVideos', {
      [key]: { _id: key, videoId: uuid, platform: 'peertube', host: 'framatube.org', fetchedAt: 1, title: 'Own', authorId: 'f@framatube.org', lengthSeconds: 60, thumbnail: 'https://framatube.org/t.jpg', nsfw: true },
    })

    const wrapper = mountCommunities()
    await flushPromises()

    expect(listed(wrapper).map(video => video.videoId)).toEqual(['video000001'])

    store.setGetter('getPeerTubeShowNsfw', true)
    await flushPromises()

    expect(listed(wrapper)[0]).toMatchObject({ videoId: uuid, platform: 'peertube', host: 'framatube.org', thumbnail: 'https://framatube.org/t.jpg', authorId: 'f@framatube.org' })
  })

  it('shows a loader while the bundle loads', async () => {
    store.setGetter('getCommunitiesReady', true)
    store.setGetter('getCommunitiesLoading', true)

    const wrapper = mountCommunities()
    await flushPromises()

    expect(wrapper.findComponent(FtLoader).exists()).toBe(true)
    expect(wrapper.findComponent(FtElementList).exists()).toBe(false)
  })

  it('is one ordinary card per video, the most voted first, a hundred at a time on a wall that looks up AI labels', async () => {
    store.setGetter('getCommunitiesReady', true)
    store.setGetter('getCommunityShares', Array.from({ length: 150 }, (_, index) => share(index, index)))

    const wrapper = mountCommunities()
    await flushPromises()

    const data = listed(wrapper)
    expect(data).toHaveLength(100)
    expect(data[0]).toMatchObject({ type: 'video', videoId: 'video000149', title: 'Title 149', author: 'Channel', lengthSeconds: '' })
    expect(data[99].videoId).toBe('video000050')
    expect(wrapper.findComponent(FtElementList).props('aiWall')).toBe(true)

    // Load more, after the refresh button
    await wrapper.findAll('button').at(-1).trigger('click')

    expect(listed(wrapper)).toHaveLength(150)
  })

  it('shows a hundred when the window remembered for the session is not a number', async () => {
    for (const saved of ['garbage', '0', '-5']) {
      sessionStorage.setItem('communitiesLimit', saved)
      store.setGetter('getCommunitiesReady', true)
      store.setGetter('getCommunityShares', Array.from({ length: 150 }, (_, index) => share(index, index)))

      const wrapper = mountCommunities()
      await flushPromises()

      expect(listed(wrapper), saved).toHaveLength(100)
      wrapper.unmount()
    }
  })

  it('leaves HackerTube\'s credit to HackerTube\'s own page', async () => {
    store.setGetter('getCommunitiesReady', true)

    const wrapper = mountCommunities()
    await flushPromises()

    expect(wrapper.find('.credit').exists()).toBe(false)
  })

  it('is the wall of every followed source, each video once, its votes summed over them', async () => {
    store.setGetter('getCommunitiesReady', true)
    store.setGetter('getCommunitySources', [HACKERTUBE, { _id: 'lemmy:a@b.example', kind: 'lemmy', name: 'a@b.example' }])
    store.setGetter('getCommunityShares', [
      share(1, 5),
      { ...share(1, 7), _id: 'lemmy:a@b.example|video000001', sourceId: 'lemmy:a@b.example' },
      // Of a source unfollowed while its shares were being written
      { ...share(2, 100), _id: 'lemmy:gone@b.example|video000002', sourceId: 'lemmy:gone@b.example' },
    ])

    const wrapper = mountCommunities()
    await flushPromises()

    expect(listed(wrapper)).toEqual([expect.objectContaining({ videoId: 'video000001', community: expect.objectContaining({ votes: 12 }) })])
  })

  it('says so when the bundle could not be loaded and there is nothing to show', async () => {
    store.setGetter('getCommunitiesReady', true)
    store.setGetter('getCommunitiesLoadFailed', true)

    const wrapper = mountCommunities()
    await flushPromises()

    expect(wrapper.find('.message').text()).toContain('could not be loaded')
  })

  it('starts the crawl once Communities is open and has videos', async () => {
    store.setGetter('getCommunityShares', [share(1, 1)])
    mountCommunities()
    await flushPromises()
    expect(startCommunitiesCrawl).not.toHaveBeenCalled()

    store.setGetter('getCommunitiesReady', true)
    await flushPromises()

    expect(startCommunitiesCrawl).toHaveBeenCalledTimes(1)
  })

  it('starts the crawl without waiting for the refresh, but after the bundle is in', async () => {
    store.setGetter('getCommunityShares', [share(1, 1)])
    const dispatch = store.dispatch
    let finishOpen
    store.dispatch = (type, payload) => {
      dispatch(type, payload)
      if (type === 'openCommunities') { return new Promise((resolve) => { finishOpen = resolve }) }
      // A refresh that never ends
      return new Promise(() => {})
    }

    try {
      store.setGetter('getCommunitiesReady', true)
      mountCommunities()
      await flushPromises()
      expect(startCommunitiesCrawl).not.toHaveBeenCalled()

      finishOpen()
      await flushPromises()

      expect(store.dispatched.map(({ type }) => type)).toEqual(['openCommunities', 'refreshCommunitiesIfDue'])
      expect(startCommunitiesCrawl).toHaveBeenCalledTimes(1)
    } finally {
      store.dispatch = dispatch
    }
  })

  it('does not start the crawl when the videos could not be loaded', async () => {
    store.setGetter('getCommunitiesReady', true)
    store.setGetter('getCommunitiesLoadFailed', true)

    mountCommunities()
    await flushPromises()

    expect(startCommunitiesCrawl).not.toHaveBeenCalled()
  })

  it('starts the crawl once a refresh brings the videos the bundle could not', async () => {
    store.setGetter('getCommunitiesReady', true)
    store.setGetter('getCommunitiesLoadFailed', true)
    mountCommunities()
    await flushPromises()

    store.setGetter('getCommunitiesLoadFailed', false)
    store.setGetter('getCommunityShares', [share(1, 1)])
    await flushPromises()

    expect(startCommunitiesCrawl).toHaveBeenCalledTimes(1)
  })

  it('shows the crawl in the refresh widget while it runs, with how many videos have their details, and nothing once it is done', async () => {
    store.setGetter('getCommunitiesReady', true)
    store.setGetter('getCommunityShares', Array.from({ length: 4 }, (_, index) => share(index, index)))
    store.setGetter('getCommunityVideos', { video000001: { _id: 'video000001', videoId: 'video000001', fetchedAt: 1 } })
    communitiesCrawlProgress.state = 'running'

    const wrapper = mountCommunities()
    await flushPromises()

    const widget = () => wrapper.findComponent(FtRefreshWidget)
    expect(widget().props('activityLabel')).toBe('Fetching video details')
    expect(widget().props('activityProgress')).toBe(0.25)

    communitiesCrawlProgress.state = 'paused'
    await flushPromises()
    expect(widget().props('activityLabel')).toBe('Video details paused')

    communitiesCrawlProgress.state = 'done'
    await flushPromises()
    expect(widget().props('activityLabel')).toBe('')
    expect(widget().props('activityProgress')).toBe(null)
  })

  describe('the refresh widget', () => {
    it('says when every source was last refreshed', async () => {
      store.setGetter('getCommunitiesReady', true)
      store.setGetter('getCommunitiesLastRefreshAt', 1_700_000_000_000)

      const wrapper = mountCommunities()
      await flushPromises()

      expect(wrapper.findComponent(FtRefreshWidget).props('lastRefreshAt')).toBe(1_700_000_000_000)
    })

    it('refreshes from its button', async () => {
      store.setGetter('getCommunitiesReady', true)
      const wrapper = mountCommunities()
      await flushPromises()
      store.dispatched.length = 0

      wrapper.findComponent(FtRefreshWidget).vm.$emit('click')

      expect(store.dispatched.map(({ type }) => type)).toEqual(['refreshCommunities'])
    })

    it('refreshes on R and F5, and not on a key held down or while typing', async () => {
      store.setGetter('getCommunitiesReady', true)
      mountCommunities()
      await flushPromises()
      store.dispatched.length = 0

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5' }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', repeat: true }))

      const input = document.createElement('input')
      input.classList.add('ft-input')
      document.body.appendChild(input)
      input.focus()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }))
      input.remove()

      expect(store.dispatched.map(({ type }) => type)).toEqual(['refreshCommunities', 'refreshCommunities'])
    })

    it('stops listening for R once the page is left', async () => {
      store.setGetter('getCommunitiesReady', true)
      const wrapper = mountCommunities()
      await flushPromises()
      store.dispatched.length = 0

      wrapper.unmount()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }))

      expect(store.dispatched).toEqual([])
    })

    it('does not refresh while a refresh runs, while the bundle loads, or before the datastore is read', async () => {
      for (const [getter, value] of [['getCommunitiesRefreshing', true], ['getCommunitiesLoading', true], ['getCommunitiesReady', false], ['getCommunitiesGrabFailed', true]]) {
        store.setGetter('getCommunitiesReady', true)
        store.setGetter(getter, value)
        const wrapper = mountCommunities()
        await flushPromises()
        store.dispatched.length = 0

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }))

        expect(wrapper.findComponent(FtRefreshWidget).props('disableRefresh'), getter).toBe(true)
        expect(store.dispatched, getter).toEqual([])
        wrapper.unmount()
        store.setGetter(getter, getter === 'getCommunitiesReady')
      }
    })

    it('says it is refreshing in place of the crawl, with how many sources are done when there is more than one', async () => {
      store.setGetter('getCommunitiesReady', true)
      store.setGetter('getCommunitiesRefreshing', true)
      store.setGetter('getCommunitiesRefreshProgress', { done: 0, total: 1 })
      communitiesCrawlProgress.state = 'running'

      const wrapper = mountCommunities()
      await flushPromises()

      const widget = wrapper.findComponent(FtRefreshWidget)
      expect(widget.props('activityLabel')).toBe('Asking the sources for new videos')
      expect(widget.props('activityProgress')).toBe(null)

      store.setGetter('getCommunitiesRefreshProgress', { done: 1, total: 4 })
      await flushPromises()
      expect(widget.props('activityProgress')).toBe(0.25)
    })

    it('says which sources could not be refreshed, and nothing when all could', async () => {
      store.setGetter('getCommunitiesReady', true)
      const wrapper = mountCommunities()
      await flushPromises()

      expect(wrapper.find('.refreshFailed').exists()).toBe(false)

      store.setGetter('getCommunitiesRefreshFailures', [{ _id: 'hackertube', name: 'HackerTube', failedAt: 1 }])
      await flushPromises()

      expect(wrapper.find('.refreshFailed').text()).toBe('Could not refresh HackerTube')
    })
  })

  it('shows a video\'s details on its card once they are in, and leaves an unavailable one off', async () => {
    store.setGetter('getCommunitiesReady', true)
    store.setGetter('getCommunityShares', [share(1, 2), share(2, 1)])
    store.setGetter('getCommunityVideos', {
      video000001: { _id: 'video000001', videoId: 'video000001', fetchedAt: 7, authorId: 'UCaaaaaaaaaaaaaaaaaaaaaa', lengthSeconds: 60, viewCount: 5 },
      video000002: { _id: 'video000002', videoId: 'video000002', fetchedAt: 7, unavailable: 'private' },
    })

    const wrapper = mountCommunities()
    await flushPromises()

    expect(listed(wrapper)).toEqual([expect.objectContaining({ videoId: 'video000001', authorId: 'UCaaaaaaaaaaaaaaaaaaaaaa', lengthSeconds: 60, viewCount: 5, lastUpdatedAt: 7 })])
  })

  describe('the toolbar', () => {
    const LEMMY_A = { _id: 'lemmy:a@b.example', kind: 'lemmy', name: 'a@b.example' }
    const LEMMY_Z = { _id: 'lemmy:z@b.example', kind: 'lemmy', name: 'Z@b.example' }

    /**
     * @param {{ _id: string }} source
     * @param {number} index
     * @param {object} [extra]
     */
    const shareOf = (source, index, extra = {}) => ({ ...share(index, 1), _id: `${source._id}|video${String(index).padStart(6, '0')}`, sourceId: source._id, ...extra })

    beforeEach(() => {
      store.setGetter('getCommunitiesReady', true)
      store.setGetter('getCommunitySources', [LEMMY_Z, HACKERTUBE, LEMMY_A])
      store.setGetter('getCommunityShares', [
        shareOf(HACKERTUBE, 1, { votes: 10, sharedAt: 3 }),
        shareOf(LEMMY_A, 1, { votes: 100, sharedAt: 1 }),
        shareOf(LEMMY_A, 2, { votes: 50, sharedAt: 2 }),
        shareOf(LEMMY_Z, 3, { votes: 20, sharedAt: 4 }),
      ])
    })

    /** @param {import('@vue/test-utils').VueWrapper} wrapper */
    const sourceChips = wrapper => wrapper.find('.chipRow').findAllComponents(FtToggleChip)

    /** @param {import('@vue/test-utils').VueWrapper} wrapper */
    const order = wrapper => listed(wrapper).map(video => video.videoId)

    it('has a chip per followed source, by name, each on until switched off', async () => {
      store.setGetter('getCommunitiesSourcesHidden', [LEMMY_A._id])

      const wrapper = mountCommunities()
      await flushPromises()

      expect(sourceChips(wrapper).map(chip => [chip.props('label'), chip.props('pressed')])).toEqual([
        ['a@b.example', false],
        ['HackerTube', true],
        ['Z@b.example', true],
      ])
      expect(wrapper.find('.chipRow').attributes('aria-label')).toBe('Sources shown')
    })

    it('has no chip group when no source is followed, and the row of a wall without chips', async () => {
      store.setGetter('getCommunitySources', [])

      const wrapper = mountCommunities()
      await flushPromises()

      expect(wrapper.find('.chipRow').exists()).toBe(false)
      expect(wrapper.find('.controlRow').classes()).toContain('withoutChips')
    })

    it('logs a chip or a sort that could not be kept, rather than leaving the failure unhandled', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const wrapper = mountCommunities()
      await flushPromises()
      const dispatch = store.dispatch
      store.dispatch = () => Promise.reject(new Error('settings.db is gone'))

      try {
        sourceChips(wrapper)[0].vm.$emit('toggle')
        await wrapper.find('select.sortSelect').setValue('views')
        await flushPromises()
      } finally {
        store.dispatch = dispatch
      }

      // Font Awesome's own complaints about the test's missing icons aside
      expect(errors.mock.calls.map(([message]) => message).filter(message => String(message).startsWith('Communities:'))).toEqual([
        `Communities: could not keep the chip of ${LEMMY_A._id}`,
        'Communities: could not keep the order of the wall',
      ])
      errors.mockRestore()
    })

    it('switches a source off and on through the setting', async () => {
      store.setGetter('getCommunitiesSourcesHidden', [LEMMY_A._id])
      const wrapper = mountCommunities()
      await flushPromises()
      store.dispatched.length = 0

      sourceChips(wrapper)[1].vm.$emit('toggle')
      sourceChips(wrapper)[0].vm.$emit('toggle')

      expect(store.dispatched).toEqual([
        { type: 'updateCommunitiesSourcesHidden', payload: [LEMMY_A._id, HACKERTUBE._id] },
        { type: 'updateCommunitiesSourcesHidden', payload: [] },
      ])
    })

    it('leaves off the videos only a source switched off shared, and counts only the shown sources\' votes', async () => {
      const wrapper = mountCommunities()
      await flushPromises()

      expect(listed(wrapper).map(video => [video.videoId, video.community.votes])).toEqual([
        ['video000001', 110],
        ['video000002', 50],
        ['video000003', 20],
      ])

      store.setGetter('getCommunitiesSourcesHidden', [LEMMY_A._id])
      await flushPromises()

      expect(listed(wrapper).map(video => [video.videoId, video.community.votes])).toEqual([
        ['video000003', 20],
        ['video000001', 10],
      ])
    })

    it('says so when every source is switched off', async () => {
      store.setGetter('getCommunitiesSourcesHidden', [LEMMY_A._id, LEMMY_Z._id, HACKERTUBE._id])

      const wrapper = mountCommunities()
      await flushPromises()

      expect(wrapper.find('.message').text()).toBe('No source is shown. Switch one on above.')
      expect(wrapper.findComponent(FtElementList).exists()).toBe(false)
    })

    it('offers the four orders, upvotes chosen while nothing else is', async () => {
      store.setGetter('getCommunitiesSort', 'nonsense')

      const wrapper = mountCommunities()
      await flushPromises()

      const select = wrapper.find('select.sortSelect')
      expect(select.findAll('option').map(option => [option.attributes('value'), option.text()])).toEqual([
        ['published', 'Video published'],
        ['shared', 'Shared on community'],
        ['views', 'Views'],
        ['votes', 'Upvotes'],
      ])
      expect(select.element.value).toBe('votes')
      expect(wrapper.find(`label[for="${select.attributes('id')}"]`).text()).toBe('Sort by')
    })

    it('keeps the order chosen in the setting, and is in it', async () => {
      const wrapper = mountCommunities()
      await flushPromises()
      store.dispatched.length = 0

      await wrapper.find('select.sortSelect').setValue('shared')

      expect(store.dispatched).toEqual([{ type: 'updateCommunitiesSort', payload: 'shared' }])

      store.setGetter('getCommunitiesSort', 'shared')
      await flushPromises()

      // The latest shown share first: Z's (4), HackerTube's (3), a's (2)
      expect(order(wrapper)).toEqual(['video000003', 'video000001', 'video000002'])
    })

    it('reverses the order with the button beside the sort, which says the direction, and keeps it in the setting', async () => {
      const wrapper = mountCommunities()
      await flushPromises()
      store.dispatched.length = 0

      const button = wrapper.find('.picker button.sortDirection')
      expect(button.attributes('aria-label')).toBe('Descending, the most or newest first. Click to reverse')

      await button.trigger('click')
      expect(store.dispatched).toEqual([{ type: 'updateCommunitiesSortDescending', payload: false }])

      const descending = order(wrapper)
      store.setGetter('getCommunitiesSortDescending', false)
      await flushPromises()

      expect(order(wrapper)).toEqual([...descending].reverse())
      expect(wrapper.find('button.sortDirection').attributes('aria-label')).toBe('Ascending, the fewest or oldest first. Click to reverse')
    })

    it('orders by video published and views from the details, a video without them last', async () => {
      store.setGetter('getCommunityVideos', {
        video000002: { _id: 'video000002', videoId: 'video000002', fetchedAt: 1, published: 200, viewCount: 5 },
        video000003: { _id: 'video000003', videoId: 'video000003', fetchedAt: 1, published: 100, viewCount: 9 },
      })
      store.setGetter('getCommunitiesSort', 'published')

      const wrapper = mountCommunities()
      await flushPromises()

      expect(order(wrapper)).toEqual(['video000002', 'video000003', 'video000001'])

      store.setGetter('getCommunitiesSort', 'views')
      await flushPromises()

      expect(order(wrapper)).toEqual(['video000003', 'video000002', 'video000001'])
    })

    it('has the Watched pill, which takes what has been watched off the wall before it is paged', async () => {
      store.setGetter('getHistoryCacheById', { video000001: { videoId: 'video000001' } })
      const wrapper = mountCommunities()
      await flushPromises()

      const watched = wrapper.find('.pageControls').findAllComponents(FtToggleChip).at(0)
      expect(watched.props('label')).toBe('Watched')
      expect(watched.props('pressed')).toBe(true)
      expect(order(wrapper)).toHaveLength(3)

      store.dispatched.length = 0
      watched.vm.$emit('toggle')
      expect(store.dispatched).toEqual([{ type: 'updateHideWatchedSubs', payload: true }])

      store.setGetter('getHideWatchedSubs', true)
      await flushPromises()

      expect(order(wrapper)).toEqual(['video000002', 'video000003'])
    })

    it('says everything has been watched when the Watched pill took it all', async () => {
      store.setGetter('getHideWatchedSubs', true)
      store.setGetter('getHistoryCacheById', { video000001: {}, video000002: {}, video000003: {} })

      const wrapper = mountCommunities()
      await flushPromises()

      expect(wrapper.find('.message').text()).toContain('You have watched everything here')
    })

    it('has the AI pill, which takes what is made with AI off the wall before it is paged, and says so when that is everything', async () => {
      store.setGetter('getHideAiVideos', true)
      store.setGetter('getAiVerdicts', { video000001: true })

      const wrapper = mountCommunities()
      await flushPromises()

      expect(wrapper.find('.pageControls').findAllComponents(FtToggleChip).at(1).props('label')).toBe('AI')
      expect(order(wrapper)).toEqual(['video000002', 'video000003'])

      store.setGetter('getAiVerdicts', { video000001: true, video000002: true, video000003: true })
      await flushPromises()

      expect(wrapper.find('.message').text()).toContain('Everything here is made with AI')
    })

    it('has no category select, and ignores a category chosen on HackerTube\'s page', async () => {
      store.setGetter('getCommunitySourceData', id => id === HACKERTUBE._id
        ? { _id: id, generated: '2026-10-31', taxonomy: { version: 'v', areas: [{ id: 'sci', name: 'Science', categories: [{ id: 'physics', name: 'Physics' }] }] } }
        : undefined)
      store.setGetter('getCommunityShares', [
        shareOf(HACKERTUBE, 1, { votes: 10, categories: ['compilers'] }),
        shareOf(LEMMY_A, 2, { votes: 5 }),
        shareOf(HACKERTUBE, 3, { votes: 1, categories: ['physics'] }),
      ])
      sessionStorage.setItem('communitiesCategory', 'physics')

      const wrapper = mountCommunities()
      await flushPromises()

      expect(wrapper.find('select.categorySelect').exists()).toBe(false)
      expect(order(wrapper)).toEqual(['video000001', 'video000002', 'video000003'])
    })
  })
})
