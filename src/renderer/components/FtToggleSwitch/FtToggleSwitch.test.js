import { describe, expect, it } from 'vitest'

import FtToggleSwitch from './FtToggleSwitch.vue'
import { mountWithApp } from '../../testing/mount'

describe('FtToggleSwitch', () => {
  it('shows its label and reports the new value when flipped', async () => {
    const wrapper = mountWithApp(FtToggleSwitch, {
      props: { label: 'Enable PeerTube', defaultValue: false },
    })

    expect(wrapper.find('label').text()).toBe('Enable PeerTube')

    await wrapper.find('input[type="checkbox"]').setValue(true)

    expect(wrapper.emitted('change')).toEqual([[true]])
  })
})
