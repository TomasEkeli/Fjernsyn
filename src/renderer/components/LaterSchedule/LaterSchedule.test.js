import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'
import { createTestRouter } from '../../testing/router'
import LaterSchedule from './LaterSchedule.vue'

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getLaterIsLiveQuiet: () => false,
        getDisableChannelLinks: false,
      },
    }),
  }
})

// helpers/utils imports the router, which imports every view
vi.mock('../../router/index', () => ({ default: {} }))

vi.mock('../../i18n/index', async () => {
  const { createTestI18n } = await import('../../testing/i18n')
  return { default: createTestI18n() }
})

const NOW = Date.parse('2026-10-04T18:00:00Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

/**
 * @param {string} id
 * @param {number} at
 */
function armed(id, at) {
  return {
    _id: id,
    videoId: id,
    title: `Stream ${id}`,
    author: `Channel ${id}`,
    authorId: `UC${id}`,
    addedAt: 0,
    position: 0,
    alarm: { at, armedAt: 0 },
  }
}

/** @type {import('@vue/test-utils').VueWrapper | null} */
let mounted = null

/** @param {object[]} items */
function mountSchedule(items) {
  mounted = mountWithApp(LaterSchedule, {
    store,
    router: createTestRouter(),
    props: { items, now: NOW },
    // In the document, so that a press inside it reaches the document as one
    // in the app does, and is not mistaken for one outside it
    attachTo: document.body,
  })

  return mounted
}

/** @param {object[]} items */
async function mountOpen(items) {
  const wrapper = mountSchedule(items)
  await wrapper.find('.schedulePill').trigger('click')
  return wrapper
}

/** @param {import('@vue/test-utils').VueWrapper} wrapper */
function distances(wrapper) {
  return wrapper.findAll('.scheduleDistance').map(cell => cell.text())
}

beforeEach(() => {
  store.dispatched.length = 0
  store.setGetter('getLaterIsLiveQuiet', () => false)
})

afterEach(() => {
  // Its document listeners go with it
  mounted?.unmount()
  mounted = null
})

describe('LaterSchedule', () => {
  it('is not there when nothing is armed', () => {
    expect(mountSchedule([]).find('.laterSchedule').exists()).toBe(false)
  })

  it('is closed to begin with, its pill saying how many and how far off the next one is', () => {
    const wrapper = mountSchedule([
      armed('gone', NOW - 4 * HOUR),
      armed('next', NOW + 2 * HOUR),
      armed('later', NOW + 3 * HOUR),
    ])

    expect(wrapper.find('.schedulePanel').exists()).toBe(false)
    expect(wrapper.find('.scheduleCount').text()).toBe('3')
    expect(wrapper.find('.scheduleNext').text()).toBe('next in 2 hr')
  })

  it('names the next one\'s state on the pill when it is not plain waiting', () => {
    const wrapper = mountSchedule([armed('a', NOW + MINUTE)])

    expect(wrapper.find('.schedulePill .scheduleState').text()).toBe('Checking')
  })

  it('opens and closes from its pill', async () => {
    const wrapper = await mountOpen([armed('a', NOW + HOUR)])

    expect(wrapper.find('.schedulePanel').exists()).toBe(true)
    expect(wrapper.find('.schedulePill').attributes('aria-expanded')).toBe('true')

    await wrapper.find('.schedulePill').trigger('click')

    expect(wrapper.find('.schedulePanel').exists()).toBe(false)
  })

  it('closes on Escape', async () => {
    const wrapper = await mountOpen([armed('a', NOW + HOUR)])

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.schedulePanel').exists()).toBe(false)
  })

  it('closes on a press outside it, and not on one inside it', async () => {
    const wrapper = await mountOpen([armed('a', NOW + HOUR)])

    wrapper.find('.scheduleDistance').element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.schedulePanel').exists()).toBe(true)

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.schedulePanel').exists()).toBe(false)
  })

  it('lists every item, each led by how far off it is', async () => {
    const wrapper = await mountOpen([
      armed('a', NOW - 5 * MINUTE),
      armed('b', NOW + 10 * 1000),
      armed('c', NOW + 25 * MINUTE),
      armed('d', NOW + HOUR + 40 * MINUTE),
      armed('e', NOW + 35 * HOUR),
    ])

    expect(distances(wrapper)).toEqual(['5 min ago', 'now', 'in 25 min', 'in 1 hr, 40 min', 'in 1 day, 11 hr'])
  })

  it('shows a state in a row only where it is not plain waiting', async () => {
    const wrapper = await mountOpen([
      armed('a', NOW + MINUTE),
      armed('b', NOW + 5 * HOUR),
    ])

    const rows = wrapper.findAll('.scheduleRow')
    expect(rows[0].find('.scheduleState').text()).toBe('Checking')
    expect(rows[1].find('.scheduleState').exists()).toBe(false)
  })

  it('disarms and removes by the item', async () => {
    const wrapper = await mountOpen([armed('a', NOW + HOUR)])

    await wrapper.find('.disarmButton button').trigger('click')
    await wrapper.find('.removeButton button').trigger('click')

    expect(store.dispatched).toEqual([
      { type: 'disarm', payload: 'a' },
      { type: 'removeFromLater', payload: 'a' },
    ])
  })

  it('links the title to its watch page and the name to its channel', async () => {
    const wrapper = await mountOpen([armed('a', NOW + HOUR)])

    expect(wrapper.find('.scheduleVideo').attributes('href')).toBe('/watch/a')
    expect(wrapper.find('a.scheduleChannel').attributes('href')).toBe('/channel/UCa')
  })
})
