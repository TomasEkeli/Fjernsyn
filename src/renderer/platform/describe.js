// `describe`: for any stored or fetched video or channel, of either platform,
// where it routes, its thumbnail, its share URL and its external player URL.
// Pure: no network, no store, no router. Shared components call it where they
// would otherwise build a URL from an id.
//
// Routes are vue-router location objects with a `path` (`{ path }`), so that a
// caller adds what only it knows by spreading: `{ ...route, query }`.
//
// For YouTube this reproduces today's rules, which live in upstream's and the
// fork's components. They are replicated here, not imported, because those
// modules import the store (and the layer must not); each rule names where it
// comes from, so a change there can be ported.

import { PLATFORM_PEERTUBE, isHostname, isUuid, parseChannelHandle, platformOf } from './refs'

/**
 * @typedef {object} DescribeConfig
 * @property {string} [backendPreference] `'local'` or `'invidious'`
 * @property {string} [currentInvidiousInstanceUrl] with scheme, no trailing slash
 * @property {string} [thumbnailPreference] `''`, `'default'`, `'start'`, `'middle'`, `'end'` or `'hidden'`
 */

/**
 * @typedef {object} DescribeOptions
 * @property {boolean} [large] the 1280px YouTube thumbnail instead of the 320px one, for cards big enough to use it
 */

/**
 * @typedef {object} Description
 * @property {{ path: string } | null} route
 * @property {string | null} thumbnail an absolute URL; `null` when there is
 *   none to show, including when thumbnails are hidden (the caller shows its
 *   placeholder, as the video card does today)
 * @property {string | null} shareUrl
 * @property {string | null} externalPlayerUrl
 */

/** @type {Readonly<Description>} */
const NOTHING = Object.freeze({ route: null, thumbnail: null, shareUrl: null, externalPlayerUrl: null })

/**
 * @param {any} entity a video (has `videoId`) or a channel (`type: 'channel'`, or an `id` or `authorId` and no `videoId`)
 * @param {DescribeConfig} [config]
 * @param {DescribeOptions} [options]
 * @returns {Description}
 */
export function describe(entity, config = {}, options = {}) {
  if (entity == null || typeof entity !== 'object') {
    return { ...NOTHING }
  }

  try {
    const isPeerTube = platformOf(entity) === PLATFORM_PEERTUBE

    if (isChannel(entity)) {
      return isPeerTube ? describePeerTubeChannel(entity) : describeYouTubeChannel(entity, config)
    }

    if (entity.videoId != null) {
      return isPeerTube ? describePeerTubeVideo(entity, config) : describeYouTubeVideo(entity, config, options)
    }
  } catch {
    // A malformed record describes as nothing rather than breaking a list
  }

  return { ...NOTHING }
}

/**
 * @param {any} entity
 * @returns {boolean}
 */
function isChannel(entity) {
  return entity.type === 'channel' || (entity.videoId == null && (entity.id != null || entity.authorId != null))
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

/**
 * @param {any} entity
 * @param {DescribeConfig} config
 * @param {DescribeOptions} options
 * @returns {Description}
 */
function describeYouTubeVideo(entity, config, { large = false }) {
  const id = entity.videoId

  if (typeof id !== 'string' || id === '') {
    return { ...NOTHING }
  }

  return {
    // FtListVideo.vue `watchVideoRouterLink`; the card adds the playlist query
    route: { path: `/watch/${id}` },
    thumbnail: youTubeVideoThumbnail(id, config, large),
    // FtListVideo.vue, the `copyYoutube` share option
    shareUrl: `https://youtu.be/${id}`,
    // src/main/externalPlayer.js, the video URL it hands the player
    externalPlayerUrl: `https://www.youtube.com/watch?v=${id}`,
  }
}

/**
 * FtListVideo.vue, the `thumbnail` computed (less DeArrow, which the card
 * still decides). The same four frames at two sizes: mq* is 320px wide,
 * hq720* is 1280px.
 *
 * @param {string} id
 * @param {DescribeConfig} config
 * @param {boolean} large
 * @returns {string | null}
 */
function youTubeVideoThumbnail(id, { backendPreference, currentInvidiousInstanceUrl, thumbnailPreference }, large) {
  if (thumbnailPreference === 'hidden') {
    return null
  }

  const baseUrl = backendPreference === 'invidious' ? currentInvidiousInstanceUrl : 'https://i.ytimg.com'

  switch (thumbnailPreference) {
    case 'start':
      return `${baseUrl}/vi/${id}/${large ? 'hq720_1' : 'mq1'}.jpg`
    case 'middle':
      return `${baseUrl}/vi/${id}/${large ? 'hq720_2' : 'mq2'}.jpg`
    case 'end':
      return `${baseUrl}/vi/${id}/${large ? 'hq720_3' : 'mq3'}.jpg`
    default:
      return `${baseUrl}/vi/${id}/${large ? 'hq720' : 'mqdefault'}.jpg`
  }
}

/**
 * @param {any} entity
 * @param {DescribeConfig} config
 * @returns {Description}
 */
function describeYouTubeChannel(entity, config) {
  const id = entity.id ?? entity.authorId

  if (typeof id !== 'string' || id === '') {
    return { ...NOTHING }
  }

  return {
    // FtListChannel.vue and ChannelsOverview.vue
    route: { path: `/channel/${id}` },
    thumbnail: youTubeChannelThumbnail(entity, config),
    // FtListVideo.vue `getYoutubeChannelUrl`
    shareUrl: `https://youtube.com/channel/${id}`,
    externalPlayerUrl: null,
  }
}

/**
 * @param {any} entity
 * @param {DescribeConfig} config
 * @returns {string | null}
 */
function youTubeChannelThumbnail(entity, { backendPreference, currentInvidiousInstanceUrl = '' }) {
  // FtListChannel.vue `parseLocalData`: a Local result's thumbnail as it came
  if (entity.dataSource === 'local') {
    return entity.thumbnail || null
  }

  // FtListChannel.vue `parseInvidiousData`: an Invidious result's third
  // thumbnail, rewritten onto the current instance whatever the backend
  if (entity.authorThumbnails !== undefined) {
    const url = Array.isArray(entity.authorThumbnails) ? entity.authorThumbnails[2]?.url : undefined
    return youtubeImageUrlToInvidious(url, currentInvidiousInstanceUrl) || null
  }

  return storedChannelThumbnail(entity.thumbnail, backendPreference, currentInvidiousInstanceUrl)
}

/**
 * A stored channel's thumbnail pointed at the backend in use.
 * ChannelsOverviewTile.vue `thumbnailUrl`, less the size it asks for, which is
 * the tile's own. One deliberate difference: for an Invidious-hosted
 * thumbnail with Invidious preferred, the tile's `invidiousImageUrlToInvidious`
 * prefixes the instance onto an absolute URL (it expects the relative
 * `/ggpht/` paths Invidious answers with); here the path is moved onto the
 * current instance, which is what the tile means.
 *
 * @param {unknown} original
 * @param {string | undefined} backendPreference
 * @param {string} currentInvidiousInstanceUrl
 * @returns {string | null}
 */
function storedChannelThumbnail(original, backendPreference, currentInvidiousInstanceUrl) {
  if (typeof original !== 'string' || original === '') {
    return null
  }

  const url = original.startsWith('//') ? `https:${original}` : original

  let hostname
  try {
    hostname = new URL(url).hostname
  } catch {
    return null
  }

  if (hostname === 'yt3.ggpht.com' || hostname === 'yt3.googleusercontent.com') {
    return backendPreference === 'invidious' ? youtubeImageUrlToInvidious(url, currentInvidiousInstanceUrl) : url
  }

  if (backendPreference === 'local') {
    return url.replace(/^.+ggpht\/(.+)/, 'https://yt3.ggpht.com/$1')
  }

  return url.replace(/^.+ggpht\/(.+)/, `${currentInvidiousInstanceUrl}/ggpht/$1`)
}

/**
 * A replica of `youtubeImageUrlToInvidious` in src/renderer/helpers/api/invidious.js,
 * which cannot be imported here: that module imports the store. Keep the two
 * the same.
 *
 * @param {string | undefined | null} url
 * @param {string} currentInstance
 * @returns {string}
 */
function youtubeImageUrlToInvidious(url, currentInstance) {
  if (!url) return ''

  // Can be prefixed with `https://` or `//` (protocol relative)
  if (url.startsWith('//')) {
    url = 'https:' + url
  }
  const newUrl = `${currentInstance}/ggpht`
  return url.replace('https://yt3.ggpht.com', newUrl)
    .replace('https://yt3.googleusercontent.com', newUrl)
    .replace(/https:\/\/i\d*\.ytimg\.com/, newUrl)
}

// ---------------------------------------------------------------------------
// PeerTube
// ---------------------------------------------------------------------------

/**
 * An instance-supplied image URL, kept only if `https:` (as the adapter keeps
 * every instance URL: design.md, ticket 05 amendment)
 *
 * @param {unknown} url
 * @returns {string | null}
 */
function httpsUrlOrNull(url) {
  if (typeof url !== 'string' || url === '') {
    return null
  }

  try {
    return new URL(url).protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/**
 * @param {any} entity
 * @param {DescribeConfig} config
 * @returns {Description}
 */
function describePeerTubeVideo(entity, { thumbnailPreference }) {
  const { host, videoId: uuid } = entity

  if (!isHostname(host) || !isUuid(uuid)) {
    return { ...NOTHING }
  }

  const watchUrl = `https://${host}/videos/watch/${uuid}`

  return {
    route: { path: `/peertube/watch/${host}/${uuid}` },
    // PeerTube has one thumbnail per video, so the frame and size preferences
    // do not apply; hiding thumbnails does
    thumbnail: thumbnailPreference === 'hidden' ? null : httpsUrlOrNull(entity.thumbnail),
    shareUrl: watchUrl,
    externalPlayerUrl: watchUrl,
  }
}

/**
 * @param {any} entity
 * @returns {Description}
 */
function describePeerTubeChannel(entity) {
  const handle = entity.id ?? entity.authorId
  const parsed = parseChannelHandle(handle)

  if (!parsed) {
    return { ...NOTHING }
  }

  const { name, host } = parsed

  return {
    route: { path: `/peertube/channel/${name}@${host}` },
    thumbnail: httpsUrlOrNull(entity.thumbnail),
    shareUrl: `https://${host}/video-channels/${name}`,
    externalPlayerUrl: null,
  }
}
