// What upstream's shared cards and lists need to show a record of a platform
// other than YouTube: where it routes, its thumbnail, the URLs it shares and
// hands the external player, and its channel's route and URL, all as
// `describe` says.
//
// Every function here answers `null` (or `false`) for a YouTube record, a
// record without `platform` included, and does not so much as ask the layer:
// a card's hook reads `describeCard(record) ?? <what it did before>`, so a
// YouTube record takes exactly today's path. The one module under `platform/`
// besides `vue.js` that is not framework-free: it asks the wiring for the
// current layer, and copies and opens links through the app's helpers.

import { toStoredPlainText } from '../components/LayerMarkdown/plainText'
import { copyToClipboard, openExternalLink } from '../helpers/utils'
import { PLATFORM_YOUTUBE, platformOf } from './refs'
import { getPlatformLayer } from './vue'

/**
 * @typedef {object} CardDescription
 * @property {{ path: string, query?: object } | null} route the record's own page: a video's watch page, a channel's page
 * @property {string | null} thumbnail a video's thumbnail or a channel's avatar; `null` when there is none, or thumbnails are hidden
 * @property {string | null} shareUrl the canonical URL on the record's own platform
 * @property {string | null} externalPlayerUrl what the external player is handed; `null` for a channel
 * @property {{ path: string } | null} channelRoute the video's channel's page, or for a channel its own
 * @property {string | null} channelShareUrl the channel's canonical URL
 */

// The one query a PeerTube watch route reads (design.md, Routes). A card's
// playlist query is YouTube's: a PeerTube item opens on its own
const WATCH_QUERY_KEYS = ['timestamp']

/**
 * @param {any} record a stored or fetched video (`videoId`) or channel
 * @param {object} [options]
 * @param {Record<string, any>} [options.query] the query the card would add to a YouTube watch route; only what the platform's route reads is kept
 * @returns {CardDescription | null} `null` for a YouTube record
 */
export function describeCard(record, { query } = {}) {
  if (!isOtherPlatform(record)) {
    return null
  }

  const layer = getPlatformLayer()
  const own = layer.describe(record)
  const isVideo = record.videoId != null && record.type !== 'channel'
  const channel = isVideo
    ? layer.describe({ type: 'channel', platform: record.platform, host: record.host, id: record.authorId })
    : own

  return {
    route: withQuery(own.route, query),
    thumbnail: own.thumbnail,
    shareUrl: own.shareUrl,
    externalPlayerUrl: own.externalPlayerUrl,
    channelRoute: channel.route,
    channelShareUrl: channel.shareUrl,
  }
}

/**
 * A playlist's cover drawn from its first video, where that video is of
 * another platform: its own thumbnail, or the placeholder when it has none.
 *
 * @param {any} video the playlist's first video, if any
 * @param {string} placeholder
 * @returns {string | null} `null` for a YouTube video (or none), so the cover keeps its own rule
 */
export function coverThumbnail(video, placeholder) {
  const card = describeCard(video)

  return card === null ? null : card.thumbnail ?? placeholder
}

/**
 * What a record of another platform needs kept when a card writes it to
 * history or a playlist, so that it renders and routes from what is stored:
 * spread last into the record the card builds. Given a `description`, it is
 * stored as escaped plain text, since the list card renders a stored
 * `description` as HTML.
 *
 * @param {any} record the card's video
 * @param {{ description?: unknown }} [options]
 * @returns {object} `{}` for a YouTube record, so its payload is exactly today's
 */
export function platformRecordFields(record, options = {}) {
  if (!isOtherPlatform(record)) {
    return {}
  }

  const fields = { platform: record.platform, host: record.host, thumbnail: record.thumbnail }

  if (options.description !== undefined) {
    fields.description = toStoredPlainText(options.description)
  }

  return fields
}

/**
 * The share entries of a card's menu for a video of another platform, in
 * place of its YouTube and Invidious ones: the canonical links only.
 *
 * @param {CardDescription} card
 * @param {(key: string) => string} t
 * @returns {object[]} dropdown options, as `FtIconButton` takes them
 */
export function cardShareOptions(card, t) {
  const options = []

  if (card.shareUrl) {
    options.push(
      { type: 'divider' },
      { label: t('PeerTube.Watch.Copy link'), value: 'copyPlatformLink' },
      { label: t('PeerTube.Watch.Open in browser'), value: 'openPlatformLink' },
    )
  }

  if (card.channelShareUrl) {
    options.push(
      { type: 'divider' },
      { label: t('PeerTube.Card.Copy channel link'), value: 'copyPlatformChannelLink' },
      { label: t('PeerTube.Card.Open channel in browser'), value: 'openPlatformChannelLink' },
    )
  }

  return options
}

/**
 * Runs one of the entries `cardShareOptions` offers.
 *
 * @param {string} option
 * @param {CardDescription} card
 * @param {(key: string) => string} t
 * @returns {boolean} whether it was one of them; the card handles the rest
 */
export function runCardShareOption(option, card, t) {
  switch (option) {
    case 'copyPlatformLink':
      copyToClipboard(card.shareUrl, { messageOnSuccess: t('PeerTube.Watch.Link copied') })
      return true
    case 'openPlatformLink':
      openExternalLink(card.shareUrl)
      return true
    case 'copyPlatformChannelLink':
      copyToClipboard(card.channelShareUrl, { messageOnSuccess: t('PeerTube.Card.Channel link copied') })
      return true
    case 'openPlatformChannelLink':
      openExternalLink(card.channelShareUrl)
      return true
    default:
      return false
  }
}

/**
 * @param {unknown} record
 * @returns {boolean}
 */
function isOtherPlatform(record) {
  return record != null && typeof record === 'object' && platformOf(record) !== PLATFORM_YOUTUBE
}

/**
 * @param {{ path: string } | null} route
 * @param {Record<string, any> | undefined} query
 */
function withQuery(route, query) {
  if (route === null || query == null) {
    return route
  }

  const kept = Object.fromEntries(WATCH_QUERY_KEYS.filter(key => query[key] != null).map(key => [key, query[key]]))

  return Object.keys(kept).length > 0 ? { ...route, query: kept } : route
}
