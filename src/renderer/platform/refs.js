// Platforms and refs: the identity of a video or channel across platforms.
// See "Platforms" in docs/CONTEXT.md.
//
// - A YouTube video ref is its `videoId`; a YouTube channel ref its `UC` id.
// - A PeerTube video ref is its uuid on its origin host, shaped as the minimal
//   stored record (`{ platform, host, videoId }`), so a ref can be handed to
//   anything that reads a record, `describe` included.
// - A PeerTube channel ref is its `name@host` handle, a string.
//
// Numeric PeerTube ids and short uuids are never refs.

export const PLATFORM_YOUTUBE = 'youtube'
export const PLATFORM_PEERTUBE = 'peertube'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// One label: letters, digits and inner hyphens, at most 63 characters
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
// At least two labels, lower case, no port, no trailing dot
const HOSTNAME_PATTERN = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`)

// PeerTube's actor name alphabet, as its server validates every actor's
// preferred username, local or federated (`actorNameAlphabet` in
// server/core/helpers/custom-validators/activitypub/actor.ts: ASCII letters,
// digits, `-`, `_`, `.` and `:`)
const ACTOR_NAME_PATTERN = /^[a-zA-Z0-9_.:-]+$/

/**
 * The platform a record belongs to. A record without `platform` is YouTube:
 * every record written before PeerTube existed has none.
 *
 * @param {{ platform?: string } | null | undefined} record
 * @returns {'youtube' | 'peertube'}
 */
export function platformOf(record) {
  return record?.platform === PLATFORM_PEERTUBE ? PLATFORM_PEERTUBE : PLATFORM_YOUTUBE
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

/**
 * Whether a value is a bare host name as refs carry them: lower case, at
 * least one dot, no scheme, port or path.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isHostname(value) {
  return typeof value === 'string' && HOSTNAME_PATTERN.test(value)
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isActorName(value) {
  return typeof value === 'string' && ACTOR_NAME_PATTERN.test(value)
}

/**
 * @param {string} host
 * @param {string} uuid a full uuid; never a numeric id or a short uuid
 * @returns {import('./shapes').PeerTubeVideoRef | null}
 */
export function peerTubeVideoRef(host, uuid) {
  const normalisedHost = typeof host === 'string' ? host.toLowerCase() : host

  if (!isHostname(normalisedHost) || !isUuid(uuid)) {
    return null
  }

  return { platform: PLATFORM_PEERTUBE, host: normalisedHost, videoId: uuid.toLowerCase() }
}

/**
 * Whether a value is a PeerTube video ref, or a record or details carrying
 * one (`platform`, `host`, `videoId`).
 *
 * @param {unknown} ref
 * @returns {ref is import('./shapes').PeerTubeVideoRef}
 */
export function isPeerTubeVideoRef(ref) {
  return typeof ref === 'object' &&
    ref !== null &&
    ref.platform === PLATFORM_PEERTUBE &&
    isHostname(ref.host) &&
    isUuid(ref.videoId)
}

/**
 * Parses a PeerTube channel handle, `name@host` or `@name@host`.
 *
 * @param {unknown} value
 * @returns {{ name: string, host: string } | null}
 */
export function parseChannelHandle(value) {
  if (typeof value !== 'string') {
    return null
  }

  const handle = value.trim().replace(/^@/, '')
  const at = handle.indexOf('@')

  if (at <= 0 || handle.indexOf('@', at + 1) !== -1) {
    return null
  }

  const name = handle.slice(0, at)
  const host = handle.slice(at + 1).toLowerCase()

  if (!isActorName(name) || !isHostname(host)) {
    return null
  }

  return { name, host }
}

/**
 * The handle that is a PeerTube channel's ref.
 *
 * @param {string} name
 * @param {string} host
 * @returns {string | null}
 */
export function peerTubeChannelRef(name, host) {
  const normalisedHost = typeof host === 'string' ? host.toLowerCase() : host

  if (!isActorName(name) || !isHostname(normalisedHost)) {
    return null
  }

  return `${name}@${normalisedHost}`
}
