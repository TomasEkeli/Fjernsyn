/**
 * The name a PeerTube download is saved under, built in main from the title
 * and the resolution, never taken from the renderer or the server as is.
 */

// Room is left for ` [2160p] (99).webm.part` within the 255 bytes most file
// systems allow a name, and the stem kept short enough that a full path
// stays well inside Windows' traditional 260 characters
const MAX_STEM_CHARACTERS = 120
const MAX_STEM_BYTES = 180
const MAX_TAG_CHARACTERS = 20
const MAX_TAG_BYTES = 30

// Characters Windows refuses in a name, and the path separators everywhere
const RESERVED_CHARACTERS = /[<>:"/\\|?*]/g

// Direction overrides and zero-width characters, which can make
// `evil\u202Ekp4.exe` read as `evilexe.4pm`
const INVISIBLE_CHARACTERS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

// Windows refuses these as names, with or without an extension
const RESERVED_NAMES = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i

const CONTENT_TYPE_EXTENSIONS = {
  'video/mp4': 'mp4',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'video/ogg': 'ogg',
  'video/webm': 'webm',
  'audio/webm': 'webm',
}

const URL_EXTENSION = /\.(mp4|m4a|mp3|ogg|webm)$/i

const encoder = new TextEncoder()

/**
 * @param {string} text
 * @param {number} maxCharacters
 * @param {number} maxBytes in UTF-8
 */
function sanitise(text, maxCharacters, maxBytes) {
  let cleaned = ''
  for (const char of text.normalize('NFC')) {
    const code = /** @type {number} */ (char.codePointAt(0))
    // Control characters, C0 and C1
    cleaned += code < 0x20 || (code >= 0x7F && code <= 0x9F) ? ' ' : char
  }

  cleaned = cleaned
    .replaceAll(INVISIBLE_CHARACTERS, '')
    .replaceAll(RESERVED_CHARACTERS, '_')
    .replaceAll(/\s+/g, ' ')
    .trim()

  // Capped by characters and by bytes, a whole character at a time
  let capped = ''
  let size = 0
  let count = 0
  for (const char of cleaned) {
    size += encoder.encode(char).length
    count++
    if (size > maxBytes || count > maxCharacters) {
      break
    }
    capped += char
  }

  // No hidden files, no `..`, and nothing Windows would strip from the end
  return capped.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
}

/**
 * @param {object} parts
 * @param {string} parts.title
 * @param {string} parts.fallback used when nothing is left of the title: the video's uuid
 * @param {string | null} parts.tag the resolution (`1080p`), `audio`, or a label, in brackets after the title
 * @param {string} parts.extension without the dot
 */
export function buildFileName({ title, fallback, tag, extension }) {
  let stem = sanitise(title, MAX_STEM_CHARACTERS, MAX_STEM_BYTES) || fallback

  if (RESERVED_NAMES.test(stem.split('.')[0].trim())) {
    stem = `_${stem}`
  }

  const cleanTag = tag === null ? '' : sanitise(tag, MAX_TAG_CHARACTERS, MAX_TAG_BYTES)

  return cleanTag ? `${stem} [${cleanTag}].${extension}` : `${stem}.${extension}`
}

/**
 * The extension from what the server says the file is, or else from the URL
 * it came from in the end, or else what PeerTube serves: MP4, or M4A for
 * audio only.
 *
 * @param {object} response
 * @param {string | null} response.contentType
 * @param {string} response.url after redirects
 * @param {boolean} response.audioOnly
 */
export function chooseExtension({ contentType, url, audioOnly }) {
  const type = contentType?.split(';')[0].trim().toLowerCase()
  if (type && Object.hasOwn(CONTENT_TYPE_EXTENSIONS, type)) {
    return CONTENT_TYPE_EXTENSIONS[type]
  }

  const fromUrl = URL_EXTENSION.exec(URL.parse(url)?.pathname ?? '')
  if (fromUrl) {
    return fromUrl[1].toLowerCase()
  }

  return audioOnly ? 'm4a' : 'mp4'
}

/**
 * `Title [1080p].mp4`, then `Title [1080p] (2).mp4` and so on.
 *
 * @param {string} name
 * @param {number} n from 1
 */
export function numberedName(name, n) {
  if (n === 1) {
    return name
  }

  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`
}
