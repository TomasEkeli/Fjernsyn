import { describe, expect, it } from 'vitest'

import ordinary from '../api/fixtures/local--player-ordinary.json'
import upcomingPremiere from '../api/fixtures/local--player-upcoming-premiere.json'
import liveStream from '../api/fixtures/local--player-live-stream.json'
import finishedStream from '../api/fixtures/local--player-finished-stream.json'
import privateVideo from '../api/fixtures/local--player-private.json'
import noSuchVideo from '../api/fixtures/local--player-no-such-video.json'
import { unavailableRecord, videoDetailsFromPlayerResponse, videoDetailsRecord } from './details'

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
