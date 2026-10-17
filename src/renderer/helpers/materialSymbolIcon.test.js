import { describe, expect, it } from 'vitest'

import { materialSymbolIcon, shiftMaterialSymbolPath } from './materialSymbolIcon'

describe('shiftMaterialSymbolPath', () => {
  it('moves absolute y coordinates down by the view box\'s height, and leaves x alone', () => {
    expect(shiftMaterialSymbolPath('M200-120L840-760Z')).toBe('M200 840L840 200Z')
  })

  it('takes the pairs after a moveto as linetos, all of them absolute', () => {
    expect(shiftMaterialSymbolPath('M764-84 608-240')).toBe('M764 876 608 720')
  })

  it('shifts both points of an absolute quadratic, and a smooth quadratic\'s one', () => {
    expect(shiftMaterialSymbolPath('M0-960Q514-221 514-235T480-80')).toBe('M0 0Q514 739 514 725T480 880')
  })

  it('shifts an absolute vertical line, never a horizontal one', () => {
    expect(shiftMaterialSymbolPath('M0-960H560V-120')).toBe('M0 0H560V840')
  })

  it('shifts every point of an absolute cubic and smooth cubic', () => {
    expect(shiftMaterialSymbolPath('M0-960C1-10 2-20 3-30S4-40 5-50')).toBe('M0 0C1 950 2 940 3 930S4 920 5 910')
  })

  it('shifts only the end point of an absolute arc, not its radii or flags', () => {
    expect(shiftMaterialSymbolPath('M0-960A10 20 0 0 1 30-40')).toBe('M0 0A10 20 0 0 1 30 920')
  })

  it('leaves relative commands as they are, numbers written as Material writes them', () => {
    expect(shiftMaterialSymbolPath('M480-80q-83 0-156-31.5t-.5-27h560v-440Z'))
      .toBe('M480 880q-83 0-156-31.5t-.5-27h560v-440Z')
  })
})

describe('materialSymbolIcon', () => {
  it('is a Font Awesome icon definition, square at the symbol\'s size, drawing the shifted path', () => {
    expect(materialSymbolIcon('fjernsyn-test', 'M200-120H760Z')).toEqual({
      prefix: 'fas',
      iconName: 'fjernsyn-test',
      icon: [960, 960, [], '', 'M200 840H760Z'],
    })
  })
})
