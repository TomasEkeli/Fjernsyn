// A YouTube channel, fetched: its details, videos and playlists in the common
// shapes (`../shapes.js`), from Local or Invidious through the backend policy
// (`./policy.js`). The mapping is the channel section of `./types.js`.
//
// Not on the layer yet: every operation rejects as `invalid`, without a
// request, as any ref the layer does not know does.

import { PlatformError } from '../errors'

export function createYouTubeChannelReader() {
  async function notYet() {
    throw new PlatformError('invalid', 'YouTube channels are not on the layer yet')
  }

  return Object.freeze({
    getChannel: notYet,
    listChannelVideos: notYet,
    listChannelPlaylists: notYet,
  })
}
