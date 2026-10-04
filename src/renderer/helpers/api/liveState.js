/**
 * Whether a video is upcoming, live, over or unavailable, read from a raw
 * `/player` response: the plain request `getLocalLiveState` makes, with no PO
 * token and no player script.
 *
 * Such a request is refused the streams of every video, so
 * `playabilityStatus.status` is `UNPLAYABLE` for a live stream and a finished
 * one alike, and says nothing here. What YouTube still sends is the
 * description of the video, and that is what is read:
 *
 * - live: `videoDetails.isLive`, or the microformat's
 *   `liveBroadcastDetails.isLiveNow`. A premiere that is playing answers
 *   both, like a stream; only `isLiveContent` tells them apart, and it is not
 *   needed.
 * - upcoming: `videoDetails.isUpcoming`, a stream and a premiere alike. The
 *   time is `liveBroadcastDetails.startTimestamp`, an ISO date with its
 *   offset, or failing that the offline slate's `scheduledStartTime`, in
 *   seconds. The two agree on every recording.
 * - over: described, and neither of those. A finished stream, a premiere that
 *   has aired, a stream whose recording was not kept, and an ordinary video
 *   that was never live, all answer this. `isPostLiveDvr` is not read: a
 *   stream that ended months ago can still carry it.
 * - unavailable: nothing described, under any status but `LOGIN_REQUIRED`:
 *   `ERROR` for a video that is not there.
 *
 * `LOGIN_REQUIRED` with nothing described is a refusal, as it is for
 * `getLocalVideoMetadata`, and throws. A bot check answers so, and so does a
 * private video; the two cannot be told apart without reading YouTube's
 * words, which are in the interface language.
 *
 * The flags are left out of the response when false, never sent as `false`.
 *
 * Pure, and free of youtubei.js, so that it is tested against recorded
 * responses (`fixtures/local--player-*.json`) without a session.
 */

/**
 * @typedef {{ state: 'upcoming', startsAt: number | null }
 *   | { state: 'live' }
 *   | { state: 'over' }
 *   | { state: 'unavailable' }} LiveState
 */

/**
 * @param {any} data the `data` of a raw `/player` response
 * @param {string} [videoId] for the message when it throws
 * @returns {LiveState}
 * @throws when the response refuses rather than answers
 */
export function liveStateFromPlayerResponse(data, videoId = '') {
  const playability = data?.playabilityStatus
  const details = data?.videoDetails
  const broadcast = data?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails

  if (typeof details?.videoId !== 'string') {
    if (typeof playability?.status !== 'string') {
      throw new Error(`/player for ${videoId} answered no playability status`)
    }

    // Asked to sign in, with nothing said about the video, is being refused
    if (playability.status === 'LOGIN_REQUIRED') {
      throw new Error(`Request for ${videoId} refused: LOGIN_REQUIRED`)
    }

    return { state: 'unavailable' }
  }

  if (details.isLive === true || broadcast?.isLiveNow === true) {
    return { state: 'live' }
  }

  if (details.isUpcoming === true) {
    return { state: 'upcoming', startsAt: startTimeOf(broadcast, playability) }
  }

  return { state: 'over' }
}

/**
 * @param {any} broadcast
 * @param {any} playability
 * @returns {number | null} milliseconds since the epoch
 */
function startTimeOf(broadcast, playability) {
  if (typeof broadcast?.startTimestamp === 'string') {
    const startsAt = Date.parse(broadcast.startTimestamp)

    if (!Number.isNaN(startsAt)) {
      return startsAt
    }
  }

  const scheduled = playability?.liveStreamability?.liveStreamabilityRenderer
    ?.offlineSlate?.liveStreamOfflineSlateRenderer?.scheduledStartTime
  const seconds = Number.parseInt(scheduled, 10)

  return Number.isNaN(seconds) ? null : seconds * 1000
}
