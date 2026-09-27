/**
 * The PeerTube entry points in upstream's views: the search bar
 * (`TopNav.vue` `goToSearch`) and the `fjernsyn://` deep link handler
 * (`App.vue` `enableOpenUrl`). Each calls this once, before its existing
 * YouTube parser, and carries on exactly as before when it answers `null`.
 *
 * Wiring, like `vue.js`: it reads the settings through the store (by
 * `isPeerTubeEnabled`), and shows toasts and navigates through the app's
 * helpers. The decision itself is the layer's `resolveUrl`: this only turns
 * its answer into a route.
 *
 * What it takes, while PeerTube is on:
 *
 * - a PeerTube video URL: the watch page, with `?start=` as the `timestamp`
 *   query, as a YouTube URL's `t=` becomes one;
 * - a PeerTube channel URL, or a `name@host` or `@name@host` handle: the
 *   channel page;
 * - a PeerTube-shaped URL or `@name@host` whose host could not be asked
 *   (unreachable, or rate limiting): nothing is opened, a toast says which
 *   host, and the caller stops, so a URL is not then searched for on YouTube.
 *
 * What it leaves to the caller (`null`): anything while PeerTube is off
 * (without asking the layer), YouTube URLs, plain search text, a bare
 * `name@host` (an email address has that shape) unless its host answers as
 * PeerTube, so it is searched for when the host cannot be asked, a host that is
 * not PeerTube, a video its instance does not have or refuses, any other
 * failure, and PeerTube playlists. There is no page for a PeerTube playlist
 * yet (a later ticket), so a playlist URL takes today's path: a search in the
 * search bar, nothing from a deep link.
 *
 * YouTube URLs and plain text cost no request: the layer answers them
 * without the network (see `index.js` `resolveUrl`).
 */

import { openInternalPath, showToast } from '../helpers/utils'
import i18n from '../i18n/index'
import { describe } from './describe'
import { PlatformError } from './errors'
import { parsePeerTubeInput } from './peertube/urls'
import { parseChannelHandle, PLATFORM_PEERTUBE } from './refs'
import { getPlatformLayer, isPeerTubeEnabled } from './vue.js'

/** The layer's failures that mean the host could not be asked, as opposed to a no */
const UNREACHABLE = new Set(['unavailable', 'rateLimited'])

/**
 * @typedef {object} PeerTubeEntry
 * @property {{ path: string, query?: { timestamp: number } } | null} route
 *   the page to open; `null` when the input is PeerTube's but nothing can be
 *   opened (the user has been told why), and the caller must stop
 */

/**
 * What a pasted or linked input opens, if it is PeerTube's. Never throws.
 *
 * @param {unknown} text as typed or linked
 * @returns {Promise<PeerTubeEntry | null>} `null`: not PeerTube's, carry on as before
 */
export async function resolvePeerTubeEntry(text) {
  if (typeof text !== 'string' || !isPeerTubeEnabled()) {
    return null
  }

  const input = text.trim()

  if (input === '') {
    return null
  }

  let answer
  try {
    answer = await getPlatformLayer().resolveUrl(input)
  } catch (error) {
    if (error instanceof PlatformError && UNREACHABLE.has(error.kind) && !isBareHandle(input)) {
      const host = error.host ?? parsePeerTubeInput(input)?.host ?? input
      showToast(i18n.global.t('PeerTube.Links.Could not reach', { host }))
      return { route: null }
    }

    return null
  }

  const route = routeFor(answer)
  return route ? { route } : null
}

/**
 * Whether the input is a bare `name@host`, the shape an email address also
 * has: no leading `@` and not a URL. Only a host that answers as PeerTube
 * makes it a handle; while its host cannot be asked it stays search text.
 *
 * @param {string} input trimmed
 * @returns {boolean}
 */
function isBareHandle(input) {
  return !input.startsWith('@') && parseChannelHandle(input) !== null
}

/**
 * `resolvePeerTubeEntry`, then opening what it found. Never throws.
 *
 * @param {unknown} text
 * @param {object} [options] as for `openInternalPath`
 * @param {boolean} [options.doCreateNewWindow]
 * @param {string | null} [options.searchQueryText]
 * @returns {Promise<'opened' | 'stopped' | null>} `null`: not PeerTube's, carry on as before
 */
export async function openPeerTubeEntry(text, { doCreateNewWindow = false, searchQueryText = null } = {}) {
  const entry = await resolvePeerTubeEntry(text)

  if (entry === null) {
    return null
  }

  if (entry.route === null) {
    return 'stopped'
  }

  openInternalPath({ ...entry.route, doCreateNewWindow, searchQueryText })
  return 'opened'
}

/**
 * The route for the layer's answer, when it is a PeerTube video or channel.
 *
 * @param {any} answer
 * @returns {{ path: string, query?: { timestamp: number } } | null}
 */
function routeFor(answer) {
  if (answer?.platform !== PLATFORM_PEERTUBE) {
    return null
  }

  if (answer.kind === 'video') {
    const { route } = describe({ platform: PLATFORM_PEERTUBE, host: answer.ref?.host, videoId: answer.ref?.videoId })

    if (!route) {
      return null
    }

    return answer.timestamp > 0 ? { ...route, query: { timestamp: answer.timestamp } } : route
  }

  if (answer.kind === 'channel') {
    return describe({ type: 'channel', platform: PLATFORM_PEERTUBE, id: answer.ref }).route
  }

  return null
}
