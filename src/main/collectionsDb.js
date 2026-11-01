import { DBActions, SyncEvents } from '../constants'
import { isStorableCollectionRecord } from './collectionsRecords'

/**
 * Main's side of the Collections datastores: one action a renderer asked for,
 * run against the handlers (`datastores/handlers/base.js`), with every write
 * passed on to the other windows (`syncOthers`), which apply it themselves
 * (`store/modules/collections.js`, `applyCollectionsSync`). What crosses to
 * the renderer on failure is a string, as for the other datastores.
 *
 * Apart from `main/index.js`, which only checks the sender and hands over,
 * so that it can be tested without Electron.
 *
 * @param {number} action one of `DBActions.COLLECTIONS`
 * @param {any} data
 * @param {object} deps
 * @param {Record<string, (...args: any[]) => Promise<any>>} deps.handlers
 * @param {(payload: { event: number, data: any }) => void} deps.syncOthers
 * @returns {Promise<any>}
 */
export async function handleCollectionsDb(action, data, { handlers, syncOthers }) {
  try {
    switch (action) {
      case DBActions.COLLECTIONS.FIND_SOURCES:
        return await handlers.findSources()

      case DBActions.COLLECTIONS.FIND_SHARES:
        return await handlers.findShares()

      case DBActions.COLLECTIONS.UPSERT_SOURCE:
        refuseUnless(isStorableCollectionRecord(data))
        await handlers.upsertSource(data)
        syncOthers({ event: SyncEvents.COLLECTIONS.UPSERT_SOURCE, data })
        return null

      case DBActions.COLLECTIONS.UPDATE_SOURCE: {
        // Never creates the record, so a refresh cannot follow again a
        // source unfollowed while it ran; other windows hear of it as of
        // any write of a source, and only when there was one
        refuseUnless(isStorableCollectionRecord(data))
        const updated = await handlers.updateSource(data)
        if (updated.updated > 0) {
          syncOthers({ event: SyncEvents.COLLECTIONS.UPSERT_SOURCE, data })
        }
        return updated
      }

      case DBActions.COLLECTIONS.REMOVE_SOURCE: {
        refuseUnless(typeof data === 'string' && data !== '')
        const removed = await handlers.removeSource(data)
        syncOthers({ event: SyncEvents.COLLECTIONS.REMOVE_SOURCE, data })
        return removed
      }

      case DBActions.COLLECTIONS.PUT_SHARES: {
        refuseUnless(Array.isArray(data) && data.every(share => isStorableCollectionRecord(share)))
        const counts = await handlers.putShares(data)
        // Not those of a source no longer followed, which were not written
        const dropped = new Set(counts.dropped)
        const written = dropped.size === 0 ? data : data.filter(share => !dropped.has(share._id))
        if (written.length > 0) {
          syncOthers({ event: SyncEvents.COLLECTIONS.PUT_SHARES, data: written })
        }
        return counts
      }

      case DBActions.COLLECTIONS.FIND_VIDEOS:
        return await handlers.findVideos()

      case DBActions.COLLECTIONS.PUT_VIDEOS:
        refuseUnless(Array.isArray(data) && data.every(video => isStorableCollectionRecord(video, { videoId: true })))
        await handlers.putVideos(data)
        syncOthers({ event: SyncEvents.COLLECTIONS.PUT_VIDEOS, data })
        return null

      case DBActions.COLLECTIONS.FIND_SOURCE_DATA:
        return await handlers.findSourceData()

      case DBActions.COLLECTIONS.PUT_SOURCE_DATA: {
        refuseUnless(isStorableCollectionRecord(data))
        const put = await handlers.putSourceData(data)
        if (put.kept) {
          syncOthers({ event: SyncEvents.COLLECTIONS.PUT_SOURCE_DATA, data })
        }
        return put
      }

      default:
        // eslint-disable-next-line no-throw-literal
        throw 'invalid collections db action'
    }
  } catch (err) {
    if (typeof err === 'string') throw err
    else throw err.toString()
  }
}

/**
 * @param {boolean} storable
 */
function refuseUnless(storable) {
  if (!storable) {
    // eslint-disable-next-line no-throw-literal
    throw 'invalid collections data'
  }
}
