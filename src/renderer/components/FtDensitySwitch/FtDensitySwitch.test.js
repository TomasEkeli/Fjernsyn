import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import FtDensitySwitch from './FtDensitySwitch.vue'
import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return { default: createFakeStore({ getters: { getListDensity: 'standard' } }) }
})

describe('FtDensitySwitch', () => {
  it('names every mode in en-US, with the current one chosen', () => {
    const wrapper = mountWithApp(FtDensitySwitch)

    expect(wrapper.text()).toContain('Card density')

    const options = wrapper.findAll('label.densityOption')
    expect(options.map(option => option.text())).toEqual(['Tight', 'Standard', 'Spacious', 'Wall'])

    const chosen = wrapper.findAll('input[type="radio"]').filter(input => input.element.checked)
    expect(chosen.map(input => input.element.value)).toEqual(['standard'])
  })

  it('asks the store to write the mode the reader picks', async () => {
    store.dispatched.length = 0
    const wrapper = mountWithApp(FtDensitySwitch)

    await wrapper.find('input[value="wall"]').setValue(true)

    expect(store.dispatched).toEqual([{ type: 'updateListDensity', payload: 'wall' }])
  })

  it('follows the setting when it changes elsewhere', async () => {
    const wrapper = mountWithApp(FtDensitySwitch)

    store.setGetter('getListDensity', 'tight')
    await nextTick()

    expect(wrapper.find('.densityTextChosen').text()).toBe('Tight')
    store.setGetter('getListDensity', 'standard')
  })
})
