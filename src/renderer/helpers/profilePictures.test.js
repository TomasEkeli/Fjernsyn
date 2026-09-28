import { describe, expect, it } from 'vitest'

import {
  firstSymbol,
  profileBubble,
  readProfilePicture,
  sameProfilePicture,
  searchIcons,
  squareCrop,
  uniqueIcons,
  withProfilePicture,
} from './profilePictures'

const SYMBOL = { kind: 'symbol', text: '🎵' }
const ICON = { kind: 'icon', name: 'music', width: 512, height: 512, path: 'M499.1 6.3c8.1 6 12.9 15.6 12.9 25.7v72z' }
const IMAGE = { kind: 'image', src: 'data:image/webp;base64,UklGRhYAAABXRUJQVlA4TAoAAAAvAAAAAEX/I/of' }

/**
 * @param {unknown} picture
 */
function read(picture) {
  return readProfilePicture({ p1: picture }, 'p1')
}

describe('readProfilePicture', () => {
  it('returns each kind of picture that is valid', () => {
    expect(read(SYMBOL)).toEqual(SYMBOL)
    expect(read(ICON)).toEqual(ICON)
    expect(read(IMAGE)).toEqual(IMAGE)
    expect(read({ kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=' })).toEqual({ kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=' })
  })

  it('returns only the fields a picture has, not whatever else was stored with it', () => {
    expect(read({ ...SYMBOL, colour: 'red' })).toEqual(SYMBOL)
  })

  it('reads nothing from a setting that is not an object', () => {
    for (const setting of [null, undefined, 'p1', 42, [SYMBOL], true]) {
      expect(readProfilePicture(setting, '0')).toBeNull()
    }
  })

  it('reads nothing for a profile with no entry', () => {
    expect(readProfilePicture({ p1: SYMBOL }, 'p2')).toBeNull()
  })

  it('reads nothing but own entries, so an id like "constructor" is not a picture', () => {
    expect(readProfilePicture({}, 'constructor')).toBeNull()
    expect(readProfilePicture({}, '__proto__')).toBeNull()
    expect(readProfilePicture(Object.create({ p1: SYMBOL }), 'p1')).toBeNull()
  })

  it('reads nothing of an unknown kind, or of no kind', () => {
    expect(read({ kind: 'video', src: IMAGE.src })).toBeNull()
    expect(read({ text: '🎵' })).toBeNull()
    expect(read('🎵')).toBeNull()
    expect(read(null)).toBeNull()
  })

  it('refuses a symbol that is empty, only spaces, too long or not text', () => {
    expect(read({ kind: 'symbol', text: '' })).toBeNull()
    expect(read({ kind: 'symbol', text: '   ' })).toBeNull()
    expect(read({ kind: 'symbol', text: 'x'.repeat(65) })).toBeNull()
    expect(read({ kind: 'symbol', text: 7 })).toBeNull()
  })

  it('takes a long emoji sequence as a symbol', () => {
    // A family of four, joined with zero width joiners: 11 code units
    expect(read({ kind: 'symbol', text: '👨‍👩‍👧‍👦' })).toEqual({ kind: 'symbol', text: '👨‍👩‍👧‍👦' })
    expect(read({ kind: 'symbol', text: 'x'.repeat(64) })).not.toBeNull()
  })

  it('refuses an icon with a bad name', () => {
    for (const name of ['', 'Music', 'music note', 'a"b', 'x'.repeat(65), 7]) {
      expect(read({ ...ICON, name })).toBeNull()
    }
  })

  it('refuses an icon whose width or height is out of range or not a whole number', () => {
    for (const size of [0, -1, 2049, 1.5, '512', Number.NaN, Infinity]) {
      expect(read({ ...ICON, width: size })).toBeNull()
      expect(read({ ...ICON, height: size })).toBeNull()
    }

    expect(read({ ...ICON, width: 1, height: 2048 })).not.toBeNull()
  })

  it('refuses an icon path with a quote, a letter that is no path command, or that is too long', () => {
    expect(read({ ...ICON, path: 'M0 0"/><script/>' })).toBeNull()
    expect(read({ ...ICON, path: "M0 0'" })).toBeNull()
    expect(read({ ...ICON, path: 'M0 0 X1 1' })).toBeNull()
    expect(read({ ...ICON, path: 'M0 0<' })).toBeNull()
    expect(read({ ...ICON, path: '' })).toBeNull()
    expect(read({ ...ICON, path: 'M0 0' + ' L1 1'.repeat(2000) })).toBeNull()
    expect(read({ ...ICON, path: ['M0 0'] })).toBeNull()
  })

  it('refuses an image that is not a base64 WebP or PNG data URL the app could have made', () => {
    for (const src of [
      'https://example.com/a.webp',
      'file:///home/tomas/a.png',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'data:image/svg+xml,<svg></svg>',
      'data:image/jpeg;base64,/9j/4AAQ',
      'data:image/webp,UklGRhYAAABX',
      'data:image/webp;base64,UklGR hYAAABX',
      'data:image/webp;base64,Ukl")GRh',
      'data:image/webp;base64,',
      ' data:image/webp;base64,UklGRhYAAABX',
    ]) {
      expect(read({ kind: 'image', src })).toBeNull()
    }
  })

  it('refuses an image too long to be one the app made', () => {
    const src = 'data:image/webp;base64,' + 'A'.repeat(100_000)

    expect(read({ kind: 'image', src })).toBeNull()
  })
})

describe('profileBubble', () => {
  const BUBBLE = { bgColor: '#3F51B5', textColor: '#FFFFFF', initial: 'M' }

  /**
   * @param {string} background
   * @returns {string} the SVG in the background's data URL, decoded
   */
  function decodedSvg(background) {
    const match = /^url\("data:image\/svg\+xml,([^"]*)"\) /.exec(background)

    expect(match).not.toBeNull()

    return decodeURIComponent(match[1])
  }

  it('draws no picture as the colour and the initial, as a bubble always was', () => {
    expect(profileBubble(null, BUBBLE)).toEqual({ style: { background: '#3F51B5', color: '#FFFFFF' }, text: 'M' })
  })

  it('draws a symbol on the colour in place of the initial', () => {
    expect(profileBubble(SYMBOL, BUBBLE)).toEqual({ style: { background: '#3F51B5', color: '#FFFFFF' }, text: '🎵' })
  })

  it('draws an icon as an SVG in the text colour over the colour, and no text', () => {
    const { style, text } = profileBubble(ICON, BUBBLE)
    const svg = decodedSvg(style.background)

    expect(text).toBe('')
    expect(style.color).toBe('#FFFFFF')
    expect(style.background).toMatch(/\) center \/ 55% no-repeat, #3F51B5$/)
    expect(svg).toBe(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="#FFFFFF" d="${ICON.path}"/></svg>`)
  })

  it('fills an icon in white when the text colour is not a hex colour', () => {
    const { style } = profileBubble(ICON, { ...BUBBLE, textColor: 'red"/><script>' })

    expect(decodedSvg(style.background)).toContain('fill="#FFFFFF"')
    expect(decodedSvg(profileBubble(ICON, { ...BUBBLE, textColor: '#000' }).style.background)).toContain('fill="#000"')
  })

  it('draws an image covering the circle, with the colour behind it, and no text', () => {
    expect(profileBubble(IMAGE, BUBBLE)).toEqual({
      style: { background: `url("${IMAGE.src}") center / cover no-repeat, #3F51B5`, color: '#FFFFFF' },
      text: '',
    })
  })
})

describe('firstSymbol', () => {
  it('takes the first character', () => {
    expect(firstSymbol('music', 'en-US')).toBe('m')
  })

  it('takes an emoji whole', () => {
    expect(firstSymbol('🎵 music', 'en-US')).toBe('🎵')
  })

  it('takes a family joined with zero width joiners whole', () => {
    expect(firstSymbol('👨‍👩‍👧‍👦👍', 'en-US')).toBe('👨‍👩‍👧‍👦')
  })

  it('takes a flag whole', () => {
    expect(firstSymbol('🇳🇴🇸🇪', 'nb-NO')).toBe('🇳🇴')
  })

  it('skips leading spaces', () => {
    expect(firstSymbol('   ★ stars', 'en-US')).toBe('★')
  })

  it('gives nothing for nothing, or only spaces', () => {
    expect(firstSymbol('', 'en-US')).toBe('')
    expect(firstSymbol(' \t ', 'en-US')).toBe('')
  })
})

describe('uniqueIcons', () => {
  const house = { prefix: 'fas', iconName: 'house', icon: [576, 512, [127968, 63498, 'home', 'home-alt'], 'f015', 'M0 0h576v512z'] }
  const flask = { prefix: 'fas', iconName: 'flask', icon: [448, 512, [], 'f0c3', 'M288 0z'] }

  it('keeps one entry for an icon exported under several names', () => {
    const icons = uniqueIcons({ faHouse: house, faHome: house, faHomeAlt: house, faFlask: flask })

    expect(icons).toHaveLength(2)
    expect(icons).toContainEqual({ name: 'house', width: 576, height: 512, path: 'M0 0h576v512z', aliases: ['home', 'home-alt'] })
    expect(icons).toContainEqual({ name: 'flask', width: 448, height: 512, path: 'M288 0z', aliases: [] })
  })

  it('takes only solid icons, and nothing else the pack exports', () => {
    const brand = { prefix: 'fab', iconName: 'github', icon: [496, 512, [], 'f09b', 'M165 0z'] }

    expect(uniqueIcons({ faHouse: house, faGithub: brand, fas: { faHouse: house }, prefix: 'fas', faNothing: null }))
      .toEqual([{ name: 'house', width: 576, height: 512, path: 'M0 0h576v512z', aliases: ['home', 'home-alt'] }])
  })

  it('leaves out an icon that could not be stored as a picture', () => {
    const duotone = { prefix: 'fas', iconName: 'two', icon: [512, 512, [], 'f000', ['M0 0z', 'M1 1z']] }

    expect(uniqueIcons({ faTwo: duotone, faFlask: flask }).map(icon => icon.name)).toEqual(['flask'])
  })

  it('offers every icon of the installed pack, as every one of them can be stored', async () => {
    const pack = await import('@fortawesome/free-solid-svg-icons')
    const names = new Set(Object.values(pack).filter(value => value?.prefix === 'fas' && value.iconName).map(value => value.iconName))
    const icons = uniqueIcons(pack)

    expect(icons.length).toBe(names.size)
    expect(icons.length).toBeGreaterThan(1000)
    expect(icons.find(found => found.name === 'house').aliases).toContain('home')
  })
})

describe('searchIcons', () => {
  /**
   * @param {string} name
   * @param {string[]} [aliases]
   */
  function icon(name, aliases = []) {
    return { name, width: 512, height: 512, path: 'M0 0z', aliases }
  }

  const ICONS = [
    icon('house-chimney', ['home-lg']),
    icon('circle-arrow-down', ['arrow-circle-down']),
    icon('download'),
    icon('arrow-up'),
    icon('gamepad'),
    icon('house', ['home', 'home-alt']),
    icon('arrow-down'),
    icon('flask'),
  ]

  /**
   * @param {string} query
   */
  function names(query) {
    return searchIcons(ICONS, query).map(found => found.name)
  }

  it('finds an icon by its name', () => {
    expect(names('flask')).toEqual(['flask'])
    expect(names('chim')).toEqual(['house-chimney'])
  })

  it('finds an icon by one of its aliases', () => {
    expect(names('home')).toEqual(['house', 'house-chimney'])
  })

  it('ignores case', () => {
    expect(names('FlAsK')).toEqual(['flask'])
  })

  it('ignores spaces and hyphens, in the query and in the names', () => {
    expect(names('game pad')).toEqual(['gamepad'])
    expect(names('game-pad')).toEqual(['gamepad'])
    expect(names('house chimney')).toEqual(['house-chimney'])
    expect(names('arrowup')).toEqual(['arrow-up'])
  })

  it('puts icons whose name starts with the query first, then the rest, each alphabetically', () => {
    expect(names('down')).toEqual(['download', 'arrow-down', 'circle-arrow-down'])
  })

  it('gives every icon, alphabetically, for an empty query', () => {
    const everything = ['arrow-down', 'arrow-up', 'circle-arrow-down', 'download', 'flask', 'gamepad', 'house', 'house-chimney']

    expect(names('')).toEqual(everything)
    expect(names('  ')).toEqual(everything)
  })

  it('gives nothing when nothing matches', () => {
    expect(names('science')).toEqual([])
  })

  it('leaves the list it was given alone', () => {
    const before = ICONS.map(found => found.name)

    searchIcons(ICONS, '')

    expect(ICONS.map(found => found.name)).toEqual(before)
  })
})

describe('squareCrop', () => {
  it('takes the middle of a landscape image', () => {
    expect(squareCrop(1920, 1080)).toEqual({ sx: 420, sy: 0, size: 1080 })
  })

  it('takes the middle of a portrait image', () => {
    expect(squareCrop(600, 1000)).toEqual({ sx: 0, sy: 200, size: 600 })
  })

  it('takes all of a square image', () => {
    expect(squareCrop(512, 512)).toEqual({ sx: 0, sy: 0, size: 512 })
  })

  it('starts on a whole pixel when the difference is odd', () => {
    expect(squareCrop(101, 100)).toEqual({ sx: 0, sy: 0, size: 100 })
    expect(squareCrop(100, 103)).toEqual({ sx: 0, sy: 1, size: 100 })
  })
})

describe('sameProfilePicture', () => {
  it('is the same for equal pictures, however they were made', () => {
    expect(sameProfilePicture(null, null)).toBe(true)
    expect(sameProfilePicture(SYMBOL, { text: '🎵', kind: 'symbol' })).toBe(true)
    expect(sameProfilePicture(ICON, { ...ICON })).toBe(true)
    expect(sameProfilePicture(IMAGE, { ...IMAGE })).toBe(true)
  })

  it('differs for another kind, another value, or none', () => {
    expect(sameProfilePicture(SYMBOL, null)).toBe(false)
    expect(sameProfilePicture(null, IMAGE)).toBe(false)
    expect(sameProfilePicture(SYMBOL, { kind: 'symbol', text: '★' })).toBe(false)
    expect(sameProfilePicture(ICON, { ...ICON, path: 'M0 0z' })).toBe(false)
    expect(sameProfilePicture(ICON, { ...ICON, width: 448 })).toBe(false)
    expect(sameProfilePicture(IMAGE, { kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=' })).toBe(false)
  })
})

describe('withProfilePicture', () => {
  it('sets a picture for a profile that had none', () => {
    expect(withProfilePicture({}, ['p1', 'p2'], 'p2', ICON)).toEqual({ p2: ICON })
    expect(withProfilePicture(undefined, ['p1'], 'p1', SYMBOL)).toEqual({ p1: SYMBOL })
  })

  it('replaces the picture a profile had, and keeps the others', () => {
    expect(withProfilePicture({ p1: SYMBOL, p2: IMAGE }, ['p1', 'p2'], 'p1', ICON)).toEqual({ p1: ICON, p2: IMAGE })
  })

  it('removes the picture for null', () => {
    expect(withProfilePicture({ p1: SYMBOL, p2: IMAGE }, ['p1', 'p2'], 'p1', null)).toEqual({ p2: IMAGE })
  })

  it('drops the entry of a profile that no longer exists', () => {
    expect(withProfilePicture({ gone: SYMBOL, p2: IMAGE }, ['p1', 'p2'], 'p1', ICON)).toEqual({ p1: ICON, p2: IMAGE })
  })

  it('drops an invalid entry already stored', () => {
    const stored = { p1: { kind: 'image', src: 'https://example.com/a.png' }, p2: IMAGE }

    expect(withProfilePicture(stored, ['p1', 'p2', 'p3'], 'p3', SYMBOL)).toEqual({ p2: IMAGE, p3: SYMBOL })
  })

  it('stores nothing for a new picture that is not valid', () => {
    expect(withProfilePicture({ p1: SYMBOL }, ['p1'], 'p1', { kind: 'symbol', text: ' ' })).toEqual({})
  })

  it('returns a new object and leaves the one it was given alone', () => {
    const stored = { p1: SYMBOL, gone: IMAGE }
    const copy = structuredClone(stored)
    const result = withProfilePicture(stored, ['p1'], 'p1', ICON)

    expect(result).not.toBe(stored)
    expect(stored).toEqual(copy)
    expect(result.p1).not.toBe(ICON)
  })

  it('keeps an id that would be special on a plain object as an entry of its own', () => {
    const result = withProfilePicture({}, ['__proto__'], '__proto__', SYMBOL)

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(readProfilePicture(result, '__proto__')).toEqual(SYMBOL)
  })
})
