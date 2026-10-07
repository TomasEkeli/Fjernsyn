import { describe, expect, it } from 'vitest'

import { BACKUP_SECTIONS } from './backup'
import {
  LINEAGE_LENGTH,
  REBASE_THRESHOLD,
  SYNC_FILE_NAME,
  SYNC_FORMAT,
  SYNC_FORMAT_VERSION,
  applyChanges,
  baseFileName,
  computeChanges,
  contentText,
  isBaseFileName,
  lineageEntry,
  readSyncFile,
  rebaseNeeded,
  writeSyncFile,
} from './keptBackup'

// Records shaped as the datastores hold them, as in backup.test.js

const PEERTUBE_UUID = '9c9de5e8-0a1b-4cd8-a5bc-4d2b5f1e3a10'

const MAIN_PROFILE = {
  _id: 'allChannels',
  name: 'All Channels',
  bgColor: '#000000',
  textColor: '#FFFFFF',
  subscriptions: [
    { id: 'UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender', thumbnail: 'https://yt3.ggpht.com/blender=s176' },
    { id: 'blender@video.blender.org', name: 'Blender Studio', thumbnail: null, platform: 'peertube', host: 'video.blender.org' },
  ],
}

const ART_PROFILE = {
  _id: 'p8Wq2xYz',
  name: 'Art',
  bgColor: '#3366FF',
  textColor: '#FFFFFF',
  subscriptions: [{ id: 'UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender', thumbnail: null }],
}

const YOUTUBE_HISTORY = {
  _id: 'h1',
  videoId: 'dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up',
  author: 'Rick Astley',
  authorId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
  published: 1256601600000,
  description: 'A long description',
  viewCount: 1600000000,
  lengthSeconds: 213,
  watchProgress: 100,
  timeWatched: 1759572000000,
  isLive: false,
  type: 'video',
}

const OLD_HISTORY = {
  _id: 'h0',
  videoId: 'jNQXAC9IVRw',
  title: 'Me at the zoo',
  author: 'jawed',
  authorId: 'UC4QobU6STFB0P71PMvOGN5A',
  published: 1114041600000,
  description: '',
  lengthSeconds: 19,
  watchProgress: 19,
  timeWatched: 1600000000000,
  isLive: false,
  type: 'video',
}

const PEERTUBE_HISTORY = {
  _id: 'h2',
  videoId: PEERTUBE_UUID,
  title: 'Sprite Fright',
  author: 'Blender Studio',
  authorId: 'blender@video.blender.org',
  published: 1635724800000,
  description: '',
  lengthSeconds: 629,
  watchProgress: 12,
  timeWatched: 1759572100000,
  isLive: false,
  type: 'video',
  platform: 'peertube',
  host: 'video.blender.org',
  thumbnail: 'https://video.blender.org/lazy-static/thumbnails/sprite.jpg',
}

const PLAYLIST = {
  _id: 'favorites',
  playlistName: 'Favorites',
  protected: true,
  createdAt: 1700000000000,
  lastUpdatedAt: 1759572000000,
  videos: [
    { videoId: 'zz', title: 'Second added first', author: 'A', authorId: 'UCa', lengthSeconds: 10, timeAdded: 2, playlistItemId: 'i2', type: 'video' },
    { videoId: 'aa', title: 'First added second', author: 'B', authorId: 'UCb', lengthSeconds: 20, timeAdded: 1, playlistItemId: 'i1', type: 'video' },
  ],
}

const LATER_QUEUED = {
  _id: 'abcdefghijk',
  videoId: 'abcdefghijk',
  title: 'Queued',
  author: 'Someone',
  authorId: 'UCx',
  addedAt: 1759400000000,
  position: -1.5,
  alarm: null,
}

const LATER_PEERTUBE = {
  _id: PEERTUBE_UUID,
  videoId: PEERTUBE_UUID,
  title: 'Sprite Fright',
  author: 'Blender Studio',
  authorId: 'blender@video.blender.org',
  addedAt: 1759400000000,
  position: -2,
  alarm: null,
  platform: 'peertube',
  host: 'video.blender.org',
  thumbnail: 'https://video.blender.org/lazy-static/thumbnails/sprite.jpg',
}

const SEARCH = { _id: 'blender sprite fright', lastUpdatedAt: 1759572000000 }

const SETTINGS = [
  { _id: 'maxVolume', value: 1000 },
  { _id: 'profilePictures', value: { allChannels: { kind: 'symbol', symbol: 'A' } } },
  { _id: 'aiChannels', value: '[]' },
]

const CHANNEL = {
  _id: 'UCSMOQeBJ2RAnuFungnQOxLg',
  channelTags: ['blender', '3d'],
  videoSamples: { sampledAt: 1759000000000, titles: ['b', 'a'] },
}

const VERDICT = { _id: 'dQw4w9WgXcQ', ai: false, checkedAt: 1759572000000 }

const BASE = {
  profiles: [MAIN_PROFILE, ART_PROFILE],
  history: [YOUTUBE_HISTORY, OLD_HISTORY, PEERTUBE_HISTORY],
  playlists: [PLAYLIST],
  later: [LATER_QUEUED],
  searchHistory: [SEARCH],
  settings: SETTINGS,
  channels: [CHANNEL],
  aiVerdicts: [VERDICT],
}

const SHA256 = '0123456789abcdef'.repeat(4)
const BASE_REFERENCE = { file: 'base-0123456789abcdef.json.gz', sha256: SHA256 }

const HEADER = { appVersion: '0.1.230', installationId: '9b0c6c8e-5d1f-4a2b-9e3d-7f6a5b4c3d2e', machineName: 'DESKTOP-TEST' }

/** A Fisher-Yates shuffle with a fixed seed, for the same shuffle every run */
function shuffled(array, seed = 7) {
  const copy = [...array]
  let state = seed
  for (let i = copy.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648
    const j = state % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

/** A copy of an object with its keys in reverse order, at the top level */
function reversedKeys(record) {
  return Object.fromEntries(Object.entries(record).reverse())
}

/** Every section shuffled, every record's keys reversed, the sections in reverse */
function scrambled(sections) {
  return Object.fromEntries(Object.entries(sections).reverse().map(([name, records]) => [
    name,
    shuffled(records).map(reversedKeys),
  ]))
}

/** @param {Record<string, any>} [document] */
function syncText(document = {}) {
  return JSON.stringify({ format: SYNC_FORMAT, formatVersion: SYNC_FORMAT_VERSION, ...HEADER, base: BASE_REFERENCE, changes: {}, ...document })
}

/** That applying the changes from base to current gives current exactly */
function expectRoundTrip(base, current) {
  const changes = computeChanges(base, current)
  expect(contentText(applyChanges(base, changes))).toBe(contentText(current))
  return changes
}

describe('the kept backup format', () => {
  it('names the sync file', () => {
    expect(SYNC_FILE_NAME).toBe('fjernsyn-sync.json')
  })

  describe('baseFileName', () => {
    it('is base with the first 16 hex digits of the hash', () => {
      const sha256 = 'fedcba9876543210' + '0'.repeat(48)

      expect(baseFileName(sha256)).toBe('base-fedcba9876543210.json.gz')
      expect(isBaseFileName(baseFileName(sha256))).toBe(true)
    })

    it('refuses what is not a SHA-256 in lower case hex', () => {
      expect(() => baseFileName('0123')).toThrow(TypeError)
      expect(() => baseFileName(SHA256.toUpperCase())).toThrow(TypeError)
    })

    it('tells a base from the other files in the folder', () => {
      for (const name of ['fjernsyn-sync.json', 'fjernsyn-sync.lock', '.fjernsyn-tmp-9b0c-x1', 'base-0123456789abcdef.json',
        'base-0123456789ABCDEF.json.gz', 'base-0123456789abcde.json.gz', 'base-0123456789abcdef (conflict).json.gz']) {
        expect(isBaseFileName(name), name).toBe(false)
      }
    })
  })

  describe('contentText', () => {
    it('is the same for the same data in any order', () => {
      expect(contentText(scrambled(BASE))).toBe(contentText(BASE))
    })

    it('differs when a record does', () => {
      expect(contentText({ ...BASE, searchHistory: [{ ...SEARCH, lastUpdatedAt: 1 }] })).not.toBe(contentText(BASE))
    })
  })

  describe('changes, then apply', () => {
    it('has no changes when nothing changed, in whatever order', () => {
      expect(expectRoundTrip(BASE, scrambled(BASE))).toEqual({})
    })

    it('puts a new record and leaves every unchanged section out', () => {
      const added = { _id: 'ytsearch', lastUpdatedAt: 1759600000000 }
      const changes = expectRoundTrip(BASE, { ...BASE, searchHistory: [SEARCH, added] })

      expect(changes).toEqual({ searchHistory: { put: [added], remove: [] } })
    })

    it('removes the ids of records gone', () => {
      const changes = expectRoundTrip(BASE, { ...BASE, profiles: [MAIN_PROFILE], aiVerdicts: [] })

      expect(changes).toEqual({
        profiles: { put: [], remove: ['p8Wq2xYz'] },
        aiVerdicts: { put: [], remove: ['dQw4w9WgXcQ'] },
      })
    })

    it('puts a rewatched old history entry whole, under its own _id', () => {
      const rewatched = { ...OLD_HISTORY, timeWatched: 1759600000000, watchProgress: 4 }
      const changes = expectRoundTrip(BASE, { ...BASE, history: [YOUTUBE_HISTORY, rewatched, PEERTUBE_HISTORY] })

      expect(changes).toEqual({ history: { put: [rewatched], remove: [] } })
    })

    it('puts a changed record whole when only something deep inside it changed', () => {
      const playlist = { ...PLAYLIST, videos: [...PLAYLIST.videos].reverse() }
      const changes = expectRoundTrip(BASE, { ...BASE, playlists: [playlist] })

      expect(changes).toEqual({ playlists: { put: [playlist], remove: [] } })
    })

    it('handles settings changed, added and removed', () => {
      const settings = [
        { _id: 'maxVolume', value: 500 },
        { _id: 'profilePictures', value: { allChannels: { kind: 'symbol', symbol: 'A' } } },
        { _id: 'settingFromLater', value: true },
      ]
      const changes = expectRoundTrip(BASE, { ...BASE, settings })

      expect(changes).toEqual({
        settings: {
          put: [{ _id: 'maxVolume', value: 500 }, { _id: 'settingFromLater', value: true }],
          remove: ['aiChannels'],
        },
      })
    })

    it('keeps PeerTube entries with their platform fields', () => {
      const history = [YOUTUBE_HISTORY, OLD_HISTORY, { ...PEERTUBE_HISTORY, watchProgress: 600 }]
      const current = { ...BASE, history, later: [LATER_QUEUED, LATER_PEERTUBE] }
      const changes = expectRoundTrip(BASE, current)

      expect(changes.history.put).toEqual([history[2]])
      expect(changes.later.put).toEqual([LATER_PEERTUBE])
      expect(applyChanges(BASE, changes).later).toContainEqual(LATER_PEERTUBE)
    })

    it('gives the current sections from shuffled input with every kind of change at once', () => {
      const current = scrambled({
        ...BASE,
        profiles: [MAIN_PROFILE],
        history: [{ ...OLD_HISTORY, timeWatched: 1759600000000 }, PEERTUBE_HISTORY, { ...YOUTUBE_HISTORY, _id: 'h3', videoId: 'otherVideo1' }],
        settings: [{ _id: 'maxVolume', value: 1 }],
        channels: [],
      })

      expectRoundTrip(scrambled(BASE), current)
    })

    it('counts a section present on one side only as empty on the other', () => {
      const { aiVerdicts: _, ...withoutVerdicts } = BASE

      expect(expectRoundTrip(withoutVerdicts, BASE)).toEqual({ aiVerdicts: { put: [VERDICT], remove: [] } })
      expect(computeChanges(BASE, withoutVerdicts)).toEqual({ aiVerdicts: { put: [], remove: ['dQw4w9WgXcQ'] } })
    })

    it('refuses a record without an _id, which could be neither put nor removed', () => {
      expect(() => computeChanges(BASE, { ...BASE, playlists: [{ playlistName: 'No id', videos: [] }] })).toThrow(TypeError)
    })

    it('changes neither input', () => {
      const base = scrambled(BASE)
      const current = { ...base, settings: [{ _id: 'maxVolume', value: 1 }] }
      const before = JSON.stringify([base, current])

      const changes = computeChanges(base, current)
      const changesBefore = JSON.stringify(changes)
      applyChanges(base, changes)

      expect(JSON.stringify([base, current])).toBe(before)
      expect(JSON.stringify(changes)).toBe(changesBefore)
    })
  })

  describe('writeSyncFile', () => {
    const CHANGES = {
      settings: { put: [{ _id: 'maxVolume', value: 500 }], remove: ['aiChannels', 'zoom'] },
      history: { put: [PEERTUBE_HISTORY, YOUTUBE_HISTORY], remove: [] },
    }

    it('writes the header, the base and the changes in the stable order', () => {
      const document = JSON.parse(writeSyncFile({ ...HEADER, base: BASE_REFERENCE, changes: CHANGES }))

      expect(Object.keys(document)).toEqual(['format', 'formatVersion', 'appVersion', 'installationId', 'machineName', 'lineage', 'base', 'changes'])
      expect(document.format).toBe('fjernsyn-sync')
      expect(document.formatVersion).toBe(1)
      expect(Object.keys(document.base)).toEqual(['file', 'sha256'])
      expect(Object.keys(document.changes)).toEqual(['history', 'settings'])
      expect(Object.keys(document.changes.history)).toEqual(['put', 'remove'])
      expect(document.changes.history.put.map(h => h.videoId)).toEqual([PEERTUBE_UUID, 'dQw4w9WgXcQ'].sort())
      expect(Object.keys(document.changes.history.put[0])).toEqual(Object.keys(document.changes.history.put[0]).sort())
    })

    it('is pretty printed with two spaces and ends with a newline', () => {
      const text = writeSyncFile({ ...HEADER, base: BASE_REFERENCE, changes: { settings: { put: [{ value: 500, _id: 'maxVolume' }], remove: ['zoom', 'aiChannels'] } } })

      expect(text).toBe(`{
  "format": "fjernsyn-sync",
  "formatVersion": 1,
  "appVersion": "0.1.230",
  "installationId": "${HEADER.installationId}",
  "machineName": "DESKTOP-TEST",
  "lineage": [],
  "base": {
    "file": "base-0123456789abcdef.json.gz",
    "sha256": "${SHA256}"
  },
  "changes": {
    "settings": {
      "put": [
        {
          "_id": "maxVolume",
          "value": 500
        }
      ],
      "remove": [
        "aiChannels",
        "zoom"
      ]
    }
  }
}
`)
    })

    it('gives the same bytes for the same changes from shuffled input', () => {
      const current = {
        ...BASE,
        history: [{ ...OLD_HISTORY, timeWatched: 1759600000000 }, { ...PEERTUBE_HISTORY, watchProgress: 600 }],
        settings: [{ _id: 'maxVolume', value: 1 }, { _id: 'newOne', value: 2 }],
      }

      const first = writeSyncFile({ ...HEADER, base: BASE_REFERENCE, changes: computeChanges(BASE, current) })
      const second = writeSyncFile({ ...HEADER, base: BASE_REFERENCE, changes: computeChanges(scrambled(BASE), scrambled(current)) })

      expect(second).toBe(first)
    })

    it('writes the lineage after the machine name and before the base, at most LINEAGE_LENGTH entries, newest first', () => {
      const lineage = Array.from({ length: LINEAGE_LENGTH + 5 }, (_, i) => i.toString(16).padStart(16, '0'))
      const text = writeSyncFile({ ...HEADER, lineage, base: BASE_REFERENCE, changes: {} })
      const document = JSON.parse(text)

      expect(Object.keys(document).indexOf('lineage')).toBe(Object.keys(document).indexOf('machineName') + 1)
      expect(Object.keys(document).indexOf('base')).toBe(Object.keys(document).indexOf('lineage') + 1)
      expect(document.lineage).toEqual(lineage.slice(0, LINEAGE_LENGTH))
      expect(readSyncFile(text).header.lineage).toEqual(lineage.slice(0, LINEAGE_LENGTH))
    })

    it('writes no changes as an empty object', () => {
      const document = JSON.parse(writeSyncFile({ ...HEADER, base: BASE_REFERENCE, changes: {} }))

      expect(document.changes).toEqual({})
    })
  })

  describe('readSyncFile', () => {
    it('reads back what was written', () => {
      const changes = computeChanges(BASE, { ...BASE, profiles: [MAIN_PROFILE], searchHistory: [{ ...SEARCH, lastUpdatedAt: 1 }] })
      const result = readSyncFile(writeSyncFile({ ...HEADER, base: BASE_REFERENCE, changes }))

      expect(result).toEqual({
        ok: true,
        header: { formatVersion: 1, ...HEADER, lineage: [] },
        base: BASE_REFERENCE,
        changes,
      })
    })

    it('reads a header without an app version, installation id or machine name as unknown', () => {
      const header = { formatVersion: 1, appVersion: null, installationId: null, machineName: null, lineage: [] }
      const bare = JSON.stringify({ format: SYNC_FORMAT, formatVersion: 1, base: BASE_REFERENCE, changes: {} })

      expect(readSyncFile(bare).header).toEqual(header)
      expect(readSyncFile(syncText({ machineName: '' })).header.machineName).toBeNull()
      expect(readSyncFile(writeSyncFile({ appVersion: '0.1.230', installationId: 'x', base: BASE_REFERENCE, changes: {} })).header.machineName).toBeNull()
    })

    it('ignores a header field it does not know', () => {
      const result = readSyncFile(syncText({ writtenWith: 'a newer Fjernsyn' }))

      expect(result.ok).toBe(true)
      expect(result.header).toEqual({ formatVersion: 1, ...HEADER, lineage: [] })
    })

    it('reads an absent or invalid lineage as empty, and drops the entries that are no lineage entry', () => {
      const entry = lineageEntry(SHA256)

      expect(entry).toBe('0123456789abcdef')
      for (const lineage of [undefined, null, 'not a list', { 0: entry }]) {
        expect(readSyncFile(syncText({ lineage })).header.lineage, JSON.stringify(lineage)).toEqual([])
      }
      expect(readSyncFile(syncText({ lineage: [entry, 5, SHA256, entry.toUpperCase(), 'fedcba9876543210'] })).header.lineage)
        .toEqual([entry, 'fedcba9876543210'])
    })

    it('drops the sections it does not know', () => {
      const result = readSyncFile(syncText({ changes: { watchParties: { put: 'anything' }, later: { put: [LATER_QUEUED] } } }))

      expect(result.changes).toEqual({ later: { put: [LATER_QUEUED], remove: [] } })
    })

    it('reads an absent put or remove as empty', () => {
      const result = readSyncFile(syncText({ changes: { channels: { remove: ['UCx'] }, aiVerdicts: { put: [VERDICT] } } }))

      expect(result.changes).toEqual({
        channels: { put: [], remove: ['UCx'] },
        aiVerdicts: { put: [VERDICT], remove: [] },
      })
    })

    describe('refusals', () => {
      it('refuses what is not JSON', () => {
        expect(readSyncFile('')).toEqual({ ok: false, reason: 'notJson' })
        expect(readSyncFile('{"format": "fjernsyn-sync",')).toEqual({ ok: false, reason: 'notJson' })
      })

      it('refuses JSON that is not a sync file', () => {
        const notSyncFiles = [
          '[]',
          'null',
          '"fjernsyn-sync"',
          syncText({ format: 'fjernsyn-backup' }),
          syncText({ format: undefined }),
          syncText({ formatVersion: '1' }),
          syncText({ formatVersion: 1.5 }),
          syncText({ formatVersion: 0 }),
          syncText({ changes: undefined }),
          syncText({ changes: [] }),
          syncText({ changes: null }),
          // a backup
          JSON.stringify({ format: 'fjernsyn-backup', formatVersion: 1, ...HEADER, sections: {} }),
        ]

        for (const text of notSyncFiles) {
          expect(readSyncFile(text), text).toEqual({ ok: false, reason: 'notSyncFile' })
        }
      })

      it('refuses a bad reference to the base', () => {
        const badBases = [
          undefined,
          null,
          'base-0123456789abcdef.json.gz',
          { file: BASE_REFERENCE.file },
          { sha256: SHA256 },
          { file: BASE_REFERENCE.file, sha256: SHA256.slice(0, 63) },
          { file: 'base-0123456789ABCDEF.json.gz', sha256: SHA256.toUpperCase() },
          { file: 'base-fedcba9876543210.json.gz', sha256: SHA256 },
          { file: '../base-0123456789abcdef.json.gz', sha256: SHA256 },
        ]

        for (const base of badBases) {
          expect(readSyncFile(syncText({ base })), JSON.stringify(base)).toEqual({ ok: false, reason: 'notSyncFile' })
        }
      })

      it('refuses a sync file from a newer format version, saying which, before anything else', () => {
        expect(readSyncFile(syncText({ formatVersion: 2 }))).toEqual({ ok: false, reason: 'newerVersion', formatVersion: 2 })
        expect(readSyncFile(syncText({ formatVersion: 3, base: 'a newer shape', changes: [] })))
          .toEqual({ ok: false, reason: 'newerVersion', formatVersion: 3 })
      })

      it('refuses malformed changes, naming the section', () => {
        const malformed = [
          ['history', null],
          ['history', []],
          ['history', { put: {} }],
          ['history', { put: null }],
          ['history', { put: [YOUTUBE_HISTORY, 'not a record'] }],
          ['history', { put: [[YOUTUBE_HISTORY]] }],
          ['playlists', { put: [{ playlistName: 'No id', videos: [] }] }],
          ['channels', { put: [{ _id: '' }] }],
          ['aiVerdicts', { put: [{ _id: 5 }] }],
          ['settings', { remove: 'maxVolume' }],
          ['settings', { remove: [5] }],
          ['settings', { remove: null }],
        ]

        for (const [section, entry] of malformed) {
          expect(readSyncFile(syncText({ changes: { [section]: entry } })), JSON.stringify(entry))
            .toEqual({ ok: false, reason: 'malformedChanges', section })
        }
      })

      it('checks every known section, not only the first', () => {
        const changes = Object.fromEntries(BACKUP_SECTIONS.map(section => [section, { put: [], remove: [] }]))
        changes.aiVerdicts = { remove: [1] }

        expect(readSyncFile(syncText({ changes }))).toEqual({ ok: false, reason: 'malformedChanges', section: 'aiVerdicts' })
      })
    })
  })

  describe('rebaseNeeded', () => {
    it('is due only once the sync file has grown past 2 MB of text', () => {
      expect(REBASE_THRESHOLD).toBe(2 * 1024 * 1024)
      expect(rebaseNeeded('x'.repeat(REBASE_THRESHOLD - 1))).toBe(false)
      expect(rebaseNeeded('x'.repeat(REBASE_THRESHOLD))).toBe(false)
      expect(rebaseNeeded('x'.repeat(REBASE_THRESHOLD + 1))).toBe(true)
    })
  })
})
