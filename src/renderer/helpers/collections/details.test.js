import { describe, expect, it } from 'vitest'

import ordinary from '../api/fixtures/local--player-ordinary.json'
import upcomingPremiere from '../api/fixtures/local--player-upcoming-premiere.json'
import liveStream from '../api/fixtures/local--player-live-stream.json'
import finishedStream from '../api/fixtures/local--player-finished-stream.json'
import privateVideo from '../api/fixtures/local--player-private.json'
import noSuchVideo from '../api/fixtures/local--player-no-such-video.json'
import {
  detailsProgress,
  loginRequiredRecord,
  missingDetails,
  needsDetails,
  PRIVATE_AFTER_SIGHTINGS,
  SIGHTINGS_APART_MS,
  UNAVAILABLE_STALE_MS,
  LIVE_STALE_MS,
  unavailableRecord,
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
