// The most replayed heatmap drawn above the player's seek bar: the curve YouTube
// draws, as one SVG path on a box the player stretches over the bar's width.

/** The box the path is drawn on, stretched to the seek bar (`preserveAspectRatio="none"`) */
export const HEATMAP_VIEW_BOX = '0 0 1000 100'

const WIDTH = 1000
const HEIGHT = 100

// YouTube's own floor: `min_height_dp` 4 of `max_height_dp` 40
const FLOOR = 0.1

/** @param {number} value */
const round = value => Math.round(value * 10) / 10

/**
 * The heatmap as a filled curve through the middle of each stretch, flat out
 * to both ends, with horizontal tangents so that it never overshoots a
 * stretch's height. Stretches are placed on `duration`, the length the seek bar
 * shows, else on the heatmap's own; any past it are held at the end.
 *
 * @param {import('../../platform/shapes').HeatmapPoint[] | null | undefined} heatmap
 * @param {number} duration in seconds
 * @returns {string | null} `null` when there is nothing to draw
 */
export function heatmapPath(heatmap, duration) {
  if (!Array.isArray(heatmap) || heatmap.length === 0) {
    return null
  }

  const length = duration > 0 ? duration : heatmap.at(-1).endSeconds

  if (!(length > 0)) {
    return null
  }

  const points = heatmap.map(({ startSeconds, endSeconds, intensity }) => [
    round(Math.min(WIDTH, ((startSeconds + endSeconds) / 2 / length) * WIDTH)),
    round(HEIGHT * (1 - (FLOOR + intensity * (1 - FLOOR)))),
  ])

  const [firstX, firstY] = points[0]
  const lastY = points.at(-1)[1]
  let path = `M0,${HEIGHT}L0,${firstY}L${firstX},${firstY}`

  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]
    const [x1, y1] = points[i]
    const middle = round((x0 + x1) / 2)

    path += `C${middle},${y0},${middle},${y1},${x1},${y1}`
  }

  return `${path}L${WIDTH},${lastY}L${WIDTH},${HEIGHT}Z`
}
