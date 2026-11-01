/**
 * Link recognition, shared by every source kind: a link a source shares,
 * turned into the ref of the video it is, or nothing.
 *
 * YouTube is recognised by the link alone, in every shape found in real
 * feeds: `watch?v=` on `www.`, `m.` and `music.youtube.com`, `youtu.be/`,
 * `/shorts/`, `/live/` and `/embed/` (on `youtube-nocookie.com` too)
 * (`videoRefFromLink`). Everything else is nothing: playlists, channels,
 * hosted clips (pictrs, catbox, imgchest, a bare `.mp4`), Vimeo, articles,
 * torrents.
 *
 * PeerTube's two shapes for a video, `/w/<id>` and `/videos/watch/<id>`, are
 * on any host, and other sites have paths like them, so a link of either
 * shape is only a candidate (`peerTubeCandidateFromLink`): the host to ask,
 * and the video's uuid. Whether the host is PeerTube, and where the video
 * comes from, only asking can tell; a source kind's `fetch` does that through
 * the platform layer (`peertubeLinks.js`), and the confirmed ref travels on
 * the kind's item (see `kinds/lemmy.js`, `lemmyShares`).
 *
 * Framework-free and pure.
 */

import { isNeverPeerTubeHost } from '../../../peerTubeHosts.js'

/** A YouTube video id: eleven characters of the URL-safe base64 alphabet */
const YOUTUBE_VIDEO_ID = /^[\w-]{11}$/

/** The hosts whose `/watch?v=` is a YouTube video */
const WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'])

/** The hosts whose `/embed/<id>` is a YouTube video */
const EMBED_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'])

/** The hosts whose `/shorts/<id>` and `/live/<id>` are a YouTube video */
const PATH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com'])

/** The domains whose every host is YouTube's */
const YOUTUBE_DOMAINS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com']

/**
 * Whether a host is one of YouTube's, any subdomain included: never a Lemmy
 * instance or any other source, whatever its paths look like.
 *
 * @param {string} host a URL's host name
 * @returns {boolean}
 */
export function isYouTubeHost(host) {
  const lower = host.toLowerCase()
  return YOUTUBE_DOMAINS.some(domain => lower === domain || lower.endsWith(`.${domain}`))
}

/**
 * @param {string | null | undefined} id
 * @returns {{ videoId: string } | null}
 */
function youTubeRef(id) {
  return typeof id === 'string' && YOUTUBE_VIDEO_ID.test(id) ? { videoId: id } : null
}

/**
 * A YouTube video's ref from a link to it, or nothing
 *
 * @param {URL} url
 * @returns {{ videoId: string } | null}
 */
function youTubeLink(url) {
  const host = url.hostname
  // The path's segments, without the empty ones a trailing or doubled slash leaves
  const path = url.pathname.split('/').filter(segment => segment !== '')

  if (host === 'youtu.be') {
    return path.length === 1 ? youTubeRef(path[0]) : null
  }

  if (WATCH_HOSTS.has(host) && path.length === 1 && path[0] === 'watch') {
    return youTubeRef(url.searchParams.get('v'))
  }

  if (path.length === 2) {
    const [kind, id] = path

    if (EMBED_HOSTS.has(host) && kind === 'embed') { return youTubeRef(id) }
    if (PATH_HOSTS.has(host) && (kind === 'shorts' || kind === 'live')) { return youTubeRef(id) }
  }

  return null
}

/**
 * The video a link is, as its ref, or nothing when it is not a link to a
 * video the app plays: only an absolute `http:` or `https:` link counts.
 *
 * @param {unknown} link
 * @returns {{ videoId: string } | null}
 */
export function videoRefFromLink(link) {
  if (typeof link !== 'string') { return null }

  let url
  try {
    url = new URL(link.trim())
  } catch {
    return null
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') { return null }

  return youTubeLink(url)
}

/** A uuid, any version, as a PeerTube URL may carry it */
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

/**
 * A uuid of one of RFC 9562's versions, 1 to 8, with its variant bits: what
 * PeerTube makes (version 4) and what it keeps for a video imported with a
 * uuid of its own
 */
const RFC_UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/

/**
 * The alphabet of PeerTube's short uuids: `short-uuid`'s default, Flickr's
 * base 58, which leaves out 0, O, I and l
 */
const BASE58 = '123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'

/**
 * A short uuid is a uuid's 128 bits in base 58: 22 characters, padded with
 * the alphabet's first; an older PeerTube may not have padded them
 */
const SHORT_UUID = /^[1-9A-HJ-NP-Za-km-z]{20,22}$/

const UUID_LIMIT = 1n << 128n

/**
 * The uuid a PeerTube short uuid stands for, worked out rather than asked:
 * the inverse of `short-uuid`'s `fromUUID`. Nothing for what is not one, and
 * for anything that does not decode to an RFC uuid (a version from 1 to 8,
 * the RFC's variant bits), so that a word or a page name of the right length
 * on another site's `/w/` path is seldom taken for a video: a random string
 * of the right length and alphabet passes about once in eight, and the host
 * is then asked whether it is PeerTube before anything is kept.
 *
 * @param {string} short
 * @returns {string | null} lower case
 */
export function uuidFromShortUuid(short) {
  if (typeof short !== 'string' || !SHORT_UUID.test(short)) { return null }

  let value = 0n
  for (const character of short) {
    value = value * 58n + BigInt(BASE58.indexOf(character))
  }

  if (value >= UUID_LIMIT) { return null }

  const hex = value.toString(16).padStart(32, '0')
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`

  return RFC_UUID.test(uuid) ? uuid : null
}

/**
 * A link that may be a PeerTube video: `/w/<id>` or `/videos/watch/<id>` on a
 * host that could be a PeerTube instance, the id a uuid or a short uuid. Its
 * host, lower case and without a port (a ref carries none), and the video's
 * uuid, lower case: a candidate, which only the host can confirm. Nothing for
 * any other link: a playlist (`/w/p/`), a channel, an embed, YouTube's and
 * Google's hosts, anything after the id.
 *
 * @param {unknown} link
 * @returns {{ host: string, videoId: string } | null}
 */
export function peerTubeCandidateFromLink(link) {
  if (typeof link !== 'string') { return null }

  let url
  try {
    url = new URL(link.trim())
  } catch {
    return null
  }

  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.port !== '') { return null }

  const host = url.hostname.toLowerCase()
  if (isNeverPeerTubeHost(host)) { return null }

  const path = url.pathname.split('/').filter(segment => segment !== '')

  let id
  if (path.length === 2 && path[0] === 'w') {
    id = path[1]
  } else if (path.length === 3 && path[0] === 'videos' && path[1] === 'watch') {
    id = path[2]
  } else {
    return null
  }

  const videoId = UUID.test(id) ? id.toLowerCase() : uuidFromShortUuid(id)

  return videoId === null ? null : { host, videoId }
}
