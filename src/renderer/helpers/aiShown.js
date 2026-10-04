import store from '../store/index'

import { platformOf, PLATFORM_YOUTUBE } from '../platform/refs'

/**
 * Whether the walls show videos made with AI, and which videos those are.
 *
 * A video is marked as AI when YouTube labels it "Made with AI", which the
 * creator declared (its verdict, helpers/aiMarker), or when its channel is
 * one the user marked as AI by hand. Marked is the default; hidden is the AI
 * pill. Like the Watched pill (`./watchedShown.js`), the pill is one setting
 * for every wall that has it, the same `hideAiVideos` Distraction Free
 * settings has as a switch: pressing one moves the others.
 *
 * Everything here reads the store, so a computed calling it is subscribed to
 * what it read: a verdict arriving, a channel marked or the pill pressed
 * redraws the wall.
 */

/**
 * @returns {boolean}
 */
export function aiIsShown() {
  return !store.getters.getHideAiVideos
}

/**
 * @param {boolean} shown
 */
export function setAiShown(shown) {
  if (shown === aiIsShown()) {
    return Promise.resolve()
  }

  return store.dispatch('updateHideAiVideos', !shown)
}

/**
 * The setting as last parsed, so that every tile on a wall asking about its
 * channel does not parse the same JSON again. Keyed by the setting's text,
 * which is still read on every call, so a caller stays subscribed to it.
 */
let parsed = { text: null, channels: [], ids: new Set() }

function parsedAiChannels() {
  const text = store.getters.getAiChannels

  if (text !== parsed.text) {
    let channels = []

    try {
      const value = JSON.parse(text)

      if (Array.isArray(value)) {
        channels = value.filter(channel => typeof channel?.id === 'string')
      }
    } catch {
      // A setting that is not JSON marks nothing
      channels = []
    }

    parsed = { text, channels, ids: new Set(channels.map(channel => channel.id)) }
  }

  return parsed
}

/**
 * The channels the user marked as AI, as the setting keeps them.
 *
 * @returns {{ id: string, name: string }[]}
 */
export function markedAiChannels() {
  return parsedAiChannels().channels.slice()
}

/**
 * @param {string | null | undefined} channelId
 * @returns {boolean}
 */
export function isChannelMarkedAi(channelId) {
  if (typeof channelId !== 'string' || channelId === '') { return false }

  return parsedAiChannels().ids.has(channelId)
}

/**
 * @param {string} channelId
 * @param {string} channelName
 */
export function markChannelAi(channelId, channelName) {
  if (isChannelMarkedAi(channelId)) { return Promise.resolve() }

  return store.dispatch('updateAiChannels', JSON.stringify([...markedAiChannels(), { id: channelId, name: channelName ?? '' }]))
}

/**
 * @param {string} channelId
 */
export function unmarkChannelAi(channelId) {
  return store.dispatch('updateAiChannels', JSON.stringify(markedAiChannels().filter(channel => channel.id !== channelId)))
}

/**
 * Why a video carries the AI marker: `declared` when YouTube labels it, which
 * the creator said, `marked` when it is from a channel the user marked, and
 * `null` when it is not known to be AI, which includes every video not yet
 * asked about. A declaration is the stronger word, so it is the one given
 * when both hold.
 *
 * Only YouTube videos: nothing else has a label to read or a channel to mark.
 *
 * @param {any} video
 * @returns {'declared' | 'marked' | null}
 */
export function aiMarkOf(video) {
  if (video == null || platformOf(video) !== PLATFORM_YOUTUBE) { return null }

  if (typeof video.videoId === 'string' && store.getters.getAiVerdicts?.[video.videoId] === true) {
    return 'declared'
  }

  if (isChannelMarkedAi(video.authorId)) {
    return 'marked'
  }

  return null
}

/**
 * Whether the AI pill takes a video off the wall. The one place that decides
 * it, for the wall wrapper, the related videos and the "all hidden" message.
 *
 * @param {any} video
 * @returns {boolean}
 */
export function isHiddenAsAi(video) {
  return !aiIsShown() && aiMarkOf(video) !== null
}

/**
 * The entries left once the pill has taken out those made with AI, or all of
 * them while AI videos are shown. For a wall that pages what it has in hand,
 * as the subscriptions stream does, so that a page is counted, and said to be
 * empty, after the pill and not before; as `withWatchedPreference` is.
 *
 * @template T
 * @param {T[]} entries
 * @returns {T[]}
 */
export function withAiPreference(entries) {
  if (aiIsShown()) {
    return entries
  }

  return entries.filter(entry => !isHiddenAsAi(entry))
}

/**
 * Whether the pill has taken every entry off a wall that has any, so that
 * the wall can say so instead of looking broken.
 *
 * @param {any[]} entries
 * @returns {boolean}
 */
export function allHiddenAsAi(entries) {
  return entries.length > 0 && !aiIsShown() && entries.every(isHiddenAsAi)
}
