import { describe, expect, it } from 'vitest'

import { CAP_HEIGHT, DESCENT, fitLabel } from './fitLabel'

/** Every character half as wide as the font is high */
const measure = (text) => text.length * 0.5

const BOX = { x: 340, baseline: 454, size: 30, width: 170, height: 36 }

/** Where the caps of a single line at full size have their middle */
const MIDDLE = BOX.baseline - (CAP_HEIGHT * BOX.size) / 2

/**
 * @param {{ size: number, lines: { text: string, y: number }[] }} label
 */
function expectInsideBox(label) {
  for (const line of label.lines) {
    expect(measure(line.text) * label.size).toBeLessThanOrEqual(BOX.width)
  }

  const top = label.lines[0].y - CAP_HEIGHT * label.size
  const bottom = label.lines.at(-1).y + DESCENT * label.size

  expect(top).toBeGreaterThanOrEqual(MIDDLE - BOX.height / 2)
  expect(bottom).toBeLessThanOrEqual(MIDDLE + BOX.height / 2)
}

describe('fitLabel', () => {
  it('sets a text that fits on one line at full size, where it always sat', () => {
    expect(fitLabel('v0.1.215', BOX, measure)).toEqual({
      size: 30,
      lines: [{ text: 'v0.1.215', x: 340, y: 454 }],
    })
  })

  it('makes a text that is a little too wide smaller before it breaks it', () => {
    const label = fitLabel('v0.1.215678901', BOX, measure)

    expect(label.lines.map(line => line.text)).toEqual(['v0.1.215678901'])
    expect(label.size).toBeLessThan(30)
    expect(label.size).toBeGreaterThan(20)
    expectInsideBox(label)
  })

  it('breaks a long text after its dashes, onto lines centred about the same middle, all inside the box', () => {
    const text = 'v0.1.215-feature-fit-window-keeps-area'
    const label = fitLabel(text, BOX, measure)

    expect(label.lines.length).toBeGreaterThan(1)
    expect(label.lines.map(line => line.text).join('')).toBe(text)
    for (const line of label.lines.slice(0, -1)) {
      expect(line.text.endsWith('-')).toBe(true)
    }
    for (const line of label.lines) {
      expect(line.x).toBe(340)
    }
    expectInsideBox(label)
  })

  it('takes the largest size that fits', () => {
    const text = 'v0.1.215-feature-fit-window-keeps-area'
    const label = fitLabel(text, BOX, measure)
    const larger = fitLabel(text, { ...BOX, size: label.size + 0.5 }, measure)

    // Starting half a step larger lands on the same size: the larger one did not fit
    expect(larger.size).toBe(label.size)
  })

  it('breaks inside a part that is too long for a line on its own', () => {
    const text = `v0.1.215-${'x'.repeat(80)}`
    const label = fitLabel(text, BOX, measure)

    expect(label.lines.map(line => line.text).join('')).toBe(text)
    expectInsideBox(label)
  })

  it('sets the text at full size on one line when there is no way to measure it', () => {
    expect(fitLabel('v0.1.215-feature-fit-window-keeps-area', BOX, null)).toEqual({
      size: 30,
      lines: [{ text: 'v0.1.215-feature-fit-window-keeps-area', x: 340, y: 454 }],
    })
  })
})
