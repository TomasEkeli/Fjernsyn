import { describe, expect, it } from 'vitest'

import { importedPlaylistVideo, isYouTubeRecord, splitImportedPlatformFields } from './records'

const HOST = 'video.blender.org'
const UUID = 'b29290cc-dc51-4a12-bcb2-2aa5fece7605'
const THUMBNAIL = 'https://video.blender.org/lazy-static/previews/sprite-fright.jpg'
const AVATAR = 'https://video.blender.org/lazy-static/avatars/blender.png'

const PEERTUBE_ENTRY = {
  videoId: UUID,
  title: 'Sprite Fright',
  author: 'Blender',
  authorId: 'blender@video.blender.org',
  platform: 'peertube',
  host: HOST,
  thumbnail: THUMBNAIL,
  authorThumbnail: AVATAR,
}

const YOUTUBE_ENTRY = {
  videoId: 'dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up',
  author: 'Rick Astley',
  authorId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
}

describe('splitImportedPlatformFields', () => {
  it('hands a YouTube record back as it is, with no platform fields', () => {
    const { record, fields } = splitImportedPlatformFields(YOUTUBE_ENTRY)

    expect(record).toBe(YOUTUBE_ENTRY)
    expect(fields).toEqual({})
  })

  it('leaves the keys of a YouTube record alone, even ones named like platform fields', () => {
    const entry = { ...YOUTUBE_ENTRY, thumbnail: 'https://i.ytimg.com/x.jpg', host: 'www.youtube.com' }

    const { record, fields } = splitImportedPlatformFields(entry)

    expect(record).toBe(entry)
    expect(fields).toEqual({})
  })

  it('splits the platform fields off a PeerTube record, keeping all of them', () => {
    const { record, fields } = splitImportedPlatformFields(PEERTUBE_ENTRY)

    expect(record).toEqual({ videoId: UUID, title: 'Sprite Fright', author: 'Blender', authorId: 'blender@video.blender.org' })
    expect(fields).toEqual({ platform: 'peertube', host: HOST, thumbnail: THUMBNAIL, authorThumbnail: AVATAR })
  })

  it('does not change the record it was given', () => {
    const entry = { ...PEERTUBE_ENTRY }

    splitImportedPlatformFields(entry)

    expect(entry).toEqual(PEERTUBE_ENTRY)
  })

  it.each([
    ['a thumbnail that is not https', { thumbnail: 'http://video.blender.org/a.jpg' }, 'thumbnail'],
    ['a thumbnail that is not a URL', { thumbnail: 'not a url' }, 'thumbnail'],
    ['a thumbnail that is not a string', { thumbnail: 42 }, 'thumbnail'],
    ['an author thumbnail that is a javascript: URL', { authorThumbnail: 'javascript:alert(1)' }, 'authorThumbnail'],
    ['an author thumbnail that is null', { authorThumbnail: null }, 'authorThumbnail'],
  ])('drops %s, keeping the rest', (_, override, key) => {
    const { fields } = splitImportedPlatformFields({ ...PEERTUBE_ENTRY, ...override })

    expect(fields).not.toHaveProperty(key)
    expect(fields).toMatchObject({ platform: 'peertube', host: HOST })
  })

  it('keeps a PeerTube history entry\'s category, and drops one that is not text', () => {
    expect(splitImportedPlatformFields({ ...PEERTUBE_ENTRY, peertubeCategory: 'Films' }).fields.peertubeCategory).toBe('Films')
    expect(splitImportedPlatformFields({ ...PEERTUBE_ENTRY, peertubeCategory: 7 }).fields).not.toHaveProperty('peertubeCategory')
    expect(splitImportedPlatformFields({ ...PEERTUBE_ENTRY, peertubeCategory: 7 }).record).not.toHaveProperty('peertubeCategory')
  })

  it('keeps a PeerTube record without thumbnails', () => {
    const { thumbnail, authorThumbnail, ...bare } = PEERTUBE_ENTRY

    expect(splitImportedPlatformFields(bare).fields).toEqual({ platform: 'peertube', host: HOST })
  })

  it.each([
    ['a host with a scheme', { host: 'https://video.blender.org' }],
    ['a host with a path', { host: 'video.blender.org/videos' }],
    ['no host', { host: undefined }],
    ['a host that is not a string', { host: ['video.blender.org'] }],
    ['a YouTube id for its video', { videoId: 'dQw4w9WgXcQ' }],
    ['a numeric id for its video', { videoId: 1234 }],
    ['a YouTube channel id for its channel', { authorId: 'UCuAXFkgsw1L7xaCfnd5JJOw' }],
    ['a channel handle without a host', { authorId: 'blender' }],
    ['a channel handle with two hosts', { authorId: 'blender@video.blender.org@evil.example' }],
    ['a channel handle on a host that is not one', { authorId: 'blender@not a host' }],
    ['a channel handle with a name PeerTube does not allow', { authorId: 'bl ender@video.blender.org' }],
    ['no channel', { authorId: undefined }],
    ['a channel that is not a string', { authorId: 42 }],
  ])('refuses a PeerTube record with %s: it cannot be kept', (_, override) => {
    expect(splitImportedPlatformFields({ ...PEERTUBE_ENTRY, ...override }).fields).toBeNull()
  })

  it('stores a PeerTube uuid in lower case, as the layer writes it', () => {
    const { record, fields } = splitImportedPlatformFields({ ...PEERTUBE_ENTRY, videoId: UUID.toUpperCase() })

    expect(record.videoId).toBe(UUID)
    expect(fields).not.toBeNull()
  })

  it('stores a PeerTube channel handle as the layer writes it, the host in lower case', () => {
    const { record } = splitImportedPlatformFields({ ...PEERTUBE_ENTRY, authorId: '@blender@Video.Blender.ORG' })

    expect(record.authorId).toBe('blender@video.blender.org')
  })

  it('leaves a YouTube record\'s id and channel exactly as they are', () => {
    const entry = { ...YOUTUBE_ENTRY, videoId: 'DQW4W9WGXCQ', authorId: 'not even a channel' }

    expect(splitImportedPlatformFields(entry).record).toBe(entry)
    expect(entry).toMatchObject({ videoId: 'DQW4W9WGXCQ', authorId: 'not even a channel' })
  })

  it('treats a record saying platform youtube, or carrying unknown keys, as the YouTube record it is', () => {
    const entry = { ...YOUTUBE_ENTRY, platform: 'youtube', someFutureKey: 1 }

    const { record, fields } = splitImportedPlatformFields(entry)

    expect(record).toBe(entry)
    expect(fields).toEqual({})
  })
})

describe('importedPlaylistVideo', () => {
  it('is the YouTube video itself, whatever it carries', () => {
    const video = { ...YOUTUBE_ENTRY, lengthSeconds: 213, timeAdded: 1, someFutureKey: 'x' }

    expect(importedPlaylistVideo(video)).toBe(video)
  })

  it('is a PeerTube video with its platform fields kept', () => {
    const video = { ...PEERTUBE_ENTRY, lengthSeconds: 629, timeAdded: 2, playlistItemId: 'i1' }

    expect(importedPlaylistVideo(video)).toEqual(video)
  })

  it('drops a malformed thumbnail from a PeerTube video', () => {
    const video = { ...PEERTUBE_ENTRY, thumbnail: 'http://insecure.example/a.jpg' }

    const imported = importedPlaylistVideo(video)

    expect(imported).not.toHaveProperty('thumbnail')
    expect(imported).toMatchObject({ videoId: UUID, platform: 'peertube', host: HOST, authorThumbnail: AVATAR })
  })

  it('is null for a PeerTube video that cannot be one', () => {
    expect(importedPlaylistVideo({ ...PEERTUBE_ENTRY, host: 'not a host' })).toBeNull()
    expect(importedPlaylistVideo({ ...PEERTUBE_ENTRY, authorId: 'UCuAXFkgsw1L7xaCfnd5JJOw' })).toBeNull()
  })

  it('is a PeerTube video with its uuid in lower case', () => {
    expect(importedPlaylistVideo({ ...PEERTUBE_ENTRY, videoId: UUID.toUpperCase() })).toEqual(PEERTUBE_ENTRY)
  })
})

describe('isYouTubeRecord', () => {
  it('is true for a record without platform, and false for a PeerTube one', () => {
    expect(isYouTubeRecord(YOUTUBE_ENTRY)).toBe(true)
    expect(isYouTubeRecord(PEERTUBE_ENTRY)).toBe(false)
  })
})
