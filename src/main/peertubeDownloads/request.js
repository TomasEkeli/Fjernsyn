/**
 * What main accepts from the renderer for a PeerTube download. The renderer
 * is not trusted with anything that decides where bytes come from or where
 * they go: the key must be a PeerTube key, the URL must look like a file an
 * instance serves for download, and the file name is built in main.
 */

/**
 * `peertube:<host>:<uuid>`, plus `:<suffix>` (a resolution, say) where one
 * video has more than one download. It can never match a YouTube video id,
 * which is 11 characters with no colon.
 */
const DOWNLOAD_KEY_PATTERN = /^peertube:([a-z0-9.-]+):[0-9a-f-]{36}(?::[\w-]+)?$/

export const KEY_PREFIX = 'peertube:'

const MAX_URL_LENGTH = 4096
const MAX_TITLE_LENGTH = 300
const MAX_LABEL_LENGTH = 40
const MAX_RESOLUTION = 10000

/**
 * Paths an instance serves files from: the download routes (including the
 * `generate` route that muxes split audio), the static and lazy-static file
 * routes, and the object storage proxy.
 */
const FILE_PATH_PREFIXES = ['/download/', '/static/', '/lazy-static/', '/object-storage/', '/object-storage-proxy/']

/**
 * Files on object storage live on another host, under paths of the storage's
 * own choosing; what they have in common is the media extension.
 */
const MEDIA_EXTENSION_PATTERN = /\.(?:mp4|m4a|mp3|ogg|webm)$/i

/**
 * @param {unknown} key
 * @returns {key is string}
 */
export function isValidDownloadKey(key) {
  return typeof key === 'string' && DOWNLOAD_KEY_PATTERN.test(key)
}

/**
 * @param {string} key a valid key
 */
export function keyHost(key) {
  return /** @type {RegExpExecArray} */ (DOWNLOAD_KEY_PATTERN.exec(key))[1]
}

/**
 * The URL rule, for the URL the renderer sends and for every redirect on the
 * way to the file. `https:` only, from any host: PeerTube files may be on
 * object storage elsewhere, and instances and their storage serve https.
 * Never a user or password in the URL. The path must be one of the
 * instance's file routes, or end in a media extension (mp4, m4a, mp3, ogg,
 * webm), so that main is not a general purpose fetcher for whatever a
 * renderer asks.
 *
 * @param {unknown} value
 * @returns {string | null} the URL, or null when refused
 */
export function checkFileUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) {
    return null
  }

  const url = URL.parse(value)
  if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return null
  }

  const allowedPath = FILE_PATH_PREFIXES.some(prefix => url.pathname.startsWith(prefix)) ||
    MEDIA_EXTENSION_PATTERN.test(url.pathname)

  return allowedPath ? url.href : null
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function checkPageUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) {
    return null
  }

  const url = URL.parse(value)
  return url !== null && (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : null
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function cappedString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/**
 * @typedef {object} PeerTubeDownloadRequest
 * @property {string} key `peertube:<host>:<uuid>[:<suffix>]`
 * @property {string} url the file, or the generate URL for split audio
 * @property {string} title for the file name, toasts and the panel
 * @property {string} label shown as the quality, e.g. `1080p`
 * @property {number | null} resolution the height, 0 for audio only, null when not known
 * @property {boolean} audioOnly
 * @property {string | null} videoUrl the video's page on its instance, kept for reference
 */

/**
 * @param {unknown} payload what the renderer sent
 * @returns {PeerTubeDownloadRequest | null} null when refused
 */
export function validateDownloadRequest(payload) {
  if (payload == null || typeof payload !== 'object') {
    return null
  }

  const { key, url, title, label, resolution, audioOnly, videoUrl } = /** @type {Record<string, unknown>} */ (payload)

  if (!isValidDownloadKey(key)) {
    return null
  }

  const fileUrl = checkFileUrl(url)
  if (fileUrl === null) {
    return null
  }

  return {
    key,
    url: fileUrl,
    title: cappedString(title, MAX_TITLE_LENGTH),
    label: cappedString(label, MAX_LABEL_LENGTH),
    resolution: Number.isInteger(resolution) && resolution >= 0 && resolution <= MAX_RESOLUTION ? /** @type {number} */ (resolution) : null,
    audioOnly: audioOnly === true,
    videoUrl: checkPageUrl(videoUrl),
  }
}
