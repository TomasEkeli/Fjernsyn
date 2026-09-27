import { beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import settingsModule from '../../store/modules/settings'
import { mountWithApp } from '../../testing/mount'

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: { getEnableRegulatedStreaming: false, getEnablePeerTube: false },
    }),
  }
})

// The settings module's helpers import the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

// Only the PeerTube toggle is under test; the others ask main for their state
beforeEach(() => {
  store.dispatched.length = 0
  window.ftElectron = {
    getReplaceHttpCache: async () => false,
    getDisableHardwareAcceleration: async () => false,
  }
})

async function mountSettings() {
  const { default: ExperimentalSettings } = await import('./ExperimentalSettings.vue')
  return mountWithApp(ExperimentalSettings, { store })
}

function peerTubeToggle(wrapper) {
  return wrapper.findAll('.switch-ctn')
    .find(toggle => toggle.find('.switch-label-text').text() === 'PeerTube (experimental)')
}

describe('the experimental PeerTube setting', () => {
  it('defaults to off in the settings', () => {
    expect(settingsModule.state.enablePeerTube).toBe(false)
  })

  it('is offered, and off by default', async () => {
    const toggle = peerTubeToggle(await mountSettings())

    expect(toggle).toBeDefined()
    expect(toggle.find('input').element.checked).toBe(false)
  })

  it('switches PeerTube on and off', async () => {
    const toggle = peerTubeToggle(await mountSettings())

    await toggle.find('input').setValue(true)
    await toggle.find('input').setValue(false)

    expect(store.dispatched).toEqual([
      { type: 'updateEnablePeerTube', payload: true },
      { type: 'updateEnablePeerTube', payload: false },
    ])
  })
})
