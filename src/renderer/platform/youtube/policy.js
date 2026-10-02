// The YouTube backend policy: which backend answers, in one place for every
// YouTube operation on the layer (ADR-0015).
//
// - A first page goes to the preferred backend, Invidious alone where the
//   build has no Local API. When fallback is on and the build has both, a
//   failure of kind `notFound`, `unavailable` or `rateLimited` is tried once
//   on the other backend. `refused` and `invalid` are final: a refusal is
//   YouTube's own answer, which the other backend would only repeat, and
//   `invalid` is our own mistake. When both fail, the last failure is thrown.
// - A cursor names the backend that made it, and a later page goes there. A
//   failure there is thrown as it is: the policy never falls back mid-list and
//   never restarts one. A cursor naming no backend this build has rejects as
//   `invalid`, without a request.
//
// What an operation asks of a backend, and how that backend's errors read as
// `PlatformError` kinds, is the operation's: it hands the policy an attempt
// per backend and the classifier for it (`./errors.js`).

import { PlatformError } from '../errors'

/** @typedef {'local' | 'invidious'} YouTubeBackend */

/** The kinds a first page is tried again for on the other backend */
export const FALLBACK_KINDS = Object.freeze(new Set(['notFound', 'unavailable', 'rateLimited']))

/**
 * @callback Classify
 * @param {unknown} error what the backend's module function threw
 * @param {YouTubeBackend} backend
 * @returns {PlatformError}
 */

/**
 * @param {object} deps
 * @param {{ backendPreference: string, backendFallback: boolean, supportsLocalApi?: boolean }} deps.config
 */
export function createBackendPolicy({ config }) {
  const localSupported = config.supportsLocalApi !== false

  /**
   * The backends a first page is asked of, in order.
   *
   * @returns {YouTubeBackend[]}
   */
  function backendOrder() {
    if (!localSupported) {
      return ['invidious']
    }

    const preferred = config.backendPreference === 'invidious' ? 'invidious' : 'local'
    const other = preferred === 'local' ? 'invidious' : 'local'

    return config.backendFallback ? [preferred, other] : [preferred]
  }

  /**
   * @param {unknown} backend
   * @returns {backend is YouTubeBackend}
   */
  function isAvailable(backend) {
    return backend === 'invidious' || (backend === 'local' && localSupported)
  }

  /**
   * @param {unknown} error
   * @param {YouTubeBackend} backend
   * @param {Classify} classify
   * @returns {PlatformError}
   */
  function classified(error, backend, classify) {
    return error instanceof PlatformError ? error : classify(error, backend)
  }

  /**
   * A first page, or anything that is not paged: the preferred backend,
   * then the other once for a failure that may be the backend's own.
   *
   * @template T
   * @param {(backend: YouTubeBackend) => Promise<T>} attempt
   * @param {Classify} classify
   * @returns {Promise<T>}
   */
  async function first(attempt, classify) {
    const order = backendOrder()
    let lastError = null

    for (const [index, backend] of order.entries()) {
      try {
        return await attempt(backend)
      } catch (error) {
        lastError = classified(error, backend, classify)

        if (!FALLBACK_KINDS.has(lastError.kind) || index === order.length - 1) {
          throw lastError
        }
      }
    }

    // Unreachable: the order is never empty
    throw lastError
  }

  /**
   * A later page, from the backend its cursor names.
   *
   * @template T
   * @param {unknown} cursor
   * @param {(backend: YouTubeBackend, cursor: any) => Promise<T>} attempt
   * @param {Classify} classify
   * @returns {Promise<T>}
   */
  async function later(cursor, attempt, classify) {
    const backend = /** @type {any} */ (cursor)?.backend

    if (!isAvailable(backend)) {
      throw new PlatformError('invalid', 'Not a YouTube cursor this build can continue')
    }

    try {
      return await attempt(backend, cursor)
    } catch (error) {
      throw classified(error, backend, classify)
    }
  }

  return Object.freeze({ backendOrder, first, later })
}
