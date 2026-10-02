// How the YouTube backends' failures read as `PlatformError` kinds, one table
// per backend, shared by every YouTube operation (ADR-0015). The strings
// matched here are YouTube's, youtubei.js' and Invidious', and the tests pin
// them.
//
// - Local, a video's playability (`classifyLocalPlayability`): `getLocalVideoInfo`
//   does not throw for a video YouTube will not play; it answers a
//   `YT.VideoInfo` whose `playability_status` says why, read here as the old
//   watch view reads it.
// - Local, a thrown error (`classifyLocalError`): youtubei.js reports an HTTP
//   failure as `Request to {url} failed with status code {status}`; a network
//   failure is a `TypeError`.
// - Invidious (`classifyInvidiousError`): the module turns the instance's JSON
//   `error` into the thrown error's message and keeps no status, so the
//   message is all there is to read. A body that is not JSON (an instance's
//   own error page) throws a `SyntaxError`, a network failure a `TypeError`.
//
// Anything not recognised is `unavailable`: the backend did not answer sense.

import { classifyPlayabilityError, getPlayabilityExplanation } from '../../helpers/player/playability'
import { PlatformError } from '../errors'

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether the video's adaptive formats are DRM protected, which the player
 * cannot play.
 *
 * @param {any} info
 */
function isDrmProtected(info) {
  return info?.streaming_data?.adaptive_formats?.some(format => format.drm_families || format.drm_track_type) === true
}

/**
 * Why YouTube will not play a video to Local, or `null` when it will (or
 * describes one that is upcoming).
 *
 * | playability                                                         | kind, reason             |
 * | ------------------------------------------------------------------- | ------------------------ |
 * | `LOGIN_REQUIRED`, error screen reason `Private video`               | refused, `private`       |
 * | unplayable, error screen offer `sponsors_only_video`                | refused, `membersOnly`   |
 * | unplayable, `Sign in to confirm your age`, or a trailer in its place | refused, `ageRestricted` |
 * | DRM-protected adaptive formats                                      | refused, `drm`           |
 * | `Sign in to confirm you’re not a bot`, `Please sign in`             | refused, `ipBlock`       |
 * | `UNPLAYABLE`, `Video unavailable`, no further explanation           | refused, `unexplained`   |
 * | any other `UNPLAYABLE` or `LOGIN_REQUIRED`                          | refused, no reason       |
 * | `ERROR` (removed, or never existed)                                 | notFound                 |
 *
 * "Unplayable" is `UNPLAYABLE` or `LOGIN_REQUIRED`.
 *
 * @param {any} info a `YT.VideoInfo`, as `getLocalVideoInfo` answers it in `info`
 * @returns {PlatformError | null}
 */
export function classifyLocalPlayability(info) {
  const status = info?.playability_status
  const code = status?.status
  const drm = isDrmProtected(info)

  if (code === 'LOGIN_REQUIRED' && status?.error_screen?.reason?.text === 'Private video') {
    return new PlatformError('refused', 'This video is private', { reason: 'private' })
  }

  if (code === 'ERROR') {
    return new PlatformError('notFound', describeStatus(status))
  }

  if (code !== 'UNPLAYABLE' && code !== 'LOGIN_REQUIRED' && !drm) {
    return null
  }

  if (status?.error_screen?.offer_id === 'sponsors_only_video') {
    return new PlatformError('refused', describeStatus(status), { reason: 'membersOnly' })
  }

  if (status?.reason === 'Sign in to confirm your age' || (info.has_trailer && info.getTrailerInfo?.() === null)) {
    return new PlatformError('refused', describeStatus(status), { reason: 'ageRestricted' })
  }

  if (drm) {
    return new PlatformError('refused', 'This video is DRM protected', { reason: 'drm' })
  }

  const kind = classifyPlayabilityError(status)

  if (kind === 'ip-block') {
    return new PlatformError('refused', describeStatus(status), { reason: 'ipBlock' })
  }

  if (kind === 'unexplained-refusal') {
    return new PlatformError('refused', describeStatus(status), { reason: 'unexplained' })
  }

  return new PlatformError('refused', describeStatus(status))
}

/**
 * `[STATUS] reason: explanation`, as the old watch view words it.
 *
 * @param {any} status
 */
function describeStatus(status) {
  let text = `[${status?.status}] ${status?.reason ?? ''}`.trim()
  const explanation = status ? getPlayabilityExplanation(status) : undefined

  if (explanation && explanation !== status?.reason) {
    text += `: ${explanation}`
  }

  return text
}

const HTTP_STATUS_PATTERN = /failed with status code (\d{3})/

/**
 * A thrown Local error, by the HTTP status youtubei.js names in it.
 *
 * | error                         | kind        |
 * | ----------------------------- | ----------- |
 * | status code 404               | notFound    |
 * | status code 429               | rateLimited |
 * | status code 400               | invalid     |
 * | status code 401, 403          | refused     |
 * | anything else, network failed | unavailable |
 *
 * @param {unknown} error
 * @returns {PlatformError}
 */
export function classifyLocalError(error) {
  if (error instanceof PlatformError) {
    return error
  }

  const message = messageOf(error)
  const match = HTTP_STATUS_PATTERN.exec(message)
  const status = match ? Number(match[1]) : null
  const text = `YouTube (Local) failed: ${message}`

  switch (status) {
    case 404:
      return new PlatformError('notFound', text, { status, cause: error })
    case 429:
      return new PlatformError('rateLimited', text, { status, cause: error })
    case 400:
      return new PlatformError('invalid', text, { status, cause: error })
    case 401:
    case 403:
      return new PlatformError('refused', text, { status, cause: error })
    default:
      return new PlatformError('unavailable', text, { status, cause: error })
  }
}

/**
 * Invidious' error messages, in the order they are tried: the first that
 * matches decides. The age check comes before the bot check, since both ask
 * to sign in.
 *
 * @type {ReadonlyArray<[RegExp, import('../errors').PlatformErrorKind, import('../errors').RefusalReason | null]>}
 */
export const INVIDIOUS_ERRORS = Object.freeze([
  [/\bprivate\b/i, 'refused', 'private'],
  [/members[- ]only|join this channel/i, 'refused', 'membersOnly'],
  [/confirm your age|age[- ]restricted|inappropriate for some users/i, 'refused', 'ageRestricted'],
  [/\bDRM\b/, 'refused', 'drm'],
  [/not a bot|please sign in/i, 'refused', 'ipBlock'],
  [/too many requests|rate[- ]limit/i, 'rateLimited', null],
  [/does not exist|not found|unavailable|been removed|no longer available|terminated/i, 'notFound', null],
])

/**
 * A thrown Invidious error, by its message (see `INVIDIOUS_ERRORS`);
 * anything else, including a network failure or an answer that is not JSON,
 * is `unavailable`.
 *
 * @param {unknown} error
 * @returns {PlatformError}
 */
export function classifyInvidiousError(error) {
  if (error instanceof PlatformError) {
    return error
  }

  const message = messageOf(error)
  const text = `YouTube (Invidious) failed: ${message}`

  if (!(error instanceof TypeError) && !(error instanceof SyntaxError)) {
    for (const [pattern, kind, reason] of INVIDIOUS_ERRORS) {
      if (pattern.test(message)) {
        return new PlatformError(kind, text, { reason, cause: error })
      }
    }
  }

  return new PlatformError('unavailable', text, { cause: error })
}

/**
 * The classifier for a backend, for the policy (`./policy.js`).
 *
 * @param {unknown} error
 * @param {'local' | 'invidious'} backend
 * @returns {PlatformError}
 */
export function classifyYouTubeError(error, backend) {
  return backend === 'local' ? classifyLocalError(error) : classifyInvidiousError(error)
}
