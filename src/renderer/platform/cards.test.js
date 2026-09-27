import { afterEach, describe as group, expect, it, vi } from 'vitest'

import { describe } from './describe'
import { getPlatformLayer } from './vue'
import { copyToClipboard, openExternalLink } from '../helpers/utils'
import { cardShareOptions, coverThumbnail, describeCard, platformRecordFields, runCardShareOption } from './cards'

const config = vi.hoisted(() => ({ value: { thumbnailPreference: '' } }))

vi.mock('./vue', () => ({
  getPlatformLayer: vi.fn(() => ({
    describe: (entity, options) => describe(entity, config.value, options),
  })),
}))

vi.mock('../helpers/utils', () => ({
  copyToClipboard: vi.fn(),
  openExternalLink: vi.fn(),
}))

const HOST = 'video.blender.org'
const UUID = 'b29290cc-dc51-4a12-bcb2-2aa5fece7605'
const HANDLE = 'blender@video.blender.org'
const THUMBNAIL = 'https://video.blender.org/lazy-static/previews/sprite-fright.jpg'
const AVATAR = 'https://video.blender.org/lazy-static/avatars/blender.png'

const PEERTUBE_VIDEO = {
  videoId: UUID,
  platform: 'peertube',
  host: HOST,
  thumbnail: THUMBNAIL,
  title: 'Sprite Fright',
  author: 'Blender',
  authorId: HANDLE,
}

const PEERTUBE_CHANNEL = { id: HANDLE, name: 'Blender', thumbnail: AVATAR, platform: 'peertube', host: HOST }

const t = (key) => `t:${key}`

afterEach(() => {
  config.value = { thumbnailPreference: '' }
  vi.clearAllMocks()
})

group('describeCard', () => {
  it('has nothing to say about a YouTube record, and does not ask the layer', () => {
    expect(describeCard({ videoId: 'dQw4w9WgXcQ', authorId: 'UCuAXFkgsw1L7xaCfnd5JJOw' })).toBeNull()
    expect(describeCard({ videoId: 'dQw4w9WgXcQ', platform: 'youtube' })).toBeNull()
    expect(describeCard({ id: 'UCuAXFkgsw1L7xaCfnd5JJOw', name: 'x', thumbnail: 'https://yt3.ggpht.com/a' })).toBeNull()
    expect(describeCard(undefined)).toBeNull()
    expect(describeCard(null)).toBeNull()
    expect(getPlatformLayer).not.toHaveBeenCalled()
  })

  it('gives a PeerTube video its own route, thumbnail, links and channel', () => {
    expect(describeCard(PEERTUBE_VIDEO)).toEqual({
      route: { path: `/peertube/watch/${HOST}/${UUID}` },
      thumbnail: THUMBNAIL,
      shareUrl: `https://${HOST}/videos/watch/${UUID}`,
      externalPlayerUrl: `https://${HOST}/videos/watch/${UUID}`,
      channelRoute: { path: `/peertube/channel/${HANDLE}` },
      channelShareUrl: `https://${HOST}/video-channels/blender`,
    })
  })

  it('carries a timestamp from the card query, and nothing of a playlist', () => {
    expect(describeCard(PEERTUBE_VIDEO, { query: { timestamp: 42, playlistId: 'PLx', playlistType: 'user' } }).route)
      .toEqual({ path: `/peertube/watch/${HOST}/${UUID}`, query: { timestamp: 42 } })
    expect(describeCard(PEERTUBE_VIDEO, { query: { playlistId: 'PLx', playlistType: 'user', playlistItemId: 'i' } }).route)
      .toEqual({ path: `/peertube/watch/${HOST}/${UUID}` })
  })

  it('leaves the thumbnail out when thumbnails are hidden', () => {
    config.value = { thumbnailPreference: 'hidden' }

    expect(describeCard(PEERTUBE_VIDEO).thumbnail).toBeNull()
  })

  it('gives a PeerTube channel its route and avatar as stored', () => {
    expect(describeCard(PEERTUBE_CHANNEL)).toEqual({
      route: { path: `/peertube/channel/${HANDLE}` },
      thumbnail: AVATAR,
      shareUrl: `https://${HOST}/video-channels/blender`,
      externalPlayerUrl: null,
      channelRoute: { path: `/peertube/channel/${HANDLE}` },
      channelShareUrl: `https://${HOST}/video-channels/blender`,
    })
  })

  it('reads a channel search result the same as a stored channel', () => {
    const result = { ...PEERTUBE_CHANNEL, type: 'channel', dataSource: 'local', subscribers: 12, handle: HANDLE }

    expect(describeCard(result).route).toEqual({ path: `/peertube/channel/${HANDLE}` })
    expect(describeCard(result).thumbnail).toBe(AVATAR)
  })

  it('describes a malformed PeerTube record as nothing, rather than as YouTube', () => {
    expect(describeCard({ videoId: 'not-a-uuid', platform: 'peertube', host: HOST })).toEqual({
      route: null,
      thumbnail: null,
      shareUrl: null,
      externalPlayerUrl: null,
      channelRoute: null,
      channelShareUrl: null,
    })
  })
})

group('coverThumbnail', () => {
  it('is null for a YouTube video, so the cover keeps its own rule', () => {
    expect(coverThumbnail({ videoId: 'dQw4w9WgXcQ' }, 'placeholder.svg')).toBeNull()
    expect(coverThumbnail(undefined, 'placeholder.svg')).toBeNull()
  })

  it("is a PeerTube video's own thumbnail, or the placeholder when it has none", () => {
    expect(coverThumbnail(PEERTUBE_VIDEO, 'placeholder.svg')).toBe(THUMBNAIL)
    expect(coverThumbnail({ ...PEERTUBE_VIDEO, thumbnail: '' }, 'placeholder.svg')).toBe('placeholder.svg')
  })
})

group('the share entries of a card of another platform', () => {
  const card = describeCard(PEERTUBE_VIDEO)

  it('offers the canonical links for the video and its channel, and no YouTube or Invidious ones', () => {
    expect(cardShareOptions(card, t)).toEqual([
      { type: 'divider' },
      { label: 't:PeerTube.Watch.Copy link', value: 'copyPlatformLink' },
      { label: 't:PeerTube.Watch.Open in browser', value: 'openPlatformLink' },
      { type: 'divider' },
      { label: 't:PeerTube.Card.Copy channel link', value: 'copyPlatformChannelLink' },
      { label: 't:PeerTube.Card.Open channel in browser', value: 'openPlatformChannelLink' },
    ])
  })

  it('offers nothing it has no URL for', () => {
    expect(cardShareOptions({ ...card, channelShareUrl: null }, t).map(option => option.value))
      .toEqual([undefined, 'copyPlatformLink', 'openPlatformLink'])
    expect(cardShareOptions({ ...card, shareUrl: null, channelShareUrl: null }, t)).toEqual([])
  })

  it('copies and opens the canonical URLs', () => {
    expect(runCardShareOption('copyPlatformLink', card, t)).toBe(true)
    expect(copyToClipboard).toHaveBeenLastCalledWith(`https://${HOST}/videos/watch/${UUID}`, { messageOnSuccess: 't:PeerTube.Watch.Link copied' })

    expect(runCardShareOption('openPlatformLink', card, t)).toBe(true)
    expect(openExternalLink).toHaveBeenLastCalledWith(`https://${HOST}/videos/watch/${UUID}`)

    expect(runCardShareOption('copyPlatformChannelLink', card, t)).toBe(true)
    expect(copyToClipboard).toHaveBeenLastCalledWith(`https://${HOST}/video-channels/blender`, { messageOnSuccess: 't:PeerTube.Card.Channel link copied' })

    expect(runCardShareOption('openPlatformChannelLink', card, t)).toBe(true)
    expect(openExternalLink).toHaveBeenLastCalledWith(`https://${HOST}/video-channels/blender`)
  })

  it('leaves every other entry to the card', () => {
    expect(runCardShareOption('history', card, t)).toBe(false)
    expect(runCardShareOption('copyYoutube', card, t)).toBe(false)
    expect(copyToClipboard).not.toHaveBeenCalled()
    expect(openExternalLink).not.toHaveBeenCalled()
  })
})

group('platformRecordFields', () => {
  it('adds nothing to a YouTube record, and does not ask the layer', () => {
    expect(platformRecordFields({ videoId: 'dQw4w9WgXcQ', authorId: 'UCuAXFkgsw1L7xaCfnd5JJOw' })).toEqual({})
    expect(platformRecordFields({ videoId: 'dQw4w9WgXcQ', platform: 'youtube' }, { description: '<b>x</b>' })).toEqual({})
    expect(platformRecordFields(undefined)).toEqual({})
    expect(getPlatformLayer).not.toHaveBeenCalled()
  })

  it('keeps the platform, host and thumbnail of a PeerTube record', () => {
    expect(platformRecordFields(PEERTUBE_VIDEO)).toEqual({ platform: 'peertube', host: HOST, thumbnail: THUMBNAIL })
  })

  it('keeps the thumbnail as stored even when thumbnails are hidden', () => {
    config.value = { thumbnailPreference: 'hidden' }

    expect(platformRecordFields(PEERTUBE_VIDEO).thumbnail).toBe(THUMBNAIL)
  })

  it('when given one, stores the description as escaped plain text', () => {
    expect(platformRecordFields(PEERTUBE_VIDEO, { description: '<a href="https://x.example">link</a> & <img src=x onerror=alert(1)>' }))
      .toEqual({ platform: 'peertube', host: HOST, thumbnail: THUMBNAIL, description: 'link &amp; ' })
    expect(platformRecordFields(PEERTUBE_VIDEO, { description: '1 &lt; 2' }).description).toBe('1 &lt; 2')
    expect(platformRecordFields(PEERTUBE_VIDEO, { description: undefined })).not.toHaveProperty('description')
    expect(platformRecordFields(PEERTUBE_VIDEO, { description: null }).description).toBe('')
  })
})
