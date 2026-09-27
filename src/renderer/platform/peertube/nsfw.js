// The NSFW preference, for every list of videos the adapter asks for (spec,
// "PeerTube adapter"): requests pass `nsfw=false` unless the setting shows
// NSFW, and then `nsfw=both`. Whatever the source's own policy (an index or an
// instance may send flagged videos anyway), a video flagged `nsfw` is dropped
// while the setting is off.

/**
 * @param {{ peertubeShowNsfw: boolean }} config
 * @returns {'both' | 'false'}
 */
export function nsfwParam(config) {
  return config.peertubeShowNsfw ? 'both' : 'false'
}

/**
 * @param {{ peertubeShowNsfw: boolean }} config
 * @returns {(video: { nsfw?: boolean }) => boolean} whether a video in the common shape is shown
 */
export function nsfwFilter(config) {
  return config.peertubeShowNsfw ? () => true : video => video.nsfw !== true
}
