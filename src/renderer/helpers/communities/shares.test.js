import { computed, reactive } from 'vue'
import { describe, expect, it } from 'vitest'

import {
  COMMUNITY_SORTS,
  communitySortOf,
  communityValues,
  DEFAULT_COMMUNITY_SORT,
  shareId,
  sharesToPut,
  shareVideoKey,
  wallVideos
} from './shares'

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

    expect(videos.map(video => [video.videoId, video.community.votes])).toEqual([
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

    expect(videos.map(video => [video.videoId, video.community.votes])).toEqual([
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
      community: {
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
    expect(video.community.sharedAt).toBe(Date.UTC(2024, 0, 1))
    expect(video.community.sourceIds).toEqual(['a', 'b'])
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
      community: {
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

  it('is worked out again when details arrive in a reactive map it had no key for, as the store adds them', () => {
    const kept = reactive({})
    const wall = computed(() => wallVideos([share('hackertube', 'aaaaaaaaaaa')], kept))

    expect(wall.value[0].lengthSeconds).toBe('')

    kept.aaaaaaaaaaa = Object.freeze({ ...details })

    expect(wall.value[0].lengthSeconds).toBe(213)
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

  describe('a PeerTube video', () => {
    const uuid = '9c9de5e8-0a1e-484a-b099-e80766180a6d'
    const key = `${uuid}@framatube.org`
    const peerTubeShare = (extra = {}) => share('a', uuid, { platform: 'peertube', host: 'framatube.org', _id: `a|${key}`, ...extra })
    const peerTubeDetails = {
      ...details,
      _id: key,
      videoId: uuid,
      platform: 'peertube',
      host: 'framatube.org',
      authorId: 'framasoft@framatube.org',
      thumbnail: 'https://framatube.org/lazy-static/thumbnails/x.jpg',
    }

    it('takes its thumbnail and its channel handle from its details, as describe and the card read them', () => {
      const [video] = wallVideos([peerTubeShare()], { [key]: peerTubeDetails })

      expect(video).toMatchObject({
        platform: 'peertube',
        host: 'framatube.org',
        videoId: uuid,
        authorId: 'framasoft@framatube.org',
        thumbnail: 'https://framatube.org/lazy-static/thumbnails/x.jpg',
      })
    })

    it('never takes a thumbnail for a YouTube video, whose thumbnail is worked out from its id', () => {
      const [video] = wallVideos([share('hackertube', 'aaaaaaaaaaa')], { aaaaaaaaaaa: { ...details, thumbnail: 'https://elsewhere.example/x.jpg' } })

      expect(video).not.toHaveProperty('thumbnail')
    })

    it('leaves one its uploader marked NSFW off the wall unless NSFW is shown, as every PeerTube wall does', () => {
      const shares = [peerTubeShare(), share('a', 'bbbbbbbbbbb')]
      const kept = { [key]: { ...peerTubeDetails, nsfw: true } }

      expect(wallVideos(shares, kept, { showNsfw: false }).map(video => video.videoId)).toEqual(['bbbbbbbbbbb'])
      expect(wallVideos(shares, kept, { showNsfw: true })).toHaveLength(2)
      expect(wallVideos(shares, kept)).toHaveLength(2)
    })
  })
})

describe('a video\'s values, from its shares and the sources shown', () => {
  const shares = [
    share('hackertube', 'aaaaaaaaaaa', { votes: 12.5, sharedAt: Date.UTC(2019, 0, 1) }),
    share('lemmy:a@x.y', 'aaaaaaaaaaa', { votes: 40, sharedAt: Date.UTC(2026, 9, 3) }),
    share('lemmy:b@x.y', 'aaaaaaaaaaa', { votes: 7, sharedAt: Date.UTC(2026, 9, 30) }),
  ]

  it('sums the votes of every share and takes the latest date when every source is shown', () => {
    expect(communityValues(shares, null)).toEqual({
      votes: 59.5,
      sharedAt: Date.UTC(2026, 9, 30),
      sourceIds: ['hackertube', 'lemmy:a@x.y', 'lemmy:b@x.y'],
    })
  })

  it('counts only the shares of the sources shown: their votes, their latest date', () => {
    expect(communityValues(shares, new Set(['hackertube', 'lemmy:a@x.y']))).toEqual({
      votes: 52.5,
      sharedAt: Date.UTC(2026, 9, 3),
      sourceIds: ['hackertube', 'lemmy:a@x.y'],
    })
  })

  it('on a source\'s page is that source\'s share alone: its votes and its date', () => {
    expect(communityValues(shares, new Set(['hackertube']))).toEqual({
      votes: 12.5,
      sharedAt: Date.UTC(2019, 0, 1),
      sourceIds: ['hackertube'],
    })
  })

  it('has no sources, votes or date when no source that shared it is shown', () => {
    expect(communityValues(shares, new Set(['lemmy:c@x.y']))).toEqual({ votes: null, sharedAt: null, sourceIds: [] })
    expect(communityValues(shares, new Set())).toEqual({ votes: null, sharedAt: null, sourceIds: [] })
  })

  it('has no votes when no shown share has any, whether null or never given', () => {
    const { votes: _absent, ...unvoted } = share('lemmy:b@x.y', 'aaaaaaaaaaa')

    expect(communityValues([share('lemmy:a@x.y', 'aaaaaaaaaaa', { votes: null }), unvoted], null).votes).toBeNull()
  })

  it('sums only the shares that have votes, and counts zero as votes', () => {
    expect(communityValues([share('a', 'aaaaaaaaaaa', { votes: null }), share('b', 'aaaaaaaaaaa', { votes: 0 })], null).votes).toBe(0)
    expect(communityValues([share('a', 'aaaaaaaaaaa', { votes: null }), share('b', 'aaaaaaaaaaa', { votes: 3 })], null).votes).toBe(3)
  })

  it('leaves the votes of a hidden source out even when only it voted', () => {
    const values = communityValues([share('a', 'aaaaaaaaaaa', { votes: 9 }), share('b', 'aaaaaaaaaaa', { votes: null })], new Set(['b']))

    expect(values.votes).toBeNull()
    expect(values.sourceIds).toEqual(['b'])
  })

  it('has no date when no shown share has one', () => {
    expect(communityValues([share('a', 'aaaaaaaaaaa', { sharedAt: null })], null).sharedAt).toBeNull()
  })

  it('names each shown source once, in the order of its shares', () => {
    expect(communityValues([share('b', 'aaaaaaaaaaa'), share('a', 'aaaaaaaaaaa'), share('b', 'aaaaaaaaaaa')], null).sourceIds).toEqual(['b', 'a'])
  })
})

describe('the wall of the sources shown', () => {
  it('leaves off a video shared only by sources not shown, and keeps one any shown source shared', () => {
    const videos = wallVideos([
      share('a', 'aaaaaaaaaaa'),
      share('b', 'bbbbbbbbbbb'),
      share('a', 'ccccccccccc'),
      share('b', 'ccccccccccc'),
    ], {}, { shown: new Set(['a']) })

    expect(videos.map(video => video.videoId).sort()).toEqual(['aaaaaaaaaaa', 'ccccccccccc'])
  })

  it('orders by the votes of the shown shares alone, as the badge counts them', () => {
    const shares = [
      share('a', 'aaaaaaaaaaa', { votes: 10 }),
      share('b', 'aaaaaaaaaaa', { votes: 100 }),
      share('a', 'bbbbbbbbbbb', { votes: 20 }),
    ]

    expect(wallVideos(shares).map(video => video.videoId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb'])

    const shownA = wallVideos(shares, {}, { shown: new Set(['a']) })

    expect(shownA.map(video => video.videoId)).toEqual(['bbbbbbbbbbb', 'aaaaaaaaaaa'])
    expect(shownA[1].community).toEqual({ votes: 10, sharedAt: Date.UTC(2020, 0, 1), sourceIds: ['a'] })
  })

  it('takes the title and channel name from a shown share, not a hidden one', () => {
    const [video] = wallVideos([
      share('a', 'aaaaaaaaaaa', { title: 'Hidden title', author: 'Hidden channel' }),
      share('b', 'aaaaaaaaaaa', { title: 'Shown title', author: '' }),
    ], {}, { shown: new Set(['b']) })

    expect(video.title).toBe('Shown title')
    expect(video.author).toBe('')
  })

  it('shows every source when none is named, as before', () => {
    expect(wallVideos([share('a', 'aaaaaaaaaaa'), share('b', 'bbbbbbbbbbb')], {}, { shown: null })).toHaveLength(2)
  })
})

describe('the wall\'s sorts', () => {
  const details = (videoId, extra) => ({ _id: videoId, videoId, fetchedAt: 1, title: '', author: '', authorId: '', lengthSeconds: 60, viewCount: null, published: null, ...extra })

  const shares = [
    share('a', 'aaaaaaaaaaa', { votes: 30, sharedAt: Date.UTC(2020, 0, 1) }),
    share('a', 'bbbbbbbbbbb', { votes: 10, sharedAt: Date.UTC(2026, 9, 1) }),
    share('b', 'ccccccccccc', { votes: null, sharedAt: Date.UTC(2024, 5, 1) }),
    share('b', 'ddddddddddd', { votes: 20, sharedAt: null }),
  ]

  const kept = {
    aaaaaaaaaaa: details('aaaaaaaaaaa', { viewCount: 500, published: Date.UTC(2010, 0, 1) }),
    bbbbbbbbbbb: details('bbbbbbbbbbb', { viewCount: 9000, published: null }),
    ccccccccccc: details('ccccccccccc', { viewCount: 0, published: Date.UTC(2023, 0, 1) }),
  }

  const order = sort => wallVideos(shares, kept, { sort }).map(video => video.videoId)

  it('offers four sorts, upvotes by default', () => {
    expect([...COMMUNITY_SORTS].sort()).toEqual(['published', 'shared', 'views', 'votes'])
    expect(DEFAULT_COMMUNITY_SORT).toBe('votes')
  })

  it('by upvotes: most first, a video without votes last', () => {
    expect(order('votes')).toEqual(['aaaaaaaaaaa', 'ddddddddddd', 'bbbbbbbbbbb', 'ccccccccccc'])
  })

  it('is by upvotes when no sort is given', () => {
    expect(wallVideos(shares, kept).map(video => video.videoId)).toEqual(order('votes'))
  })

  it('by shared on community: the latest shown share first, a video with no date last', () => {
    expect(order('shared')).toEqual(['bbbbbbbbbbb', 'ccccccccccc', 'aaaaaaaaaaa', 'ddddddddddd'])
  })

  it('by video published: newest first, a video whose details have no date, or that has no details, last', () => {
    expect(order('published')).toEqual(['ccccccccccc', 'aaaaaaaaaaa', 'ddddddddddd', 'bbbbbbbbbbb'])
  })

  it('by views: most first, zero before unknown, a video without details last', () => {
    expect(order('views')).toEqual(['bbbbbbbbbbb', 'aaaaaaaaaaa', 'ccccccccccc', 'ddddddddddd'])
  })

  it('breaks a tie on the sorted value by votes, then the latest share, then the video id', () => {
    const tied = [
      share('a', 'bbbbbbbbbbb', { votes: 1, sharedAt: Date.UTC(2020, 0, 1) }),
      share('a', 'aaaaaaaaaaa', { votes: 1, sharedAt: Date.UTC(2020, 0, 1) }),
      share('a', 'ccccccccccc', { votes: 1, sharedAt: Date.UTC(2021, 0, 1) }),
      share('a', 'ddddddddddd', { votes: 2, sharedAt: Date.UTC(2020, 0, 1) }),
    ]

    expect(wallVideos(tied, {}, { sort: 'views' }).map(video => video.videoId))
      .toEqual(['ddddddddddd', 'ccccccccccc', 'aaaaaaaaaaa', 'bbbbbbbbbbb'])
    expect(wallVideos(tied, {}, { sort: 'shared' }).map(video => video.videoId))
      .toEqual(['ccccccccccc', 'ddddddddddd', 'aaaaaaaaaaa', 'bbbbbbbbbbb'])
  })

  it('sorts on the values of the shown shares: by shared on community, a hidden source\'s later date does not count', () => {
    const two = [
      share('a', 'aaaaaaaaaaa', { sharedAt: Date.UTC(2020, 0, 1) }),
      share('b', 'aaaaaaaaaaa', { sharedAt: Date.UTC(2026, 0, 1) }),
      share('a', 'bbbbbbbbbbb', { sharedAt: Date.UTC(2022, 0, 1) }),
    ]

    expect(wallVideos(two, {}, { sort: 'shared' }).map(video => video.videoId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb'])
    expect(wallVideos(two, {}, { sort: 'shared', shown: new Set(['a']) }).map(video => video.videoId)).toEqual(['bbbbbbbbbbb', 'aaaaaaaaaaa'])
  })

  it('takes a sort it does not know as upvotes', () => {
    expect(wallVideos(shares, kept, { sort: 'nonsense' }).map(video => video.videoId)).toEqual(order('votes'))
  })

  describe('ascending', () => {
    const ascending = sort => wallVideos(shares, kept, { sort, descending: false }).map(video => video.videoId)

    it('is descending unless asked otherwise', () => {
      for (const sort of COMMUNITY_SORTS) {
        expect(wallVideos(shares, kept, { sort, descending: true }).map(video => video.videoId)).toEqual(order(sort))
      }
    })

    it('by upvotes: fewest first, a video without votes still last', () => {
      expect(ascending('votes')).toEqual(['bbbbbbbbbbb', 'ddddddddddd', 'aaaaaaaaaaa', 'ccccccccccc'])
    })

    it('by shared on community: the earliest first, a video with no date still last', () => {
      expect(ascending('shared')).toEqual(['aaaaaaaaaaa', 'ccccccccccc', 'bbbbbbbbbbb', 'ddddddddddd'])
    })

    it('by video published: oldest first, those without a date still last, in the same order', () => {
      expect(ascending('published')).toEqual(['aaaaaaaaaaa', 'ccccccccccc', 'ddddddddddd', 'bbbbbbbbbbb'])
    })

    it('by views: fewest first, a video without details still last', () => {
      expect(ascending('views')).toEqual(['ccccccccccc', 'aaaaaaaaaaa', 'bbbbbbbbbbb', 'ddddddddddd'])
    })

    it('breaks a tie as descending does: by votes, then the latest share, then the video id', () => {
      const tied = [
        share('a', 'bbbbbbbbbbb', { votes: 1, sharedAt: Date.UTC(2020, 0, 1) }),
        share('a', 'aaaaaaaaaaa', { votes: 1, sharedAt: Date.UTC(2020, 0, 1) }),
        share('a', 'ccccccccccc', { votes: 1, sharedAt: Date.UTC(2021, 0, 1) }),
        share('a', 'ddddddddddd', { votes: 2, sharedAt: Date.UTC(2020, 0, 1) }),
      ]

      expect(wallVideos(tied, {}, { sort: 'views', descending: false }).map(video => video.videoId))
        .toEqual(['ddddddddddd', 'ccccccccccc', 'aaaaaaaaaaa', 'bbbbbbbbbbb'])
      expect(wallVideos(tied, {}, { sort: 'shared', descending: false }).map(video => video.videoId))
        .toEqual(['ddddddddddd', 'aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'])
    })
  })
})

describe('a stored sort', () => {
  it('is kept when it is one of the four', () => {
    for (const sort of COMMUNITY_SORTS) {
      expect(communitySortOf(sort)).toBe(sort)
    }
  })

  it('is upvotes when it is anything else', () => {
    expect(communitySortOf('')).toBe('votes')
    expect(communitySortOf(undefined)).toBe('votes')
    expect(communitySortOf('toString')).toBe('votes')
    expect(communitySortOf(3)).toBe('votes')
  })
})

describe('which shares a fetch puts', () => {
  const kept = {
    [shareId('hackertube', { videoId: 'aaaaaaaaaaa' })]: share('hackertube', 'aaaaaaaaaaa', { votes: 5, why: 'old why', categories: ['x', 'y'], seenAt: 1 }),
    [shareId('hackertube', { videoId: 'bbbbbbbbbbb' })]: share('hackertube', 'bbbbbbbbbbb', { votes: 3, seenAt: 1 }),
  }

  it('puts a video new to the source as a new share', () => {
    const fresh = share('hackertube', 'ccccccccccc', { seenAt: 9 })

    expect(sharesToPut(kept, [fresh])).toEqual([fresh])
  })

  it('puts nothing for a share the source gives again unchanged, however long ago it was last put', () => {
    const again = share('hackertube', 'bbbbbbbbbbb', { votes: 3, seenAt: 9 })

    expect(sharesToPut(kept, [again])).toEqual([])
  })

  it('puts a kept share whose votes, why or categories changed, as the source now gives it', () => {
    const votes = share('hackertube', 'aaaaaaaaaaa', { votes: 6, why: 'old why', categories: ['x', 'y'], seenAt: 9 })
    const why = share('hackertube', 'aaaaaaaaaaa', { votes: 5, why: 'new why', categories: ['x', 'y'], seenAt: 9 })
    const categories = share('hackertube', 'aaaaaaaaaaa', { votes: 5, why: 'old why', categories: ['x'], seenAt: 9 })
    const reordered = share('hackertube', 'aaaaaaaaaaa', { votes: 5, why: 'old why', categories: ['y', 'x'], seenAt: 9 })
    const title = share('hackertube', 'aaaaaaaaaaa', { votes: 5, why: 'old why', categories: ['x', 'y'], title: 'Renamed', seenAt: 9 })

    for (const changed of [votes, why, categories, reordered, title]) {
      expect(sharesToPut(kept, [changed])).toEqual([changed])
    }
  })

  it('puts nothing for categories given again as a new array with the same ids', () => {
    const again = share('hackertube', 'aaaaaaaaaaa', { votes: 5, why: 'old why', categories: ['x', 'y'].slice(), seenAt: 9 })

    expect(again.categories).not.toBe(kept[shareId('hackertube', { videoId: 'aaaaaaaaaaa' })].categories)
    expect(sharesToPut(kept, [again])).toEqual([])
  })

  it('puts a kept share whose why the source has since taken away', () => {
    const cleared = share('hackertube', 'aaaaaaaaaaa', { votes: 5, why: null, categories: ['x', 'y'], seenAt: 9 })

    expect(sharesToPut(kept, [cleared])).toEqual([cleared])
  })

  it('leaves a field the source does not give as it was kept, as the put does', () => {
    const { categories: _, ...withoutCategories } = share('hackertube', 'aaaaaaaaaaa', { votes: 5, why: 'old why', seenAt: 9 })

    expect(sharesToPut(kept, [withoutCategories])).toEqual([])
  })

  it('never removes a kept share the source no longer gives', () => {
    const fresh = share('hackertube', 'ccccccccccc', { seenAt: 9 })

    const put = sharesToPut(kept, [fresh])

    expect(put.map(item => item._id)).toEqual([fresh._id])
    expect(put.some(item => item._id === shareId('hackertube', { videoId: 'aaaaaaaaaaa' }))).toBe(false)
  })

  it('puts a share given twice once, as the last of them', () => {
    const first = share('hackertube', 'ccccccccccc', { votes: 1, seenAt: 9 })
    const last = share('hackertube', 'ccccccccccc', { votes: 2, seenAt: 9 })

    expect(sharesToPut(kept, [first, last])).toEqual([last])
  })

  it('takes a kept map whose shares are frozen, as the store holds them', () => {
    const frozen = Object.freeze({ ...kept })
    Object.values(frozen).forEach(Object.freeze)

    expect(sharesToPut(frozen, [share('hackertube', 'bbbbbbbbbbb', { votes: 4, seenAt: 9 })])).toHaveLength(1)
  })
})
