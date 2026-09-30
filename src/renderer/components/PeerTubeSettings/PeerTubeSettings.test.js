import { beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import settingsModule from '../../store/modules/settings'
import { mountWithApp } from '../../testing/mount'
import PeerTubeSettings from './PeerTubeSettings.vue'
import { parseSource } from '../../platform/peertube/source'
import { normaliseSearchSource } from './searchSource'

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getEnablePeerTube: true,
        getPeerTubeSearchSource: 'https://sepiasearch.org',
        getPeerTubeShowNsfw: false,
        getEnableLayerSearch: false,
        getDefaultSearchScope: 'youtube',
      },
    }),
  }
})

// The settings module's helpers import the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

beforeEach(() => {
  store.dispatched.length = 0
  store.setGetter('getPeerTubeSearchSource', 'https://sepiasearch.org')
  store.setGetter('getPeerTubeShowNsfw', false)
  store.setGetter('getEnableLayerSearch', false)
  store.setGetter('getDefaultSearchScope', 'youtube')
})

function mountSettings() {
  return mountWithApp(PeerTubeSettings, { store })
}

function sourceInput(wrapper) {
  return wrapper.find('.searchSource input')
}

function nsfwToggle(wrapper) {
  return wrapper.findAll('.switch-ctn')
    .find(toggle => toggle.find('.switch-label-text').text() === 'Show NSFW content')
}

function dispatched(type) {
  return store.dispatched.filter(action => action.type === type).map(action => action.payload)
}

describe('the PeerTube settings defaults', () => {
  it('search SepiaSearch, and hide NSFW content', () => {
    expect(settingsModule.state.peerTubeSearchSource).toBe('https://sepiasearch.org')
    expect(settingsModule.state.peerTubeShowNsfw).toBe(false)
  })
})

describe('the PeerTube search source setting', () => {
  it('shows the source as set, and says what it is', () => {
    const wrapper = mountSettings()

    expect(sourceInput(wrapper).element.value).toBe('https://sepiasearch.org')
    expect(wrapper.text()).toContain('Search source')
    expect(wrapper.text()).toContain('SepiaSearch is an index of videos from many PeerTube instances, and it does not moderate')
    expect(wrapper.text()).toContain('Any instance or index that speaks the PeerTube search API works here')
  })

  it('saves a valid https address when Enter is pressed', async () => {
    const wrapper = mountSettings()

    await sourceInput(wrapper).setValue('https://search.joinpeertube.org')
    await sourceInput(wrapper).trigger('keydown', { key: 'Enter' })

    expect(dispatched('updatePeerTubeSearchSource')).toEqual(['https://search.joinpeertube.org'])
  })

  it('saves it when the field is left, without a trailing slash', async () => {
    const wrapper = mountSettings()

    await sourceInput(wrapper).setValue('  https://tube.example/  ')
    await sourceInput(wrapper).trigger('blur')

    expect(dispatched('updatePeerTubeSearchSource')).toEqual(['https://tube.example'])
  })

  it('does not save what is already set', async () => {
    const wrapper = mountSettings()

    await sourceInput(wrapper).trigger('blur')

    expect(dispatched('updatePeerTubeSearchSource')).toEqual([])
  })

  it.each([
    'http://tube.example',
    'tube.example',
    'not a url',
    '',
  ])('does not save %j, and says why', async (value) => {
    const wrapper = mountSettings()

    await sourceInput(wrapper).setValue(value)
    await sourceInput(wrapper).trigger('blur')

    expect(dispatched('updatePeerTubeSearchSource')).toEqual([])
    expect(wrapper.text()).toContain('The search source has to be an https address, such as https://sepiasearch.org')
  })

  it.each([
    ['https://www.youtube.com', 'www.youtube.com'],
    [' https://YouTube.com/ ', 'youtube.com'],
    ['https://www.google.com/search', 'www.google.com'],
  ])('does not save %j, and says it is not a PeerTube search source', async (value, host) => {
    const wrapper = mountSettings()

    await sourceInput(wrapper).setValue(value)
    await sourceInput(wrapper).trigger('blur')

    expect(dispatched('updatePeerTubeSearchSource')).toEqual([])
    expect(wrapper.find('.invalidSource').text()).toBe(`${host} is not a PeerTube search source. Use a PeerTube instance or index, such as https://sepiasearch.org`)
  })

  it('clears the complaint once a valid source is saved', async () => {
    const wrapper = mountSettings()

    await sourceInput(wrapper).setValue('http://tube.example')
    await sourceInput(wrapper).trigger('blur')
    await sourceInput(wrapper).setValue('https://tube.example')
    await sourceInput(wrapper).trigger('blur')

    expect(wrapper.text()).not.toContain('The search source has to be an https address')
    expect(dispatched('updatePeerTubeSearchSource')).toEqual(['https://tube.example'])
  })

  it('resets to SepiaSearch', async () => {
    store.setGetter('getPeerTubeSearchSource', 'https://tube.example')
    const wrapper = mountSettings()

    await wrapper.find('.resetSearchSource').trigger('click')

    expect(dispatched('updatePeerTubeSearchSource')).toEqual(['https://sepiasearch.org'])
  })

  it('follows the setting when it changes elsewhere', async () => {
    const wrapper = mountSettings()

    store.setGetter('getPeerTubeSearchSource', 'https://tube.example')
    await wrapper.vm.$nextTick()

    expect(sourceInput(wrapper).element.value).toBe('https://tube.example')
  })
})

describe('the NSFW setting', () => {
  it('is off by default', () => {
    const toggle = nsfwToggle(mountSettings())

    expect(toggle).toBeDefined()
    expect(toggle.find('input').element.checked).toBe(false)
  })

  it('switches NSFW content on and off', async () => {
    const toggle = nsfwToggle(mountSettings())

    await toggle.find('input').setValue(true)
    await toggle.find('input').setValue(false)

    expect(dispatched('updatePeerTubeShowNsfw')).toEqual([true, false])
  })
})

describe('reading a search source', () => {
  it.each([
    ['https://sepiasearch.org', 'https://sepiasearch.org'],
    ['https://sepiasearch.org/', 'https://sepiasearch.org'],
    [' https://Tube.Example ', 'https://tube.example'],
    ['https://tube.example/sub/path/', 'https://tube.example/sub/path'],
    ['https://sepiasearch.org/api/v1/', 'https://sepiasearch.org'],
  ])('takes %j as %j', (input, expected) => {
    expect(normaliseSearchSource(input)).toBe(expected)
  })

  it.each([
    'http://tube.example',
    'ftp://tube.example',
    'https://tube.example:8443',
    'https://user:pass@tube.example',
    'https://tube.example/?q=1',
    'https://tube.example/#x',
    'https://localhost',
    'https://youtube.com',
    'https://m.youtube.com',
    'tube.example',
    '',
    null,
  ])('refuses %j', (input) => {
    expect(normaliseSearchSource(input)).toBe(null)
  })

  it.each([
    'https://sepiasearch.org',
    'https://Tube.Example/sub/api/v1',
    'http://tube.example',
    'https://tube.example:8443',
    'https://www.youtube.com',
  ])('saves %j as exactly what the layer\'s client would search', (input) => {
    expect(normaliseSearchSource(input)).toBe(parseSource(input)?.base ?? null)
  })
})

describe('the default search scope', () => {
  it('is offered only while the search page on the layer is on', async () => {
    expect(mountSettings().find('.defaultSearchScope').exists()).toBe(false)

    store.setGetter('getEnableLayerSearch', true)
    const wrapper = mountSettings()

    expect(wrapper.find('.defaultSearchScope select').element.value).toBe('youtube')
    expect(wrapper.findAll('.defaultSearchScope option').map(option => option.text())).toEqual(['YouTube', 'PeerTube', 'All'])
  })

  it('is saved when chosen', async () => {
    store.setGetter('getEnableLayerSearch', true)
    const wrapper = mountSettings()

    await wrapper.find('.defaultSearchScope select').setValue('all')

    expect(store.dispatched).toContainEqual({ type: 'updateDefaultSearchScope', payload: 'all' })
  })
})
