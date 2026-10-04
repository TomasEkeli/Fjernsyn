import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from 'youtubei.js'

import upcomingStream from './fixtures/local--player-upcoming-stream.json'
import liveStream from './fixtures/local--player-live-stream.json'
import upcomingPremiere from './fixtures/local--player-upcoming-premiere.json'
import premierePlaying from './fixtures/local--player-premiere-playing.json'
import finishedStream from './fixtures/local--player-finished-stream.json'
import finishedStreamNoRecording from './fixtures/local--player-finished-stream-no-recording.json'
import finishedPremiere from './fixtures/local--player-finished-premiere.json'
import ordinary from './fixtures/local--player-ordinary.json'
import privateVideo from './fixtures/local--player-private.json'
import noSuchVideo from './fixtures/local--player-no-such-video.json'
import { liveStateFromPlayerResponse } from './liveState'
import { getLocalLiveState } from './local'

describe('liveStateFromPlayerResponse', () => {
  it('reads an upcoming stream as upcoming, at its start time in ms', () => {
    expect(liveStateFromPlayerResponse(upcomingStream.answer))
      .toEqual({ state: 'upcoming', startsAt: Date.parse('2026-10-04T21:00:00Z') })
  })

  it('reads an upcoming premiere the same way', () => {
    expect(liveStateFromPlayerResponse(upcomingPremiere.answer))
      .toEqual({ state: 'upcoming', startsAt: Date.parse('2026-10-15T16:30:00Z') })
  })

  it('takes the start time from the offline slate, in seconds, when the microformat has none', () => {
    const answer = structuredClone(upcomingStream.answer)
    delete answer.microformat.playerMicroformatRenderer.liveBroadcastDetails.startTimestamp

    expect(liveStateFromPlayerResponse(answer))
      .toEqual({ state: 'upcoming', startsAt: 1791147600 * 1000 })
  })

  it('answers upcoming with no time when neither gives one', () => {
    const answer = structuredClone(upcomingStream.answer)
    delete answer.microformat
    delete answer.playabilityStatus.liveStreamability

    expect(liveStateFromPlayerResponse(answer)).toEqual({ state: 'upcoming', startsAt: null })
  })

  it('reads a live stream as live, though its status is UNPLAYABLE', () => {
    expect(liveStream.answer.playabilityStatus.status).toBe('UNPLAYABLE')
    expect(liveStateFromPlayerResponse(liveStream.answer)).toEqual({ state: 'live' })
  })

  it('reads a premiere that is playing as live', () => {
    expect(liveStateFromPlayerResponse(premierePlaying.answer)).toEqual({ state: 'live' })
  })

  it('reads live from the microformat alone, when videoDetails does not say', () => {
    const answer = structuredClone(liveStream.answer)
    delete answer.videoDetails.isLive

    expect(liveStateFromPlayerResponse(answer)).toEqual({ state: 'live' })
  })

  it('reads a finished stream as over', () => {
    expect(liveStateFromPlayerResponse(finishedStream.answer)).toEqual({ state: 'over' })
  })

  it('reads a finished stream with no recording as over, though it is still flagged isPostLiveDvr', () => {
    expect(finishedStreamNoRecording.answer.videoDetails.isPostLiveDvr).toBe(true)
    expect(liveStateFromPlayerResponse(finishedStreamNoRecording.answer)).toEqual({ state: 'over' })
  })

  it('reads a premiere that has aired as over', () => {
    expect(liveStateFromPlayerResponse(finishedPremiere.answer)).toEqual({ state: 'over' })
  })

  it('reads an ordinary video, never live, as over', () => {
    expect(liveStateFromPlayerResponse(ordinary.answer)).toEqual({ state: 'over' })
  })

  it('reads a video that is not there as unavailable', () => {
    expect(liveStateFromPlayerResponse(noSuchVideo.answer)).toEqual({ state: 'unavailable' })
  })

  it('throws for a private video, which answers as a refusal does: LOGIN_REQUIRED with nothing described', () => {
    expect(() => liveStateFromPlayerResponse(privateVideo.answer, 'abc')).toThrow('refused: LOGIN_REQUIRED')
  })

  it('throws for a response with no playability status, which has not answered', () => {
    expect(() => liveStateFromPlayerResponse({})).toThrow()
    expect(() => liveStateFromPlayerResponse(undefined)).toThrow()
  })
})

describe('getLocalLiveState', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function answering(execute) {
    vi.spyOn(Session, 'create').mockResolvedValue({ actions: { execute } })
  }

  it('makes the plain /player request and reads its answer', async () => {
    const execute = vi.fn().mockResolvedValue({ data: liveStream.answer })
    answering(execute)

    await expect(getLocalLiveState('xDWQ3LkccY8')).resolves.toEqual({ state: 'live' })
    expect(execute).toHaveBeenCalledWith('/player', {
      videoId: 'xDWQ3LkccY8',
      racyCheckOk: true,
      contentCheckOk: true
    })
    expect(Session.create).toHaveBeenCalledWith(expect.objectContaining({
      retrieve_player: false,
      generate_session_locally: true
    }))
  })

  it('throws a refusal rather than answering', async () => {
    answering(vi.fn().mockResolvedValue({ data: privateVideo.answer }))

    await expect(getLocalLiveState('aPrivateVid')).rejects.toThrow('refused: LOGIN_REQUIRED')
  })

  it('throws what a failed request throws', async () => {
    answering(vi.fn().mockRejectedValue(new Error('Request to /player failed with status 429')))

    await expect(getLocalLiveState('xDWQ3LkccY8')).rejects.toThrow('429')
  })
})
