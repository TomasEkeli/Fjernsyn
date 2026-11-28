import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'
import WallZoomChip from './WallZoomChip.vue'

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getWallTileZoom: 100,
      },
    }),
  }
})

function mountChip() {
  return mountWithApp(WallZoomChip, {
    store,
    stubs: { FontAwesomeIcon: true },
  })
}

/**
 * A drag, as the browser reports one: `input` for every step the handle
 * passes through and `change` only when it is let go. Test-utils' `setValue`
 * fires both at once, which is the one thing these tests have to tell apart.
 */
async function dragTo(wrapper, value, { release = true } = {}) {
  const slider = wrapper.get('.panel input[type="range"]')

  slider.element.value = String(value)
  await slider.trigger('input')

  if (release) {
    await slider.trigger('change')
  }
}

describe('WallZoomChip', () => {
  beforeEach(() => {
    store.dispatched.length = 0
    store.setGetter('getWallTileZoom', 100)
  })

  afterEach(() => {
    document.body.style.removeProperty('--ft-wall-zoom')
  })

  it('reads out the size it is set to', async () => {
    const wrapper = mountChip()

    expect(wrapper.get('.chip').text()).toContain('Zoom 100%')

    store.setGetter('getWallTileZoom', 70)
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.chip').text()).toContain('Zoom 70%')
  })

  it('opens and closes the panel, and says which it is', async () => {
    const wrapper = mountChip()

    expect(wrapper.find('.panel').exists()).toBe(false)
    expect(wrapper.get('.chip').attributes('aria-expanded')).toBe('false')

    await wrapper.get('.chip').trigger('click')

    expect(wrapper.find('.panel').exists()).toBe(true)
    expect(wrapper.get('.chip').attributes('aria-expanded')).toBe('true')

    await wrapper.get('.chip').trigger('click')

    expect(wrapper.find('.panel').exists()).toBe(false)
  })

  it('closes on escape', async () => {
    const wrapper = mountChip()
    await wrapper.get('.chip').trigger('click')

    await wrapper.get('.panel').trigger('keydown.esc')

    expect(wrapper.find('.panel').exists()).toBe(false)
  })

  it('closes when focus leaves it altogether, and stays open while focus moves inside', async () => {
    const wrapper = mountChip()
    await wrapper.get('.chip').trigger('click')

    await wrapper.get('.wallZoom').trigger('focusout', {
      relatedTarget: wrapper.get('.panel').element,
    })
    expect(wrapper.find('.panel').exists()).toBe(true)

    await wrapper.get('.wallZoom').trigger('focusout', { relatedTarget: null })
    expect(wrapper.find('.panel').exists()).toBe(false)
  })

  // The point of the pill being on the wall: the wall moves under the hand.
  it('shows the size under the handle while it is moving, and saves nothing', async () => {
    const wrapper = mountChip()
    await wrapper.get('.chip').trigger('click')

    await dragTo(wrapper, 60, { release: false })

    expect(document.body.style.getPropertyValue('--ft-wall-zoom')).toBe('0.6')
    expect(wrapper.get('.chip').text()).toContain('Zoom 60%')
    expect(store.dispatched).toEqual([])
  })

  it('saves the size when the handle is let go', async () => {
    const wrapper = mountChip()
    await wrapper.get('.chip').trigger('click')

    await dragTo(wrapper, 150)

    expect(store.dispatched).toEqual([
      { type: 'updateWallTileZoom', payload: 150 },
    ])
  })

  // With the drag over, the saved value is the only thing the pill reads, so
  // the two cannot disagree once the store has answered.
  it('goes back to the saved size once the drag is over', async () => {
    const wrapper = mountChip()
    await wrapper.get('.chip').trigger('click')

    await dragTo(wrapper, 150)

    store.setGetter('getWallTileZoom', 150)
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.chip').text()).toContain('Zoom 150%')
  })
})
