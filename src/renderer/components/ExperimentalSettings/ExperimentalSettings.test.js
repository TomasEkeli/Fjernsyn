import { beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import settingsModule from '../../store/modules/settings'
import { mountWithApp } from '../../testing/mount'

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: { getEnableRegulatedStreaming: false, getEnablePeerTube: false, getEnableLayerSurfaces: false },
    }),
  }
})

// The settings module's helpers import the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

// Only the PeerTube and surface switch toggles are under test; the others ask main for their state
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

function toggleLabelled(wrapper, label) {
  return wrapper.findAll('.switch-ctn')
    .find(toggle => toggle.find('.switch-label-text').text() === label)
}

function peerTubeToggle(wrapper) {
  return toggleLabelled(wrapper, 'PeerTube (experimental)')
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

describe('the experimental surface switch', () => {
  it('defaults to off in the settings', () => {
    expect(settingsModule.state.enableLayerSurfaces).toBe(false)
  })

  it('is offered, off by default, and switches the layer\'s views on and off', async () => {
    const toggle = toggleLabelled(await mountSettings(), 'New YouTube pages (experimental)')

    expect(toggle).toBeDefined()
    expect(toggle.find('input').element.checked).toBe(false)

    await toggle.find('input').setValue(true)
    await toggle.find('input').setValue(false)

    expect(store.dispatched).toEqual([
      { type: 'updateEnableLayerSurfaces', payload: true },
      { type: 'updateEnableLayerSurfaces', payload: false },
    ])
  })
})
