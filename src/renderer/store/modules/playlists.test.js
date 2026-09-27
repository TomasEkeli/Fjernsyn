import { afterEach, describe, expect, it, vi } from 'vitest'

import { DBPlaylistHandlers } from '../../../datastores/handlers/index'
import playlists from './playlists'

// What the store writes, recorded instead of written
vi.mock('../../../datastores/handlers/index', () => ({
  DBPlaylistHandlers: {
    upsertVideoByPlaylistId: vi.fn(async () => {}),
    upsertVideosByPlaylistId: vi.fn(async () => {}),
  },
}))

// helpers/utils imports the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

const HOST = 'video.blender.org'
const UUID = 'b29290cc-dc51-4a12-bcb2-2aa5fece7605'
const THUMBNAIL = 'https://video.blender.org/lazy-static/previews/sprite-fright.jpg'

const PEERTUBE_ITEM = {
  videoId: UUID,
  title: 'Sprite Fright',
  author: 'Blender',
  authorId: 'blender@video.blender.org',
  description: 'A film',
  viewCount: 1234,
  lengthSeconds: 629,
  published: 1635465600000,
  platform: 'peertube',
  host: HOST,
  thumbnail: THUMBNAIL,
}

const YOUTUBE_ITEM = {
  videoId: 'dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up',
  author: 'Rick Astley',
  authorId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
  description: 'The video',
  viewCount: 1600000000,
  lengthSeconds: 213,
  published: 1256428800000,
}

const commit = vi.fn()

afterEach(() => {
  vi.clearAllMocks()
})

describe('the playlists store keeps what a PeerTube item needs', () => {
  it('addVideos keeps platform, host and thumbnail, and drops what it drops for YouTube', async () => {
    await playlists.actions.addVideos({ commit }, { _id: 'p1', videos: [PEERTUBE_ITEM, YOUTUBE_ITEM] })

    const [[, , [peertube, youtube]]] = DBPlaylistHandlers.upsertVideosByPlaylistId.mock.calls

    expect(peertube).toMatchObject({ platform: 'peertube', host: HOST, thumbnail: THUMBNAIL, videoId: UUID, type: 'video' })
    expect(peertube).not.toHaveProperty('description')
    expect(peertube).not.toHaveProperty('viewCount')

    expect(Object.keys(youtube).sort()).toEqual([
      'author', 'authorId', 'lengthSeconds', 'playlistItemId', 'published', 'timeAdded', 'title', 'type', 'videoId',
    ])
  })

  it('addVideo keeps platform, host and thumbnail, and adds nothing to a YouTube item', async () => {
    const peertube = { ...PEERTUBE_ITEM }
    const youtube = { ...YOUTUBE_ITEM }

    await playlists.actions.addVideo({ commit }, { _id: 'p1', videoData: peertube })
    await playlists.actions.addVideo({ commit }, { _id: 'p1', videoData: youtube })

    const written = DBPlaylistHandlers.upsertVideoByPlaylistId.mock.calls.map(call => call[2])

    expect(written[0]).toMatchObject({ platform: 'peertube', host: HOST, thumbnail: THUMBNAIL })
    expect(Object.keys(written[1]).sort()).toEqual([
      'author', 'authorId', 'description', 'lengthSeconds', 'playlistItemId', 'published', 'timeAdded', 'title', 'type', 'videoId', 'viewCount',
    ])
  })
})
