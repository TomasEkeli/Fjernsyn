import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import TestCard from './TestCard.vue'
import { mountWithApp } from '../../testing/mount'

describe('TestCard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 3, 9, 7, 5))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('carries the name in capitals at the top and the version at the bottom', () => {
    const wrapper = mountWithApp(TestCard, {
      props: { name: 'Fjernsyn', version: 'v0.0.1' },
    })

    expect(wrapper.find('.identity').text()).toBe('FJERNSYN')
    expect(wrapper.find('.version').text()).toBe('v0.0.1')
  })

  describe('with a canvas to measure the version on', () => {
    beforeEach(() => {
      // Every character half as wide as the font is high
      vi.stubGlobal('OffscreenCanvas', class {
        getContext() {
          return {
            font: '',
            measureText: (text) => ({ width: text.length * 50 }),
          }
        }
      })
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('sets a version that fits at full size, on one line where it always sat', () => {
      const wrapper = mountWithApp(TestCard, {
        props: { name: 'Fjernsyn', version: 'v0.1.215' },
      })

      const version = wrapper.find('.version')
      const lines = version.findAll('tspan')
      expect(version.attributes('style')).toContain('font-size: 30px')
      expect(lines.map(line => [line.text(), line.attributes('x'), line.attributes('y')]))
        .toEqual([['v0.1.215', '340', '454']])
    })

    it("shrinks and breaks a branch build's long version to keep it inside its box", () => {
      const version = 'v0.1.215-feature-fit-window-keeps-area'
      const wrapper = mountWithApp(TestCard, {
        props: { name: 'Fjernsyn', version },
      })

      const text = wrapper.find('.version')
      const lines = text.findAll('tspan')
      const size = Number.parseFloat(/font-size: ([\d.]+)px/.exec(text.attributes('style'))[1])
      expect(size).toBeLessThan(30)
      expect(lines.length).toBeGreaterThan(1)
      expect(lines.map(line => line.text()).join('')).toBe(version)
      expect(wrapper.find('svg').attributes('aria-label')).toBe(`Fjernsyn ${version}`)
    })
  })

  it('links the name to where it points, and the version only when it has somewhere to point', () => {
    const wrapper = mountWithApp(TestCard, {
      props: { name: 'Fjernsyn', version: 'v0.0.1', nameUrl: 'https://example.com/repo' },
    })

    const link = wrapper.find('a.nameLink')
    expect(link.attributes('href')).toBe('https://example.com/repo')
    expect(link.attributes('aria-label')).toBe('Fjernsyn')
    expect(wrapper.find('a.versionLink').exists()).toBe(false)
  })

  it('hides a link to the pattern behind the red square at the foot, with nothing to give it away', () => {
    const wrapper = mountWithApp(TestCard, {
      props: { name: 'Fjernsyn', version: 'v0.0.1' },
    })

    const link = wrapper.find('a.patternLink')
    expect(link.attributes('href')).toBe('https://en.wikipedia.org/wiki/Philips_circle_pattern')
    expect(link.attributes('tabindex')).toBe('-1')
    expect(link.attributes('aria-hidden')).toBe('true')
    expect(link.attributes('title')).toBeUndefined()
    expect(link.text()).toBe('')
  })

  it('links the version to its release once it has one', () => {
    const wrapper = mountWithApp(TestCard, {
      props: { name: 'Fjernsyn', version: 'v0.0.1', versionUrl: 'https://example.com/releases/v0.0.1' },
    })

    const link = wrapper.find('a.versionLink')
    expect(link.attributes('href')).toBe('https://example.com/releases/v0.0.1')
    expect(link.attributes('aria-label')).toBe('v0.0.1')
  })

  it('names the build in a tooltip on the version, if it is known', () => {
    const wrapper = mountWithApp(TestCard, {
      props: { name: 'Fjernsyn', version: 'v0.0.1', buildStamp: 'abc1234 2026-10-03' },
    })

    expect(wrapper.find('.versionBox title').text()).toBe('abc1234 2026-10-03')
  })

  it('shows the time as HH:mm:ss on the right and the date as dd-MM-yy on the left', () => {
    const wrapper = mountWithApp(TestCard, {
      props: { name: 'Fjernsyn', version: 'v0.0.1' },
    })

    expect(wrapper.find('.clock').text()).toBe('09:07:05')
    expect(wrapper.find('.date').text()).toBe('03-10-26')
  })

  it('keeps time, rolling the date over at midnight', async () => {
    vi.setSystemTime(new Date(2026, 9, 3, 23, 59, 58, 400))
    const wrapper = mountWithApp(TestCard, {
      props: { name: 'Fjernsyn', version: 'v0.0.1' },
    })

    await vi.advanceTimersByTimeAsync(600)
    expect(wrapper.find('.clock').text()).toBe('23:59:59')

    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.find('.clock').text()).toBe('00:00:00')
    expect(wrapper.find('.date').text()).toBe('04-10-26')
  })

  it('stops the clock when it leaves the page', () => {
    const wrapper = mountWithApp(TestCard, {
      props: { name: 'Fjernsyn', version: 'v0.0.1' },
    })

    expect(vi.getTimerCount()).toBeGreaterThan(0)
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
