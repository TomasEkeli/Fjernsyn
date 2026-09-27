// Recognising PeerTube URLs and handles, and resolving them to refs.
//
// Recognition is by path alone (`parsePeerTubeInput`, pure): any host can be a
// PeerTube instance. A path that is not PeerTube-shaped is never sent
// anywhere, so an Invidious `/watch?v=` or any other site's URL costs no
// request. A PeerTube-shaped URL is only answered with a ref once its host has
// been confirmed as PeerTube through `/api/v1/config` (`createUrlResolver`,
// through the client's `isPeerTube`, which keeps the answer, yes or no, for
// the session).
//
// Recognised:
//   /w/{uuid or short uuid}, /videos/watch/{id}, /videos/embed/{id}      video
//   /c/{name}[/...], /video-channels/{name}[/...]                          channel
//   /w/p/{id}, /videos/watch/playlist/{id}                                 playlist
//   name@host, @name@host                                                  channel
// A channel path may carry a remote handle (`/c/name@origin`), which is taken
// to its origin.
//
// Never recognised, whatever the path: YouTube's and Google's hosts
// (`isNeverPeerTubeHost`), and the hosts the caller excludes (the current
// Invidious instance, whose `/c/{name}` is a YouTube channel).

import { isNeverPeerTubeHost } from '../../../peerTubeHosts.js'
import { PlatformError } from '../errors'
import { PLATFORM_PEERTUBE, isHostname, isUuid, parseChannelHandle, peerTubeChannelRef, peerTubeVideoRef } from '../refs'

// A uuid, a short uuid (base 58) or a numeric id
const VIDEO_ID = '[A-Za-z0-9-]+'
const PLAYLIST_ID = '[A-Za-z0-9-]+'

const PATTERNS = [
  { kind: 'playlist', pattern: new RegExp(`^/w/p/(${PLAYLIST_ID})$`) },
  { kind: 'playlist', pattern: new RegExp(`^/videos/watch/playlist/(${PLAYLIST_ID})$`) },
  { kind: 'video', pattern: new RegExp(`^/w/(${VIDEO_ID})$`) },
  { kind: 'video', pattern: new RegExp(`^/videos/(?:watch|embed)/(${VIDEO_ID})$`) },
  { kind: 'channel', pattern: /^\/(?:c|video-channels)\/([^/]+)(?:\/.*)?$/ },
]

/**
 * @typedef {object} VideoCandidate
 * @property {'video'} kind
 * @property {string} host
 * @property {string} id a uuid, a short uuid or a numeric id, not yet a ref
 * @property {number | null} timestamp from `?start=`, in seconds
 */

/**
 * @typedef {object} ChannelCandidate
 * @property {'channel'} kind
 * @property {string} host the channel's origin
 * @property {string} name
 */

/**
 * @typedef {object} PlaylistCandidate
 * @property {'playlist'} kind
 * @property {string} host
 * @property {string} id
 */

/** @typedef {VideoCandidate | ChannelCandidate | PlaylistCandidate} Candidate */

/**
 * PeerTube's `start` parameter: seconds, or `1h2m3s` and its parts.
 *
 * @param {string | null} value
 * @returns {number | null}
 */
function parseStart(value) {
  if (value == null) {
    return null
  }

  if (/^\d+$/.test(value)) {
    return Number(value)
  }

  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value)

  if (!match || value === '') {
    return null
  }

  const [, hours = 0, minutes = 0, seconds = 0] = match
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
}

/**
 * @param {string} value
 * @returns {string | null}
 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/**
 * Recognises a PeerTube-shaped URL or handle, without any request.
 *
 * @param {string} input trimmed
 * @param {object} [options]
 * @param {Iterable<string>} [options.excludedHosts] lower-case host names never taken for PeerTube
 * @returns {Candidate | null}
 */
export function parsePeerTubeInput(input, { excludedHosts = [] } = {}) {
  const excluded = new Set(excludedHosts)
  const candidate = recognise(input)

  if (!candidate || isNeverPeerTubeHost(candidate.host) || excluded.has(candidate.host)) {
    return null
  }

  if (candidate.urlHost !== undefined && (isNeverPeerTubeHost(candidate.urlHost) || excluded.has(candidate.urlHost))) {
    return null
  }

  const result = { ...candidate }
  delete result.urlHost
  return result
}

/**
 * @param {string} input
 * @returns {(Candidate & { urlHost?: string }) | null}
 */
function recognise(input) {
  const handle = parseChannelHandle(input)

  if (handle) {
    return { kind: 'channel', host: handle.host, name: handle.name }
  }

  let url
  try {
    url = new URL(input)
  } catch {
    return null
  }

  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.port !== '' || !isHostname(url.hostname)) {
    return null
  }

  const host = url.hostname
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname

  for (const { kind, pattern } of PATTERNS) {
    const match = pattern.exec(path)

    if (!match) {
      continue
    }

    if (kind === 'video') {
      return { kind, host, urlHost: host, id: match[1], timestamp: parseStart(url.searchParams.get('start')) }
    }

    if (kind === 'playlist') {
      return { kind, host, urlHost: host, id: match[1] }
    }

    const name = safeDecode(match[1])

    if (name === null) {
      return null
    }

    // A remote channel as another instance shows it: `/c/name@origin`
    if (name.includes('@')) {
      const remote = parseChannelHandle(name)
      return remote ? { kind, host: remote.host, urlHost: host, name: remote.name } : null
    }

    return peerTubeChannelRef(name, host) ? { kind, host, urlHost: host, name } : null
  }

  return null
}

/**
 * @typedef {object} PeerTubeVideoResolution
 * @property {'peertube'} platform
 * @property {'video'} kind
 * @property {import('../shapes').PeerTubeVideoRef} ref
 * @property {string} host
 * @property {number | null} timestamp seconds to start at, from the URL
 */

/**
 * @typedef {object} PeerTubeChannelResolution
 * @property {'peertube'} platform
 * @property {'channel'} kind
 * @property {string} ref the `name@host` handle
 * @property {string} host
 * @property {string} name
 */

/**
 * @typedef {object} PeerTubePlaylistResolution
 * @property {'peertube'} platform
 * @property {'playlist'} kind
 * @property {import('../shapes').PeerTubePlaylistRef} ref
 * @property {string} host
 * @property {string} id as the URL carries it (a short uuid is not resolved)
 */

/** @typedef {PeerTubeVideoResolution | PeerTubeChannelResolution | PeerTubePlaylistResolution} PeerTubeResolution */

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('./client').createPeerTubeClient>} deps.client
 */
export function createUrlResolver({ client }) {
  /**
   * @param {string} host
   * @param {string} id
   * @returns {Promise<string>}
   */
  async function fullUuid(host, id) {
    if (isUuid(id)) {
      return id
    }

    const body = await client.get(host, `/videos/${encodeURIComponent(id)}`)

    if (!isUuid(body?.uuid)) {
      throw new PlatformError('unavailable', `${host} answered for video ${id} without a uuid`, { status: 200, host })
    }

    return body.uuid
  }

  /**
   * Resolves what `parsePeerTubeInput` recognised. Holds no state of its own:
   * what is known of each host is the client's. `null` when the host is
   * not PeerTube; a `PlatformError` when the host could not be asked, or is
   * PeerTube but the video could not be resolved.
   *
   * @param {Candidate} candidate
   * @returns {Promise<PeerTubeResolution | null>}
   */
  async function resolve(candidate) {
    const { host } = candidate

    if (!await client.isPeerTube(host)) {
      return null
    }

    switch (candidate.kind) {
      case 'video': {
        const uuid = await fullUuid(host, candidate.id)
        return {
          platform: PLATFORM_PEERTUBE,
          kind: 'video',
          ref: peerTubeVideoRef(host, uuid),
          host,
          timestamp: candidate.timestamp,
        }
      }
      case 'channel':
        return {
          platform: PLATFORM_PEERTUBE,
          kind: 'channel',
          ref: peerTubeChannelRef(candidate.name, host),
          host,
          name: candidate.name,
        }
      case 'playlist':
        return {
          platform: PLATFORM_PEERTUBE,
          kind: 'playlist',
          ref: { platform: PLATFORM_PEERTUBE, host, playlistId: candidate.id },
          host,
          id: candidate.id,
        }
    }

    return null
  }

  return Object.freeze({ resolve })
}
