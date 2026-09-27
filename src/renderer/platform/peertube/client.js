// The HTTP client under the PeerTube adapter. Every request the adapter makes
// to an instance goes through here, so the rules that hold for all of them
// hold in one place:
//
// - Every request is `https://{host}/api/v1/...`, carrying the marker header
//   `X-Fjernsyn-PeerTube`. A renderer fetch cannot set a User-Agent, so the
//   main process recognises the marker, removes it and sets the prescribed
//   User-Agent instead (design.md, amendment of 2026-09-27). The marker is
//   `probe` until the host's config has answered as PeerTube, and `confirmed`
//   after: main only remembers a host (for its images and media) on
//   `confirmed`.
// - No request ever goes to a host `isNeverPeerTubeHost` names (YouTube's and
//   Google's), whatever a URL or handle said.
// - `count` is always an integer from 1 to 100, PeerTube's maximum page size.
// - An instance's config is fetched once per host per session, and its
//   `serverVersion` is what features are detected by. Only the fields listed in
//   `readConfig` are kept: the instance's own JavaScript and CSS
//   (`instance.customizations`) are never read.
// - Whether a host is PeerTube at all (`isPeerTube`) is remembered once
//   definitely answered.
// - A 429 is honoured per host: until its `Retry-After` has passed, requests to
//   that host fail as rate limited without touching the network.
// - Failures are `PlatformError`s with a kind (see `../errors.js`).
//
// All of that per-host state lives in the client, so the wiring builds one
// client for the session and hands it to every rebuild of the layer.

import {
  PEERTUBE_MARKER_CONFIRMED,
  PEERTUBE_MARKER_HEADER,
  PEERTUBE_MARKER_PROBE,
  isNeverPeerTubeHost,
} from '../../../peerTubeHosts.js'
import { PlatformError } from '../errors'
import { isHostname } from '../refs'

export const MAX_COUNT = 100

// Sent in place of a `count` that is not a finite number of at least one
export const DEFAULT_COUNT = 20

// Used when a 429 carries no usable Retry-After: PeerTube's API limiter window
// is 10 seconds by default
const DEFAULT_RETRY_AFTER_MS = 10_000

/**
 * The first server version with each feature the adapter detects.
 */
export const FEATURES = Object.freeze({
  // `/api/v1/videos/{id}/chapters`
  chapters: '6.0.0',
  // `/api/v1/videos/{id}/storyboards`
  storyboards: '6.0.0',
  // `/download/videos/generate/{uuid}`, muxing a split-audio download
  generatedDownloads: '6.3.0',
  // captions carry an absolute `fileUrl` next to `captionPath`
  captionFileUrl: '7.1.0',
  // `/api/v1/videos/{id}/comments/{commentId}/replies`
  commentReplies: '8.3.0',
})

/** @typedef {keyof typeof FEATURES} Feature */

// PeerTube's error `code`s that say why a video is refused. Anonymous refusals
// of private, internal and blocked videos carry no code, so they have no reason.
/** @type {Record<string, import('../errors').RefusalReason>} */
const REFUSAL_CODES = {
  video_requires_password: 'password',
  incorrect_video_password: 'password',
}

/**
 * @param {unknown} version
 * @returns {number[] | null}
 */
function parseVersion(version) {
  if (typeof version !== 'string') {
    return null
  }

  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim())

  if (!match) {
    return null
  }

  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

/**
 * Whether a server version is at least a minimum, comparing major, minor and
 * patch by number and ignoring anything after them (`7.1.0-rc.1` is 7.1.0).
 *
 * @param {string | null | undefined} version
 * @param {string} minimum
 * @returns {boolean}
 */
export function versionAtLeast(version, minimum) {
  const have = parseVersion(version)
  const need = parseVersion(minimum)

  if (!have || !need) {
    return false
  }

  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) {
      return have[i] > need[i]
    }
  }

  return true
}

/**
 * @typedef {object} InstanceConfig
 * @property {string} host
 * @property {string} serverVersion
 * @property {string | null} instanceName
 */

/**
 * Keeps only what the adapter uses from `/api/v1/config`. Add fields here by
 * name; never copy the body wholesale, since it carries the instance's own
 * JavaScript and CSS.
 *
 * @param {string} host
 * @param {any} body
 * @returns {InstanceConfig | null}
 */
function readConfig(host, body) {
  if (typeof body?.serverVersion !== 'string') {
    return null
  }

  return Object.freeze({
    host,
    serverVersion: body.serverVersion,
    instanceName: typeof body.instance?.name === 'string' ? body.instance.name : null,
  })
}

/**
 * @param {string | null} value
 * @param {number} now
 * @returns {number}
 */
function parseRetryAfter(value, now) {
  if (value == null) {
    return DEFAULT_RETRY_AFTER_MS
  }

  const trimmed = value.trim()

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000
  }

  const date = Date.parse(trimmed)

  if (Number.isNaN(date)) {
    return DEFAULT_RETRY_AFTER_MS
  }

  return Math.max(0, date - now)
}

/**
 * @param {string} text
 * @returns {any}
 */
function tryParseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * An integer from 1 to `MAX_COUNT`. Anything that is not a finite number of
 * at least one (NaN, zero, negative, Infinity, a word) is `DEFAULT_COUNT`.
 *
 * @param {unknown} value
 * @returns {number}
 */
function clampCount(value) {
  const count = Math.floor(Number(value))

  if (!Number.isFinite(count) || count < 1) {
    return DEFAULT_COUNT
  }

  return Math.min(count, MAX_COUNT)
}

/**
 * Whether a failure to read a host's config says the host is not PeerTube,
 * rather than that it could not be asked right now. A refusal (401, 403), a
 * rate limit and a server error are "could not ask"; any other HTTP answer,
 * including a 200 that is not a PeerTube config, is "no".
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isDefiniteNo(error) {
  return error instanceof PlatformError &&
    error.status != null &&
    ![401, 403, 429].includes(error.status) &&
    error.status < 500
}

/**
 * @param {Record<string, unknown>} [query]
 * @returns {string}
 */
function buildQuery(query = {}) {
  const params = new URLSearchParams()

  for (const [name, value] of Object.entries(query)) {
    if (value == null) {
      continue
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(name, String(item))
      }
    } else if (name === 'count') {
      params.append(name, String(clampCount(value)))
    } else {
      params.append(name, String(value))
    }
  }

  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

/**
 * @param {object} deps
 * @param {typeof fetch} deps.fetch
 * @param {() => number} [deps.now] the clock, in ms since the epoch
 */
export function createPeerTubeClient({ fetch, now = Date.now }) {
  /** @type {Map<string, number>} host to the time its rate limit ends */
  const blockedUntil = new Map()

  /** @type {Map<string, Promise<InstanceConfig>>} */
  const configs = new Map()

  /** @type {Set<string>} hosts whose config has answered as PeerTube */
  const confirmed = new Set()

  /** @type {Map<string, boolean>} definite answers to `isPeerTube` only */
  const peerTubeAnswers = new Map()

  /**
   * GETs `https://{host}/api/v1{path}` and returns the parsed JSON body.
   *
   * @param {string} host a bare host name
   * @param {string} path below `/api/v1`, starting with `/`
   * @param {Record<string, unknown>} [query] `null` and `undefined` are left out, arrays repeated
   * @returns {Promise<any>}
   */
  async function get(host, path, query) {
    if (!isHostname(host) || isNeverPeerTubeHost(host) || typeof path !== 'string' || !path.startsWith('/')) {
      throw new PlatformError('invalid', `Not a PeerTube request: ${host} ${path}`, { host })
    }

    const until = blockedUntil.get(host)

    if (until !== undefined) {
      const remaining = until - now()

      if (remaining > 0) {
        throw new PlatformError('rateLimited', `${host} is rate limiting requests`, { retryAfterMs: remaining, host })
      }

      blockedUntil.delete(host)
    }

    const url = `https://${host}/api/v1${path}${buildQuery(query)}`

    let response
    let text
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          [PEERTUBE_MARKER_HEADER]: confirmed.has(host) ? PEERTUBE_MARKER_CONFIRMED : PEERTUBE_MARKER_PROBE,
        },
      })
      text = await response.text()
    } catch (cause) {
      throw new PlatformError('unavailable', `${host} could not be reached`, { status: response?.status ?? null, host, cause })
    }

    const { status } = response

    if (status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now())
      blockedUntil.set(host, now() + retryAfterMs)
      throw new PlatformError('rateLimited', `${host} is rate limiting requests`, { status, retryAfterMs, host })
    }

    const body = tryParseJson(text)

    if (!response.ok) {
      throw errorForStatus(host, status, body)
    }

    if (body === undefined) {
      throw new PlatformError('unavailable', `${host} answered with something other than JSON`, { status, host })
    }

    return body
  }

  /**
   * The instance's config, once per host per session. A failure is not
   * remembered, so the next call asks again.
   *
   * @param {string} host
   * @returns {Promise<InstanceConfig>}
   */
  function getConfig(host) {
    let pending = configs.get(host)

    if (!pending) {
      pending = get(host, '/config').then((body) => {
        const config = readConfig(host, body)

        if (!config) {
          throw new PlatformError('unavailable', `${host} did not answer as a PeerTube instance`, { status: 200, host })
        }

        confirmed.add(host)
        return config
      })

      configs.set(host, pending)
      pending.catch(() => configs.delete(host))
    }

    return pending
  }

  /**
   * Whether a host is a PeerTube instance, by its config. A definite answer,
   * yes or no, is remembered for the session; when the host could not be
   * asked (unreachable, refusing, rate limiting, failing) this rejects with
   * the `PlatformError` and remembers nothing. YouTube's and Google's hosts
   * are never PeerTube, without a request.
   *
   * @param {string} host
   * @returns {Promise<boolean>}
   */
  async function isPeerTube(host) {
    if (!isHostname(host) || isNeverPeerTubeHost(host)) {
      return false
    }

    const known = peerTubeAnswers.get(host)

    if (known !== undefined) {
      return known
    }

    try {
      await getConfig(host)
      peerTubeAnswers.set(host, true)
      return true
    } catch (error) {
      if (isDefiniteNo(error)) {
        peerTubeAnswers.set(host, false)
        return false
      }

      throw error
    }
  }

  /**
   * Whether the instance's server version has a feature.
   *
   * @param {string} host
   * @param {Feature} feature
   * @returns {Promise<boolean>}
   */
  async function supports(host, feature) {
    if (!Object.hasOwn(FEATURES, feature)) {
      throw new Error(`Unknown PeerTube feature: ${feature}`)
    }

    const { serverVersion } = await getConfig(host)
    return versionAtLeast(serverVersion, FEATURES[feature])
  }

  return Object.freeze({ get, getConfig, isPeerTube, supports })
}

/**
 * @param {string} host
 * @param {number} status
 * @param {any} body
 * @returns {PlatformError}
 */
function errorForStatus(host, status, body) {
  const detail = typeof body?.detail === 'string' ? body.detail : `HTTP ${status}`
  const message = `${host}: ${detail}`

  if (status === 401 || status === 403) {
    const reason = REFUSAL_CODES[body?.code] ?? null
    return new PlatformError('refused', message, { status, reason, host })
  }

  if (status === 404 || status === 410) {
    return new PlatformError('notFound', message, { status, host })
  }

  if (status >= 400 && status < 500) {
    return new PlatformError('invalid', message, { status, host })
  }

  return new PlatformError('unavailable', message, { status, host })
}
