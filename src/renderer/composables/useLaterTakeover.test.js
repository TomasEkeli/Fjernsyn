import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DBLaterHandlers } from '../../datastores/handlers/index'
import later from '../store/modules/later'
import { runLaterTakeover } from './useLaterTakeover'

vi.mock('../../datastores/handlers/index', () => ({
  DBLaterHandlers: {
    upsert: vi.fn(async () => {}),
  },
}))
vi.mock('../helpers/utils', () => ({ showToast: vi.fn() }))
vi.mock('../i18n/index', () => ({ default: { global: { t: key => key } } }))

const NOW = Date.parse('2026-10-04T12:00:00Z')

function video(videoId, extra = {}) {
  return { videoId, title: `Title ${videoId}`, author: 'A', authorId: 'UC1', lengthSeconds: 10, timeAdded: 1, playlistItemId: `p-${videoId}`, type: 'video', ...extra }
}

/**
 * The parts of the store the takeover reaches: the playlists and the settings
 * as plain values, the Later list as the real module over a recorded datastore
 */
function fakeStore({ playlists = [], done = false, quickBookmark = 'favorites', laterItems = {} } = {}) {
  const laterState = { laterItems: structuredClone(laterItems), laterReady: true }
  const settings = { laterTakeoverDone: done, quickBookmarkTargetPlaylistId: quickBookmark }
  const calls = []

  const store = {
    calls,
    laterState,
    settings,
    playlists,
    getters: {
      get getLaterTakeoverDone() { return settings.laterTakeoverDone },
      get getQuickBookmarkTargetPlaylistId() { return settings.quickBookmarkTargetPlaylistId },
      getPlaylist: id => store.playlists.find(p => p._id === id),
    },
    async dispatch(type, payload) {
      calls.push(type)

      switch (type) {
        case 'addManyToLater':
          return later.actions.addManyToLater({ state: laterState, commit: (mutation, value) => later.mutations[mutation](laterState, value) }, payload)
        case 'updateLaterTakeoverDone':
          settings.laterTakeoverDone = payload
          return
        case 'updateQuickBookmarkTargetPlaylistId':
          settings.quickBookmarkTargetPlaylistId = payload
          return
        case 'removePlaylist':
          store.playlists = store.playlists.filter(p => p._id !== payload)
      }
    },
  }

  return store
}

const queuedIds = store => later.getters.getLaterQueued(store.laterState).map(i => i._id)

describe('the Watch Later takeover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('copies the playlist in its order, above what is there, then deletes it and marks it done', async () => {
    const store = fakeStore({
      playlists: [{ _id: 'favorites', videos: [] }, { _id: 'watchLater', videos: [video('a'), video('b'), video('c')] }],
      laterItems: { old: { _id: 'old', videoId: 'old', addedAt: 0, position: 0, alarm: null } },
    })

    expect(await runLaterTakeover(store, NOW)).toBe('moved')

    expect(queuedIds(store)).toEqual(['a', 'b', 'c', 'old'])
    expect(Object.values(store.laterState.laterItems).every(i => i.alarm === null)).toBe(true)
    expect(store.playlists.map(p => p._id)).toEqual(['favorites'])
    expect(store.settings.laterTakeoverDone).toBe(true)
    expect(store.calls).toEqual(['addManyToLater', 'removePlaylist', 'updateLaterTakeoverDone'])
  })

  it('skips a video already in the list, and one met before in the playlist', async () => {
    const store = fakeStore({
      playlists: [{ _id: 'watchLater', videos: [video('a'), video('b'), video('a')] }],
      laterItems: { b: { _id: 'b', videoId: 'b', addedAt: 0, position: 0, alarm: { at: 5, armedAt: 0 } } },
    })

    await runLaterTakeover(store, NOW)

    expect(DBLaterHandlers.upsert).toHaveBeenCalledTimes(1)
    expect(queuedIds(store)).toEqual(['a'])
    expect(store.laterState.laterItems.b.alarm).toEqual({ at: 5, armedAt: 0 })
  })

  it('deletes nothing and marks nothing when a write fails, and a second try finishes it', async () => {
    DBLaterHandlers.upsert.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('disk'))
    const store = fakeStore({ playlists: [{ _id: 'watchLater', videos: [video('a'), video('b')] }] })

    expect(await runLaterTakeover(store, NOW)).toBe('failed')
    expect(store.playlists.map(p => p._id)).toEqual(['watchLater'])
    expect(store.settings.laterTakeoverDone).toBe(false)

    // Safe, not ordered: what the first try wrote stays, once
    expect(await runLaterTakeover(store, NOW)).toBe('moved')
    expect(queuedIds(store).toSorted()).toEqual(['a', 'b'])
    expect(store.playlists).toEqual([])
  })

  it('moves a quick bookmark aimed at Watch Later to Favorites, or to nothing', async () => {
    const withFavorites = fakeStore({ quickBookmark: 'watchLater', playlists: [{ _id: 'favorites', videos: [] }, { _id: 'watchLater', videos: [] }] })
    await runLaterTakeover(withFavorites, NOW)
    expect(withFavorites.settings.quickBookmarkTargetPlaylistId).toBe('favorites')

    const without = fakeStore({ quickBookmark: 'watchLater', playlists: [{ _id: 'watchLater', videos: [] }] })
    await runLaterTakeover(without, NOW)
    expect(without.settings.quickBookmarkTargetPlaylistId).toBe('')
  })

  it('marks it done when there is no Watch Later playlist', async () => {
    const store = fakeStore({ playlists: [{ _id: 'favorites', videos: [] }] })

    expect(await runLaterTakeover(store, NOW)).toBe('nothing-to-move')
    expect(store.settings.laterTakeoverDone).toBe(true)
  })

  it('does nothing the second time, and leaves a Watch Later playlist made since alone', async () => {
    const store = fakeStore({ playlists: [{ _id: 'watchLater', videos: [video('a')] }] })
    await runLaterTakeover(store, NOW)

    // Made afterwards, and given the id on the next start
    store.playlists = [{ _id: 'watchLater', playlistName: 'Watch Later', videos: [video('z')] }]
    store.calls.length = 0

    expect(await runLaterTakeover(store, NOW)).toBe('done-before')
    expect(store.calls).toEqual([])
    expect(store.playlists.map(p => p._id)).toEqual(['watchLater'])
    expect(queuedIds(store)).toEqual(['a'])
  })

  it('moves PeerTube videos too, with what they need to render and route, and deletes the playlist', async () => {
    const uuid = 'b29290cc-dc51-4a12-bcb2-2aa5fece7605'
    const thumbnail = 'https://x.org/lazy-static/previews/a.jpg'
    const store = fakeStore({ playlists: [{ _id: 'watchLater', videos: [video('a'), video(uuid, { platform: 'peertube', host: 'x.org', thumbnail })] }] })

    expect(await runLaterTakeover(store, NOW)).toBe('moved')

    expect(queuedIds(store)).toEqual(['a', uuid])
    expect(store.laterState.laterItems[uuid]).toMatchObject({ platform: 'peertube', host: 'x.org', thumbnail })
    expect(store.playlists).toEqual([])
    expect(store.settings.laterTakeoverDone).toBe(true)
  })
})
