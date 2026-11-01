import { describe, expect, it } from 'vitest'

import ordinary from '../api/fixtures/local--player-ordinary.json'
import upcomingPremiere from '../api/fixtures/local--player-upcoming-premiere.json'
import liveStream from '../api/fixtures/local--player-live-stream.json'
import finishedStream from '../api/fixtures/local--player-finished-stream.json'
import privateVideo from '../api/fixtures/local--player-private.json'
import noSuchVideo from '../api/fixtures/local--player-no-such-video.json'
import { PlatformError } from '../../platform/errors'
import {
  detailsProgress,
  loginRequiredRecord,
  missingDetails,
  missingPeerTubeDetails,
  needsDetails,
  peerTubeFailureRecord,
  peerTubeRefOf,
  PRIVATE_AFTER_SIGHTINGS,
  SIGHTINGS_APART_MS,
  UNAVAILABLE_STALE_MS,
  LIVE_STALE_MS,
  unavailableRecord,
  videoDetailsFromPeerTubeSummary,
  videoDetailsFromPlayerResponse,
  videoDetailsRecord,
} from './details'

describe('reading a video\'s details from a plain /player answer', () => {
  it('reads an ordinary video: duration, views, publish date, channel, and its title', () => {
    expect(videoDetailsFromPlayerResponse(ordinary.answer, 'dQw4w9WgXcQ')).toEqual({
      kind: 'described',
      details: {
        title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
        author: 'Rick Astley',
        authorId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
        lengthSeconds: 213,
        viewCount: 1823135990,
        published: Date.parse('2009-10-24T23:57:33-07:00'),
      },
    })
  })

  it('reads it though the answer calls it UNPLAYABLE, as every plain request is', () => {
    expect(ordinary.answer.playabilityStatus.status).toBe('UNPLAYABLE')
    expect(videoDetailsFromPlayerResponse(ordinary.answer).kind).toBe('described')
  })

  it('flags an upcoming premiere as upcoming, at its start time', () => {
    const { details } = videoDetailsFromPlayerResponse(upcomingPremiere.answer)

    expect(details.isUpcoming).toBe(true)
    expect(details.premiereDate).toBe(Date.parse('2026-10-15T16:30:00Z'))
    expect(details.liveNow).toBeUndefined()
  })

  it('flags a live stream as live now', () => {
    const { details } = videoDetailsFromPlayerResponse(liveStream.answer)

    expect(details.liveNow).toBe(true)
    expect(details.isUpcoming).toBeUndefined()
  })

  it('flags neither on a stream that has finished', () => {
    const { details } = videoDetailsFromPlayerResponse(finishedStream.answer)

    expect(details.liveNow).toBeUndefined()
    expect(details.isUpcoming).toBeUndefined()
    expect(details.premiereDate).toBeUndefined()
  })

  it('takes the upload date when there is no publish date, and none when there is neither', () => {
    const uploadOnly = structuredClone(ordinary.answer)
    delete uploadOnly.microformat.playerMicroformatRenderer.publishDate
    uploadOnly.microformat.playerMicroformatRenderer.uploadDate = '2010-01-02T03:04:05+00:00'

    expect(videoDetailsFromPlayerResponse(uploadOnly).details.published).toBe(Date.parse('2010-01-02T03:04:05Z'))

    const neither = structuredClone(ordinary.answer)
    delete neither.microformat

    expect(videoDetailsFromPlayerResponse(neither).details.published).toBeNull()
  })

  it('answers no view count or length rather than a wrong one when they cannot be read', () => {
    const answer = structuredClone(ordinary.answer)
    delete answer.videoDetails.viewCount
    answer.videoDetails.lengthSeconds = 'soon'

    const { details } = videoDetailsFromPlayerResponse(answer)

    expect(details.viewCount).toBeNull()
    expect(details.lengthSeconds).toBe('')
  })

  it('reads a video that is not there as gone', () => {
    expect(videoDetailsFromPlayerResponse(noSuchVideo.answer)).toEqual({ kind: 'gone' })
  })

  it('throws for any other status that describes nothing, which is a failure and not a verdict', () => {
    for (const status of ['UNPLAYABLE', 'LIVE_STREAM_OFFLINE', 'CONTENT_CHECK_REQUIRED', 'OK']) {
      expect(() => videoDetailsFromPlayerResponse({ playabilityStatus: { status } }, 'abc'), status).toThrow(status)
    }
  })

  it('reads a private video as asked to sign in, which a bot check answers too', () => {
    expect(videoDetailsFromPlayerResponse(privateVideo.answer)).toEqual({ kind: 'login-required' })
  })

  it('throws for an answer with no playability status, which has not answered', () => {
    expect(() => videoDetailsFromPlayerResponse({}, 'abc')).toThrow()
    expect(() => videoDetailsFromPlayerResponse(undefined)).toThrow()
  })
})

describe('the record kept for a video', () => {
  it('keeps the details by the video\'s ref, with when they were fetched', () => {
    const { details } = videoDetailsFromPlayerResponse(ordinary.answer)

    expect(videoDetailsRecord({ videoId: 'dQw4w9WgXcQ' }, details, 1000)).toEqual({
      _id: 'dQw4w9WgXcQ',
      videoId: 'dQw4w9WgXcQ',
      fetchedAt: 1000,
      ...details,
    })
  })

  it('keeps a PeerTube video by its uuid and origin host', () => {
    expect(videoDetailsRecord({ videoId: 'uuid', platform: 'peertube', host: 'example.org' }, { title: 't' }, 1)).toEqual({
      _id: 'uuid@example.org',
      videoId: 'uuid',
      platform: 'peertube',
      host: 'example.org',
      fetchedAt: 1,
      title: 't',
    })
  })

  it('keeps an unavailable video as unavailable, with why', () => {
    expect(unavailableRecord({ videoId: 'aaaaaaaaaaa' }, 'gone', 5)).toEqual({
      _id: 'aaaaaaaaaaa',
      videoId: 'aaaaaaaaaaa',
      fetchedAt: 5,
      unavailable: 'gone',
    })
  })
})

describe('a video that asks to sign in', () => {
  const ref = { videoId: 'aaaaaaaaaaa' }
  const DAY = 24 * 60 * 60 * 1000

  it('is a suspect the first time, still on the wall and still to be asked about', () => {
    const record = loginRequiredRecord(ref, undefined, 1000)

    expect(record).toEqual({ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 1000, loginRequired: { count: 1, lastAt: 1000 } })
    expect(record.unavailable).toBeUndefined()
    expect(needsDetails(record, 1000)).toBe(true)
  })

  it('never becomes private from answers on the same day, however many', () => {
    let record
    for (let at = 0; at < SIGHTINGS_APART_MS; at += 60 * 60 * 1000) {
      record = loginRequiredRecord(ref, record, at)
    }

    expect(record.unavailable).toBeUndefined()
    expect(record.loginRequired.count).toBe(1)
  })

  it('becomes private only after asking to sign in on three occasions at least twelve hours apart', () => {
    expect(PRIVATE_AFTER_SIGHTINGS).toBe(3)
    expect(SIGHTINGS_APART_MS).toBe(12 * 60 * 60 * 1000)

    const first = loginRequiredRecord(ref, undefined, 0)
    const second = loginRequiredRecord(ref, first, SIGHTINGS_APART_MS)
    const tooSoon = loginRequiredRecord(ref, second, 2 * SIGHTINGS_APART_MS - 1)
    const third = loginRequiredRecord(ref, second, 2 * SIGHTINGS_APART_MS)

    expect(second.loginRequired.count).toBe(2)
    expect(tooSoon.unavailable).toBeUndefined()
    expect(third).toEqual({ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', fetchedAt: 2 * SIGHTINGS_APART_MS, unavailable: 'private' })
  })

  it('stays private when asked again once its mark has gone stale and it still asks to sign in', () => {
    const marked = unavailableRecord(ref, 'private', 0)

    expect(loginRequiredRecord(ref, marked, 40 * DAY)).toEqual(unavailableRecord(ref, 'private', 40 * DAY))
  })

  it('starts counting afresh over a record that had details', () => {
    const described = videoDetailsRecord(ref, { title: 't' }, 0)

    expect(loginRequiredRecord(ref, described, 5).loginRequired).toEqual({ count: 1, lastAt: 5 })
  })
})

describe('whether a video needs asking about', () => {
  const DAY = 24 * 60 * 60 * 1000
  const ref = { videoId: 'aaaaaaaaaaa' }

  it('does with no record, and does not once described', () => {
    expect(needsDetails(undefined, 0)).toBe(true)
    expect(needsDetails(videoDetailsRecord(ref, { title: 't' }, 0), 365 * DAY)).toBe(false)
  })

  it('asks again about an unavailable video once its mark is thirty days old, so a wrong mark heals', () => {
    expect(UNAVAILABLE_STALE_MS).toBe(30 * DAY)

    for (const reason of ['gone', 'private']) {
      const record = unavailableRecord(ref, reason, 0)
      expect(needsDetails(record, UNAVAILABLE_STALE_MS), reason).toBe(false)
      expect(needsDetails(record, UNAVAILABLE_STALE_MS + 1), reason).toBe(true)
    }
  })

  it('asks again about a live or upcoming video a day later, as that does not last', () => {
    expect(LIVE_STALE_MS).toBe(DAY)

    for (const flag of ['liveNow', 'isUpcoming']) {
      const record = videoDetailsRecord(ref, { [flag]: true }, 0)
      expect(needsDetails(record, DAY), flag).toBe(false)
      expect(needsDetails(record, DAY + 1), flag).toBe(true)
    }
  })
})

describe('which videos still need details', () => {
  const share = (videoId, votes, extra = {}) => ({ _id: `s|${videoId}`, sourceId: 's', videoId, title: '', author: '', votes, sharedAt: null, seenAt: 0, ...extra })
  const uuid = '9c9de5e8-0a1e-484a-b099-e80766180a6d'

  const shares = [
    share('aaaaaaaaaaa', 3),
    share('bbbbbbbbbbb', 30),
    share('ccccccccccc', 10),
    { ...share('aaaaaaaaaaa', 5), _id: 't|aaaaaaaaaaa', sourceId: 't' },
    share(uuid, 99, { platform: 'peertube', host: 'framatube.org' }),
    share('not-an-id', 50),
  ]

  it('is every YouTube video with no record, the most voted first, each once', () => {
    expect(missingDetails(shares, { ccccccccccc: { _id: 'ccccccccccc', videoId: 'ccccccccccc', fetchedAt: 1 } }, 1))
      .toEqual(['bbbbbbbbbbb', 'aaaaaaaaaaa'])
  })

  it('counts a video found unavailable as done, until its mark is stale', () => {
    const details = { bbbbbbbbbbb: { _id: 'bbbbbbbbbbb', videoId: 'bbbbbbbbbbb', fetchedAt: 1, unavailable: 'gone' } }

    expect(missingDetails(shares, details, 1)).toEqual(['ccccccccccc', 'aaaaaaaaaaa'])
    expect(missingDetails(shares, details, 2 + UNAVAILABLE_STALE_MS)).toEqual(['ccccccccccc', 'aaaaaaaaaaa', 'bbbbbbbbbbb'])
  })

  it('puts a suspect after every video never asked about', () => {
    const details = { bbbbbbbbbbb: loginRequiredRecord({ videoId: 'bbbbbbbbbbb' }, undefined, 1) }

    expect(missingDetails(shares, details, 1)).toEqual(['ccccccccccc', 'aaaaaaaaaaa', 'bbbbbbbbbbb'])
  })

  it('counts how many of the YouTube videos are done, a suspect not among them', () => {
    expect(detailsProgress(shares, {
      bbbbbbbbbbb: { _id: 'bbbbbbbbbbb', videoId: 'bbbbbbbbbbb', fetchedAt: 1, unavailable: 'gone' },
      ccccccccccc: { _id: 'ccccccccccc', videoId: 'ccccccccccc', fetchedAt: 1 },
      aaaaaaaaaaa: loginRequiredRecord({ videoId: 'aaaaaaaaaaa' }, undefined, 1),
      unrelated00: { _id: 'unrelated00', videoId: 'unrelated00', fetchedAt: 1 },
    }, 1)).toEqual({ done: 2, total: 3 })
  })
})

describe('a PeerTube video\'s details, from the platform layer\'s summary', () => {
  // As the layer's getVideoSummary answers for video.blender.org's recording
  // (platform/peertube/videos.test.js)
  const summary = {
    type: 'video',
    platform: 'peertube',
    host: 'video.blender.org',
    videoId: '057e35a6-c5b8-4fb4-8230-0f5df412ca50',
    title: 'OVERGROWN: a feature film project by Blender Studio',
    author: 'Blender Studio',
    authorId: 'blender_studio@video.blender.org',
    lengthSeconds: 70,
    published: Date.parse('2026-07-10T14:00:16.560Z'),
    viewCount: 12697,
    liveNow: false,
    isUpcoming: false,
    nsfw: false,
    thumbnail: 'https://video.blender.org/lazy-static/thumbnails/057e35a6-c5b8-4fb4-8230-0f5df412ca50.jpg',
  }

  it('says what a YouTube video\'s say, with the channel as its handle, and its thumbnail', () => {
    expect(videoDetailsFromPeerTubeSummary(summary)).toEqual({
      title: 'OVERGROWN: a feature film project by Blender Studio',
      author: 'Blender Studio',
      authorId: 'blender_studio@video.blender.org',
      lengthSeconds: 70,
      viewCount: 12697,
      published: Date.parse('2026-07-10T14:00:16.560Z'),
      thumbnail: 'https://video.blender.org/lazy-static/thumbnails/057e35a6-c5b8-4fb4-8230-0f5df412ca50.jpg',
    })
  })

  it('is kept by the video\'s uuid and origin host', () => {
    expect(videoDetailsRecord(peerTubeRefOf(summary), videoDetailsFromPeerTubeSummary(summary), 5)).toMatchObject({
      _id: '057e35a6-c5b8-4fb4-8230-0f5df412ca50@video.blender.org',
      videoId: '057e35a6-c5b8-4fb4-8230-0f5df412ca50',
      platform: 'peertube',
      host: 'video.blender.org',
      fetchedAt: 5,
    })
  })

  it('flags a live that is live now, which has no duration', () => {
    const { lengthSeconds: _, ...live } = { ...summary, liveNow: true }

    expect(videoDetailsFromPeerTubeSummary(live)).toMatchObject({ liveNow: true, lengthSeconds: '' })
  })

  it('flags a live not yet started as upcoming, at its scheduled start when it has one', () => {
    const at = Date.parse('2026-12-01T18:00:00Z')

    expect(videoDetailsFromPeerTubeSummary({ ...summary, lengthSeconds: 0, isUpcoming: true, premiereDate: new Date(at) }))
      .toMatchObject({ isUpcoming: true, premiereDate: at })
    expect(videoDetailsFromPeerTubeSummary({ ...summary, lengthSeconds: 0, isUpcoming: true })).not.toHaveProperty('premiereDate')
  })

  it('keeps the uploader\'s NSFW mark, for the wall to honour the setting by', () => {
    expect(videoDetailsFromPeerTubeSummary({ ...summary, nsfw: true })).toMatchObject({ nsfw: true })
  })

  it('answers nothing it cannot read rather than something wrong', () => {
    expect(videoDetailsFromPeerTubeSummary({ ...summary, viewCount: undefined, published: undefined, thumbnail: '', author: undefined }))
      .toMatchObject({ viewCount: null, published: null, author: '' })
    expect(videoDetailsFromPeerTubeSummary({ ...summary, thumbnail: '' })).not.toHaveProperty('thumbnail')
  })
})

describe('what a PeerTube video\'s failure is kept as', () => {
  const ref = { platform: 'peertube', host: 'video.blender.org', videoId: '057e35a6-c5b8-4fb4-8230-0f5df412ca50' }

  it('is gone when the instance has no such video', () => {
    expect(peerTubeFailureRecord(ref, new PlatformError('notFound', 'no'), 3)).toEqual(unavailableRecord(ref, 'gone', 3))
  })

  it('is private when the instance refuses to show it, for whatever reason', () => {
    expect(peerTubeFailureRecord(ref, new PlatformError('refused', 'no', { reason: 'password' }), 3)).toEqual(unavailableRecord(ref, 'private', 3))
  })

  it.each([
    [new PlatformError('unavailable', 'down')],
    [new PlatformError('rateLimited', 'slow down')],
    [new PlatformError('invalid', 'bad')],
    [new TypeError('Failed to fetch')],
  ])('is nothing for a failure that says nothing of the video: %s', (error) => {
    expect(peerTubeFailureRecord(ref, error, 3)).toBe(null)
  })
})

describe('which PeerTube videos still need details', () => {
  const share = (videoId, votes, host) => ({ _id: `s|${videoId}@${host}`, sourceId: 's', videoId, platform: 'peertube', host, title: '', author: '', votes, sharedAt: null, seenAt: 0 })
  const a = '9c9de5e8-0a1e-484a-b099-e80766180a6d'
  const b = '059ca8df-3049-44a3-93a9-d603327f2e74'
  const c = '00e42c34-81d4-4744-a2e2-cf3b2b3c19d9'

  const shares = [
    share(a, 3, 'framatube.org'),
    share(b, 30, 'peertube.v1.root42.de'),
    share(c, 10, 'kolektiva.media'),
    { _id: 's|dQw4w9WgXcQ', sourceId: 's', videoId: 'dQw4w9WgXcQ', title: '', author: '', votes: 99, sharedAt: null, seenAt: 0 },
  ]

  it('is every PeerTube video by its ref, the most voted first, those never asked about before the rest', () => {
    const details = {
      [`${c}@kolektiva.media`]: { _id: `${c}@kolektiva.media`, videoId: c, platform: 'peertube', host: 'kolektiva.media', fetchedAt: 1, liveNow: true },
    }

    expect(missingPeerTubeDetails(shares, details, 2 + LIVE_STALE_MS)).toEqual([
      { platform: 'peertube', host: 'peertube.v1.root42.de', videoId: b },
      { platform: 'peertube', host: 'framatube.org', videoId: a },
      { platform: 'peertube', host: 'kolektiva.media', videoId: c },
    ])
    expect(missingPeerTubeDetails(shares, details, 1)).toHaveLength(2)
  })

  it('leaves out YouTube videos, which the crawl asks YouTube about', () => {
    expect(missingDetails(shares, {}, 1)).toEqual(['dQw4w9WgXcQ'])
    expect(missingPeerTubeDetails(shares, {}, 1).map(ref => ref.videoId)).not.toContain('dQw4w9WgXcQ')
  })
})
