import { afterEach, describe, expect, it, vi } from 'vitest'

import { DBSettingHandlers } from '../../../datastores/handlers/index'
import settings from './settings'

// The settings as stored, per test, instead of read from disk
vi.mock('../../../datastores/handlers/index', () => ({
  DBSettingHandlers: { find: vi.fn(async () => []), upsert: vi.fn(async () => {}) },
}))

// The module's helpers import the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the search page\'s retired switch', () => {
  it('has no setting, getter or action left', () => {
    expect(settings.state).not.toHaveProperty('enableLayerSearch')
    expect(settings.getters).not.toHaveProperty('getEnableLayerSearch')
    expect(settings.actions).not.toHaveProperty('updateEnableLayerSearch')
  })

  it('is ignored in a settings file that still has it, and the rest of the file loads', async () => {
    DBSettingHandlers.find.mockResolvedValueOnce([
      { _id: 'enableLayerSearch', value: true },
      { _id: 'searchLatched', value: true },
    ])
    const consoleError = vi.spyOn(console, 'error')
    const state = { ...settings.state }
    const commit = (type, value) => settings.mutations[type](state, value)

    await settings.actions.grabUserSettings({ commit, dispatch: vi.fn(), state })

    expect(state.searchLatched).toBe(true)
    expect(state).not.toHaveProperty('enableLayerSearch')
    expect(consoleError).not.toHaveBeenCalled()
  })
})

describe('the settings the backup keeper changed', () => {
  it('takes in only those whose stored value differs, each with its side effect', async () => {
    DBSettingHandlers.find.mockResolvedValueOnce([
      { _id: 'defaultVolume', value: 1 },
      { _id: 'maxVolume', value: 300 },
      { _id: 'searchLatched', value: true },
      { _id: 'notASetting', value: 1 },
    ])
    const state = { ...settings.state, defaultVolume: 1, maxVolume: 100, searchLatched: false }
    const commit = vi.fn((type, value) => settings.mutations[type](state, value))
    const dispatch = vi.fn()

    await settings.actions.grabChangedUserSettings({ commit, dispatch, state })

    expect(commit.mock.calls).toEqual([['setMaxVolume', 300], ['setSearchLatched', true]])
    expect(dispatch.mock.calls).toEqual([['triggerMaxVolumeSideEffects', 300]])
  })
})
