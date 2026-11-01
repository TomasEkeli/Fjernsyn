import { liveStateFromPlayerResponse } from '../api/liveState'
import { shareVideoKey } from './shares'

/**
 * A collection video's own details, which no source gives: its duration,
 * views, publish date and channel, read from the plain `/player` request the
 * crawl makes for it (`getLocalPlayerResponse`), with no PO token and no
 * player script. YouTube calls every video unplayable to such a request, and
 * still describes it.
 *
 * Kept in `collection-videos.db`, one record per video by its ref, apart from
 * the shares, so that a share stays what its source said. A video with a
 * record is done, whether it was described or found unavailable: that is how
 * the crawl knows what is left.
 *
 * Pure, and tested against the recorded answers in `../api/fixtures`.
 */

/**
 * @typedef {object} VideoDetailsFields what a described video's answer says
 * @property {string} title
 * @property {string} author
 * @property {string} authorId
 * @property {number | ''} lengthSeconds `''` when it cannot be read, as a
 *   share's wall video has it: undefined would make the card take it for a
 *   live stream
 * @property {number | null} viewCount
 * @property {number | null} published milliseconds since the epoch
 * @property {true} [liveNow]
 * @property {true} [isUpcoming]
 * @property {number} [premiereDate] when an upcoming video starts, in
 *   milliseconds since the epoch, when it says
 */

/**
 * @typedef {{ kind: 'described', details: VideoDetailsFields }
 *   | { kind: 'gone' }
 *   | { kind: 'login-required' }} PlayerAnswer
 *
 * `gone` is nothing described under any status but `LOGIN_REQUIRED`: `ERROR`
 * for a video deleted or never there. `login-required` is nothing described
 * under `LOGIN_REQUIRED`, which a private video answers and so does a bot
 * check; only what answers after it can tell the two apart (see `crawl.js`).
 */

/**
 * @typedef {object} VideoDetails the record kept for one video
 * @property {string} _id the video's ref as one string (`shareVideoKey`)
 * @property {string} videoId
 * @property {'peertube'} [platform]
 * @property {string} [host]
 * @property {number} fetchedAt
 * @property {'gone' | 'private'} [unavailable] set when YouTube described no
 *   video, and then none of the details are
 * @property {string} [title]
 * @property {string} [author]
 * @property {string} [authorId]
 * @property {number | ''} [lengthSeconds]
 * @property {number | null} [viewCount]
 * @property {number | null} [published]
 * @property {true} [liveNow]
 * @property {true} [isUpcoming]
 * @property {number} [premiereDate]
 */

/**
 * @param {unknown} text
 * @returns {number | null}
 */
function wholeNumber(text) {
  if (typeof text !== 'string' && typeof text !== 'number') { return null }

  const number = Number(text)

  return Number.isInteger(number) && number >= 0 ? number : null
}

/**
 * @param {unknown} text an ISO date, with its offset
 * @returns {number | null}
 */
function dateOf(text) {
  if (typeof text !== 'string') { return null }

  const at = Date.parse(text)

  return Number.isNaN(at) ? null : at
}

/**
 * @param {any} data the `data` of a raw `/player` response
 * @param {string} [videoId] for the message when it throws
 * @returns {PlayerAnswer}
 * @throws when the response has no playability status, which has not answered
 */
export function videoDetailsFromPlayerResponse(data, videoId = '') {
  const playability = data?.playabilityStatus
  const details = data?.videoDetails
  const microformat = data?.microformat?.playerMicroformatRenderer

  if (typeof details?.videoId !== 'string') {
    if (typeof playability?.status !== 'string') {
      throw new Error(`/player for ${videoId} answered no playability status`)
    }

    return playability.status === 'LOGIN_REQUIRED' ? { kind: 'login-required' } : { kind: 'gone' }
  }

  /** @type {VideoDetailsFields} */
  const fields = {
    title: typeof details.title === 'string' ? details.title : '',
    author: typeof details.author === 'string' ? details.author : (microformat?.ownerChannelName ?? ''),
    authorId: typeof details.channelId === 'string' ? details.channelId : (microformat?.externalChannelId ?? ''),
    lengthSeconds: wholeNumber(details.lengthSeconds) ?? '',
    viewCount: wholeNumber(details.viewCount),
    published: dateOf(microformat?.publishDate) ?? dateOf(microformat?.uploadDate),
  }

  // Described, so this answers and never throws
  const live = liveStateFromPlayerResponse(data, videoId)

  if (live.state === 'live') {
    fields.liveNow = true
  } else if (live.state === 'upcoming') {
    fields.isUpcoming = true

    if (live.startsAt !== null) {
      fields.premiereDate = live.startsAt
    }
  }

  return { kind: 'described', details: fields }
}

/**
 * @param {{ videoId: string, platform?: string, host?: string }} ref
 * @param {number} fetchedAt
 */
function recordOf(ref, fetchedAt) {
  const record = { _id: shareVideoKey(ref), videoId: ref.videoId }

  if (ref.platform === 'peertube') {
    record.platform = 'peertube'
    record.host = ref.host
  }

  record.fetchedAt = fetchedAt

  return record
}

/**
 * @param {{ videoId: string, platform?: string, host?: string }} ref
 * @param {Partial<VideoDetailsFields>} details
 * @param {number} fetchedAt
 * @returns {VideoDetails}
 */
export function videoDetailsRecord(ref, details, fetchedAt) {
  return { ...recordOf(ref, fetchedAt), ...details }
}

/**
 * @param {{ videoId: string, platform?: string, host?: string }} ref
 * @param {'gone' | 'private'} reason
 * @param {number} fetchedAt
 * @returns {VideoDetails}
 */
export function unavailableRecord(ref, reason, fetchedAt) {
  return { ...recordOf(ref, fetchedAt), unavailable: reason }
}
