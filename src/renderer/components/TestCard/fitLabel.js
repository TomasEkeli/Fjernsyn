// Sets a label into a box on the test card, as large as it will go up to the
// box's own size: on one line where it fits, smaller where it does not, and
// broken over lines once a single line would be too small. A release's version
// fits at full size; a branch build's, which carries the branch name, does not.

/** Font metrics as fractions of the font size, near enough for Helvetica and Arial */
export const CAP_HEIGHT = 0.72
export const DESCENT = 0.21
const LINE_HEIGHT = 1.2

/** Sizes are tried from the box's own downwards in steps of this, to no smaller than the last */
const STEP = 0.5
const SMALLEST = 4

/**
 * @typedef {object} LabelBox
 * @property {number} x where each line is centred
 * @property {number} baseline where a single line at full size sits
 * @property {number} size the full font size
 * @property {number} width the most any one line may take up
 * @property {number} height the most the lines may take up together, about the
 *   middle of a full-size line's capitals
 */

/**
 * @typedef {object} Label
 * @property {number} size the font size the label is set at
 * @property {{ text: string, x: number, y: number }[]} lines each line and its baseline
 */

/**
 * @param {string} text
 * @param {LabelBox} box
 * @param {((text: string) => number) | null} measure how wide a text is at a
 *   font size of 1; without it the text is set at full size on one line
 * @returns {Label}
 */
export function fitLabel(text, box, measure) {
  if (!measure) {
    return layOut([text], box.size, box)
  }

  // Lines may break after a dash or an underscore, which keeps the version
  // number in one piece and the branch name's words whole
  const parts = text.split(/(?<=[-_])/)

  let size = box.size
  let lines = wrap(parts, (line) => measure(line) * size <= box.width)

  while (heightOf(lines.length, size) > box.height && size - STEP >= SMALLEST) {
    size -= STEP
    lines = wrap(parts, (line) => measure(line) * size <= box.width)
  }

  return layOut(lines, size, box)
}

/**
 * How tall the lines are from the top of the first line's capitals to the foot
 * of the last line's descenders, with as much again above for balance: the
 * lines are centred on their capitals, so the descenders hang below the middle.
 *
 * @param {number} count
 * @param {number} size
 */
function heightOf(count, size) {
  return ((count - 1) * LINE_HEIGHT + CAP_HEIGHT + 2 * DESCENT) * size
}

/**
 * Fills each line with as many parts as fit, and breaks a part that does not
 * fit on a line of its own wherever it has to.
 *
 * @param {string[]} parts
 * @param {(line: string) => boolean} fits
 * @returns {string[]}
 */
function wrap(parts, fits) {
  const lines = []
  let line = ''

  for (const part of parts) {
    if (fits(line + part)) {
      line += part
      continue
    }

    if (line) {
      lines.push(line)
      line = ''
    }

    for (const character of part) {
      if (line && !fits(line + character)) {
        lines.push(line)
        line = ''
      }

      line += character
    }
  }

  lines.push(line)

  return lines
}

/**
 * Centres the lines' capitals on the middle of a full-size line's, so a label
 * that fits at full size sits exactly where the box puts it.
 *
 * @param {string[]} lines
 * @param {number} size
 * @param {LabelBox} box
 * @returns {Label}
 */
function layOut(lines, size, box) {
  const middle = box.baseline - (CAP_HEIGHT * box.size) / 2
  const block = ((lines.length - 1) * LINE_HEIGHT + CAP_HEIGHT) * size
  const first = middle - block / 2 + CAP_HEIGHT * size

  return {
    size,
    lines: lines.map((text, index) => ({
      text,
      x: box.x,
      y: Math.round((first + index * LINE_HEIGHT * size) * 100) / 100,
    })),
  }
}
