import { describe, expect, it } from 'vitest'

import { heatmapPath } from './heatmap'

const point = (startSeconds, endSeconds, intensity) => ({ startSeconds, endSeconds, intensity })

describe('the most replayed heatmap as an SVG path', () => {
  it('is a filled curve through the middle of each stretch, flat out to both ends, on a 1000 by 100 box', () => {
    expect(heatmapPath([point(0, 10, 1), point(10, 20, 0)], 20))
      .toBe('M0,100L0,0L250,0C500,0,500,90,750,90L1000,90L1000,100Z')
  })

  it('keeps the least replayed stretch a tenth high, as YouTube does', () => {
    expect(heatmapPath([point(0, 10, 0)], 10)).toBe('M0,100L0,90L500,90L1000,90L1000,100Z')
  })

  it('places the stretches on the duration the seek bar shows, holding any past it at the end', () => {
    expect(heatmapPath([point(0, 10, 0.5), point(30, 50, 0.5)], 20))
      .toBe('M0,100L0,45L250,45C625,45,625,45,1000,45L1000,45L1000,100Z')
  })

  it('falls back on the heatmap\'s own length without a duration', () => {
    expect(heatmapPath([point(0, 10, 1), point(10, 20, 0)], Number.NaN))
      .toBe(heatmapPath([point(0, 10, 1), point(10, 20, 0)], 20))
  })

  it.each([
    ['no heatmap', null, 20],
    ['an empty one', [], 20],
    ['one with no length and no duration', [point(0, 0, 1)], 0],
  ])('is none for %s', (_what, heatmap, duration) => {
    expect(heatmapPath(heatmap, duration)).toBeNull()
  })
})
