// What the PeerTube search source setting accepts: the rule the layer's
// PeerTube client applies to a source (`readSource` in
// platform/peertube/source.js, the one rule both use), so that the setting
// never holds a source the layer would refuse.

import { readSource } from '../../platform/peertube/source'

export const DEFAULT_SEARCH_SOURCE = 'https://sepiasearch.org'

/**
 * The source as it is saved, or what is wrong with it.
 *
 * @param {unknown} value what was typed
 * @returns {{ source: string, problem: null } | { source: null, problem: 'invalid' | 'neverPeerTube', host?: string }}
 */
export function checkSearchSource(value) {
  const read = readSource(typeof value === 'string' ? value.trim() : value)

  if (read.problem !== null) {
    return { source: null, ...read }
  }

  return { source: read.base, problem: null }
}

/**
 * The source as it is saved: the client's base URL for it (lower-case host,
 * no trailing slash or `/api/v1`); `null` for anything the client would
 * refuse, a host that is never PeerTube included.
 *
 * @param {unknown} value what was typed
 * @returns {string | null}
 */
export function normaliseSearchSource(value) {
  return checkSearchSource(value).source
}
