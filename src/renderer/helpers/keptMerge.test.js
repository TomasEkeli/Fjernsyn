import { describe, expect, it } from 'vitest'

import { mergeSections } from './keptMerge'

// Synthetic records shaped as the datastores hold them

function watched(_id, videoId, timeWatched, watchProgress = 30) {
  return { _id, videoId, title: `Video ${videoId}`, author: 'Synthetic Channel', authorId: 'UCsynthetic', lengthSeconds: 60, watchProgress, timeWatched, type: 'video' }
}

function playlist(_id, lastUpdatedAt, videoIds = []) {
  return { _id, playlistName: `List ${_id}`, protected: false, createdAt: 1, lastUpdatedAt, videos: videoIds.map(videoId => ({ videoId, playlistItemId: `i-${videoId}` })) }
}

const PROFILE = { _id: 'allChannels', name: 'All Channels', bgColor: '#000000', textColor: '#FFFFFF', subscriptions: [] }

const H1 = watched('h1', 'video000001', 1)
const H2 = watched('h2', 'video000002', 2)

const ANCESTOR = {
  profiles: [PROFILE],
  history: [H1, H2],
  settings: [{ _id: 'maxVolume', value: 100 }],
}

/** The ancestor with a section replaced */
const withSection = (section, records) => ({ ...ANCESTOR, [section]: records })

describe('mergeSections', () => {
  it('takes what only theirs changed: an addition, a change and a removal', () => {
    const changed = { ...H1, watchProgress: 50, timeWatched: 3 }
    const added = watched('h3', 'video000003', 4)
    const theirs = withSection('history', [changed, added])

    const { merged, toApply, conflicts } = mergeSections({ ancestor: ANCESTOR, theirs, ours: ANCESTOR })

    expect(merged.history).toEqual([changed, added])
    expect(toApply).toEqual({ history: { put: [changed, added], remove: ['h2'] } })
    expect(conflicts).toBe(0)
  })

  it('keeps what only ours changed, with nothing to apply', () => {
    const changed = { ...H1, watchProgress: 50, timeWatched: 3 }
    const ours = { ...withSection('history', [changed]), searchHistory: [{ _id: 'synthetic search', lastUpdatedAt: 5 }] }

    const { merged, toApply, conflicts } = mergeSections({ ancestor: ANCESTOR, theirs: ANCESTOR, ours })

    expect(merged.history).toEqual([changed])
    expect(merged.searchHistory).toEqual(ours.searchHistory)
    expect(toApply).toEqual({})
    expect(conflicts).toBe(0)
  })

  it('takes the later watch when both changed one history entry', () => {
    const theirs = withSection('history', [{ ...H1, watchProgress: 200, timeWatched: 5 }, H2])
    const ours = withSection('history', [{ ...H1, watchProgress: 100, timeWatched: 4 }, H2])

    const theirsLater = mergeSections({ ancestor: ANCESTOR, theirs, ours })
    expect(theirsLater.toApply).toEqual({ history: { put: [theirs.history[0]], remove: [] } })
    expect(theirsLater.conflicts).toBe(1)

    const oursLater = mergeSections({ ancestor: ANCESTOR, theirs: ours, ours: theirs })
    expect(oursLater.merged.history).toEqual(theirs.history)
    expect(oursLater.toApply).toEqual({})
    expect(oursLater.conflicts).toBe(1)
  })

  it('decides a conflict by the section\'s time field, and the folder\'s where there is none', () => {
    const ancestor = {
      playlists: [playlist('p1', 1)],
      searchHistory: [{ _id: 's1', lastUpdatedAt: 1, extra: 'a' }],
      aiVerdicts: [{ _id: 'v1', ai: false, checkedAt: 1 }],
      profiles: [PROFILE],
    }
    const theirs = {
      playlists: [playlist('p1', 2, ['theirs00001'])],
      searchHistory: [{ _id: 's1', lastUpdatedAt: 3, extra: 'theirs' }],
      aiVerdicts: [{ _id: 'v1', ai: true, checkedAt: 2 }],
      profiles: [{ ...PROFILE, bgColor: '#111111' }],
    }
    const ours = {
      playlists: [playlist('p1', 3, ['ours0000001'])],
      searchHistory: [{ _id: 's1', lastUpdatedAt: 2, extra: 'ours' }],
      aiVerdicts: [{ _id: 'v1', ai: false, checkedAt: 3 }],
      profiles: [{ ...PROFILE, bgColor: '#222222' }],
    }

    const { merged, toApply, conflicts } = mergeSections({ ancestor, theirs, ours })

    expect(merged.playlists).toEqual(ours.playlists)
    expect(merged.searchHistory).toEqual(theirs.searchHistory)
    expect(merged.aiVerdicts).toEqual(ours.aiVerdicts)
    expect(merged.profiles).toEqual(theirs.profiles)
    expect(Object.keys(toApply).sort()).toEqual(['profiles', 'searchHistory'])
    expect(conflicts).toBe(4)
  })

  it('carries a removal on one side when the other did not change the record', () => {
    const removedByOurs = mergeSections({ ancestor: ANCESTOR, theirs: ANCESTOR, ours: withSection('history', [H1]) })
    expect(removedByOurs.merged.history).toEqual([H1])
    expect(removedByOurs.toApply).toEqual({})

    const removedByTheirs = mergeSections({ ancestor: ANCESTOR, theirs: withSection('history', [H1]), ours: ANCESTOR })
    expect(removedByTheirs.merged.history).toEqual([H1])
    expect(removedByTheirs.toApply).toEqual({ history: { put: [], remove: ['h2'] } })
  })

  it('keeps the change when one side removed a record the other changed', () => {
    const changed = { ...H2, watchProgress: 55, timeWatched: 9 }

    const theirsRemoved = mergeSections({ ancestor: ANCESTOR, theirs: withSection('history', [H1]), ours: withSection('history', [H1, changed]) })
    expect(theirsRemoved.merged.history).toEqual([H1, changed])
    expect(theirsRemoved.toApply).toEqual({})

    const oursRemoved = mergeSections({ ancestor: ANCESTOR, theirs: withSection('history', [H1, changed]), ours: withSection('history', [H1]) })
    expect(oursRemoved.merged.history).toEqual([H1, changed])
    expect(oursRemoved.toApply).toEqual({ history: { put: [changed], remove: [] } })
  })

  describe('without an ancestor', () => {
    it('is a union: what either side lacks is kept, so a removal does not travel', () => {
      const ours = { ...withSection('history', [H1]), playlists: [playlist('p2', 1)] }
      const theirs = withSection('history', [H2])

      const { merged, toApply, conflicts } = mergeSections({ ancestor: null, theirs, ours })

      expect(merged.history).toEqual([H2, H1])
      expect(merged.playlists).toEqual(ours.playlists)
      expect(toApply).toEqual({ history: { put: [H2], remove: [] } })
      expect(conflicts).toBe(0)
    })

    it('decides a conflict for the folder, except in the history, where the later watch wins', () => {
      const theirs = { history: [{ ...H1, watchProgress: 10, timeWatched: 1 }], playlists: [playlist('p1', 1, ['theirs00001'])] }
      const ours = { history: [{ ...H1, watchProgress: 90, timeWatched: 7 }], playlists: [playlist('p1', 9, ['ours0000001'])] }

      const { merged, toApply, conflicts } = mergeSections({ ancestor: null, theirs, ours })

      expect(merged.history).toEqual(ours.history)
      expect(merged.playlists).toEqual(theirs.playlists)
      expect(toApply).toEqual({ playlists: { put: theirs.playlists, remove: [] } })
      expect(conflicts).toBe(2)
    })
  })

  it('never removes a setting, with or without an ancestor', () => {
    const ours = withSection('settings', [{ _id: 'maxVolume', value: 100 }, { _id: 'ourOwn', value: true }])
    const theirs = withSection('settings', [])

    for (const ancestor of [{ ...ANCESTOR, settings: ours.settings }, null]) {
      const { merged, toApply } = mergeSections({ ancestor, theirs, ours })

      expect(merged.settings).toEqual(ours.settings)
      expect(toApply).toEqual({})
    }
  })

  it('tells history entries apart by video, so one video under two _ids is one entry', () => {
    const theirs = withSection('history', [watched('theirs-id', 'video000001', 8, 99), H2])
    const ours = withSection('history', [watched('ours-id', 'video000001', 7, 50), H2])

    const theirsLater = mergeSections({ ancestor: null, theirs, ours })
    expect(theirsLater.merged.history).toEqual([theirs.history[0], H2])
    expect(theirsLater.toApply).toEqual({ history: { put: [theirs.history[0]], remove: ['ours-id'] } })

    // The other way about: ours is later, and stays under its own _id
    const reversed = { ...ours, history: [watched('ours-id', 'video000001', 9, 50), H2] }
    const oursLater = mergeSections({ ancestor: null, theirs, ours: reversed })
    expect(oursLater.merged.history).toEqual(reversed.history)
    expect(oursLater.toApply).toEqual({})
  })

  it('has nothing to apply when the two sides are the same', () => {
    const { merged, toApply, conflicts } = mergeSections({ ancestor: null, theirs: ANCESTOR, ours: structuredClone(ANCESTOR) })

    expect(merged).toEqual(ANCESTOR)
    expect(toApply).toEqual({})
    expect(conflicts).toBe(0)
  })
})
