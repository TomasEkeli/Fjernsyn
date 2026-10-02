// A YouTube channel link by name (`/c/`, `/user/`, `@handle`) resolved to the
// channel's `UC` ref, through the backend policy (`./policy.js`), as the old
// channel view resolves a route's `?url=` (src/renderer/views/Channel/Channel.vue,
// `resolveChannelUrl`).
//
// - Local: `getLocalChannelId(url)`, youtubei.js' `resolveURL`, following one
//   redirect on youtube.com. Invidious: `invidiousGetChannelId(url)`, the
//   instance's `/api/v1/resolveurl`. Both modules swallow every failure and
//   answer `null`, so a 404, an outage and a URL that is not a channel all
//   arrive as one `null`. That is `notFound` here, which the policy tries
//   once on the other backend when fallback is on: no channel is gone on one
//   service's word (ADR-0012), and here one service's word cannot even say
//   whether it looked.
// - A `/channel/UC…` URL names its ref already, and is answered without a
//   request.

import { PlatformError } from '../errors'
import { isYouTubeChannelRef } from '../refs'
import { classifyYouTubeError } from './errors'

/** A channel URL's path naming the ref itself, with or without a tab after it */
const CHANNEL_ID_PATH_PATTERN = /^\/channel\/(UC[\w-]{22})(?:\/|$)/

/**
 * The ref a `/channel/UC…` URL names, or `null`.
 *
 * @param {string} url
 * @returns {string | null}
 */
function refInPath(url) {
  try {
    return CHANNEL_ID_PATH_PATTERN.exec(new URL(url).pathname)?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * @param {object} deps
 * @param {import('./deps').YouTubeDeps} deps.youtube
 * @param {ReturnType<typeof import('./policy').createBackendPolicy>} deps.policy
 */
export function createYouTubeChannelResolver({ youtube, policy }) {
  /**
   * @param {'local' | 'invidious'} backend
   * @param {string} url
   */
  async function resolveOn(backend, url) {
    const id = backend === 'local'
      ? await youtube.getLocalChannelId(url)
      : await youtube.invidiousGetChannelId(url)

    if (!isYouTubeChannelRef(id)) {
      throw new PlatformError('notFound', `YouTube (${backend === 'local' ? 'Local' : 'Invidious'}) resolved no channel at ${url}`)
    }

    return id
  }

  /**
   * The `UC` ref of the channel a YouTube channel URL names. Rejects with a
   * `PlatformError`, `notFound` when no backend asked resolved it.
   *
   * @param {string} url a URL on a YouTube host
   * @returns {Promise<string>}
   */
  async function resolveChannel(url) {
    const named = refInPath(url)

    if (named !== null) {
      return named
    }

    return policy.first(backend => resolveOn(backend, url), classifyYouTubeError)
  }

  return Object.freeze({ resolveChannel })
}
