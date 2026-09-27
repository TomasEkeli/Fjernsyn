import { describe, expect, it, vi } from 'vitest'

import { DBHistoryHandlers } from '../../../datastores/handlers/index'
import history from './history'

// What the store writes, recorded instead of written
vi.mock('../../../datastores/handlers/index', () => ({
  DBHistoryHandlers: {
    delete: vi.fn(async () => {}),
  },
}))

const UUID = 'b29290cc-dc51-4a12-bcb2-2aa5fece7605'

const PEERTUBE_ENTRY = { videoId: UUID, title: 'Sprite Fright', platform: 'peertube', host: 'video.blender.org' }
const YOUTUBE_ENTRY = { videoId: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up' }

describe('the history store, removing a PeerTube entry', () => {
  it('deletes it by its uuid, from the database and from both caches, leaving the rest', async () => {
    const state = {
      historyCacheSorted: [PEERTUBE_ENTRY, YOUTUBE_ENTRY],
      historyCacheById: { [UUID]: PEERTUBE_ENTRY, [YOUTUBE_ENTRY.videoId]: YOUTUBE_ENTRY },
    }
    const commit = (type, payload) => history.mutations[type](state, payload)

    await history.actions.removeFromHistory({ commit }, UUID)

    expect(DBHistoryHandlers.delete).toHaveBeenCalledWith(UUID)
    expect(state.historyCacheSorted).toEqual([YOUTUBE_ENTRY])
    expect(state.historyCacheById).toEqual({ [YOUTUBE_ENTRY.videoId]: YOUTUBE_ENTRY })
  })
})
