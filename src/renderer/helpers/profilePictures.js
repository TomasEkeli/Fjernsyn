// Profile pictures: a symbol, an icon or an image drawn in a profile's bubble
// in place of its initial. Stored in the `profilePictures` setting, keyed by
// profile id, rather than on the profile records, which upstream code rebuilds
// from named fields and writes back whole. See
// `.scratch/profile-pictures/spec.md`.
//
// Imports nothing from the app (`helpers/strings.js` pulls in i18n), so its
// checks need neither i18n nor a store.

/**
 * @typedef {{ kind: 'symbol', text: string }
 *   | { kind: 'icon', name: string, width: number, height: number, path: string }
 *   | { kind: 'image', src: string }} ProfilePicture
 */

/** Long zero width joiner sequences are around 35 code units */
const SYMBOL_MAX_LENGTH = 64
const ICON_NAME = /^[a-z0-9-]{1,64}$/
/** The pack's largest is 640 by 512 */
const ICON_MAX_SIZE = 2048
/** Path commands, numbers and separators: nothing that could close the attribute it goes into */
const ICON_PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/
/** The pack's longest is 2,479 */
const ICON_PATH_MAX_LENGTH = 10_000
/** Only what the app makes itself from a local file, so no stored value can make it fetch anything */
const IMAGE_SRC = /^data:image\/(webp|png);base64,[A-Za-z0-9+/]+=*$/
const IMAGE_SRC_MAX_LENGTH = 100_000

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)

  return prototype === Object.prototype || prototype === null
}

/**
 * @param {unknown} size
 */
function isIconSize(size) {
  return Number.isInteger(size) && size >= 1 && size <= ICON_MAX_SIZE
}

/**
 * A picture as it may be stored, checked field by field, and copied so that
 * nothing else stored with it comes along.
 * @param {unknown} value
 * @returns {ProfilePicture | null} null for anything that is not a valid picture
 */
export function validProfilePicture(value) {
  if (!isPlainObject(value)) {
    return null
  }

  switch (value.kind) {
    case 'symbol': {
      const { text } = value

      if (typeof text !== 'string' || text.trim() === '' || text.length > SYMBOL_MAX_LENGTH) {
        return null
      }

      return { kind: 'symbol', text }
    }
    case 'icon': {
      const { name, width, height, path } = value

      if (typeof name !== 'string' || !ICON_NAME.test(name) ||
        !isIconSize(width) || !isIconSize(height) ||
        typeof path !== 'string' || path.length > ICON_PATH_MAX_LENGTH || !ICON_PATH.test(path)) {
        return null
      }

      return { kind: 'icon', name, width: /** @type {number} */ (width), height: /** @type {number} */ (height), path }
    }
    case 'image': {
      const { src } = value

      if (typeof src !== 'string' || src.length > IMAGE_SRC_MAX_LENGTH || !IMAGE_SRC.test(src)) {
        return null
      }

      return { kind: 'image', src }
    }
    default:
      return null
  }
}

/**
 * The stored setting is trusted for nothing: it can be hand edited, or
 * written by another version of the app.
 * @param {unknown} pictures the stored setting
 * @param {string} profileId
 * @returns {ProfilePicture | null} null for anything that is not a valid picture
 */
export function readProfilePicture(pictures, profileId) {
  if (!isPlainObject(pictures) || typeof profileId !== 'string' || !Object.hasOwn(pictures, profileId)) {
    return null
  }

  return validProfilePicture(pictures[profileId])
}

/**
 * @param {ProfilePicture | null} a
 * @param {ProfilePicture | null} b
 * @returns {boolean} whether they draw the same, null being no picture
 */
export function sameProfilePicture(a, b) {
  if (a === null || b === null) {
    return a === b
  }

  switch (a.kind) {
    case 'symbol':
      return b.kind === 'symbol' && a.text === b.text
    case 'icon':
      return b.kind === 'icon' && a.name === b.name && a.width === b.width && a.height === b.height && a.path === b.path
    case 'image':
      return b.kind === 'image' && a.src === b.src
    default:
      return false
  }
}

/**
 * The setting with one profile's picture changed. It holds only entries for
 * profiles that exist and read as valid, so each write sweeps out those of
 * deleted profiles, as the profile order's writes do.
 * @param {unknown} pictures the stored setting
 * @param {string[]} profileIds every profile that exists
 * @param {string} profileId
 * @param {ProfilePicture | null} picture null removes it, as does one that is not valid
 * @returns {Record<string, ProfilePicture>} a new object
 */
export function withProfilePicture(pictures, profileIds, profileId, picture) {
  /** @type {[string, ProfilePicture][]} */
  const entries = []

  for (const id of profileIds) {
    if (id === profileId) { continue }

    const kept = readProfilePicture(pictures, id)

    if (kept !== null) {
      entries.push([id, kept])
    }
  }

  const added = validProfilePicture(picture)

  if (added !== null) {
    entries.push([profileId, added])
  }

  // Not assigned one by one: an id of `__proto__` would set the prototype
  return Object.fromEntries(entries)
}

const HEX_COLOUR = /^#[0-9a-fA-F]{3,8}$/

/**
 * An icon as an SVG data URL, filled in the text colour. The path is safe to
 * put in an attribute by the reader's pattern; the colour is checked here.
 * @param {{ width: number, height: number, path: string }} icon
 * @param {string} textColor
 */
function iconDataUrl({ width, height, path }, textColor) {
  const fill = HEX_COLOUR.test(textColor) ? textColor : '#FFFFFF'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><path fill="${fill}" d="${path}"/></svg>`

  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/**
 * How a profile's circle is drawn, wherever one is: its inline style and its
 * text. With no picture, exactly the style every place had before pictures.
 * The colour stays behind an image as the last layer, so it shows through a
 * transparent one and while one is decoding.
 * @param {ProfilePicture | null} picture
 * @param {{ bgColor: string, textColor: string, initial: string }} bubble
 * @returns {{ style: { background: string, color: string }, text: string }}
 */
export function profileBubble(picture, { bgColor, textColor, initial }) {
  switch (picture?.kind) {
    case 'symbol':
      return { style: { background: bgColor, color: textColor }, text: picture.text }
    case 'icon':
      return {
        style: { background: `url("${iconDataUrl(picture, textColor)}") center / 55% no-repeat, ${bgColor}`, color: textColor },
        text: ''
      }
    case 'image':
      return {
        style: { background: `url("${picture.src}") center / cover no-repeat, ${bgColor}`, color: textColor },
        text: ''
      }
    default:
      return { style: { background: bgColor, color: textColor }, text: initial }
  }
}

/**
 * What a symbol typed or pasted in becomes. Found as `getFirstCharacter`
 * finds a profile's initial, so that emoji joined with zero width joiners,
 * flags and skin tones stay whole.
 * @param {string} text
 * @param {string} locale
 * @returns {string} the first grapheme of the trimmed text, or ''
 */
export function firstSymbol(text, locale) {
  const trimmed = text.trim()

  if (trimmed === '') {
    return ''
  }

  const segmenter = new Intl.Segmenter([locale, 'en'], { granularity: 'grapheme' })

  return segmenter.segment(trimmed)[Symbol.iterator]().next().value.segment
}

/**
 * An icon the picker offers: what a picture of it stores, and the other names
 * it can be found by.
 * @typedef {{ name: string, width: number, height: number, path: string, aliases: string[] }} PickerIcon
 */

/**
 * Every icon in the solid pack, once each. The pack exports each icon under
 * several names (`faHome` and `faHouse` are one object), and exports more
 * than icons. An icon that could not be stored as a picture, of which the
 * pack has none, is left out, so that every one offered can be picked.
 * @param {Record<string, unknown>} module the pack, as imported
 * @returns {PickerIcon[]}
 */
export function uniqueIcons(module) {
  /** @type {Map<string, PickerIcon>} */
  const icons = new Map()

  for (const definition of Object.values(module)) {
    if (!isPlainObject(definition) || definition.prefix !== 'fas' || !Array.isArray(definition.icon)) { continue }

    const [width, height, aliases, , path] = definition.icon
    const picture = validProfilePicture({ kind: 'icon', name: definition.iconName, width, height, path })

    if (picture === null || picture.kind !== 'icon' || icons.has(picture.name)) { continue }

    icons.set(picture.name, {
      name: picture.name,
      width: picture.width,
      height: picture.height,
      path: picture.path,
      aliases: Array.isArray(aliases) ? aliases.filter(alias => typeof alias === 'string') : []
    })
  }

  return [...icons.values()]
}

/**
 * @param {string} text
 */
function searchKey(text) {
  return text.toLowerCase().replaceAll(/[\s-]+/g, '')
}

/**
 * @param {PickerIcon} a
 * @param {PickerIcon} b
 */
function byName(a, b) {
  if (a.name < b.name) { return -1 }
  if (a.name > b.name) { return 1 }

  return 0
}

/**
 * The icons whose name or one of whose aliases has the query in it, compared
 * lower case and without spaces or hyphens, so "game pad" finds `gamepad`
 * and "home" finds `house`. Those whose name starts with it come first, then
 * the rest, each alphabetically. The free packs ship no keywords, so
 * "science" does not find `flask`.
 * @param {PickerIcon[]} icons
 * @param {string} query
 * @returns {PickerIcon[]} a new array; every icon, alphabetically, for an empty query
 */
export function searchIcons(icons, query) {
  const key = searchKey(query)

  if (key === '') {
    return [...icons].sort(byName)
  }

  const first = []
  const rest = []

  for (const icon of icons) {
    const name = searchKey(icon.name)

    if (name.startsWith(key)) {
      first.push(icon)
    } else if (name.includes(key) || icon.aliases.some(alias => searchKey(alias).includes(key))) {
      rest.push(icon)
    }
  }

  return [...first.sort(byName), ...rest.sort(byName)]
}

/**
 * The largest square in the middle of an image, which is what an image
 * picture shows: there is no cropping by hand.
 * @param {number} width
 * @param {number} height
 * @returns {{ sx: number, sy: number, size: number }} its left and top edges, and its side
 */
export function squareCrop(width, height) {
  const size = Math.min(width, height)

  return {
    sx: Math.floor((width - size) / 2),
    sy: Math.floor((height - size) / 2),
    size
  }
}
