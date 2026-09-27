// What a PeerTube source given by URL is (the search source): the one rule
// the client applies before asking it anything, and the settings apply before
// saving one, so that the setting never holds a source the layer would
// refuse.

import { isNeverPeerTubeHost } from '../../../peerTubeHosts.js'
import { isHostname } from '../refs'

/**
 * A source as an https URL with a bare host name, no port, credentials,
 * query or fragment: its host and base URL (no trailing slash, and no
 * `/api/v1`, since a source given with its API path is the same source).
 * Otherwise the problem: `invalid` for anything that is not such a URL,
 * `neverPeerTube` (with the host) for YouTube's and Google's hosts.
 *
 * @param {unknown} value
 * @returns {{ host: string, base: string, problem: null } | { problem: 'invalid' } | { problem: 'neverPeerTube', host: string }}
 */
export function readSource(value) {
  if (typeof value !== 'string') {
    return { problem: 'invalid' }
  }

  let url
  try {
    url = new URL(value)
  } catch {
    return { problem: 'invalid' }
  }

  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !isHostname(url.hostname)
  ) {
    return { problem: 'invalid' }
  }

  if (isNeverPeerTubeHost(url.hostname)) {
    return { problem: 'neverPeerTube', host: url.hostname }
  }

  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '').replace(/\/+$/, '')

  return { host: url.hostname, base: `https://${url.hostname}${path}`, problem: null }
}

/**
 * The host and base URL of a source, or `null` for anything `readSource`
 * finds a problem with.
 *
 * @param {unknown} value
 * @returns {{ host: string, base: string } | null}
 */
export function parseSource(value) {
  const source = readSource(value)
  return source.problem === null ? { host: source.host, base: source.base } : null
}
