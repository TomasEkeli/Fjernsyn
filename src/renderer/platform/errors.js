/**
 * What went wrong, as the platform layer tells it:
 *
 * - `refused`: the platform will not show it to an anonymous viewer (private,
 *   internal, password protected, blocked)
 * - `notFound`: it does not exist there
 * - `rateLimited`: asked too often; `retryAfterMs` says for how long to wait
 * - `unavailable`: the platform could not be reached or did not answer sense
 *   (network failure, 5xx, a response that does not parse)
 * - `invalid`: the request itself was wrong (400)
 *
 * @typedef {'refused' | 'notFound' | 'rateLimited' | 'unavailable' | 'invalid'} PlatformErrorKind
 */

/**
 * Why a platform refused, where it says.
 *
 * - PeerTube: `private`, `internal`, `password`, `blocked`
 * - YouTube: `private`, `membersOnly`, `ageRestricted`, `drm`, `ipBlock`
 *   (YouTube's bot check, which it shows to an address it distrusts) and
 *   `unexplained` (unplayable, with no reason given); see
 *   `./youtube/errors.js`
 *
 * @typedef {'private' | 'internal' | 'password' | 'blocked' | 'membersOnly' | 'ageRestricted' | 'drm' | 'ipBlock' | 'unexplained'} RefusalReason
 */

const KINDS = new Set(['refused', 'notFound', 'rateLimited', 'unavailable', 'invalid'])

export class PlatformError extends Error {
  /**
   * @param {PlatformErrorKind} kind
   * @param {string} message
   * @param {object} [details]
   * @param {number | null} [details.status] the HTTP status, where there was one
   * @param {number | null} [details.retryAfterMs] how long to wait, for `rateLimited`
   * @param {RefusalReason | null} [details.reason] why, for `refused`, where the platform says
   * @param {string | null} [details.host] the instance asked
   * @param {unknown} [details.body] the answer's parsed JSON body, for an
   *   HTTP error answer; `undefined` when it had none that parsed
   * @param {unknown} [details.cause]
   * @param {import('./shapes').ChannelSummary} [details.channel] for a refused
   *   channel, what the platform shows of it all the same (YouTube's age
   *   gate: the name and avatar)
   */
  constructor(kind, message, { status = null, retryAfterMs = null, reason = null, host = null, body, cause, channel } = {}) {
    if (!KINDS.has(kind)) {
      throw new TypeError(`Unknown platform error kind: ${kind}`)
    }

    super(message, cause === undefined ? undefined : { cause })

    this.name = 'PlatformError'
    /** @type {PlatformErrorKind} */
    this.kind = kind
    /** @type {number | null} */
    this.status = status
    /** @type {number | null} */
    this.retryAfterMs = retryAfterMs
    /** @type {RefusalReason | null} */
    this.reason = reason
    /** @type {string | null} */
    this.host = host

    if (body !== undefined) {
      /** @type {unknown} */
      this.body = body
    }

    if (channel !== undefined) {
      /** @type {import('./shapes').ChannelSummary} */
      this.channel = channel
    }
  }
}
