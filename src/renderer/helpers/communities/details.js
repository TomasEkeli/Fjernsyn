import { liveStateFromPlayerResponse } from '../api/liveState'
import { PlatformError } from '../../platform/errors'
import { isPeerTubeNotFound } from '../../platform/peertube/feed'
import { isPeerTubeVideoRef, isYouTubeVideoRef, platformOf, PLATFORM_PEERTUBE, PLATFORM_YOUTUBE } from '../../platform/refs'
import { shareVideoKey, wallVideos } from './shares'

/**
 * A community video's own details, which no source gives: its duration,
 * views, publish date and channel, read from the plain `/player` request the
 * crawl makes for it (`getLocalPlayerResponse`), with no PO token and no
 * player script. YouTube calls every video unplayable to such a request, and
 * still describes it.
 *
 * Kept in `community-videos.db`, one record per video by its ref, apart from
 * the shares, so that a share stays what its source said. A video with a
 * record is done, whether it was described or found unavailable, with three
 * exceptions that `needsDetails` names: a suspect (below), an unavailable mark
 * a month old, and a live or upcoming video a day old. That is how the crawl
 * knows what is left.
 *
 * A video that asks to sign in may be private, or the request met a bot
 * check, which answers the same and cannot be told from it without reading
 * YouTube's words, which are in the interface language. So one answer never
 * hides a video: it is kept as a suspect, still on the wall and still asked
 * about, and becomes private only after asking to sign in on
 * `PRIVATE_AFTER_SIGHTINGS` occasions at least `SIGHTINGS_APART_MS` apart.
 *
 * A PeerTube video's details come from the platform layer instead
 * (`videoDetailsFromPeerTubeSummary`), kept by its uuid and origin host in
 * the same records, with the same rules for what is done.
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
 * `gone` is nothing described under `ERROR`: a video deleted or never there.
 * `login-required` is nothing described under `LOGIN_REQUIRED`, which a
 * private video answers and so does a bot check. Nothing described under any
 * other status is no answer, and throws.
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
 * @property {{ count: number, lastAt: number }} [loginRequired] a suspect: it
 *   asked to sign in, on `count` occasions far enough apart, the last counted
 *   at `lastAt`; none of the details are set
 * @property {string} [title]
 * @property {string} [author]
 * @property {string} [authorId]
 * @property {number | ''} [lengthSeconds]
 * @property {number | null} [viewCount]
 * @property {number | null} [published]
 * @property {true} [liveNow]
 * @property {true} [isUpcoming]
 * @property {number} [premiereDate]
 * @property {string} [thumbnail] PeerTube only: its own thumbnail, an
 *   absolute https URL on the instance that answered
 * @property {true} [nsfw] PeerTube only: its uploader marked it NSFW
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

    if (playability.status === 'LOGIN_REQUIRED') { return { kind: 'login-required' } }
    if (playability.status === 'ERROR') { return { kind: 'gone' } }

    throw new Error(`/player for ${videoId} described nothing, under ${playability.status}`)
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

/** Occasions a video must ask to sign in on before it is taken for private */
export const PRIVATE_AFTER_SIGHTINGS = 3

/** How far apart those occasions must be to count apart */
export const SIGHTINGS_APART_MS = 12 * 60 * 60 * 1000

/** How old an unavailable mark gets before the video is asked about again */
export const UNAVAILABLE_STALE_MS = 30 * 24 * 60 * 60 * 1000

/** How old a live or upcoming video's details get before it is asked about again */
export const LIVE_STALE_MS = 24 * 60 * 60 * 1000

/**
 * The record for a video that asked to sign in, from the one kept before.
 *
 * @param {{ videoId: string, platform?: string, host?: string }} ref
 * @param {VideoDetails | undefined} previous
 * @param {number} at
 * @returns {VideoDetails}
 */
export function loginRequiredRecord(ref, previous, at) {
  // Taken for private before, and asking to sign in still
  if (previous?.unavailable === 'private') { return unavailableRecord(ref, 'private', at) }

  const before = previous?.loginRequired

  if (before === undefined) {
    return { ...recordOf(ref, at), loginRequired: { count: 1, lastAt: at } }
  }

  // Asked again too soon after the last time that counted: the same
  // occasion, which a bot check that lasts a while would otherwise multiply
  if (at - before.lastAt < SIGHTINGS_APART_MS) {
    return { ...recordOf(ref, at), loginRequired: { ...before } }
  }

  if (before.count + 1 >= PRIVATE_AFTER_SIGHTINGS) { return unavailableRecord(ref, 'private', at) }

  return { ...recordOf(ref, at), loginRequired: { count: before.count + 1, lastAt: at } }
}

/**
 * Whether a video is to be asked about: it has no record, or is a suspect,
 * or its unavailable mark has gone stale, so that a wrong one heals, or it
 * was live or upcoming a day ago, which does not last.
 *
 * @param {VideoDetails | undefined} record
 * @param {number} now
 * @returns {boolean}
 */
export function needsDetails(record, now) {
  if (record == null) { return true }
  if (record.loginRequired !== undefined) { return true }
  if (record.unavailable !== undefined) { return now - record.fetchedAt > UNAVAILABLE_STALE_MS }
  if (record.liveNow === true || record.isUpcoming === true) { return now - record.fetchedAt > LIVE_STALE_MS }

  return false
}

/**
 * The record kept for a key. Read before it is looked for, so that a reactive
 * caller is told when one arrives for a key that had none.
 *
 * @param {Record<string, VideoDetails>} details
 * @param {string} key
 * @returns {VideoDetails | undefined}
 */
export function detailsFor(details, key) {
  const record = details[key]

  return Object.hasOwn(details, key) ? record : undefined
}

/**
 * The videos of one platform the shares name that are to be asked about:
 * those never asked about first, then those asked about before, each the most
 * voted first, so that the top of the wall fills in first.
 *
 * @template T
 * @param {import('./shares').Share[]} shares
 * @param {Record<string, VideoDetails>} details by the video's ref as one string
 * @param {number} now
 * @param {(video: import('./shares').CommunityVideo) => T | null} pick what
 *   to answer for a video of the platform asked for, null for any other
 * @returns {T[]}
 */
function missingOf(shares, details, now, pick) {
  const never = []
  const again = []

  for (const video of wallVideos(shares)) {
    const picked = pick(video)
    if (picked === null) { continue }

    const record = detailsFor(details, shareVideoKey(video))

    if (record === undefined) {
      never.push(picked)
    } else if (needsDetails(record, now)) {
      again.push(picked)
    }
  }

  return never.concat(again)
}

/**
 * The YouTube videos the shares name that are to be asked about, by id: those
 * never asked about first, then those asked about before, each the most voted
 * first, so that the top of the wall fills in first. PeerTube videos are not
 * among them: their details come through the platform layer, not YouTube
 * (`missingPeerTubeDetails`).
 *
 * @param {import('./shares').Share[]} shares
 * @param {Record<string, VideoDetails>} details by the video's ref as one string
 * @param {number} now
 * @returns {string[]}
 */
export function missingDetails(shares, details, now) {
  return missingOf(shares, details, now, (video) => {
    return platformOf(video) === PLATFORM_YOUTUBE && isYouTubeVideoRef(video.videoId) ? video.videoId : null
  })
}

/**
 * The PeerTube videos the shares name that are to be asked about, by ref, in
 * the order `missingDetails` gives YouTube's.
 *
 * @param {import('./shares').Share[]} shares
 * @param {Record<string, VideoDetails>} details by the video's ref as one string
 * @param {number} now
 * @returns {import('../../platform/shapes').PeerTubeVideoRef[]}
 */
export function missingPeerTubeDetails(shares, details, now) {
  return missingOf(shares, details, now, (video) => {
    return isPeerTubeVideoRef(video) ? peerTubeRefOf(video) : null
  })
}

/**
 * A PeerTube video's ref, from anything that carries one: a share, a wall
 * video, the layer's summary
 *
 * @param {{ videoId: string, host: string }} video
 * @returns {import('../../platform/shapes').PeerTubeVideoRef}
 */
export function peerTubeRefOf({ videoId, host }) {
  return { platform: PLATFORM_PEERTUBE, host, videoId }
}

/**
 * What the platform layer's summary of a PeerTube video
 * (`getVideoSummary`) says of it, as the details kept for a YouTube video say
 * it: its channel is its handle (`name@host`), which the card links and
 * hidden and marked channels match by. Two more of its own: its thumbnail,
 * which `describe` takes from the video and cannot work out from its id as
 * YouTube's, and its uploader's NSFW mark, for the wall to honour the
 * setting by.
 *
 * @param {import('../../platform/shapes').VideoSummary} summary
 * @returns {VideoDetailsFields & { thumbnail?: string, nsfw?: true }}
 */
export function videoDetailsFromPeerTubeSummary(summary) {
  /** @type {VideoDetailsFields & { thumbnail?: string, nsfw?: true }} */
  const fields = {
    title: typeof summary.title === 'string' ? summary.title : '',
    author: typeof summary.author === 'string' ? summary.author : '',
    authorId: typeof summary.authorId === 'string' ? summary.authorId : '',
    // A live now has none, which the card reads as live; '' says the same
    lengthSeconds: wholeNumber(summary.lengthSeconds) ?? '',
    viewCount: wholeNumber(summary.viewCount),
    published: typeof summary.published === 'number' && Number.isFinite(summary.published) ? summary.published : null,
  }

  if (typeof summary.thumbnail === 'string' && summary.thumbnail !== '') { fields.thumbnail = summary.thumbnail }
  if (summary.liveNow === true) { fields.liveNow = true }

  if (summary.isUpcoming === true) {
    fields.isUpcoming = true

    const start = summary.premiereDate instanceof Date ? summary.premiereDate.getTime() : NaN
    if (Number.isFinite(start)) { fields.premiereDate = start }
  }

  if (summary.nsfw === true) { fields.nsfw = true }

  return fields
}

/**
 * What a PeerTube video whose details could not be had is kept as: gone when
 * the instance itself says it has no such video (a 404 whose body is
 * PeerTube's own not-found, `isPeerTubeNotFound`), private when it refuses to
 * show it and says why (private, internal, password protected, blocked), and
 * nothing for anything else, which is asked again on the next start: an HTML
 * 404 or a bare 403 is as likely a proxy, a firewall or a lapsed domain as
 * the instance, and a mark would hide a real video for a month.
 *
 * @param {import('../../platform/shapes').PeerTubeVideoRef} ref
 * @param {unknown} error
 * @param {number} at
 * @returns {VideoDetails | null}
 */
export function peerTubeFailureRecord(ref, error, at) {
  const kind = error instanceof PlatformError ? error.kind : null

  if (kind === 'notFound' && isPeerTubeNotFound(error.body)) { return unavailableRecord(ref, 'gone', at) }
  if (kind === 'refused' && error.reason != null) { return unavailableRecord(ref, 'private', at) }

  return null
}

/**
 * How far the crawl has got: of the YouTube videos the shares name, how many
 * are not to be asked about. Cheap, for a count shown as each answer comes in.
 *
 * @param {import('./shares').Share[]} shares
 * @param {Record<string, VideoDetails>} details by the video's ref as one string
 * @param {number} now
 * @returns {{ done: number, total: number }}
 */
export function detailsProgress(shares, details, now) {
  const seen = new Set()
  let done = 0

  for (const share of shares) {
    if (platformOf(share) !== PLATFORM_YOUTUBE || seen.has(share.videoId) || !isYouTubeVideoRef(share.videoId)) { continue }

    seen.add(share.videoId)

    if (!needsDetails(detailsFor(details, share.videoId), now)) { done++ }
  }

  return { done, total: seen.size }
}
