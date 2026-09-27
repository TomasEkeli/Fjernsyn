/**
 * The User-Agent for requests to PeerTube instances.
 *
 * A renderer `fetch` cannot set `User-Agent` (Chromium drops the header
 * silently) and always sends the app's own origin as `Referer`. So the
 * platform layer's PeerTube fetch marks each request with
 * `X-Fjernsyn-PeerTube`, and main's `onBeforeSendHeaders` handler hands every
 * request to `apply`:
 *
 * - The marker is always removed before the request goes out.
 * - A marked request leaves with the prescribed agent and no Referer. Marked
 *   `probe` (the layer is still checking whether the host is PeerTube at all),
 *   that is all; marked `confirmed`, the host is remembered, and from then on
 *   every request to it (API, image and media alike, marked or not) is treated
 *   the same way. Hosts are remembered for the life of the process.
 * - A YouTube or Google host (`isNeverPeerTubeHost`) is never remembered and
 *   never altered, whatever the marker says, so that no YouTube request can
 *   come to carry the Fjernsyn agent.
 *
 * See `thoughts/2026-09-27-platform-layer-spike.md`.
 */

import { isNeverPeerTubeHost, PEERTUBE_MARKER_CONFIRMED, PEERTUBE_MARKER_HEADER } from '../peerTubeHosts'

const PROJECT_URL = 'https://github.com/TomasEkeli/Fjernsyn'

/**
 * @param {string} version the app's version, from package.json
 * @returns {string}
 */
export function peerTubeUserAgent(version) {
  return `Fjernsyn/${version} (+${PROJECT_URL})`
}

/**
 * @param {Record<string, string>} headers
 * @param {string} name
 * @returns {string[]} the keys naming that header, whatever their case
 */
function headerKeys(headers, name) {
  const lowerName = name.toLowerCase()
  return Object.keys(headers).filter(key => key.toLowerCase() === lowerName)
}

/**
 * @param {Record<string, string>} headers
 * @param {string} name
 */
function deleteHeader(headers, name) {
  for (const key of headerKeys(headers, name)) {
    delete headers[key]
  }
}

/**
 * @param {object} options
 * @param {string} options.userAgent the agent every request to a PeerTube host carries
 */
export function createPeerTubeRequestHeaders({ userAgent }) {
  /** @type {Set<string>} hosts (with port, lower case) seen on a request marked confirmed */
  const peerTubeHosts = new Set()

  return {
    /**
     * Rewrites the headers of a request to a PeerTube host in place.
     *
     * @param {string} url
     * @param {Record<string, string>} requestHeaders
     * @returns {boolean} whether the request was given the PeerTube agent
     */
    apply(url, requestHeaders) {
      const markerKeys = headerKeys(requestHeaders, PEERTUBE_MARKER_HEADER)
      const marker = markerKeys.length > 0 ? String(requestHeaders[markerKeys[0]]).trim().toLowerCase() : null
      deleteHeader(requestHeaders, PEERTUBE_MARKER_HEADER)

      let parsed

      try {
        parsed = new URL(url)
      } catch {
        return false
      }

      if (isNeverPeerTubeHost(parsed.hostname)) {
        return false
      }

      const host = parsed.host.toLowerCase()

      if (marker === PEERTUBE_MARKER_CONFIRMED) {
        peerTubeHosts.add(host)
      }

      if (marker === null && !peerTubeHosts.has(host)) {
        return false
      }

      deleteHeader(requestHeaders, 'User-Agent')
      deleteHeader(requestHeaders, 'Referer')
      requestHeaders['User-Agent'] = userAgent

      return true
    },
  }
}
