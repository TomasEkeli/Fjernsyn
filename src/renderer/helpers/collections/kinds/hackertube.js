/**
 * HackerTube as a source kind: hackertube.org recognised, its export asked
 * after, and its videos made shares.
 *
 * The app ships a stripped copy of HackerTube's export (the bundle, see
 * `../hackertube.js`), so a refresh only checks for a newer one: it asks
 * `/api/export` for the export's date, and only when that is newer than the
 * export loaded does it download `videos.jsonl` and `taxonomy.json` and strip
 * them as the bundle is stripped. Never the zip, and never `mentions.jsonl`.
 *
 * The build script (`_scripts/getHackerTubeBundle.mjs`) downloads through
 * these same functions, so it imports nothing but siblings by their full
 * names, and takes the `fetch` to use as the app's refresh does.
 */

import {
  HACKERTUBE_URL,
  hackerTubeShare,
  hackerTubeSource,
  stripHackerTubeExport,
} from '../hackertube.js'

export const HACKERTUBE_EXPORT_URL = `${HACKERTUBE_URL}/api/export`

/** The two files of the export the app uses, under `/download/` */
const HACKERTUBE_FILES = {
  videos: `${HACKERTUBE_URL}/download/videos.jsonl`,
  taxonomy: `${HACKERTUBE_URL}/download/taxonomy.json`,
}

/** The manifest is a few hundred bytes */
const MANIFEST_TIMEOUT_MS = 20_000

/** `videos.jsonl` is about 9 MB */
const DOWNLOAD_TIMEOUT_MS = 120_000

/**
 * Whether the export dated `generated` is newer than the one loaded. Dates
 * are compared as dates; one that cannot be read as a date is taken for newer
 * whenever it differs from the one loaded, so that a change in how HackerTube
 * writes it is loaded once, and then is the one loaded.
 *
 * @param {string} generated
 * @param {string | null | undefined} loaded
 * @returns {boolean}
 */
export function isNewerExport(generated, loaded) {
  if (loaded == null) { return true }
  if (generated === loaded) { return false }

  const generatedAt = Date.parse(generated)
  const loadedAt = Date.parse(loaded)

  if (Number.isFinite(generatedAt) && Number.isFinite(loadedAt)) {
    return generatedAt > loadedAt
  }

  return true
}

/**
 * @param {typeof fetch} fetchFn
 * @param {string} url
 * @param {number} timeout
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function get(fetchFn, url, timeout, init = {}) {
  const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeout) })

  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`)
  }

  return response
}

/**
 * HackerTube's export manifest: the export's date as `generated`, and the
 * files' sizes. Asked past any cache, since the whole point is to learn
 * whether it changed.
 *
 * @param {typeof fetch} fetchFn
 * @returns {Promise<{ generated: string, videos?: number }>}
 */
export async function fetchHackerTubeManifest(fetchFn) {
  const response = await get(fetchFn, HACKERTUBE_EXPORT_URL, MANIFEST_TIMEOUT_MS, { cache: 'no-cache' })
  const manifest = await response.json()

  if (typeof manifest?.generated !== 'string' || manifest.generated === '') {
    throw new Error(`${HACKERTUBE_EXPORT_URL}: no \`generated\` date in the manifest`)
  }

  return manifest
}

/**
 * HackerTube's export, `videos.jsonl` and `taxonomy.json`, downloaded and
 * stripped into the bundle's shape. A videos file without one video in it is
 * not taken for an export.
 *
 * @param {typeof fetch} fetchFn
 * @param {string} generated the manifest's date for it
 * @returns {Promise<import('../hackertube.js').HackerTubeBundle>}
 */
export async function downloadHackerTubeExport(fetchFn, generated) {
  const [videosText, taxonomy] = await Promise.all([
    get(fetchFn, HACKERTUBE_FILES.videos, DOWNLOAD_TIMEOUT_MS).then(response => response.text()),
    get(fetchFn, HACKERTUBE_FILES.taxonomy, DOWNLOAD_TIMEOUT_MS).then(response => response.json()),
  ])

  const bundle = stripHackerTubeExport({ generated, videosText, taxonomy })

  if (bundle.videos.length === 0) {
    throw new Error(`${HACKERTUBE_FILES.videos}: no videos in it`)
  }

  return bundle
}

/**
 * hackertube.org, at any path (its front page, its data page, its export's
 * URL, as an OPML file writes it), with or without `https://` and `www.`.
 *
 * @param {string} url
 * @param {number} now
 * @returns {import('../shares.js').Source | null}
 */
function recognise(url, now) {
  const text = url.trim()
  if (text === '') { return null }

  let parsed
  try {
    parsed = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') { return null }
  if (parsed.hostname !== 'hackertube.org' && parsed.hostname !== 'www.hackertube.org') { return null }

  return hackerTubeSource(now)
}

/**
 * The videos of a newer export than the one loaded, with its date to keep on
 * the source once they are in, and its taxonomy to keep apart; nothing when
 * the export is the one loaded, which costs one small request.
 *
 * @param {import('../shares.js').Source} source
 * @param {{ fetch: typeof fetch }} deps
 * @returns {Promise<import('./index.js').SourceFetch>}
 */
async function fetchItems(source, { fetch: fetchFn }) {
  const { generated } = await fetchHackerTubeManifest(fetchFn)

  if (!isNewerExport(generated, source.dataGenerated)) {
    return { items: [] }
  }

  const bundle = await downloadHackerTubeExport(fetchFn, generated)

  return {
    items: bundle.videos,
    sourceFields: { dataGenerated: bundle.generated },
    sourceData: { generated: bundle.generated, taxonomy: bundle.taxonomy },
  }
}

/** @type {import('./index.js').SourceKind} */
export const hackerTubeKind = {
  kind: 'hackertube',
  // Its videos come with the app, in the bundle the first open loads
  shipped: true,
  recognise,
  fetch: fetchItems,
  toShares: (items, _source, seenAt) => items.map(video => hackerTubeShare(video, seenAt)).filter(share => share !== null),
}
