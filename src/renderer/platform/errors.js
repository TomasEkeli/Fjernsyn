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
 * @typedef {'private' | 'internal' | 'password' | 'blocked'} RefusalReason
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
   * @param {unknown} [details.cause]
   */
  constructor(kind, message, { status = null, retryAfterMs = null, reason = null, host = null, cause } = {}) {
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
  }
}
