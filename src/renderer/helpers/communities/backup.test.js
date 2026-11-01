import { describe, expect, it } from 'vitest'

import { SOURCE_MACHINE_FIELDS, backedUpSource, communitiesBackupSections, withMachineFields } from './backup.js'

// What of Communities goes into a backup: the followed sources without what
// belongs to this machine, and the shares of every source but HackerTube

const HACKERTUBE = { _id: 'hackertube', kind: 'hackertube', url: 'https://hackertube.org', name: 'HackerTube', followedAt: 1, dataGenerated: '2026-10-31', checkedAt: 5, attemptedAt: 6, failedAt: null }
const LEMMY = { _id: 'lemmy:videos@lemmy.example', kind: 'lemmy', url: 'https://lemmy.example/c/videos', name: 'videos@lemmy.example', followedAt: 2, checkedAt: 7, attemptedAt: 8, failedAt: 9 }

const share = (sourceId, videoId, seenAt = 10) => ({ _id: `${sourceId}|${videoId}`, sourceId, videoId, title: 'Synthetic', author: '', votes: 3, why: null, sharedAt: 1, discussionUrl: null, seenAt })

describe('communities in a backup', () => {
  it('leaves the refresh times and the export loaded out of a source', () => {
    expect(SOURCE_MACHINE_FIELDS).toEqual(['checkedAt', 'attemptedAt', 'failedAt', 'dataGenerated'])
    expect(backedUpSource(HACKERTUBE)).toEqual({ _id: 'hackertube', kind: 'hackertube', url: 'https://hackertube.org', name: 'HackerTube', followedAt: 1 })
    expect(backedUpSource(LEMMY)).toEqual({ _id: LEMMY._id, kind: 'lemmy', url: LEMMY.url, name: LEMMY.name, followedAt: 2 })
  })

  it('gives a source without those fields back as it is', () => {
    const source = backedUpSource(LEMMY)
    expect(backedUpSource(source)).toBe(source)
  })

  it('writes every followed source and the shares of all but HackerTube, and of no source unfollowed', () => {
    const shares = [share('hackertube', 'aaaaaaaaaaa'), share(LEMMY._id, 'bbbbbbbbbbb'), share('lemmy:gone@lemmy.example', 'ccccccccccc')]

    expect(communitiesBackupSections([HACKERTUBE, LEMMY], shares)).toEqual({
      communitySources: [backedUpSource(HACKERTUBE), backedUpSource(LEMMY)],
      communityShares: [shares[1]],
    })
  })

  it('writes two empty sections when nothing is followed', () => {
    expect(communitiesBackupSections([], [share('hackertube', 'aaaaaaaaaaa')])).toEqual({ communitySources: [], communityShares: [] })
  })

  it('keeps this machine\'s refresh times when a source comes from another machine', () => {
    const fromBackup = { ...backedUpSource(LEMMY), name: 'Renamed', checkedAt: 99 }

    expect(withMachineFields(fromBackup, LEMMY)).toEqual({ ...backedUpSource(LEMMY), name: 'Renamed', checkedAt: 7, attemptedAt: 8, failedAt: 9 })
    expect(withMachineFields(fromBackup, null)).toEqual({ ...backedUpSource(LEMMY), name: 'Renamed' })
  })
})
