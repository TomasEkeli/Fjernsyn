// Field readers shared by the PeerTube adapter's modules: one place that knows
// PeerTube's old and new field names (spec, "PeerTube adapter"), so that a
// video from a 6.x instance, an 8.x instance and a search index all come out
// in the same common shapes (`../shapes.js`).
//
// - Thumbnails: `thumbnails[]` (8.x, each with `fileUrl` or `path`), else
//   `previewPath` (larger) or `thumbnailPath`, else the index's absolute
//   `previewUrl` or `thumbnailUrl`.
// - Avatars: `avatars[]`, else the singular `avatar` of older instances.
// - Comments: `commentsPolicy` (1 enabled, 2 disabled, 3 requires approval),
//   else the older `commentsEnabled`.
//
// Pure: no requests. Every URL handed out is absolute and http(s); a path is
// made absolute on the instance that answered, which serves it (thumbnails of
// remote videos are cached locally), while `host` in a summary is always the
// video's or channel's origin.

import { PLATFORM_PEERTUBE, isHostname, isUuid, peerTubeChannelRef } from '../refs'

// PeerTube's video states (`VideoState` in its models)
const STATE_PUBLISHED = 1
const STATE_WAITING_FOR_LIVE = 4
const STATE_LIVE_ENDED = 5

// The comments policy that turns comments off
const COMMENTS_DISABLED = 2

// The avatar picked for a channel: the smallest at least this wide, which is
// PeerTube's 120 px size, big enough for the card and the channel lists
const AVATAR_MIN_WIDTH = 120

/**
 * An absolute https URL for a URL or a path the instance answered with,
 * resolved against `https://{host}`, or `null` for anything else.
 *
 * https only: the client only ever talks https to instances, and a media,
 * thumbnail, caption or storyboard URL an instance hands out gets no less, so
 * `http:`, `javascript:`, `data:` and the rest are all `null`. The answer is
 * the parsed URL's `href`, normalised, so that nothing raw (a line break, a
 * space) reaches what is built from it, such as the storyboard's WebVTT.
 *
 * @param {string} host the instance that answered
 * @param {unknown} urlOrPath
 * @returns {string | null}
 */
export function absoluteUrl(host, urlOrPath) {
  if (typeof urlOrPath !== 'string' || urlOrPath === '') {
    return null
  }

  try {
    const url = new URL(urlOrPath, `https://${host}`)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/**
 * A bare lower-case host name, or `null`.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function hostOrNull(value) {
  if (typeof value !== 'string') {
    return null
  }

  const host = value.toLowerCase()
  return isHostname(host) ? host : null
}

/**
 * The host of a URL, or `null`.
 *
 * @param {unknown} url
 * @returns {string | null}
 */
export function hostOfUrl(url) {
  if (typeof url !== 'string') {
    return null
  }

  try {
    return hostOrNull(new URL(url).hostname)
  } catch {
    return null
  }
}

/**
 * The instance a video belongs to: its channel's host, else its account's,
 * else its canonical URL's, else the instance that answered.
 *
 * @param {any} video a details response or a list item
 * @param {string} answeringHost
 * @returns {string}
 */
export function originHost(video, answeringHost) {
  return hostOrNull(video?.channel?.host) ??
    hostOrNull(video?.account?.host) ??
    hostOfUrl(video?.url) ??
    answeringHost
}

/**
 * Whether the instance that answered says the video is someone else's.
 * Only an explicit `isLocal: false` says so.
 *
 * @param {any} video
 * @returns {boolean}
 */
export function isRemote(video) {
  return video?.isLocal === false
}

/**
 * The largest thumbnail. A square one (PeerTube 8 makes a 1:1 image for
 * podcasts) is only taken when there is nothing else.
 *
 * @param {any} video
 * @param {string} host the instance that answered
 * @returns {string}
 */
export function pickThumbnail(video, host) {
  const listed = Array.isArray(video?.thumbnails) ? video.thumbnails : []
  const thumbnails = listed
    .map(thumbnail => ({ width: thumbnail?.width, height: thumbnail?.height, url: absoluteUrl(host, thumbnail?.fileUrl ?? thumbnail?.path) }))
    .filter(thumbnail => thumbnail.url)

  if (thumbnails.length > 0) {
    const landscape = thumbnails.filter(({ width, height }) => !(width > 0 && width === height))
    const candidates = landscape.length > 0 ? landscape : thumbnails
    const largest = candidates.reduce((best, thumbnail) => ((thumbnail.width ?? 0) > (best.width ?? 0) ? thumbnail : best))
    return largest.url
  }

  return absoluteUrl(host, video?.previewPath) ??
    absoluteUrl(host, video?.thumbnailPath) ??
    absoluteUrl(host, video?.previewUrl) ??
    absoluteUrl(host, video?.thumbnailUrl) ??
    ''
}

/**
 * An actor's images with an absolute https URL each, and their widths: from
 * the list (`avatars[]`, `banners[]`) when it has any, else the singular field
 * of older instances (`avatar`, `banner`).
 *
 * @param {unknown} list
 * @param {unknown} single
 * @param {string} host the instance that answered
 * @returns {Array<{ width: number, url: string }>}
 */
function usableImages(list, single, host) {
  let images = []

  if (Array.isArray(list) && list.length > 0) {
    images = list
  } else if (single) {
    images = [single]
  }

  return images
    .map(image => ({ width: Number(image?.width) || 0, url: absoluteUrl(host, image?.fileUrl ?? image?.path) }))
    .filter(image => image.url)
}

/**
 * A channel's or account's avatar: the smallest at least `AVATAR_MIN_WIDTH`
 * wide, else the largest there is. `''` when there is none.
 *
 * @param {any} actor
 * @param {string} host the instance that answered
 * @returns {string}
 */
export function pickAvatar(actor, host) {
  const usable = usableImages(actor?.avatars, actor?.avatar, host)
    .sort((a, b) => a.width - b.width)

  if (usable.length === 0) {
    return ''
  }

  return (usable.find(avatar => avatar.width >= AVATAR_MIN_WIDTH) ?? usable.at(-1)).url
}

/**
 * The largest of an actor's images, from the list (`avatars[]`, `banners[]`)
 * or the singular field of older instances (`avatar`, `banner`); `null` when
 * there is none.
 *
 * @param {unknown} list
 * @param {unknown} single
 * @param {string} host the instance that answered
 * @returns {string | null}
 */
function pickLargestImage(list, single, host) {
  const usable = usableImages(list, single, host)

  if (usable.length === 0) {
    return null
  }

  return usable.reduce((best, image) => (image.width > best.width ? image : best)).url
}

/**
 * A channel's largest avatar, for its header. `''` when there is none.
 *
 * @param {any} actor
 * @param {string} host the instance that answered
 * @returns {string}
 */
export function pickLargestAvatar(actor, host) {
  return pickLargestImage(actor?.avatars, actor?.avatar, host) ?? ''
}

/**
 * A channel's largest banner, or `null`.
 *
 * @param {any} actor
 * @param {string} host the instance that answered
 * @returns {string | null}
 */
export function pickBanner(actor, host) {
  return pickLargestImage(actor?.banners, actor?.banner, host)
}

/**
 * A channel in the common shape, the same as the stub stored in profiles
 * (`id` the handle, `name` the display name, `thumbnail` the avatar), plus its
 * canonical `url` and follower count. `null` when the channel cannot be named.
 *
 * @param {any} channel
 * @param {string} answeringHost
 * @returns {import('../shapes').ChannelSummary | null}
 */
export function channelSummary(channel, answeringHost) {
  const host = hostOrNull(channel?.host) ?? answeringHost
  const handle = peerTubeChannelRef(channel?.name, host)

  if (!handle) {
    return null
  }

  const url = absoluteUrl(host, channel.url) ?? `https://${host}/video-channels/${channel.name}`

  return {
    platform: PLATFORM_PEERTUBE,
    host,
    id: handle,
    handle,
    name: typeof channel.displayName === 'string' && channel.displayName !== '' ? channel.displayName : channel.name,
    thumbnail: pickAvatar(channel, answeringHost),
    url,
    subscriberCount: typeof channel.followersCount === 'number' ? channel.followersCount : null,
  }
}

/**
 * A channel in a list (search results): a `ChannelSummary` that the existing
 * channel card (`FtListChannel`) renders as it is. The card reads a Local
 * API channel's fields when `dataSource` is `'local'` (`thumbnail`, `name`,
 * `id`, `subscribers`, `videos`, `handle`, `descriptionShort`), and would
 * otherwise read Invidious's `authorThumbnails[2]`, which PeerTube has none
 * of; so `dataSource` says which field names the item carries, not where it
 * came from. `null` when the channel cannot be named.
 *
 * @param {any} channel
 * @param {string} answeringHost
 * @returns {import('../shapes').ChannelListItem | null}
 */
export function channelListItem(channel, answeringHost) {
  const summary = channelSummary(channel, answeringHost)

  if (!summary) {
    return null
  }

  const description = typeof channel.description === 'string' ? channel.description : ''

  return {
    type: 'channel',
    dataSource: 'local',
    ...summary,
    subscribers: summary.subscriberCount,
    videos: typeof channel.videosCount === 'number' ? channel.videosCount : null,
    description,
    descriptionShort: plainSnippet(description),
  }
}

// The length a card's description snippet is cut to
const SNIPPET_LENGTH = 200

/**
 * A short plain-text snippet of instance-supplied text, safe to hand to
 * `v-safer-html` (which the channel card renders `descriptionShort` with, and
 * which lets `<a href>` and `<img src style>` through): `&`, `<`, `>` and `"`
 * escaped so no markup survives, whitespace (newlines included) collapsed to
 * single spaces, and cut to `SNIPPET_LENGTH` characters on a word boundary
 * with an ellipsis. Cut before escaping, so an entity is never split.
 *
 * @param {string} text
 * @returns {string}
 */
export function plainSnippet(text) {
  let snippet = text.replaceAll(/\s+/g, ' ').trim()

  if (snippet.length > SNIPPET_LENGTH) {
    const cut = snippet.slice(0, SNIPPET_LENGTH + 1)
    const space = cut.lastIndexOf(' ')
    snippet = `${(space > 0 ? cut.slice(0, space) : cut.slice(0, SNIPPET_LENGTH)).trimEnd()}…`
  }

  return snippet
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * A label PeerTube sends as `{ id, label }`: `null` when the id is `null`,
 * which is how PeerTube says "Unknown".
 *
 * @param {any} field
 * @returns {string | null}
 */
export function labelOf(field) {
  if (field == null || field.id == null || typeof field.label !== 'string') {
    return null
  }

  return field.label
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function timeOf(value) {
  if (typeof value !== 'string') {
    return undefined
  }

  const time = Date.parse(value)
  return Number.isNaN(time) ? undefined : time
}

/**
 * The live state of a video: `null` for a video that is not a live,
 * otherwise `'live'`, `'waiting'` or `'ended'`.
 *
 * @param {any} video
 * @returns {'live' | 'waiting' | 'ended' | null}
 */
export function liveStatusOf(video) {
  if (video?.isLive !== true) {
    return null
  }

  switch (video.state?.id) {
    case STATE_WAITING_FOR_LIVE:
      return 'waiting'
    case STATE_LIVE_ENDED:
      return 'ended'
    case STATE_PUBLISHED:
      return 'live'
    default:
      // A search index sends no state: a live it lists is live
      return video.state == null ? 'live' : 'waiting'
  }
}

/**
 * When a waiting live is scheduled to start, where the instance says
 * (`liveSchedules`, 6.2 and later).
 *
 * @param {any} video
 * @returns {Date | null}
 */
function scheduledStart(video) {
  const schedules = Array.isArray(video?.liveSchedules) ? video.liveSchedules : []
  const times = schedules.map(schedule => timeOf(schedule?.startAt)).filter(time => time !== undefined)

  return times.length > 0 ? new Date(Math.min(...times)) : null
}

/**
 * Whether comments are open, from `commentsPolicy` or the older
 * `commentsEnabled`. Open when neither says otherwise.
 *
 * @param {any} video
 * @returns {boolean}
 */
export function commentsEnabledOf(video) {
  if (typeof video?.commentsPolicy?.id === 'number') {
    return video.commentsPolicy.id !== COMMENTS_DISABLED
  }

  if (typeof video?.commentsEnabled === 'boolean') {
    return video.commentsEnabled
  }

  return true
}

/**
 * A video in the common summary shape, with the field names the existing card
 * reads, from a details response or a list item. `null` when it has no uuid.
 *
 * - `host` is the origin; `thumbnail` absolute on the instance that answered.
 * - `lengthSeconds` is left out for a live that is live now: the card reads
 *   a missing duration as live.
 * - `isUpcoming` for a live that has not started, with `premiereDate` only
 *   when it is scheduled.
 *
 * @param {any} video
 * @param {string} answeringHost
 * @returns {import('../shapes').VideoSummary | null}
 */
export function videoSummary(video, answeringHost) {
  if (!isUuid(video?.uuid)) {
    return null
  }

  const host = originHost(video, answeringHost)
  const channel = channelSummary(video.channel, answeringHost)
  const liveStatus = liveStatusOf(video)

  /** @type {import('../shapes').VideoSummary} */
  const summary = {
    type: 'video',
    platform: PLATFORM_PEERTUBE,
    host,
    videoId: video.uuid.toLowerCase(),
    title: typeof video.name === 'string' ? video.name : '',
    author: channel?.name ?? '',
    authorId: channel?.id ?? '',
    thumbnail: pickThumbnail(video, answeringHost),
    liveNow: liveStatus === 'live',
    isUpcoming: liveStatus === 'waiting',
    nsfw: video.nsfw === true,
  }

  if (liveStatus !== 'live') {
    summary.lengthSeconds = typeof video.duration === 'number' ? video.duration : 0
  }

  const published = timeOf(video.publishedAt)
  if (published !== undefined) {
    summary.published = published
  }

  if (typeof video.views === 'number') {
    summary.viewCount = video.views
  }

  if (liveStatus === 'waiting') {
    const start = scheduledStart(video)
    if (start) {
      summary.premiereDate = start
    }
  }

  return summary
}
