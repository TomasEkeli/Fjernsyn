import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'

import { DBPlaylistHandlers } from '../../datastores/handlers/index'
import { mountWithApp } from '../testing/mount'
import { useKeeperRefresh } from './useKeeperRefresh'

// What a window loads again when main's keeper says it changed sections in
// the datastores while the app ran, with main and the store's actions stubbed

vi.mock('../../datastores/handlers/index', () => ({
  DBPlaylistHandlers: { find: vi.fn(async () => [{ _id: 'favorites' }]) },
}))

const PROFILE = id => ({ _id: id, name: id, subscriptions: [] })

/**
 * The parts of the store a load reaches: the actions recorded, and the
 * profiles as grabAllProfiles leaves them, the default profile made active as
 * it does whenever the list grows
 */
function fakeStore({ profiles = ['allChannels', 'work'], active = 'work', profilesAfter = profiles } = {}) {
  const store = {
    state: { profiles: { profileList: profiles.map(PROFILE), activeProfile: active } },
    dispatched: [],
    committed: [],
    async dispatch(type, payload) {
      store.dispatched.push(payload === undefined ? type : `${type} ${payload}`)

      if (type === 'grabAllProfiles') {
        store.state.profiles.profileList = profilesAfter.map(PROFILE)
        store.state.profiles.activeProfile = 'allChannels'
      }
    },
    commit(type, payload) {
      store.committed.push([type, payload])

      if (type === 'setActiveProfile') {
        store.state.profiles.activeProfile = payload
      }
    },
  }

  return store
}

let wrapper = null
const loaded = ref(true)

beforeEach(() => {
  loaded.value = true
  window.ftElectron = { handleKeeperDataChanged: vi.fn() }
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  delete window.ftElectron
})

function mountRefresh(store) {
  wrapper = mountWithApp(defineComponent({
    setup() {
      useKeeperRefresh(store, () => loaded.value)
      return () => null
    },
  }))
}

/** Main saying the keeper changed these sections */
async function changed(sections) {
  const [[handler]] = window.ftElectron.handleKeeperDataChanged.mock.calls
  handler(sections)
  await flushPromises()
}

describe('loading again what the keeper changed', () => {
  it('loads each section with its action, the settings first and the subscriptions after the profiles', async () => {
    const store = fakeStore()
    mountRefresh(store)

    await changed(['profiles', 'history', 'playlists', 'later', 'searchHistory', 'settings', 'channels', 'aiVerdicts'])

    expect(store.dispatched[0]).toBe('grabChangedUserSettings')
    expect(store.dispatched.slice(1).sort()).toEqual([
      'grabAiVerdicts',
      'grabAllPlaylists',
      'grabAllProfiles All Channels',
      'grabAllSubscriptions',
      'grabChannels',
      'grabHistory',
      'grabLater',
      'grabSearchHistoryEntries',
    ])
    expect(store.dispatched.indexOf('grabAllSubscriptions')).toBeGreaterThan(store.dispatched.indexOf('grabAllProfiles All Channels'))
  })

  it('loads only the sections named', async () => {
    const store = fakeStore()
    mountRefresh(store)

    await changed(['later'])
    await changed(['searchHistory'])

    expect(store.dispatched).toEqual(['grabLater', 'grabSearchHistoryEntries'])
  })

  it('loads nothing before the window\'s data has, and what came meanwhile once it has', async () => {
    loaded.value = false
    const store = fakeStore()
    mountRefresh(store)

    await changed(['history'])
    await changed(['history', 'later'])
    expect(store.dispatched).toEqual([])

    loaded.value = true
    await flushPromises()

    expect(store.dispatched.sort()).toEqual(['grabHistory', 'grabLater'])
  })

  it('keeps the active profile when the profiles grow', async () => {
    const store = fakeStore({ profilesAfter: ['allChannels', 'work', 'music'] })
    mountRefresh(store)

    await changed(['profiles'])

    expect(store.state.profiles.activeProfile).toBe('work')
  })

  it('falls back to All Channels when the active profile was removed', async () => {
    const store = fakeStore({ profilesAfter: ['allChannels'] })
    mountRefresh(store)

    await changed(['profiles'])

    expect(store.state.profiles.activeProfile).toBe('allChannels')
  })

  it('empties the playlists when the datastore holds none, and makes no default ones', async () => {
    DBPlaylistHandlers.find.mockResolvedValueOnce([])
    const store = fakeStore()
    mountRefresh(store)

    await changed(['playlists'])

    expect(store.dispatched).toEqual([])
    expect(store.committed).toEqual([['setAllPlaylists', []]])
  })
})
