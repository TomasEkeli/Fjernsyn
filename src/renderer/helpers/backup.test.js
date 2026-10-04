import { describe, expect, it } from 'vitest'

import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, BACKUP_SECTIONS, backupFileName, readBackup, writeBackup } from './backup'

// Records shaped as the datastores hold them

const PEERTUBE_UUID = '9c9de5e8-0a1b-4cd8-a5bc-4d2b5f1e3a10'

const MAIN_PROFILE = {
  _id: 'allChannels',
  name: 'All Channels',
  bgColor: '#000000',
  textColor: '#FFFFFF',
  subscriptions: [
    { id: 'UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender', thumbnail: 'https://yt3.ggpht.com/blender=s176' },
    { id: 'blender@video.blender.org', name: 'Blender Studio', thumbnail: null, platform: 'peertube', host: 'video.blender.org' },
    { id: 'UCBa659QWEk1AI4Tg--mrJ2A', name: 'Tom Scott', thumbnail: null },
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
  description: '',
  viewCount: 1600000000,
  lengthSeconds: 213,
  watchProgress: 100,
  timeWatched: 1759572000000,
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
    { videoId: PEERTUBE_UUID, title: 'Sprite Fright', author: 'Blender Studio', authorId: 'blender@video.blender.org', lengthSeconds: 629, timeAdded: 3, playlistItemId: 'i3', platform: 'peertube', host: 'video.blender.org' },
  ],
}

const LATER_ARMED = {
  _id: 'jNQXAC9IVRw',
  videoId: 'jNQXAC9IVRw',
  title: 'Me at the zoo',
  author: 'jawed',
  authorId: 'UC4QobU6STFB0P71PMvOGN5A',
  addedAt: 1759500000000,
  position: 0,
  isUpcoming: true,
  premiereDate: 1759600000000,
  alarm: { at: 1759600000000, armedAt: 1759500000000 },
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

const SECTIONS = {
  profiles: [MAIN_PROFILE, ART_PROFILE],
  history: [YOUTUBE_HISTORY, PEERTUBE_HISTORY],
  playlists: [PLAYLIST],
  later: [LATER_ARMED, LATER_QUEUED],
  searchHistory: [SEARCH],
  settings: SETTINGS,
  channels: [CHANNEL],
  aiVerdicts: [VERDICT],
}

const KNOWN_SETTINGS = ['maxVolume', 'profilePictures', 'aiChannels', 'proxyHostname', 'installationId']
const MACHINE_BOUND = ['proxyHostname', 'installationId']
const SETTINGS_CONTEXT = { knownSettings: KNOWN_SETTINGS, machineBoundSettings: MACHINE_BOUND }

const HEADER = { appVersion: '0.1.214', installationId: '9b0c6c8e-5d1f-4a2b-9e3d-7f6a5b4c3d2e' }

/**
 * @param {Record<string, any>} sections
 * @param {Record<string, any>} [header]
 */
function backupText(sections, header = {}) {
  return JSON.stringify({ format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, ...HEADER, ...header, sections })
}

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

const byKey = key => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0)

describe('the backup format', () => {
  describe('backupFileName', () => {
    it('is fjernsyn-backup with the date', () => {
      expect(backupFileName('2026-10-04')).toBe('fjernsyn-backup-2026-10-04.json')
    })
  })

  describe('writeBackup', () => {
    it('writes the header and the sections in the fixed order', () => {
      const reversedSections = Object.fromEntries(Object.entries(SECTIONS).reverse())
      const document = JSON.parse(writeBackup({ ...HEADER, sections: reversedSections }))

      expect(Object.keys(document)).toEqual(['format', 'formatVersion', 'appVersion', 'installationId', 'sections'])
      expect(document.format).toBe('fjernsyn-backup')
      expect(document.formatVersion).toBe(1)
      expect(document.appVersion).toBe('0.1.214')
      expect(document.installationId).toBe(HEADER.installationId)
      expect(Object.keys(document.sections)).toEqual([...BACKUP_SECTIONS])
    })

    it('has no time in it', () => {
      const text = writeBackup({ ...HEADER, sections: {} })

      expect(Object.keys(JSON.parse(text))).not.toContain('exportedAt')
      expect(text).toBe(writeBackup({ ...HEADER, sections: {} }))
    })

    it('is pretty printed with two spaces and ends with a newline', () => {
      const text = writeBackup({ ...HEADER, sections: { searchHistory: [SEARCH] } })

      expect(text).toBe(`{
  "format": "fjernsyn-backup",
  "formatVersion": 1,
  "appVersion": "0.1.214",
  "installationId": "${HEADER.installationId}",
  "sections": {
    "searchHistory": [
      {
        "_id": "blender sprite fright",
        "lastUpdatedAt": 1759572000000
      }
    ]
  }
}
`)
    })

    it('leaves out a section it is not given', () => {
      const document = JSON.parse(writeBackup({ ...HEADER, sections: { profiles: [MAIN_PROFILE] } }))

      expect(Object.keys(document.sections)).toEqual(['profiles'])
    })

    it('sorts the records by their key: history by video id, the others by _id', () => {
      const document = JSON.parse(writeBackup({ ...HEADER, sections: SECTIONS }))

      expect(document.sections.profiles.map(p => p._id)).toEqual(['allChannels', 'p8Wq2xYz'])
      expect(document.sections.history.map(h => h.videoId)).toEqual([PEERTUBE_UUID, 'dQw4w9WgXcQ'].sort())
      expect(document.sections.later.map(l => l._id)).toEqual(['abcdefghijk', 'jNQXAC9IVRw'])
      expect(document.sections.settings.map(s => s._id)).toEqual(['aiChannels', 'maxVolume', 'profilePictures'])
    })

    it('sorts the keys of every object at every level', () => {
      const document = JSON.parse(writeBackup({ ...HEADER, sections: SECTIONS }))

      const later = document.sections.later.find(l => l._id === 'jNQXAC9IVRw')
      expect(Object.keys(later)).toEqual(Object.keys(LATER_ARMED).sort())
      expect(Object.keys(later.alarm)).toEqual(['armedAt', 'at'])

      const playlist = document.sections.playlists[0]
      expect(Object.keys(playlist.videos[0])).toEqual(Object.keys(PLAYLIST.videos[0]).sort())
    })

    it('keeps the order of the arrays inside a record', () => {
      const document = JSON.parse(writeBackup({ ...HEADER, sections: SECTIONS }))

      expect(document.sections.playlists[0].videos.map(v => v.videoId)).toEqual(['zz', 'aa', PEERTUBE_UUID])
      expect(document.sections.profiles[0].subscriptions.map(s => s.id)).toEqual(MAIN_PROFILE.subscriptions.map(s => s.id))
      expect(document.sections.channels[0].channelTags).toEqual(['blender', '3d'])
      expect(document.sections.channels[0].videoSamples.titles).toEqual(['b', 'a'])
    })

    it('gives the same bytes for the same data in any order', () => {
      const first = writeBackup({ ...HEADER, sections: SECTIONS })

      const scrambled = Object.fromEntries(Object.entries(SECTIONS).reverse().map(([name, records]) => [
        name,
        shuffled(records).map(reversedKeys),
      ]))

      expect(writeBackup({ ...HEADER, sections: scrambled })).toBe(first)
    })

    it('does not change the records it is given', () => {
      const records = [reversedKeys(LATER_ARMED)]
      const before = JSON.stringify(records)

      writeBackup({ ...HEADER, sections: { later: records } })

      expect(JSON.stringify(records)).toBe(before)
    })
  })

  describe('readBackup', () => {
    it('reads back what was written: the records are the records', () => {
      const result = readBackup(writeBackup({ ...HEADER, sections: SECTIONS }), SETTINGS_CONTEXT)

      expect(result.ok).toBe(true)
      expect(result.header).toEqual({ formatVersion: 1, ...HEADER })
      expect(result.unknownSections).toEqual([])

      for (const section of BACKUP_SECTIONS) {
        const key = section === 'history' ? 'videoId' : '_id'
        expect(result.sections[section]).toEqual([...SECTIONS[section]].sort(byKey(key)))
        expect(result.counts[section]).toEqual({ kept: SECTIONS[section].length, leftOut: {} })
      }
    })

    it('keeps PeerTube history entries, playlist videos and subscriptions', () => {
      const result = readBackup(backupText(SECTIONS), SETTINGS_CONTEXT)

      expect(result.sections.history).toContainEqual(PEERTUBE_HISTORY)
      expect(result.sections.playlists[0].videos).toContainEqual(PLAYLIST.videos[2])
      expect(result.sections.profiles[0].subscriptions).toContainEqual(MAIN_PROFILE.subscriptions[1])
    })

    it('keeps the keys of a good record it does not know', () => {
      const newer = { ...YOUTUBE_HISTORY, someFieldFromLater: { nested: [1, 2] } }
      const result = readBackup(backupText({ history: [newer], channels: [{ ...CHANNEL, learnedLater: true }] }), SETTINGS_CONTEXT)

      expect(result.sections.history).toEqual([newer])
      expect(result.sections.channels[0].learnedLater).toBe(true)
    })

    it('leaves a section the backup does not hold out of what to replace', () => {
      const result = readBackup(backupText({ profiles: [MAIN_PROFILE] }), SETTINGS_CONTEXT)

      expect(Object.keys(result.sections)).toEqual(['profiles'])
      expect(Object.keys(result.counts)).toEqual(['profiles'])
    })

    it('replaces with an empty section when the backup holds one', () => {
      const result = readBackup(backupText({ searchHistory: [] }), SETTINGS_CONTEXT)

      expect(result.sections).toEqual({ searchHistory: [] })
      expect(result.counts.searchHistory).toEqual({ kept: 0, leftOut: {} })
    })

    it('names the sections it does not know, and ignores them', () => {
      const result = readBackup(backupText({ profiles: [MAIN_PROFILE], watchParties: [{}], bookmarks: 'not even a list' }), SETTINGS_CONTEXT)

      expect(result.ok).toBe(true)
      expect(result.unknownSections).toEqual(['bookmarks', 'watchParties'])
      expect(Object.keys(result.sections)).toEqual(['profiles'])
    })

    it('reads a header without an app version or installation id as unknown', () => {
      const text = JSON.stringify({ format: BACKUP_FORMAT, formatVersion: 1, sections: {} })

      expect(readBackup(text, SETTINGS_CONTEXT).header).toEqual({ formatVersion: 1, appVersion: null, installationId: null })
    })

    describe('settings', () => {
      it('drops and counts machine-bound and unknown settings', () => {
        const settings = [
          ...SETTINGS,
          { _id: 'proxyHostname', value: '10.0.0.1' },
          { _id: 'installationId', value: 'someone else' },
          { _id: 'hideTrendingVideos', value: true },
        ]
        const result = readBackup(backupText({ settings }), SETTINGS_CONTEXT)

        expect(result.sections.settings).toEqual(SETTINGS)
        expect(result.counts.settings).toEqual({ kept: 3, leftOut: { machineBound: 2, unknownSetting: 1 } })
      })

      it('leaves out a setting without a value', () => {
        const result = readBackup(backupText({ settings: [{ _id: 'maxVolume' }, { value: 3 }] }), SETTINGS_CONTEXT)

        expect(result.sections.settings).toEqual([])
        expect(result.counts.settings.leftOut).toEqual({ missingFields: 2 })
      })

      it('keeps a setting whose value is null or false', () => {
        const settings = [{ _id: 'maxVolume', value: null }, { _id: 'aiChannels', value: false }]

        expect(readBackup(backupText({ settings }), SETTINGS_CONTEXT).sections.settings).toEqual(settings)
      })
    })

    describe('bad records are left out and counted, good ones kept', () => {
      it.each([
        ['profiles', MAIN_PROFILE, [
          { ...MAIN_PROFILE, _id: 'noColour', bgColor: undefined },
          { _id: 'noSubs', name: 'X', bgColor: '#000', textColor: '#fff' },
          { name: 'no id', bgColor: '#000', textColor: '#fff', subscriptions: [] },
          { _id: 'subsNotList', name: 'X', bgColor: '#000', textColor: '#fff', subscriptions: {} },
        ]],
        ['history', YOUTUBE_HISTORY, [
          { ...YOUTUBE_HISTORY, videoId: 'noProgress', watchProgress: undefined },
          { ...YOUTUBE_HISTORY, videoId: undefined },
          { ...YOUTUBE_HISTORY, videoId: 'noTitle', title: undefined },
        ]],
        ['playlists', PLAYLIST, [
          { _id: 'noName', videos: [] },
          { _id: 'noVideos', playlistName: 'X' },
          { _id: 5, playlistName: 'id not a string', videos: [] },
        ]],
        ['later', LATER_QUEUED, [
          { ...LATER_QUEUED, videoId: '' },
          { ...LATER_QUEUED, _id: 'noTitle', videoId: 'noTitle', title: 5 },
        ]],
        ['searchHistory', SEARCH, [
          { _id: 'no time' },
          { _id: 42, lastUpdatedAt: 1 },
          { _id: 'string time', lastUpdatedAt: '1759572000000' },
        ]],
        ['channels', CHANNEL, [
          { channelTags: [] },
          { _id: '', channelTags: [] },
        ]],
        ['aiVerdicts', VERDICT, [
          { _id: 'noAi', checkedAt: 1 },
          { _id: 'aiNotBoolean', ai: 'false', checkedAt: 1 },
          { _id: 'noCheckedAt', ai: true },
          { ai: true, checkedAt: 1 },
        ]],
      ])('%s', (section, good, bad) => {
        const cleaned = bad.map(record => JSON.parse(JSON.stringify(record)))
        const result = readBackup(backupText({ [section]: [...cleaned, good, 'not a record', null, [good]] }), SETTINGS_CONTEXT)

        expect(result.sections[section]).toEqual([good])
        expect(result.counts[section]).toEqual({ kept: 1, leftOut: { missingFields: bad.length + 3 } })
      })
    })

    it('leaves out the second of two records with the same key', () => {
      const result = readBackup(backupText({
        history: [YOUTUBE_HISTORY, { ...YOUTUBE_HISTORY, _id: 'other', title: 'Again' }],
        aiVerdicts: [VERDICT, { ...VERDICT, ai: true }],
      }), SETTINGS_CONTEXT)

      expect(result.sections.history).toEqual([YOUTUBE_HISTORY])
      expect(result.sections.aiVerdicts).toEqual([VERDICT])
      expect(result.counts.history.leftOut).toEqual({ duplicate: 1 })
      expect(result.counts.aiVerdicts.leftOut).toEqual({ duplicate: 1 })
    })

    it('keeps the one watched last of two history entries for the same video', () => {
      const later = { ...YOUTUBE_HISTORY, _id: 'h9', timeWatched: YOUTUBE_HISTORY.timeWatched + 1000, watchProgress: 150 }
      const earlier = { ...YOUTUBE_HISTORY, _id: 'h0', timeWatched: 1 }
      const result = readBackup(backupText({ history: [YOUTUBE_HISTORY, later, earlier] }), SETTINGS_CONTEXT)

      expect(result.sections.history).toEqual([later])
      expect(result.counts.history).toEqual({ kept: 1, leftOut: { duplicate: 2 } })
    })

    it('leaves out a record with a field name the datastore cannot store, at any level', () => {
      const result = readBackup(backupText({
        channels: [CHANNEL, { _id: 'UCdot', 'a.b': 1 }, { _id: 'UCdollar', nested: [{ $where: 'x' }] }],
        settings: [{ _id: 'profilePictures', value: { 'blender@video.blender.org': {} } }],
      }), SETTINGS_CONTEXT)

      expect(result.sections.channels).toEqual([CHANNEL])
      expect(result.counts.channels.leftOut).toEqual({ unstorable: 2 })
      expect(result.counts.settings).toEqual({ kept: 0, leftOut: { unstorable: 1 } })
    })

    it('keeps a playlist without an _id, which the datastore gives one', () => {
      const playlist = { playlistName: 'Older export', videos: [] }
      const result = readBackup(backupText({ playlists: [playlist, { ...playlist, playlistName: 'Another' }] }), SETTINGS_CONTEXT)

      expect(result.sections.playlists).toEqual([playlist, { ...playlist, playlistName: 'Another' }])
    })

    it('leaves out a history entry with the _id of another, which the datastore would not take', () => {
      const other = { ...YOUTUBE_HISTORY, videoId: 'otherVideo1' }
      const result = readBackup(backupText({ history: [YOUTUBE_HISTORY, other] }), SETTINGS_CONTEXT)

      expect(result.sections.history).toEqual([YOUTUBE_HISTORY])
      expect(result.counts.history.leftOut).toEqual({ duplicate: 1 })
    })

    it('leaves out a PeerTube history entry that cannot be one', () => {
      const notUuid = { ...PEERTUBE_HISTORY, videoId: 'not-a-uuid' }
      const result = readBackup(backupText({ history: [notUuid, PEERTUBE_HISTORY] }), SETTINGS_CONTEXT)

      expect(result.sections.history).toEqual([PEERTUBE_HISTORY])
      expect(result.counts.history.leftOut).toEqual({ invalidPeerTube: 1 })
    })

    it('drops a PeerTube thumbnail that is not https, as the imports do', () => {
      const result = readBackup(backupText({ history: [{ ...PEERTUBE_HISTORY, thumbnail: 'file:///etc/passwd' }] }), SETTINGS_CONTEXT)

      expect(result.sections.history[0]).not.toHaveProperty('thumbnail')
      expect(result.counts.history).toEqual({ kept: 1, leftOut: {} })
    })

    it('keeps a playlist without its bad videos, and counts them', () => {
      const playlist = {
        ...PLAYLIST,
        videos: [
          PLAYLIST.videos[0],
          { videoId: 'noLength', title: 'X', timeAdded: 1 },
          { ...PLAYLIST.videos[2], videoId: 'not-a-uuid' },
          'not a video',
          PLAYLIST.videos[1],
        ],
      }
      const result = readBackup(backupText({ playlists: [playlist] }), SETTINGS_CONTEXT)

      expect(result.sections.playlists).toEqual([{ ...PLAYLIST, videos: [PLAYLIST.videos[0], PLAYLIST.videos[1]] }])
      expect(result.counts.playlists).toEqual({ kept: 1, leftOut: { playlistVideos: 3 } })
    })

    it('keeps a Later item\'s place and alarm, and fills in what an older one lacks', () => {
      const older = { videoId: 'olderItem01', title: 'Older', author: 'A', authorId: 'UCa', alarm: { at: 5 } }
      const result = readBackup(backupText({ later: [LATER_ARMED, LATER_QUEUED, older] }), SETTINGS_CONTEXT)

      expect(result.sections.later).toEqual([
        LATER_ARMED,
        LATER_QUEUED,
        { ...older, _id: 'olderItem01', addedAt: 0, position: 0, alarm: { at: 5, armedAt: 5 } },
      ])
    })

    describe('refusals', () => {
      it('refuses what is not JSON', () => {
        expect(readBackup('_id,value\nmaxVolume,1000', SETTINGS_CONTEXT)).toEqual({ ok: false, reason: 'notJson' })
        expect(readBackup('', SETTINGS_CONTEXT)).toEqual({ ok: false, reason: 'notJson' })
      })

      it('refuses JSON that is not a backup', () => {
        const notBackups = [
          '[]',
          'null',
          '"fjernsyn-backup"',
          JSON.stringify({ sections: {} }),
          JSON.stringify({ format: 'freetube', formatVersion: 1, sections: {} }),
          JSON.stringify({ format: BACKUP_FORMAT, sections: {} }),
          JSON.stringify({ format: BACKUP_FORMAT, formatVersion: '1', sections: {} }),
          JSON.stringify({ format: BACKUP_FORMAT, formatVersion: 1.5, sections: {} }),
          JSON.stringify({ format: BACKUP_FORMAT, formatVersion: 0, sections: {} }),
          JSON.stringify({ format: BACKUP_FORMAT, formatVersion: 1 }),
          JSON.stringify({ format: BACKUP_FORMAT, formatVersion: 1, sections: [] }),
          // one line of a FreeTube settings export
          JSON.stringify({ _id: 'maxVolume', value: 1000 }),
        ]

        for (const text of notBackups) {
          expect(readBackup(text, SETTINGS_CONTEXT), text).toEqual({ ok: false, reason: 'notBackup' })
        }
      })

      it('refuses a backup from a newer format version, saying which', () => {
        expect(readBackup(backupText({}, { formatVersion: 2 }), SETTINGS_CONTEXT))
          .toEqual({ ok: false, reason: 'newerVersion', formatVersion: 2 })
      })

      it('refuses profiles without the one that holds every subscription', () => {
        expect(readBackup(backupText({ profiles: [ART_PROFILE] }), SETTINGS_CONTEXT)).toEqual({ ok: false, reason: 'noMainProfile' })
        // left out as unreadable, which comes to the same
        expect(readBackup(backupText({ profiles: [{ ...MAIN_PROFILE, bgColor: undefined }, ART_PROFILE] }), SETTINGS_CONTEXT))
          .toEqual({ ok: false, reason: 'noMainProfile' })
      })

      it('takes an empty profiles section, as the app makes the main profile itself', () => {
        expect(readBackup(backupText({ profiles: [] }), SETTINGS_CONTEXT).ok).toBe(true)
      })

      it('refuses a backup with a section that is not an array, naming it', () => {
        expect(readBackup(backupText({ profiles: [MAIN_PROFILE], playlists: { favorites: PLAYLIST } }), SETTINGS_CONTEXT))
          .toEqual({ ok: false, reason: 'sectionNotArray', section: 'playlists' })
        expect(readBackup(backupText({ settings: null }), SETTINGS_CONTEXT))
          .toEqual({ ok: false, reason: 'sectionNotArray', section: 'settings' })
      })
    })
  })
})
