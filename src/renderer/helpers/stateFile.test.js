import { describe, expect, it } from 'vitest'

import { SETTLED_BY_RULE, mergeStateRecords, readStateFile, stateChangesSince, writeStateFile } from './stateFile'

// Synthetic throughout, shaped as the datastores store it

const ARCHIVE = '0123456789abcdef'

const stateFile = records => ({ archive: ARCHIVE, records })

const laterItem = fields => ({
  _id: 'dQw4w9WgXcQ',
  videoId: 'dQw4w9WgXcQ',
  title: 'A video',
  author: 'A channel',
  authorId: 'UCSMOQeBJ2RAnuFungnQOxLg',
  lengthSeconds: 212,
  viewCount: 900,
  published: 1764000000000,
  addedAt: 1764100000000,
  position: 2.5,
  ...fields,
})

describe('writeStateFile and readStateFile', () => {
  it('round trips a state file', () => {
    const state = stateFile({
      'history/dQw4w9WgXcQ': { at: 1764160000000, fields: { watchProgress: 221.4 } },
      'later/dQw4w9WgXcQ': { at: 1764159000000, fields: { viewCount: 900 } },
    })

    expect(readStateFile(writeStateFile(state))).toEqual({ ok: true, state })
  })

  it('refuses text that is not JSON, and JSON that is not a state file', () => {
    expect(readStateFile('{"archive":')).toEqual({ ok: false, reason: 'notJson' })
    expect(readStateFile('[]')).toEqual({ ok: false, reason: 'notStateFile' })
    expect(readStateFile('{"records":{}}')).toEqual({ ok: false, reason: 'notStateFile' })
    expect(readStateFile(JSON.stringify({ archive: ARCHIVE }))).toEqual({ ok: false, reason: 'notStateFile' })
    expect(readStateFile(JSON.stringify(stateFile({ 'later/a': { fields: {} } })))).toEqual({ ok: false, reason: 'notStateFile' })
  })

  it('gives the same bytes for the same state whatever order the keys went in', () => {
    const one = writeStateFile({
      archive: ARCHIVE,
      records: {
        'later/b': { at: 2, fields: { viewCount: 2, title: 'Second' } },
        'later/a': {
          at: 1,
          fields: { thumbnail: { height: 90, source: { url: 'https://yt3.ggpht.com/one', width: 120 } }, title: 'First' },
        },
      },
    })
    const other = writeStateFile({
      records: {
        'later/a': {
          fields: { title: 'First', thumbnail: { source: { width: 120, url: 'https://yt3.ggpht.com/one' }, height: 90 } },
          at: 1,
        },
        'later/b': { fields: { title: 'Second', viewCount: 2 }, at: 2 },
      },
      archive: ARCHIVE,
    })

    expect(one).toBe(other)
  })
})

describe('mergeStateRecords', () => {
  const desktop = { by: 'aaaa', state: stateFile({ 'later/one': { at: 20, fields: { viewCount: 20 } } }) }
  const laptop = { by: 'bbbb', state: stateFile({ 'later/one': { at: 30, fields: { viewCount: 30 } } }) }

  it('takes the newest value of a key across two machines', () => {
    expect(mergeStateRecords([desktop, laptop])['later/one']).toEqual({ at: 30, by: 'bbbb', fields: { viewCount: 30 } })
    expect(mergeStateRecords([laptop, desktop])['later/one']).toEqual({ at: 30, by: 'bbbb', fields: { viewCount: 30 } })
  })

  it('breaks a tie on at by the installation id', () => {
    const tied = { by: 'bbbb', state: stateFile({ 'later/one': { at: 20, fields: { viewCount: 99 } } }) }

    expect(mergeStateRecords([desktop, tied])['later/one']).toEqual({ at: 20, by: 'bbbb', fields: { viewCount: 99 } })
    expect(mergeStateRecords([tied, desktop])['later/one']).toEqual({ at: 20, by: 'bbbb', fields: { viewCount: 99 } })
  })

  it('keeps a key only one machine has', () => {
    const alone = { by: 'bbbb', state: stateFile({ 'history/other': { at: 5, fields: { watchProgress: 12 } } }) }

    expect(mergeStateRecords([desktop, alone])).toEqual({
      'later/one': { at: 20, by: 'aaaa', fields: { viewCount: 20 } },
      'history/other': { at: 5, by: 'bbbb', fields: { watchProgress: 12 } },
    })
  })
})

describe('stateChangesSince', () => {
  it('names only the records whose state fields differ from the archive', () => {
    const archived = [laterItem(), laterItem({ _id: 'other', videoId: 'other' })]
    const records = [laterItem({ viewCount: 1200 }), laterItem({ _id: 'other', videoId: 'other' })]

    const changes = stateChangesSince('later', records, archived, 1764200000000)

    expect(Object.keys(changes)).toEqual(['later/dQw4w9WgXcQ'])
    expect(changes['later/dQw4w9WgXcQ'].at).toBe(1764200000000)
    expect(changes['later/dQw4w9WgXcQ'].fields.viewCount).toBe(1200)
    expect(changes['later/dQw4w9WgXcQ'].fields.position).toBeUndefined()
  })

  it('ignores a difference in an intent field', () => {
    const archived = [laterItem()]
    const records = [laterItem({ position: 7.5 })]

    expect(stateChangesSince('later', records, archived, 1764200000000)).toEqual({})
  })

  it('says nothing about a record the archive has and this machine no longer does', () => {
    expect(stateChangesSince('later', [], [laterItem()], 1764200000000)).toEqual({})
  })
})

describe('the rules the newest value does not settle', () => {
  const OFFERED_KEY = 'settings/communitiesStarterSourcesOffered'
  const offered = (at, value) => stateFile({ [OFFERED_KEY]: { at, fields: { _id: 'communitiesStarterSourcesOffered', value } } })

  const SOURCE_ID = 'lemmy:videos@lemmy.example'
  const share = (at, votes) => ({ at, fields: { _id: `${SOURCE_ID}|video000001`, sourceId: SOURCE_ID, videoId: 'video000001', votes, seenAt: at } })

  it('keeps communitiesStarterSourcesOffered as the union of both machines\' lists', () => {
    // What mergeStarterSourcesOffered exists for: the list only grows, so one
    // machine's unfollows never have the starter sources offered again
    const files = [
      { by: 'aaaa', state: offered(30, ['hackertube', 'lemmy:mine@lemmy.example']) },
      { by: 'bbbb', state: offered(40, ['hackertube', 'lemmy:theirs@lemmy.example']) },
    ]

    const merged = mergeStateRecords(files)
    expect(merged[OFFERED_KEY].fields.value).toEqual(['hackertube', 'lemmy:theirs@lemmy.example'])

    SETTLED_BY_RULE.settings(merged, { files, sections: {} })

    expect(merged[OFFERED_KEY]).toEqual({
      at: 40,
      by: 'bbbb',
      fields: { _id: 'communitiesStarterSourcesOffered', value: ['hackertube', 'lemmy:mine@lemmy.example', 'lemmy:theirs@lemmy.example'] },
    })
  })

  it('drops a share whose source nothing follows after the merge', () => {
    // What dropUnfollowedShares exists for: this machine unfollowed the source
    // while the other refreshed one of its shares, and the refresh must not
    // bring back a share of nothing, which no unfollow would ever remove
    const merged = { [`communityShares/${SOURCE_ID}|video000001`]: { by: 'bbbb', ...share(40, 9) } }

    SETTLED_BY_RULE.communityShares(merged, { files: [], sections: { communitySources: [] } })

    expect(merged).toEqual({})
  })

  it('keeps a share whose source arrives in the same merge', () => {
    const key = `communityShares/${SOURCE_ID}|video000001`
    const merged = {
      [`communitySources/${SOURCE_ID}`]: { at: 40, by: 'bbbb', fields: { _id: SOURCE_ID, name: 'videos@lemmy.example' } },
      [key]: { by: 'bbbb', ...share(40, 9) },
    }

    SETTLED_BY_RULE.communityShares(merged, { files: [], sections: { communitySources: [] } })

    expect(Object.keys(merged)).toContain(key)
  })
})
