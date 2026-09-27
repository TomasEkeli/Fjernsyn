import { describe, expect, it } from 'vitest'

import {
  PLATFORM_PEERTUBE,
  PLATFORM_YOUTUBE,
  isHostname,
  isUuid,
  parseChannelHandle,
  peerTubeChannelRef,
  peerTubeVideoRef,
  platformOf,
} from './refs'

const UUID = 'b29290cc-5c6d-4b9e-8d64-2f6f3b3a1e11'

describe('refs', () => {
  it('names the two platforms', () => {
    expect(PLATFORM_YOUTUBE).toBe('youtube')
    expect(PLATFORM_PEERTUBE).toBe('peertube')
  })

  describe('platformOf', () => {
    it('reads a record without a platform as YouTube', () => {
      expect(platformOf({ videoId: 'dQw4w9WgXcQ' })).toBe('youtube')
      expect(platformOf({ id: 'UCfMJ2MchTSW2kWaT0kK94Yw', name: 'x' })).toBe('youtube')
    })

    it('reads a PeerTube record as PeerTube', () => {
      expect(platformOf({ videoId: UUID, platform: 'peertube', host: 'video.blender.org' })).toBe('peertube')
    })

    it('reads nothing at all as YouTube, as the old path does', () => {
      expect(platformOf(null)).toBe('youtube')
      expect(platformOf(undefined)).toBe('youtube')
    })
  })

  describe('isUuid', () => {
    it('accepts a full uuid in either case', () => {
      expect(isUuid(UUID)).toBe(true)
      expect(isUuid(UUID.toUpperCase())).toBe(true)
    })

    it('refuses a short uuid, a YouTube id and anything not a string', () => {
      expect(isUuid('r82zDAKQPtDRAFhKfwUsMp')).toBe(false)
      expect(isUuid('dQw4w9WgXcQ')).toBe(false)
      expect(isUuid(`${UUID}x`)).toBe(false)
      expect(isUuid(42)).toBe(false)
      expect(isUuid(undefined)).toBe(false)
    })
  })

  describe('isHostname', () => {
    it('accepts a bare host name with a dot', () => {
      expect(isHostname('video.blender.org')).toBe(true)
      expect(isHostname('tilvids.com')).toBe(true)
    })

    it('refuses a single label, a port, a scheme, a path and upper case', () => {
      expect(isHostname('localhost')).toBe(false)
      expect(isHostname('tilvids.com:443')).toBe(false)
      expect(isHostname('https://tilvids.com')).toBe(false)
      expect(isHostname('tilvids.com/w')).toBe(false)
      expect(isHostname('Tilvids.com')).toBe(false)
      expect(isHostname('-bad.com')).toBe(false)
      expect(isHostname('')).toBe(false)
    })
  })

  describe('peerTubeVideoRef', () => {
    it('is a uuid on its origin host, as a PeerTube record carries them', () => {
      expect(peerTubeVideoRef('Video.Blender.org', UUID.toUpperCase())).toEqual({
        platform: 'peertube',
        host: 'video.blender.org',
        videoId: UUID,
      })
    })

    it('refuses a numeric id or a short uuid, which are never refs', () => {
      expect(peerTubeVideoRef('video.blender.org', '1234')).toBeNull()
      expect(peerTubeVideoRef('video.blender.org', 'r82zDAKQPtDRAFhKfwUsMp')).toBeNull()
      expect(peerTubeVideoRef('not a host', UUID)).toBeNull()
    })
  })

  describe('channel handles', () => {
    it('parses name@host and @name@host, lower-casing the host', () => {
      expect(parseChannelHandle('blender_studio@video.blender.org')).toEqual({ name: 'blender_studio', host: 'video.blender.org' })
      expect(parseChannelHandle('@blender_studio@Video.Blender.ORG')).toEqual({ name: 'blender_studio', host: 'video.blender.org' })
      expect(parseChannelHandle('  ct_3003.und-heise@makertube.net ')).toEqual({ name: 'ct_3003.und-heise', host: 'makertube.net' })
    })

    it('refuses what is not a handle', () => {
      expect(parseChannelHandle('@youtubecreators')).toBeNull()
      expect(parseChannelHandle('name@localhost')).toBeNull()
      expect(parseChannelHandle('na me@video.blender.org')).toBeNull()
      expect(parseChannelHandle('name@video.blender.org/path')).toBeNull()
      expect(parseChannelHandle('a@b@video.blender.org')).toBeNull()
      expect(parseChannelHandle('@video.blender.org')).toBeNull()
      expect(parseChannelHandle(null)).toBeNull()
    })

    it('builds the handle that is a PeerTube channel ref', () => {
      expect(peerTubeChannelRef('blender_studio', 'Video.Blender.org')).toBe('blender_studio@video.blender.org')
      expect(peerTubeChannelRef('bad name', 'video.blender.org')).toBeNull()
      expect(peerTubeChannelRef('blender_studio', 'nohost')).toBeNull()
    })
  })
})
