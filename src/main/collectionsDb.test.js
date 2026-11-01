import { describe, expect, it, vi } from 'vitest'

import { DBActions, SyncEvents } from '../constants'
import { handleCollectionsDb } from './collectionsDb'

function fakeHandlers() {
  return {
    findSources: vi.fn(async () => [{ _id: 'hackertube' }]),
    findShares: vi.fn(async () => []),
    upsertSource: vi.fn(async () => {}),
    updateSource: vi.fn(async () => ({ updated: 1 })),
    removeSource: vi.fn(async () => ({ shares: 2 })),
    putShares: vi.fn(async () => ({ added: 1, updated: 0, dropped: [] })),
    findVideos: vi.fn(async () => []),
    putVideos: vi.fn(async () => {}),
    findSourceData: vi.fn(async () => []),
    putSourceData: vi.fn(async () => ({ kept: true })),
  }
}

/**
 * @param {number} action
 * @param {any} [data]
 */
async function handle(action, data, handlers = fakeHandlers()) {
  const syncOthers = vi.fn()
  const answer = handleCollectionsDb(action, data, { handlers, syncOthers })
  return { handlers, syncOthers, answer }
}

describe('main\'s collections datastore actions', () => {
  it('reads without telling other windows', async () => {
    const { handlers, syncOthers, answer } = await handle(DBActions.COLLECTIONS.FIND_SOURCES)

    expect(await answer).toEqual([{ _id: 'hackertube' }])
    expect(handlers.findSources).toHaveBeenCalledOnce()
    expect(syncOthers).not.toHaveBeenCalled()
  })

  it('writes shares and passes them on to the other windows', async () => {
    const shares = [{ _id: 'hackertube|aaaaaaaaaaa', sourceId: 'hackertube' }]
    const { handlers, syncOthers, answer } = await handle(DBActions.COLLECTIONS.PUT_SHARES, shares)

    expect(await answer).toEqual({ added: 1, updated: 0, dropped: [] })
    expect(handlers.putShares).toHaveBeenCalledWith(shares)
    expect(syncOthers).toHaveBeenCalledWith({ event: SyncEvents.COLLECTIONS.PUT_SHARES, data: shares })
  })

  it('passes on only the shares written, none of a source no longer followed', async () => {
    const shares = [{ _id: 'hackertube|aaaaaaaaaaa', sourceId: 'hackertube' }, { _id: 'lemmy:gone@b.example|aaaaaaaaaaa', sourceId: 'lemmy:gone@b.example' }]
    const handlers = fakeHandlers()
    handlers.putShares.mockResolvedValueOnce({ added: 1, updated: 0, dropped: ['lemmy:gone@b.example|aaaaaaaaaaa'] })

    const { syncOthers, answer } = await handle(DBActions.COLLECTIONS.PUT_SHARES, shares, handlers)

    expect(await answer).toEqual({ added: 1, updated: 0, dropped: ['lemmy:gone@b.example|aaaaaaaaaaa'] })
    expect(syncOthers).toHaveBeenCalledWith({ event: SyncEvents.COLLECTIONS.PUT_SHARES, data: [shares[0]] })

    handlers.putShares.mockResolvedValueOnce({ added: 0, updated: 0, dropped: shares.map(share => share._id) })
    const none = await handle(DBActions.COLLECTIONS.PUT_SHARES, shares, handlers)
    await none.answer
    expect(none.syncOthers).not.toHaveBeenCalled()
  })

  it('updates a followed source and passes it on, and passes on nothing when it was not followed', async () => {
    const source = { _id: 'lemmy:a@b.example', name: 'a', checkedAt: 5 }
    const handlers = fakeHandlers()

    const followed = await handle(DBActions.COLLECTIONS.UPDATE_SOURCE, source, handlers)
    expect(await followed.answer).toEqual({ updated: 1 })
    expect(handlers.updateSource).toHaveBeenCalledWith(source)
    expect(handlers.upsertSource).not.toHaveBeenCalled()
    expect(followed.syncOthers).toHaveBeenCalledWith({ event: SyncEvents.COLLECTIONS.UPSERT_SOURCE, data: source })

    handlers.updateSource.mockResolvedValueOnce({ updated: 0 })
    const gone = await handle(DBActions.COLLECTIONS.UPDATE_SOURCE, source, handlers)
    expect(await gone.answer).toEqual({ updated: 0 })
    expect(gone.syncOthers).not.toHaveBeenCalled()
  })

  it('passes on a source\'s own data only when it was kept', async () => {
    const handlers = fakeHandlers()
    handlers.putSourceData.mockResolvedValueOnce({ kept: false })

    const { syncOthers, answer } = await handle(DBActions.COLLECTIONS.PUT_SOURCE_DATA, { _id: 'lemmy:gone@b.example' }, handlers)

    expect(await answer).toEqual({ kept: false })
    expect(syncOthers).not.toHaveBeenCalled()
  })

  it('refuses a record it cannot store, and tells nobody', async () => {
    for (const [action, data] of [
      [DBActions.COLLECTIONS.UPSERT_SOURCE, { name: 'no id' }],
      [DBActions.COLLECTIONS.UPDATE_SOURCE, { name: 'no id' }],
      [DBActions.COLLECTIONS.PUT_SHARES, [{ _id: 'x', $where: 1 }]],
      [DBActions.COLLECTIONS.PUT_VIDEOS, [{ _id: 'x' }]],
      [DBActions.COLLECTIONS.PUT_SOURCE_DATA, 'x'],
    ]) {
      const { syncOthers, answer } = await handle(action, data)

      await expect(answer, String(action)).rejects.toBe('invalid collections data')
      expect(syncOthers).not.toHaveBeenCalled()
    }
  })

  describe('unfollowing a source', () => {
    it('removes it, with its shares and data, and tells the other windows which', async () => {
      const { handlers, syncOthers, answer } = await handle(DBActions.COLLECTIONS.REMOVE_SOURCE, 'lemmy:a@b.example')

      expect(await answer).toEqual({ shares: 2 })
      expect(handlers.removeSource).toHaveBeenCalledWith('lemmy:a@b.example')
      expect(syncOthers).toHaveBeenCalledWith({ event: SyncEvents.COLLECTIONS.REMOVE_SOURCE, data: 'lemmy:a@b.example' })
    })

    it('refuses anything but a source\'s id, and removes nothing', async () => {
      for (const data of [undefined, '', 5, { _id: 'hackertube' }, ['hackertube']]) {
        const { handlers, syncOthers, answer } = await handle(DBActions.COLLECTIONS.REMOVE_SOURCE, data)

        await expect(answer, JSON.stringify(data)).rejects.toBe('invalid collections data')
        expect(handlers.removeSource).not.toHaveBeenCalled()
        expect(syncOthers).not.toHaveBeenCalled()
      }
    })
  })

  it('refuses an action it does not know', async () => {
    const { answer } = await handle(999)

    await expect(answer).rejects.toBe('invalid collections db action')
  })

  it('answers a failure in the datastore as a string, which is what crosses to the renderer', async () => {
    const handlers = fakeHandlers()
    handlers.removeSource.mockRejectedValueOnce(new Error('locked'))

    await expect(handleCollectionsDb(DBActions.COLLECTIONS.REMOVE_SOURCE, 'hackertube', { handlers, syncOthers: vi.fn() })).rejects.toBe('Error: locked')
  })
})
