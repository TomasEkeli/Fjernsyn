/**
 * Hosts that are never a PeerTube instance, whatever a URL, a handle or an
 * instance's own JSON says.
 *
 * Both processes need the rule. The platform layer in the renderer refuses to
 * send a PeerTube request to these hosts, and main refuses to learn them as
 * PeerTube hosts when it sets the User-Agent for PeerTube requests (see
 * `src/main/peertubeRequests.js`). Without the second, one marked request to a
 * YouTube host would give every later YouTube request the Fjernsyn agent, which
 * sets them apart from a browser's.
 *
 * Kept free of imports so that main, the renderer and the tests can all load it.
 */

/** Registrable domains whose hosts, and every subdomain of them, are never PeerTube */
const NEVER_PEERTUBE_DOMAINS = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'googlevideo.com',
  'ytimg.com',
  'ggpht.com',
  'googleusercontent.com',
  'google.com',
  'googleapis.com',
  'gstatic.com',
]

/**
 * @param {string} host a bare hostname, as `URL#hostname` gives it
 * @returns {boolean} true when the host is YouTube's or Google's, or not a usable hostname at all
 */
export function isNeverPeerTubeHost(host) {
  if (typeof host !== 'string' || host === '') {
    return true
  }

  const hostname = host.toLowerCase().replace(/\.$/, '')

  if (hostname === 'localhost' || !hostname.includes('.')) {
    return true
  }

  return NEVER_PEERTUBE_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
}

/** The request header the layer marks PeerTube requests with; main removes it before they go out */
export const PEERTUBE_MARKER_HEADER = 'X-Fjernsyn-PeerTube'

/**
 * Marker values. `probe` marks a request to a host not yet confirmed as
 * PeerTube (its `/api/v1/config` check): main gives that one request the
 * User-Agent and remembers nothing. `confirmed` marks a request to a host the
 * layer has confirmed: main remembers it, so that its images and media get the
 * User-Agent too.
 */
export const PEERTUBE_MARKER_PROBE = 'probe'
export const PEERTUBE_MARKER_CONFIRMED = 'confirmed'
