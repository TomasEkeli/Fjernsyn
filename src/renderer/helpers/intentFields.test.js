import { describe, expect, it } from 'vitest'

import { BACKUP_SECTIONS } from './backup'
import { laterItemFromVideo } from './later'
import { SECTION_FIELDS, isEventedSection, recordKey, splitFields } from './intentFields'

// Records shaped as the datastores store them, as in backup.test.js

const LATER_ITEM = {
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
  alarm: { at: 1764200000000, armedAt: 1764100000000 },
}

describe('recordKey', () => {
  it('gives a Later record the key later/<id>', () => {
    expect(recordKey('later', LATER_ITEM)).toBe('later/dQw4w9WgXcQ')
  })

  it('refuses a record with no id, which would key every such record alike', () => {
    expect(() => recordKey('later', { videoId: 'dQw4w9WgXcQ' })).toThrow()
  })

  it('refuses a section it does not know', () => {
    expect(() => recordKey('bookmarks', LATER_ITEM)).toThrow()
  })
})

describe('splitFields', () => {
  it('splits a Later record into its intent and its state fields', () => {
    const { intent, state, unknown } = splitFields('later', LATER_ITEM)

    expect(intent).toEqual({
      _id: 'dQw4w9WgXcQ',
      videoId: 'dQw4w9WgXcQ',
      position: 2.5,
      alarm: { at: 1764200000000, armedAt: 1764100000000 },
    })
    expect(state).toEqual({
      title: 'A video',
      author: 'A channel',
      authorId: 'UCSMOQeBJ2RAnuFungnQOxLg',
      lengthSeconds: 212,
      viewCount: 900,
      published: 1764000000000,
      addedAt: 1764100000000,
    })
    expect(unknown).toEqual([])
  })

  it('names a field it has never seen, and guesses no side for it', () => {
    expect(splitFields('later', { _id: 'a', somethingNew: 1 }).unknown).toEqual(['somethingNew'])
  })

  it('puts the whole record in state for a section with no intents', () => {
    const channel = { _id: 'UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender', thumbnail: 'https://yt3.ggpht.com/blender=s176' }
    const { intent, state, unknown } = splitFields('channels', channel)

    expect(intent).toEqual({})
    expect(state).toEqual(channel)
    expect(unknown).toEqual([])
  })
})

describe('isEventedSection', () => {
  it('says only later is evented in this part', () => {
    expect(BACKUP_SECTIONS.filter(isEventedSection)).toEqual(['later'])
  })
})

describe('the partition covers the record', () => {
  it('covers every field the Later handler writes', () => {
    // the fields named in src/datastores/handlers/base.js's Later class
    for (const field of ['position', 'alarm', 'premiereDate', 'viewCount']) {
      expect([...SECTION_FIELDS.later.intent, ...SECTION_FIELDS.later.state]).toContain(field)
    }
  })

  it('covers every field laterItemFromVideo writes, PeerTube included', () => {
    const peerTube = laterItemFromVideo({
      videoId: '9c9de5e8-0a1b-4cd8-a5bc-4d2b5f1e3a10',
      platform: 'peertube',
      host: 'video.blender.org',
      thumbnail: 'https://video.blender.org/thumb.jpg',
      title: 'A video',
      author: 'Blender Studio',
      authorId: 'blender@video.blender.org',
      lengthSeconds: 212,
      viewCount: 900,
      published: 1764000000000,
      isUpcoming: true,
      premiereDate: 1764200000000,
    }, 1764100000000)

    expect(splitFields('later', peerTube).unknown).toEqual([])
  })

  it('names every section, so one added upstream fails here first', () => {
    expect(Object.keys(SECTION_FIELDS).sort()).toEqual([...BACKUP_SECTIONS].sort())
  })
})
