// Material Symbols as Font Awesome icons, so a button drawn with Font Awesome
// (FtIconButton) can show the same symbol as the player's controls, which draw
// Material Symbols paths (PlayerIcons in src/constants.js) through shaka.

// Material Symbols are drawn in the view box `0 -960 960 960`: y runs from -960
// at the top to 0 at the bottom. Font Awesome draws an icon in `0 0 w h`, so the
// path has to come down by the box's height to be seen.
const SIZE = 960

// For each absolute command, which of its numbers (repeating in groups of the
// group's length) are y coordinates. H carries only x; Z carries nothing
const Y_INDICES = {
  M: { group: 2, ys: [1] },
  L: { group: 2, ys: [1] },
  T: { group: 2, ys: [1] },
  Q: { group: 4, ys: [1, 3] },
  S: { group: 4, ys: [1, 3] },
  C: { group: 6, ys: [1, 3, 5] },
  A: { group: 7, ys: [6] },
  V: { group: 1, ys: [0] },
}

const COMMAND = /([a-zA-Z])([^a-zA-Z]*)/g
const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi

/**
 * Rewrites a Material Symbols path to be drawn in `0 0 960 960`. Relative
 * commands move from wherever the pen is, so only absolute ones change.
 * Numbers come back separated by a space, a minus sign where they are negative.
 * @param {string} path
 * @returns {string}
 */
export function shiftMaterialSymbolPath(path) {
  return path.replaceAll(COMMAND, (_, command, args) => {
    const rule = Y_INDICES[command]
    if (!rule) {
      return command + args
    }

    const numbers = args.match(NUMBER) ?? []
    const shifted = numbers.map((value, index) => {
      return rule.ys.includes(index % rule.group) ? String(Number(value) + SIZE) : value
    })

    return command + joinNumbers(shifted)
  })
}

/**
 * Joins numbers as a path writes them: a space between two, none before a
 * minus sign, which separates on its own
 * @param {string[]} numbers
 */
function joinNumbers(numbers) {
  return numbers.reduce((joined, value, index) => {
    if (index === 0 || value.startsWith('-')) {
      return joined + value
    }
    return joined + ' ' + value
  }, '')
}

/**
 * A Font Awesome icon definition for a Material Symbols path, to be added to
 * Font Awesome's library and then named as `['fas', iconName]`
 * @param {string} iconName
 * @param {string} path a Material Symbols path, as PlayerIcons holds them
 */
export function materialSymbolIcon(iconName, path) {
  return {
    prefix: 'fas',
    iconName,
    icon: [SIZE, SIZE, [], '', shiftMaterialSymbolPath(path)],
  }
}
