// The PeerTube section's place on upstream's settings page
// (views/Settings/Settings.vue), which registers it with one line. The page is
// mounted with every section stubbed, so that what is asserted is which
// sections it shows.

import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { createTestI18n } from '../../testing/i18n'
import { mountWithApp } from '../../testing/mount'
import Settings from '../../views/Settings/Settings.vue'
import { peerTubeSettingsSections } from './section'

const stubSection = vi.hoisted(() => async (name) => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('div', { class: `stub${name}` }) }) }
})

vi.mock('./PeerTubeSettings.vue', () => stubSection('PeerTubeSettings'))
vi.mock('../GeneralSettings/GeneralSettings.vue', () => stubSection('GeneralSettings'))
vi.mock('../ThemeSettings.vue', () => stubSection('ThemeSettings'))
vi.mock('../PlayerSettings/PlayerSettings.vue', () => stubSection('PlayerSettings'))
vi.mock('../ExternalPlayerSettings.vue', () => stubSection('ExternalPlayerSettings'))
vi.mock('../YtDlpSettings/YtDlpSettings.vue', () => stubSection('YtDlpSettings'))
vi.mock('../SubscriptionSettings/SubscriptionSettings.vue', () => stubSection('SubscriptionSettings'))
vi.mock('../PrivacySettings.vue', () => stubSection('PrivacySettings'))
vi.mock('../DataSettings/DataSettings.vue', () => stubSection('DataSettings'))
vi.mock('../DistractionSettings/DistractionSettings.vue', () => stubSection('DistractionSettings'))
vi.mock('../ProxySettings/ProxySettings.vue', () => stubSection('ProxySettings'))
vi.mock('../SponsorBlockSettings.vue', () => stubSection('SponsorBlockSettings'))
vi.mock('../ParentalControlSettings.vue', () => stubSection('ParentalControlSettings'))
vi.mock('../ExperimentalSettings/ExperimentalSettings.vue', () => stubSection('ExperimentalSettings'))
vi.mock('../PasswordSettings/PasswordSettings.vue', () => stubSection('PasswordSettings'))
vi.mock('../PasswordDialog/PasswordDialog.vue', () => stubSection('PasswordDialog'))
vi.mock('../FtSettingsMenu/FtSettingsMenu.vue', () => stubSection('FtSettingsMenu'))

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getEnablePeerTube: false,
        getSettingsSectionSortEnabled: false,
        getSettingsPassword: '',
      },
    }),
  }
})

// The settings module's helpers import the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

beforeEach(() => {
  store.setGetter('getEnablePeerTube', false)
  store.setGetter('getSettingsSectionSortEnabled', false)
})

function sectionTypes(wrapper) {
  return wrapper.findAll('[data-section]').map(section => section.attributes('data-section'))
}

describe('the PeerTube settings section', () => {
  it('is not on the settings page while PeerTube is switched off', async () => {
    const wrapper = mountWithApp(Settings, { store })
    await flushPromises()

    expect(sectionTypes(wrapper)).toContain('experimental')
    expect(sectionTypes(wrapper)).not.toContain('peertube')
    expect(wrapper.find('.stubPeerTubeSettings').exists()).toBe(false)
  })

  it('is on the settings page, before the experimental section, while PeerTube is on', async () => {
    store.setGetter('getEnablePeerTube', true)
    const wrapper = mountWithApp(Settings, { store })
    await flushPromises()

    const types = sectionTypes(wrapper)
    expect(types).toContain('peertube')
    expect(types.indexOf('peertube')).toBe(types.indexOf('experimental') - 1)
    expect(wrapper.find('.stubPeerTubeSettings').exists()).toBe(true)
  })

  it('comes and goes as PeerTube is switched on and off', async () => {
    const wrapper = mountWithApp(Settings, { store })
    await flushPromises()

    store.setGetter('getEnablePeerTube', true)
    await flushPromises()
    expect(wrapper.find('.stubPeerTubeSettings').exists()).toBe(true)

    store.setGetter('getEnablePeerTube', false)
    await flushPromises()
    expect(wrapper.find('.stubPeerTubeSettings').exists()).toBe(false)
  })

  it('is named for the settings menu', () => {
    store.setGetter('getEnablePeerTube', true)
    const { global: { t } } = createTestI18n()

    expect(peerTubeSettingsSections(t)).toEqual([expect.objectContaining({
      type: 'peertube',
      title: 'PeerTube Settings',
      icon: ['fas', 'globe'],
    })])
  })
})
