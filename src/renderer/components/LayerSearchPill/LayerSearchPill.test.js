import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { defaults } from '../../platform/search/query'
import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'
import LayerSearchPill from './LayerSearchPill.vue'

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getEnablePeerTube: true,
        getSearchRememberedParameters: null,
        getSearchLatched: false,
      },
    }),
  }
})

const remembered = { ...defaults('peertube'), sort: 'date', language: ['no'] }

beforeEach(() => {
  store.dispatched.length = 0
  store.setGetter('getEnablePeerTube', true)
  store.setGetter('getSearchRememberedParameters', remembered)
  store.setGetter('getSearchLatched', false)
})

function mountPill() {
  return mountWithApp(LayerSearchPill, { store })
}

describe('the pill', () => {
  it('is hidden while nothing is remembered', () => {
    store.setGetter('getSearchRememberedParameters', null)

    expect(mountPill().find('.searchPill').exists()).toBe(false)
  })

  it('is hidden for a stored set that is plain or junk', () => {
    store.setGetter('getSearchRememberedParameters', { scope: 'all', sort: 'rating' })

    expect(mountPill().find('.searchPill').exists()).toBe(false)
  })

  it('shows the remembered set in words', () => {
    expect(mountPill().find('.pillWords').text()).toBe('PeerTube · newest · Norwegian')
  })

  it('shows only YouTube\'s part of the set while PeerTube is off', () => {
    store.setGetter('getEnablePeerTube', false)

    expect(mountPill().find('.pillWords').text()).toBe('YouTube · newest')
  })

  it('is lit while latched, and says what the next search does', () => {
    const unlit = mountPill()
    expect(unlit.find('.searchPill').classes()).not.toContain('lit')
    expect(unlit.find('.pillToggle').attributes('aria-pressed')).toBe('false')

    store.setGetter('getSearchLatched', true)
    const lit = mountPill()

    expect(lit.find('.searchPill').classes()).toContain('lit')
    expect(lit.find('.pillToggle').attributes('title')).toBe('Next search uses: PeerTube · newest · Norwegian. Click to search without them')
  })

  it('toggles the latch on a click', async () => {
    const wrapper = mountPill()

    await wrapper.find('.pillToggle').trigger('click')

    expect(store.dispatched).toEqual([{ type: 'updateSearchLatched', payload: true }])
  })

  it('opens the chip bar on the set, with the scope as a chip', async () => {
    const wrapper = mountPill()
    expect(wrapper.find('.pillPanel').exists()).toBe(false)

    await wrapper.find('.pillExpand').trigger('click')

    expect(wrapper.find('.pillPanel .scopeChip select').element.value).toBe('peertube')
    expect(wrapper.find('.pillPanel .sortChip select').element.value).toBe('date')
  })

  it('writes a change to the set, and latches it', async () => {
    const wrapper = mountPill()
    await wrapper.find('.pillExpand').trigger('click')

    await wrapper.find('.pillPanel .timeChip select').setValue('year')
    await flushPromises()

    expect(store.dispatched).toEqual([
      { type: 'updateSearchRememberedParameters', payload: { ...remembered, time: 'year' } },
      { type: 'updateSearchLatched', payload: true },
    ])
  })

  it('forgets the set when a change leaves nothing set', async () => {
    store.setGetter('getSearchRememberedParameters', { ...defaults('youtube'), sort: 'views' })
    store.setGetter('getSearchLatched', true)
    const wrapper = mountPill()
    await wrapper.find('.pillExpand').trigger('click')

    await wrapper.find('.pillPanel .sortChip .chipClear').trigger('click')

    expect(store.dispatched).toEqual([
      { type: 'updateSearchRememberedParameters', payload: null },
      { type: 'updateSearchLatched', payload: false },
    ])
  })
})
