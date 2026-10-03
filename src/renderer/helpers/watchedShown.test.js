import { beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../store/index'
import { setWatchedShown, watchedIsShown, withWatchedPreference } from './watchedShown'

vi.mock('../store/index', async () => {
  const { createFakeStore } = await import('../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getHideWatchedSubs: false,
        getHistoryCacheById: {},
      },
    }),
  }
})

const watched = { videoId: 'seen' }
const unwatched = { videoId: 'new' }
const sharedWatched = { postContent: { type: 'video', content: { videoId: 'seen' } } }
const textPost = { postContent: { type: 'text' } }

describe('watchedShown', () => {
  beforeEach(() => {
    store.dispatched.length = 0
    store.setGetter('getHideWatchedSubs', false)
    store.setGetter('getHistoryCacheById', { seen: { videoId: 'seen' } })
  })

  it('is the hide-watched setting the other way round', () => {
    expect(watchedIsShown()).toBe(true)

    store.setGetter('getHideWatchedSubs', true)

    expect(watchedIsShown()).toBe(false)
  })

  it('sets the setting the chip is pressed against', () => {
    setWatchedShown(false)

    expect(store.dispatched).toEqual([{ type: 'updateHideWatchedSubs', payload: true }])
  })

  it('does not dispatch when nothing would change', () => {
    setWatchedShown(true)

    expect(store.dispatched).toEqual([])
  })

  it('keeps everything while watched entries are shown', () => {
    const entries = [watched, unwatched, sharedWatched, textPost]

    expect(withWatchedPreference(entries)).toBe(entries)
  })

  it('takes out what has been watched, including posts sharing it, while hidden', () => {
    store.setGetter('getHideWatchedSubs', true)

    expect(withWatchedPreference([watched, unwatched, sharedWatched, textPost]))
      .toEqual([unwatched, textPost])
  })
})
