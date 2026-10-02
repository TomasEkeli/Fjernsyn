// How a YouTube video's details read as the common `VideoDetails`
// (`../shapes.js`), one reader per backend. The specification is the
// `VideoDetails` table in `./types.js`; the reading is the old watch view's
// (`getVideoInformationLocal` and `getVideoInformationInvidious` in
// `views/Watch/Watch.js`), re-implemented here so the view stays unedited.
//
// What the old view does besides reading stays the view's: hiding likes and
// chapters, the `showFamilyFriendlyOnly` gate, putting watched recommendations
// last, live chat, toasts and the subscription details update.
//
// Neither backend says whether a video is a short in its details (Local's
// player and next responses carry no marker, Invidious' `/videos/{id}` none
// either), so a video's details are always `type: 'video'`; only lists know
// shorts.
//
// The playback source here is a `manifest` source with the single-file
// (legacy) formats only, and no manifest, captions, chapters or storyboard;
// those come with the manifests. A live or a post-live DVR has no legacy
// formats; a waiting live has nothing to play, except on Local where YouTube
// put a trailer in its place, which the old view plays.

import { getLocalVideoTitle } from '../../helpers/player/watchMetadata'

/** The old view's thumbnail preference names, by the frame YouTube keeps for each */
const THUMBNAIL_FRAMES = Object.freeze({ start: 'maxres1', middle: 'maxres2', end: 'maxres3' })

/** The watch-next items the old view reads, by their youtubei.js node type */
const WATCH_NEXT_TYPES = new Set(['CompactVideo', 'CompactMovie'])
const WATCH_NEXT_LOCKUP_CONTENT = new Set(['VIDEO', 'STATION'])

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function numberOrNull(value) {
  return isNumber(value) ? value : null
}

/**
 * A category as the backend names it, in the backend's language: trimmed,
 * `null` when there is none.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function categoryOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringsOf(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
}

/**
 * A youtubei.js `Text`, or the string it stands for.
 *
 * @param {any} value
 * @returns {string | undefined}
 */
function textOf(value) {
  if (typeof value === 'string') {
    return value
  }

  return typeof value?.text === 'string' ? value.text : undefined
}

/**
 * A date youtubei.js gives as a `Date` (and a fixture as its ISO string).
 *
 * @param {unknown} value
 * @returns {Date | null}
 */
function dateOf(value) {
  if (value == null || value === '') {
    return null
  }

  const date = value instanceof Date ? value : new Date(/** @type {any} */ (value))
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Plain text made safe to carry as `'html'`: the Local text runs parser
 * escapes the text it is given, and a plain fallback is escaped the same way.
 *
 * @param {string} text
 */
function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * The live status, by the backend's flags in this order.
 *
 * @param {{ live: boolean, upcoming: boolean, postLiveDvr: boolean }} flags
 * @returns {'live' | 'waiting' | 'ended' | null}
 */
function liveStatusOf({ live, upcoming, postLiveDvr }) {
  if (live) {
    return 'live'
  }

  if (upcoming) {
    return 'waiting'
  }

  return postLiveDvr ? 'ended' : null
}

/**
 * The thumbnail the preference names on `base` (`https://i.ytimg.com` or the
 * Invidious instance), else the backend's own.
 *
 * @param {string} base
 * @param {string} id
 * @param {string} preference
 * @param {string} fallback
 */
function thumbnailFor(base, id, preference, fallback) {
  const frame = THUMBNAIL_FRAMES[preference]
  return frame ? `${base}/vi/${id}/${frame}.jpg` : fallback
}

/**
 * A manifest source with legacy formats only, until the manifests exist.
 *
 * @param {import('../shapes').LegacyFormat[]} legacyFormats
 * @param {boolean} isLive
 * @returns {import('../shapes').ManifestPlaybackSource}
 */
function legacyOnlySource(legacyFormats, isLive) {
  return {
    transport: 'manifest',
    manifestUrl: null,
    manifestMimeType: null,
    legacyFormats,
    audio: null,
    captions: [],
    chapters: [],
    chaptersSrc: null,
    storyboard: null,
    isLive,
  }
}

/**
 * The fields every YouTube video's details have the same, whichever backend.
 *
 * @param {string} id
 */
function youtubeConstants(id) {
  return {
    type: /** @type {'video'} */ ('video'),
    videoId: id,
    descriptionKind: /** @type {'html'} */ ('html'),
    language: null,
    url: `https://www.youtube.com/watch?v=${id}`,
    // Neither backend says in the details; the comments page does
    commentsEnabled: null,
    // YouTube downloads are yt-dlp's, never files the platform serves (Q9)
    downloadEnabled: false,
    downloadOptions: [],
  }
}

/**
 * @param {string | null} id
 * @param {string} name
 * @param {string} thumbnail
 * @param {number | null} subscriberCount
 * @returns {import('../shapes').ChannelSummary | null}
 */
function channelOf(id, name, thumbnail, subscriberCount) {
  return id ? { id, name, thumbnail, subscriberCount } : null
}

/**
 * A subscriber count from its text, `null` when it does not read.
 *
 * @param {import('./deps').YouTubeDeps} youtube
 * @param {unknown} text
 */
function subscriberCountOf(youtube, text) {
  return typeof text === 'string' && text !== '' ? numberOrNull(youtube.parseLocalSubscriberCount(text)) : null
}

// ---------------------------------------------------------------------------
// Local
// ---------------------------------------------------------------------------

/**
 * The text runs as markup, else the short description, escaped.
 *
 * @param {import('./deps').YouTubeDeps} youtube
 * @param {any} info
 */
function localDescription(youtube, info) {
  const runs = info.secondary_info?.description?.runs
  const plain = escapeHtml(info.basic_info?.short_description ?? '')

  if (!runs) {
    return plain
  }

  try {
    return youtube.parseLocalTextRuns(runs)
  } catch {
    return plain
  }
}

/**
 * Ms since the epoch: the microformat's exact date, else the page's text
 * date ("Jan 1, 2000"), which is less exact; absent when neither reads.
 *
 * @param {any} info
 * @returns {number | undefined}
 */
function localPublished(info) {
  for (const text of [info.page?.[0]?.microformat?.publish_date, textOf(info.primary_info?.published)]) {
    const published = typeof text === 'string' ? Date.parse(text) : NaN

    if (!Number.isNaN(published)) {
      return published
    }
  }

  return undefined
}

/**
 * @param {import('./deps').YouTubeDeps} youtube
 * @param {any} info
 * @returns {number | undefined}
 */
function localViewCount(youtube, info) {
  if (isNumber(info.basic_info?.view_count)) {
    return info.basic_info.view_count
  }

  const text = textOf(info.primary_info?.view_count)
  const parsed = text ? youtube.extractNumberFromString(text) : NaN

  return isNumber(parsed) ? parsed : undefined
}

/**
 * The watch-next list, filtered as the old view filters it.
 *
 * @param {import('./deps').YouTubeDeps} youtube
 * @param {any} info
 * @returns {import('../shapes').VideoSummary[]}
 */
function localRelated(youtube, info) {
  const feed = Array.isArray(info.watch_next_feed) ? info.watch_next_feed : []

  return feed
    .filter(item => WATCH_NEXT_TYPES.has(item?.type) ||
      (item?.type === 'LockupView' && WATCH_NEXT_LOCKUP_CONTENT.has(item.content_type)))
    .map(item => youtube.parseLocalWatchNextVideo(item))
    .filter(Boolean)
}

/**
 * @param {any} info
 * @param {import('./deps').YouTubeDeps} youtube
 * @param {'live' | 'waiting' | 'ended' | null} liveStatus
 * @returns {import('../shapes').ManifestPlaybackSource | null}
 */
function localPlaybackSource(info, youtube, liveStatus) {
  const formats = info.streaming_data?.formats

  if (liveStatus === 'live' || liveStatus === 'ended') {
    return legacyOnlySource([], liveStatus === 'live')
  }

  // A waiting live plays only where YouTube answered a trailer in its place,
  // which `getLocalVideoInfo` swaps in and marks playable
  if (liveStatus === 'waiting' && info.playability_status?.status !== 'OK') {
    return null
  }

  // No streaming data at all: region locked, or the like
  if (!info.streaming_data) {
    return null
  }

  return legacyOnlySource(Array.isArray(formats) ? formats.map(format => youtube.mapLocalLegacyFormat(format)) : [], false)
}

/**
 * @param {string} id
 * @param {{ info: any }} answer what `getLocalVideoInfo` answered
 * @param {object} deps
 * @param {import('./deps').YouTubeDeps} deps.youtube
 * @param {Readonly<import('../index').PlatformConfig>} deps.config
 * @returns {import('../shapes').VideoDetails}
 */
export function localVideoDetails(id, { info }, { youtube, config }) {
  const basic = info.basic_info ?? {}
  const owner = info.secondary_info?.owner
  const live = !!basic.is_live
  const upcoming = !!basic.is_upcoming
  const liveStatus = liveStatusOf({ live, upcoming, postLiveDvr: !!basic.is_post_live_dvr })

  const authorId = basic.channel_id ?? owner?.author?.id ?? ''
  const author = basic.author ?? owner?.author?.name ?? ''
  const authorThumbnail = owner?.author?.best_thumbnail?.url ?? ''
  const premiereDate = upcoming ? dateOf(basic.start_timestamp) : null
  const licence = info.secondary_info?.metadata?.rows
    ?.find(row => row?.title?.text === 'License')?.contents?.[0]?.text

  /** @type {import('../shapes').VideoDetails} */
  const details = {
    ...youtubeConstants(id),
    title: getLocalVideoTitle(info),
    author,
    authorId,
    thumbnail: thumbnailFor('https://i.ytimg.com', id, config.thumbnailPreference,
      basic.thumbnail?.[0]?.url ?? `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`),
    liveNow: live,
    isUpcoming: upcoming,
    description: localDescription(youtube, info),
    // YouTube no longer gives dislikes
    likeCount: numberOrNull(basic.like_count),
    dislikeCount: null,
    tags: stringsOf(basic.keywords),
    category: categoryOf(basic.category),
    licence: typeof licence === 'string' ? licence : null,
    channel: channelOf(authorId || null, author, authorThumbnail, subscriberCountOf(youtube, owner?.subscriber_count?.text)),
    authorThumbnail,
    liveStatus,
    playbackSource: localPlaybackSource(info, youtube, liveStatus),
    isUnlisted: !!basic.is_unlisted,
    related: localRelated(youtube, info),
  }

  if (!live) {
    details.lengthSeconds = isNumber(basic.duration) ? basic.duration : ''
  }

  const published = localPublished(info)
  if (published !== undefined) {
    details.published = published
  }

  const viewCount = localViewCount(youtube, info)
  if (viewCount !== undefined) {
    details.viewCount = viewCount
  }

  if (premiereDate) {
    details.premiereDate = premiereDate
  }

  if (typeof basic.is_family_safe === 'boolean') {
    details.isFamilyFriendly = basic.is_family_safe
  }

  return details
}

// ---------------------------------------------------------------------------
// Invidious
// ---------------------------------------------------------------------------

/**
 * Invidious' description markup, cleaned as the old description component
 * (`WatchVideoDescription.vue`, `parseDescriptionHtml`) cleans it: YouTube's
 * redirect wrapper and tracking attributes gone, its relative links made
 * absolute, its seek calls renamed to the description's own.
 *
 * @param {string} html
 */
export function cleanInvidiousDescriptionHtml(html) {
  return html
    .replaceAll('target="_blank"', '')
    .replaceAll(/\/redirect.+?(?=q=)/g, '')
    .replaceAll('q=', '')
    .replaceAll(/rel="nofollow\snoopener"/g, '')
    .replaceAll(/class=.+?(?=")./g, '')
    .replaceAll(/id=.+?(?=")./g, '')
    .replaceAll(/data-target-new-window=.+?(?=")./g, '')
    .replaceAll(/data-url=.+?(?=")./g, '')
    .replaceAll(/data-sessionlink=.+?(?=")./g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('%3A', ':')
    .replaceAll('%2F', '/')
    .replaceAll(/&v.+?(?=")/g, '')
    .replaceAll(/&redirect-token.+?(?=")/g, '')
    .replaceAll(/&redir_token.+?(?=")/g, '')
    .replaceAll('href="/', 'href="https://www.youtube.com/')
    .replaceAll('href="/hashtag/', 'href="https://wwww.youtube.com/hashtag/')
    .replaceAll('yt.www.watch.player.seekTo', 'changeDuration')
}

/**
 * `descriptionHtml`, cleaned, unless it holds no text (Invidious answers
 * empty elements, `<p></p>`, for an empty description); then the plain
 * `description`, escaped.
 *
 * @param {any} video
 */
function invidiousDescription(video) {
  const html = typeof video.descriptionHtml === 'string' ? cleanInvidiousDescriptionHtml(video.descriptionHtml) : ''

  if (html.replaceAll(/<[^>]*>/g, '').trim() !== '') {
    return html
  }

  return escapeHtml(typeof video.description === 'string' ? video.description : '')
}

/**
 * An Invidious URL on the instance where it is relative to it.
 *
 * @param {string} instance
 * @param {unknown} url
 */
function onInstance(instance, url) {
  if (typeof url !== 'string') {
    return ''
  }

  return url.startsWith('/') && !url.startsWith('//') ? `${instance}${url}` : url
}

/**
 * The recommendations, whose `published` Invidious gives as an ISO date
 * where the rest of its API gives seconds: made ms, as the old view does.
 *
 * @param {any} video
 * @returns {import('../shapes').VideoSummary[]}
 */
function invidiousRelated(video) {
  const recommended = Array.isArray(video.recommendedVideos) ? video.recommendedVideos : []

  return recommended.map((item) => {
    const summary = { type: 'video', ...item }

    if (typeof item.published === 'string') {
      summary.published = Date.parse(item.published)
    }

    return summary
  })
}

/**
 * @param {string} id
 * @param {any} video what `invidiousGetVideoInformation` answered
 * @param {object} deps
 * @param {import('./deps').YouTubeDeps} deps.youtube
 * @param {Readonly<import('../index').PlatformConfig>} deps.config
 * @returns {import('../shapes').VideoDetails}
 */
export function invidiousVideoDetails(id, video, { youtube, config }) {
  const instance = config.currentInvidiousInstanceUrl
  const live = !!video.liveNow
  const upcoming = !!video.isUpcoming
  const liveStatus = liveStatusOf({ live, upcoming, postLiveDvr: !!video.isPostLiveDvr })

  const authorId = typeof video.authorId === 'string' ? video.authorId : ''
  const author = typeof video.author === 'string' ? video.author : ''
  const channelThumbnail = video.authorThumbnails?.[1]?.url
  const authorThumbnail = channelThumbnail ? youtube.youtubeImageUrlToInvidious(channelThumbnail, instance) : ''

  /** @type {import('../shapes').ManifestPlaybackSource | null} */
  let playbackSource = null

  if (liveStatus === 'live' || liveStatus === 'ended') {
    playbackSource = legacyOnlySource([], live)
  } else if (liveStatus === null) {
    const formats = Array.isArray(video.formatStreams) ? video.formatStreams : []
    playbackSource = legacyOnlySource(formats.map(format => youtube.mapInvidiousLegacyFormat(format)), false)
  }

  /** @type {import('../shapes').VideoDetails} */
  const details = {
    ...youtubeConstants(id),
    title: typeof video.title === 'string' ? video.title : '',
    author,
    authorId,
    thumbnail: thumbnailFor(instance, id, config.thumbnailPreference, onInstance(instance, video.videoThumbnails?.[0]?.url)),
    liveNow: live,
    isUpcoming: upcoming,
    description: invidiousDescription(video),
    likeCount: numberOrNull(video.likeCount),
    dislikeCount: numberOrNull(video.dislikeCount),
    tags: stringsOf(video.keywords),
    category: categoryOf(video.genre),
    licence: null,
    channel: channelOf(authorId || null, author, authorThumbnail, subscriberCountOf(youtube, video.subCountText)),
    authorThumbnail,
    liveStatus,
    playbackSource,
    isUnlisted: video.isListed === false,
    related: invidiousRelated(video),
  }

  if (!live) {
    details.lengthSeconds = isNumber(video.lengthSeconds) ? video.lengthSeconds : ''
  }

  if (isNumber(video.published)) {
    details.published = video.published * 1000
  }

  if (isNumber(video.viewCount)) {
    details.viewCount = video.viewCount
  }

  if (upcoming && isNumber(video.premiereTimestamp)) {
    details.premiereDate = new Date(video.premiereTimestamp * 1000)
  }

  if (typeof video.isFamilyFriendly === 'boolean') {
    details.isFamilyFriendly = video.isFamilyFriendly
  }

  return details
}
