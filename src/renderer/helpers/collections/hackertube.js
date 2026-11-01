/**
 * HackerTube as a source: its export stripped to what the app uses, and its
 * videos as shares.
 *
 * HackerTube (https://hackertube.org) gathers the YouTube videos Hacker News
 * has recommended over nineteen years, with an LLM's notes on each, and
 * publishes them under ODC-By 1.0. The app ships a stripped copy of that
 * export (`static/collections/hackertube.json.gz`, made by
 * `_scripts/getHackerTubeBundle.mjs`), and the update check strips a fresh
 * export with the same functions, so the two never disagree on the shape.
 *
 * Framework-free, and importing only its sibling by its full name, so that the
 * build script can run it in Node as it is.
 */

import { shareId } from './shares.js'

export const HACKERTUBE_SOURCE_ID = 'hackertube'
export const HACKERTUBE_URL = 'https://hackertube.org'

/** The bundle's own shape, raised when it changes in a way old code cannot read */
export const HACKERTUBE_BUNDLE_FORMAT_VERSION = 1

const YOUTUBE_VIDEO_ID = /^[\w-]{11}$/

/**
 * @typedef {object} HackerTubeVideo one video as the bundle keeps it: the
 * fields of a row of HackerTube's `videos.jsonl` the app uses, under their
 * own names, with the categories as their ids
 * @property {string} vid
 * @property {string} title
 * @property {string} channel
 * @property {string | null} why_hn
 * @property {string[]} categories
 * @property {number | null} score
 * @property {{ recommenders: number | null, first_year: number | null, last_year: number | null }} hn
 * @property {{ hn_comment_id: number } | null} quote
 */

/**
 * @typedef {object} HackerTubeTaxonomy
 * @property {string | null} version
 * @property {{ id: string, name: string, categories: { id: string, name: string }[] }[]} areas
 */

/**
 * @typedef {object} HackerTubeBundle
 * @property {number} formatVersion
 * @property {string} generated the export's date, as HackerTube gives it (`2026-10-31`)
 * @property {HackerTubeTaxonomy} taxonomy
 * @property {HackerTubeVideo[]} videos
 */

/**
 * @typedef {object} Share one occurrence of a video in a source
 * @property {string} _id the source id and the video's ref, see `shareId`
 * @property {string} sourceId
 * @property {string} videoId a YouTube video id, or a PeerTube video's uuid
 * @property {'peertube'} [platform] PeerTube only, as on every stored video
 * @property {string} [host] PeerTube only: the video's origin
 * @property {string} title what the source calls it, until the video's own details are known
 * @property {string} author the channel name the source gives, likewise
 * @property {number | null} votes the source's votes for it; null where the source has none
 * @property {string | null} why the source's reason for it
 * @property {number | null} sharedAt when it was shared, in ms
 * @property {string | null} discussionUrl where the source discusses it
 * @property {string[]} [categories] HackerTube's category ids
 * @property {number} seenAt when the source was last seen to carry it, in ms
 */

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringOrEmpty(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One row of HackerTube's `videos.jsonl`, or a row already stripped, reduced
 * to what the app uses: `vid`, `title`, `channel`, `why_hn`, the category
 * ids, `score`, `hn.recommenders`, `hn.first_year`, `hn.last_year` and
 * `quote.hn_comment_id`. Nothing for a row without a YouTube video id.
 *
 * @param {any} row
 * @returns {HackerTubeVideo | null}
 */
export function stripHackerTubeVideo(row) {
  if (!isObject(row) || typeof row.vid !== 'string' || !YOUTUBE_VIDEO_ID.test(row.vid)) {
    return null
  }

  const categories = Array.isArray(row.categories)
    ? row.categories
        .map(category => typeof category === 'string' ? category : (isObject(category) ? category.id : null))
        .filter(id => typeof id === 'string' && id !== '')
    : []

  const hn = isObject(row.hn) ? row.hn : {}
  const commentId = isObject(row.quote) ? numberOrNull(row.quote.hn_comment_id) : null

  return {
    vid: row.vid,
    title: stringOrEmpty(row.title),
    channel: stringOrEmpty(row.channel),
    why_hn: typeof row.why_hn === 'string' ? row.why_hn : null,
    categories,
    score: numberOrNull(row.score),
    hn: {
      recommenders: numberOrNull(hn.recommenders),
      first_year: numberOrNull(hn.first_year),
      last_year: numberOrNull(hn.last_year),
    },
    quote: commentId === null ? null : { hn_comment_id: commentId },
  }
}

/**
 * HackerTube's `taxonomy.json` without the descriptions: its areas, and the
 * categories in each, by id and name.
 *
 * @param {any} taxonomy
 * @returns {HackerTubeTaxonomy}
 */
export function stripHackerTubeTaxonomy(taxonomy) {
  if (!isObject(taxonomy) || !Array.isArray(taxonomy.areas)) {
    return { version: null, areas: [] }
  }

  const named = item => isObject(item) && typeof item.id === 'string' && typeof item.name === 'string'

  return {
    version: typeof taxonomy.version === 'string' ? taxonomy.version : null,
    areas: taxonomy.areas.filter(named).map(area => ({
      id: area.id,
      name: area.name,
      categories: (Array.isArray(area.categories) ? area.categories : [])
        .filter(named)
        .map(category => ({ id: category.id, name: category.name })),
    })),
  }
}

/**
 * A HackerTube export, as downloaded, stripped into the bundle's shape. Lines
 * that do not parse, and rows without a YouTube video id, are skipped; a
 * video met twice is kept as first met.
 *
 * @param {{ generated: string, videosText: string, taxonomy: any }} exported
 *   the manifest's `generated`, `videos.jsonl` as text, and `taxonomy.json` parsed
 * @returns {HackerTubeBundle}
 */
export function stripHackerTubeExport({ generated, videosText, taxonomy }) {
  const videos = []
  const seen = new Set()

  for (const line of videosText.split(/\r?\n/)) {
    if (line.trim() === '') { continue }

    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }

    const video = stripHackerTubeVideo(row)
    if (video === null || seen.has(video.vid)) { continue }

    seen.add(video.vid)
    videos.push(video)
  }

  return {
    formatVersion: HACKERTUBE_BUNDLE_FORMAT_VERSION,
    generated,
    taxonomy: stripHackerTubeTaxonomy(taxonomy),
    videos,
  }
}

/**
 * A HackerTube video, raw or stripped, as HackerTube's share of it. Its votes
 * are HackerTube's score, its why HN's reason as HackerTube puts it, and its
 * discussion the HN comment HackerTube quotes. HackerTube dates a video only
 * by the years HN talked about it, so it counts as shared on the first of
 * January (UTC) of the last of them.
 *
 * @param {any} row
 * @param {number} seenAt
 * @returns {Share | null}
 */
export function hackerTubeShare(row, seenAt) {
  const video = stripHackerTubeVideo(row)
  if (video === null) { return null }

  const lastYear = video.hn.last_year
  const commentId = video.quote?.hn_comment_id

  return {
    _id: shareId(HACKERTUBE_SOURCE_ID, { videoId: video.vid }),
    sourceId: HACKERTUBE_SOURCE_ID,
    videoId: video.vid,
    title: video.title,
    author: video.channel,
    votes: video.score,
    why: video.why_hn === '' ? null : video.why_hn,
    sharedAt: lastYear === null ? null : Date.UTC(lastYear, 0, 1),
    discussionUrl: commentId == null ? null : `https://news.ycombinator.com/item?id=${commentId}`,
    categories: video.categories,
    seenAt,
  }
}

/**
 * @typedef {object} Source one followed place that shares videos
 * @property {string} _id
 * @property {string} kind
 * @property {string} url
 * @property {string} name
 * @property {number} followedAt
 * @property {string | null} [dataGenerated] HackerTube only: the `generated`
 *   of the data loaded into this installation's shares, null before any is
 */

/**
 * HackerTube as a followed source, before any of its data is loaded.
 *
 * @param {number} followedAt
 * @returns {Source}
 */
export function hackerTubeSource(followedAt) {
  return {
    _id: HACKERTUBE_SOURCE_ID,
    kind: 'hackertube',
    url: HACKERTUBE_URL,
    name: 'HackerTube',
    followedAt,
    dataGenerated: null,
  }
}
