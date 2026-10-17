import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import About from './About.vue'
import { mountWithApp } from '../../testing/mount'

import packageDetails from '../../../../package.json'

const LATEST_RELEASE_API = 'https://api.github.com/repos/TomasEkeli/Fjernsyn/releases/latest'
const LATEST_RELEASE_PAGE = 'https://github.com/TomasEkeli/Fjernsyn/releases/latest'

/**
 * @param {() => Promise<any>} respond
 */
function stubFetch(respond) {
  const fetch = vi.fn(respond)
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('About', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('links the date to the latest release when this is not it', async () => {
    const fetch = stubFetch(async () => ({ ok: true, json: async () => ({ tag_name: 'v99.0.1' }) }))

    const wrapper = mountWithApp(About)
    await flushPromises()

    expect(fetch).toHaveBeenCalledWith(LATEST_RELEASE_API)
    expect(wrapper.find('a.dateLink').attributes('href')).toBe(LATEST_RELEASE_PAGE)
  })

  it('leaves the date unlinked when this is the latest release', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ tag_name: `v${packageDetails.version}` }) }))

    const wrapper = mountWithApp(About)
    await flushPromises()

    expect(wrapper.find('a.dateLink').exists()).toBe(false)
  })

  it('leaves the date unlinked when the latest release cannot be had', async () => {
    stubFetch(async () => ({ ok: false, json: async () => ({ message: 'Not Found' }) }))
    const notFound = mountWithApp(About)

    await flushPromises()
    expect(notFound.find('a.dateLink').exists()).toBe(false)

    stubFetch(async () => { throw new TypeError('Failed to fetch') })
    const offline = mountWithApp(About)

    await flushPromises()
    expect(offline.find('a.dateLink').exists()).toBe(false)
  })
})
