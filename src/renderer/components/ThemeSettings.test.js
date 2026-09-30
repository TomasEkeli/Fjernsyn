import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import store from '../store/index'
import settingsModule from '../store/modules/settings'
import { mountWithApp } from '../testing/mount'
import FtPrompt from './FtPrompt/FtPrompt.vue'

vi.mock('../store/index', async () => {
  const { createFakeStore } = await import('../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getBarColor: false,
        getBaseTheme: 'dark',
        getMainColor: 'Red',
        getSecColor: 'Blue',
        getExpandSideBar: false,
        getIsSideNavOpen: false,
        getHideLabelsSideBar: false,
        getHideHeaderLogo: false,
        getUiScale: 100,
        getDisableSmoothScrolling: false,
        getFramelessWindow: true,
      },
    }),
  }
})

// The settings module's helpers import the router, which imports every view
vi.mock('../router/index', () => ({ default: {} }))

beforeEach(() => {
  store.dispatched.length = 0
  window.ftElectron = { relaunch: vi.fn() }
})

async function mountSettings() {
  const { default: ThemeSettings } = await import('./ThemeSettings.vue')
  // The prompt teleports to the app's root, which a test does not have
  return mountWithApp(ThemeSettings, { store, stubs: { FtPrompt: true } })
}

function toggle(wrapper, label) {
  return wrapper.findAll('.switch-ctn')
    .find(item => item.find('.switch-label-text').text() === label)
}

describe('the frameless window setting', () => {
  it('defaults to on, and is not carried by a settings export', async () => {
    const { NON_TRANSFERABLE_SETTINGS } = await import('../store/modules/settings')

    expect(settingsModule.state.framelessWindow).toBe(true)
    expect(NON_TRANSFERABLE_SETTINGS.has('framelessWindow')).toBe(true)
  })

  it('is offered, showing the saved value', async () => {
    const frameless = toggle(await mountSettings(), 'Frameless Window')

    expect(frameless).toBeDefined()
    expect(frameless.find('input').element.checked).toBe(true)
  })

  it('saves and restarts only when the restart is agreed to', async () => {
    const wrapper = await mountSettings()

    await toggle(wrapper, 'Frameless Window').find('input').setValue(false)
    expect(store.dispatched).toEqual([])

    wrapper.findComponent(FtPrompt).vm.$emit('click', 'restart')
    await flushPromises()

    expect(store.dispatched).toEqual([{ type: 'updateFramelessWindow', payload: false }])
    expect(window.ftElectron.relaunch).toHaveBeenCalled()
    expect(wrapper.findComponent(FtPrompt).exists()).toBe(false)
  })

  it('moves the toggle back and saves nothing when the restart is cancelled', async () => {
    const wrapper = await mountSettings()

    await toggle(wrapper, 'Frameless Window').find('input').setValue(false)
    wrapper.findComponent(FtPrompt).vm.$emit('click', 'cancel')
    await flushPromises()

    expect(store.dispatched).toEqual([])
    expect(toggle(wrapper, 'Frameless Window').find('input').element.checked).toBe(true)
  })

  it('shares the prompt with smooth scrolling, each saving only its own setting', async () => {
    const wrapper = await mountSettings()

    await toggle(wrapper, 'Disable Smooth Scrolling').find('input').setValue(true)
    wrapper.findComponent(FtPrompt).vm.$emit('click', 'restart')
    await flushPromises()

    expect(store.dispatched).toEqual([{ type: 'updateDisableSmoothScrolling', payload: true }])
    expect(toggle(wrapper, 'Frameless Window').find('input').element.checked).toBe(true)
  })

  it('moves back only the toggle that asked, when cancelled', async () => {
    const wrapper = await mountSettings()

    await toggle(wrapper, 'Disable Smooth Scrolling').find('input').setValue(true)
    wrapper.findComponent(FtPrompt).vm.$emit('click', null)
    await flushPromises()

    expect(toggle(wrapper, 'Disable Smooth Scrolling').find('input').element.checked).toBe(false)
    expect(toggle(wrapper, 'Frameless Window').find('input').element.checked).toBe(true)
  })
})
