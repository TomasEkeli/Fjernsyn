// The YouTube adapters, Local and Invidious behind one backend policy
// (`./policy.js`, ADR-0015), wrapping the existing module functions handed in
// as the `youtube` dependencies (`./deps.js`). The layer (`../index.js`)
// routes a YouTube ref here; everything below speaks the common shapes.

import { createYouTubeChannelReader } from './channels'
import { createYouTubeCommentReader } from './comments'
import { createBackendPolicy } from './policy'
import { createYouTubeSearcher } from './search'
import { createYouTubeVideoReader } from './videos'

/**
 * @param {object} deps
 * @param {import('./deps').YouTubeDeps} deps.youtube
 * @param {Readonly<import('../index').PlatformConfig>} deps.config
 */
export function createYouTubeAdapter({ youtube, config }) {
  const policy = createBackendPolicy({ config })
  const shared = { youtube, config, policy }

  return Object.freeze({
    ...createYouTubeVideoReader(shared),
    ...createYouTubeChannelReader(shared),
    ...createYouTubeCommentReader(shared),
    ...createYouTubeSearcher({ youtube, config }),
  })
}
