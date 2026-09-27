/**
 * The PeerTube watch URL a renderer may hand the external player
 * (`videoUrl` in the external player payload, see `./externalPlayer.js`).
 *
 * A YouTube video is named by its id, and main builds the URL itself. A
 * PeerTube video is on whichever instance hosts it, so the renderer sends the
 * whole URL, and main takes nothing from it but what a PeerTube watch URL can
 * be: `https:`, a named host that is not YouTube's or Google's
 * (`isNeverPeerTubeHost`) and not an address, no credentials, no port, and a
 * watch path (`/videos/watch/{uuid}` or `/w/{uuid or short uuid}`). The URL
 * handed on is rebuilt from those parts alone, so no query or fragment rides
 * along.
 */

import { isNeverPeerTubeHost } from '../peerTubeHosts'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
// A short uuid: a uuid in base 58 (PeerTube's `short-uuid`, the Flickr alphabet)
const SHORT_UUID = '[1-9A-HJ-NP-Za-km-z]{16,24}'

const WATCH_PATH = new RegExp(`^/(?:videos/watch/${UUID}|w/(?:${UUID}|${SHORT_UUID}))$`, 'i')

// A top-level label has a letter in it; an IPv4 address's last part does not
const NAMED_HOST = /^(?:[a-z0-9-]+\.)+[a-z0-9-]*[a-z][a-z0-9-]*$/

/**
 * @param {unknown} value the payload's `videoUrl`
 * @returns {string | null} the URL to hand the player, or `null` when it is not a PeerTube watch URL
 */
export function peerTubeWatchUrl(value) {
  if (typeof value !== 'string') {
    return null
  }

  const url = URL.parse(value)

  if (
    url === null ||
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    !NAMED_HOST.test(url.hostname) ||
    isNeverPeerTubeHost(url.hostname) ||
    !WATCH_PATH.test(url.pathname)
  ) {
    return null
  }

  return `https://${url.hostname}${url.pathname}`
}
