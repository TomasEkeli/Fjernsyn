import { beforeEach, describe, expect, it, vi } from 'vitest'

import store from '../../store/index'
import { mountWithApp } from '../../testing/mount'
import { createTestRouter } from '../../testing/router'
import LaterSchedule from './LaterSchedule.vue'

vi.mock('../../store/index', async () => {
  const { createFakeStore } = await import('../../testing/store')
  return {
    default: createFakeStore({
      getters: {
        getLaterScheduleExpanded: true,
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

/** @param {object[]} items */
function mountSchedule(items) {
  return mountWithApp(LaterSchedule, {
    store,
    router: createTestRouter(),
    props: { items, now: NOW },
  })
}

/** @param {import('@vue/test-utils').VueWrapper} wrapper */
function distances(wrapper) {
  return wrapper.findAll('.scheduleDistance').map(cell => cell.text())
}

beforeEach(() => {
  store.dispatched.length = 0
  store.setGetter('getLaterScheduleExpanded', true)
  store.setGetter('getLaterIsLiveQuiet', () => false)
})

describe('LaterSchedule', () => {
  it('is not there when nothing is armed', () => {
    expect(mountSchedule([]).find('.laterSchedule').exists()).toBe(false)
  })

  it('leads every row with how far off it is', () => {
    const wrapper = mountSchedule([
      armed('a', NOW + 25 * MINUTE),
      armed('b', NOW + HOUR + 40 * MINUTE),
    ])

    expect(distances(wrapper)).toEqual(['in 25 min', 'in 1 hr, 40 min'])
  })

  it('says how long ago for one whose time has passed, and now within the minute', () => {
    const wrapper = mountSchedule([
      armed('a', NOW - 5 * MINUTE),
      armed('b', NOW + 10 * 1000),
    ])

    expect(distances(wrapper)).toEqual(['5 min ago', 'now'])
  })

  it('shows a state only where it is not plain waiting', () => {
    const wrapper = mountSchedule([
      armed('a', NOW + MINUTE),
      armed('b', NOW + 5 * HOUR),
    ])

    const rows = wrapper.findAll('.scheduleRow')
    expect(rows[0].find('.scheduleState').text()).toBe('Checking')
    expect(rows[1].find('.scheduleState').exists()).toBe(false)
  })

  it('shows the soonest three, and the rest when asked', async () => {
    const wrapper = mountSchedule([1, 2, 3, 4, 5].map(n => armed(`${n}`, NOW + n * HOUR)))

    expect(wrapper.findAll('.scheduleRow')).toHaveLength(3)
    expect(wrapper.find('.scheduleMore').text()).toBe('Show 2 more')

    await wrapper.find('.scheduleMore').trigger('click')

    expect(wrapper.findAll('.scheduleRow')).toHaveLength(5)
    expect(wrapper.find('.scheduleMore').text()).toBe('Show fewer')
  })

  it('offers no more with three or fewer', () => {
    expect(mountSchedule([armed('a', NOW + HOUR)]).find('.scheduleMore').exists()).toBe(false)
  })

  it('folded, is one line saying how far off the next one is', () => {
    store.setGetter('getLaterScheduleExpanded', false)

    const wrapper = mountSchedule([
      armed('gone', NOW - 4 * HOUR),
      armed('next', NOW + 2 * HOUR),
      armed('later', NOW + 3 * HOUR),
    ])

    expect(wrapper.find('.scheduleRows').exists()).toBe(false)
    expect(wrapper.find('.scheduleCount').text()).toBe('3')
    expect(wrapper.find('.scheduleNext').text()).toBe('next in 2 hr')
  })

  it('remembers being folded or opened', async () => {
    const wrapper = mountSchedule([armed('a', NOW + HOUR)])

    await wrapper.find('.scheduleHeader').trigger('click')

    expect(store.dispatched).toEqual([{ type: 'updateLaterScheduleExpanded', payload: false }])
  })

  it('disarms and removes by the item', async () => {
    const wrapper = mountSchedule([armed('a', NOW + HOUR)])

    await wrapper.find('.disarmButton button').trigger('click')
    await wrapper.find('.removeButton button').trigger('click')

    expect(store.dispatched).toEqual([
      { type: 'disarm', payload: 'a' },
      { type: 'removeFromLater', payload: 'a' },
    ])
  })

  it('links the title to its watch page and the name to its channel', () => {
    const wrapper = mountSchedule([armed('a', NOW + HOUR)])

    expect(wrapper.find('.scheduleVideo').attributes('href')).toBe('/watch/a')
    expect(wrapper.find('a.scheduleChannel').attributes('href')).toBe('/channel/UCa')
  })
})
