import { describe, expect, it, vi } from 'vitest'

import { MACHINE_BOUND_SETTINGS, MAIN_ONLY_SETTINGS } from '../../../main/backup/machineBound'
import { NON_TRANSFERABLE_SETTINGS } from './settings'

// Main's copy of the machine-bound settings against upstream's list, which
// main cannot import. An upstream sync that adds a setting to
// NON_TRANSFERABLE_SETTINGS fails here until main's copy has it too, as the
// kept backup would otherwise carry that setting to the other machine.

// The module's helpers import the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

describe('main\'s copy of the machine-bound settings', () => {
  it('is upstream\'s list and the settings only main keeps, no more and no less', () => {
    const expected = [...NON_TRANSFERABLE_SETTINGS, ...MAIN_ONLY_SETTINGS].sort()
    const actual = [...MACHINE_BOUND_SETTINGS].sort()

    expect(
      actual,
      'MACHINE_BOUND_SETTINGS in src/main/backup/machineBound.js has drifted from NON_TRANSFERABLE_SETTINGS in ' +
      'src/renderer/store/modules/settings.js. Update main\'s copy so that it holds every setting in that list, ' +
      'plus MAIN_ONLY_SETTINGS, and nothing else.'
    ).toEqual(expected)
  })
})
