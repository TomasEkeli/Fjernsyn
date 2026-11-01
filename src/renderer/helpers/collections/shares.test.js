import { describe, expect, it } from 'vitest'

import { shareId, shareVideoKey, wallVideos } from './shares'

/**
 * @param {string} sourceId
 * @param {string} videoId
 * @param {object} [extra]
 */
function share(sourceId, videoId, extra = {}) {
  return {
    _id: shareId(sourceId, { videoId }),
    sourceId,
    videoId,
    title: `Title ${videoId}`,
    author: `Channel ${videoId}`,
    votes: 1,
    why: null,
    sharedAt: Date.UTC(2020, 0, 1),
    discussionUrl: null,
    seenAt: 0,
    ...extra,
  }
}

describe('a share\'s keys', () => {
  it('is keyed by its source and the video\'s ref', () => {
    expect(shareId('hackertube', { videoId: 'aaaaaaaaaaa' })).toBe('hackertube|aaaaaaaaaaa')
  })

  it('keys a PeerTube video by its uuid and origin host', () => {
    const ref = { videoId: '9c9de5e8-0a1e-484a-b099-e80766180a6d', host: 'framatube.org' }

    expect(shareId('lemmy:peertube@lemmy.world', ref)).toBe('lemmy:peertube@lemmy.world|9c9de5e8-0a1e-484a-b099-e80766180a6d@framatube.org')
    expect(shareVideoKey(ref)).toBe('9c9de5e8-0a1e-484a-b099-e80766180a6d@framatube.org')
  })

  it('groups a YouTube video by its video id', () => {
    expect(shareVideoKey(share('a', 'aaaaaaaaaaa'))).toBe('aaaaaaaaaaa')
  })
})

describe('the wall\'s videos', () => {
  it('is one card per video, however many sources shared it', () => {
    const videos = wallVideos([
      share('hackertube', 'aaaaaaaaaaa'),
      share('lemmy:videos@lemmy.world', 'aaaaaaaaaaa'),
      share('hackertube', 'bbbbbbbbbbb'),
    ])

    expect(videos.map(video => video.videoId).sort()).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb'])
  })

  it('orders by votes summed over the video\'s shares, most first', () => {
    const videos = wallVideos([
      share('hackertube', 'aaaaaaaaaaa', { votes: 10 }),
      share('hackertube', 'bbbbbbbbbbb', { votes: 25 }),
      share('lemmy:x', 'aaaaaaaaaaa', { votes: 20 }),
      share('hackertube', 'ccccccccccc', { votes: 3.5 }),
    ])

    expect(videos.map(video => [video.videoId, video.collection.votes])).toEqual([
      ['aaaaaaaaaaa', 30],
      ['bbbbbbbbbbb', 25],
      ['ccccccccccc', 3.5],
    ])
  })

  it('puts a video no source voted on after every video with votes, zero included', () => {
    const videos = wallVideos([
      share('a', 'aaaaaaaaaaa', { votes: null }),
      share('a', 'bbbbbbbbbbb', { votes: 0 }),
      share('a', 'ccccccccccc', { votes: 2 }),
    ])

    expect(videos.map(video => [video.videoId, video.collection.votes])).toEqual([
      ['ccccccccccc', 2],
      ['bbbbbbbbbbb', 0],
      ['aaaaaaaaaaa', null],
    ])
  })

  it('breaks a tie by the latest share, then by video id, so the order never wobbles', () => {
    const videos = wallVideos([
      share('a', 'ccccccccccc', { votes: 5, sharedAt: Date.UTC(2010, 0, 1) }),
      share('a', 'bbbbbbbbbbb', { votes: 5, sharedAt: Date.UTC(2020, 0, 1) }),
      share('a', 'aaaaaaaaaaa', { votes: 5, sharedAt: Date.UTC(2010, 0, 1) }),
    ])

    expect(videos.map(video => video.videoId)).toEqual(['bbbbbbbbbbb', 'aaaaaaaaaaa', 'ccccccccccc'])
  })

  it('is an ordinary video for the card: its title and channel name from the share, no duration yet', () => {
    const [video] = wallVideos([share('hackertube', 'aaaaaaaaaaa')])

    expect(video).toEqual({
      type: 'video',
      videoId: 'aaaaaaaaaaa',
      title: 'Title aaaaaaaaaaa',
      author: 'Channel aaaaaaaaaaa',
      lengthSeconds: '',
      collection: {
        votes: 1,
        sharedAt: Date.UTC(2020, 0, 1),
        sourceIds: ['hackertube'],
      },
    })
  })

  it('takes the title from the first share that has one, and the latest share date', () => {
    const [video] = wallVideos([
      share('a', 'aaaaaaaaaaa', { title: '', author: '', sharedAt: Date.UTC(2024, 0, 1) }),
      share('b', 'aaaaaaaaaaa', { title: 'Named', author: 'Someone', sharedAt: Date.UTC(2012, 0, 1) }),
    ])

    expect(video.title).toBe('Named')
    expect(video.author).toBe('Someone')
    expect(video.collection.sharedAt).toBe(Date.UTC(2024, 0, 1))
    expect(video.collection.sourceIds).toEqual(['a', 'b'])
  })

  it('carries a PeerTube video\'s platform and host, as every other wall does', () => {
    const uuid = '9c9de5e8-0a1e-484a-b099-e80766180a6d'
    const [video] = wallVideos([share('a', uuid, { platform: 'peertube', host: 'framatube.org' })])

    expect(video.platform).toBe('peertube')
    expect(video.host).toBe('framatube.org')
  })

  it('is empty for no shares', () => {
    expect(wallVideos([])).toEqual([])
  })
})

describe('the wall\'s videos, with their details', () => {
  const details = {
    _id: 'aaaaaaaaaaa',
    videoId: 'aaaaaaaaaaa',
    fetchedAt: 1234,
    title: 'Its own title',
    author: 'Its channel',
    authorId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
    lengthSeconds: 213,
    viewCount: 1000,
    published: Date.UTC(2009, 9, 25),
  }

  it('shows what the video says of itself once its details are in: duration, views, date, and a channel to link to', () => {
    const [video] = wallVideos([share('hackertube', 'aaaaaaaaaaa')], { aaaaaaaaaaa: details })

    expect(video).toEqual({
      type: 'video',
      videoId: 'aaaaaaaaaaa',
      title: 'Its own title',
      author: 'Its channel',
      authorId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
      lengthSeconds: 213,
      viewCount: 1000,
      published: Date.UTC(2009, 9, 25),
      lastUpdatedAt: 1234,
      collection: {
        votes: 1,
        sharedAt: Date.UTC(2020, 0, 1),
        sourceIds: ['hackertube'],
      },
    })
  })

  it('keeps what the share says where the details say nothing', () => {
    const [video] = wallVideos([share('hackertube', 'aaaaaaaaaaa')], {
      aaaaaaaaaaa: { ...details, title: '', author: '', authorId: '', viewCount: null, published: null, lengthSeconds: '' },
    })

    expect(video.title).toBe('Title aaaaaaaaaaa')
    expect(video.author).toBe('Channel aaaaaaaaaaa')
    expect(video.lengthSeconds).toBe('')
    expect(video).not.toHaveProperty('authorId')
    expect(video).not.toHaveProperty('viewCount')
    expect(video).not.toHaveProperty('published')
  })

  it('carries the live and upcoming flags, an upcoming one\'s start as a date', () => {
    const [live, upcoming] = wallVideos([
      share('a', 'aaaaaaaaaaa', { votes: 2 }),
      share('a', 'bbbbbbbbbbb', { votes: 1 }),
    ], {
      aaaaaaaaaaa: { ...details, liveNow: true },
      bbbbbbbbbbb: { ...details, _id: 'bbbbbbbbbbb', videoId: 'bbbbbbbbbbb', isUpcoming: true, premiereDate: Date.UTC(2030, 0, 1) },
    })

    expect(live.liveNow).toBe(true)
    expect(upcoming.isUpcoming).toBe(true)
    expect(upcoming.premiereDate).toEqual(new Date(Date.UTC(2030, 0, 1)))
  })

  it('leaves a video YouTube said is unavailable off the wall', () => {
    const videos = wallVideos([share('a', 'aaaaaaaaaaa'), share('a', 'bbbbbbbbbbb')], {
      aaaaaaaaaaa: { _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 1, unavailable: 'gone' },
    })

    expect(videos.map(video => video.videoId)).toEqual(['bbbbbbbbbbb'])
  })

  it('matches a PeerTube video\'s details by its uuid and host', () => {
    const uuid = '9c9de5e8-0a1e-484a-b099-e80766180a6d'
    const [video] = wallVideos([share('a', uuid, { platform: 'peertube', host: 'framatube.org' })], {
      [`${uuid}@framatube.org`]: { ...details, _id: `${uuid}@framatube.org`, videoId: uuid },
    })

    expect(video.lengthSeconds).toBe(213)
  })
})
