// Guards the renderer test setup itself (vitest.config.mjs and this
// directory), so that a broken alias, constant or helper fails here, by name,
// rather than as a puzzle in some view's test.

import { flushPromises } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { h, withDirectives } from 'vue'
import { RouterLink } from 'vue-router'

import activeLocales from '../../../static/locales/activeLocales.json'
import { vSaferHtml } from '../directives/vSaferHtml'
import { mountWithApp } from './mount'
import { createTestRouter } from './router'

describe('renderer test setup', () => {
  it('has the build constants the renderer is built with', () => {
    expect(process.env.IS_ELECTRON).toBe(true)
    expect(process.env.IS_ELECTRON_MAIN).toBe(false)
    expect(process.env.SUPPORTS_LOCAL_API).toBe(true)
    expect(process.env.LOCALE_NAMES).toContain('English (US)')
    expect(process.env.GEOLOCATION_NAMES).toContain('en-US')
  })

  it('imports JSON, as fixtures are', () => {
    expect(activeLocales).toContain('en-US')
  })

  it('lands navigation to any path, on a given route or the stub', async () => {
    const router = createTestRouter([{ path: '/peertube/watch/:host/:uuid', name: 'peertubeWatch' }])
    const Links = {
      render: () => [
        h(RouterLink, { to: '/peertube/watch/video.blender.org/abc', class: 'known' }, () => 'known'),
        h(RouterLink, { to: '/nowhere/in/particular?x=1', class: 'unknown' }, () => 'unknown'),
      ],
    }
    const wrapper = mountWithApp(Links, { router })

    await wrapper.find('a.known').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('peertubeWatch')
    expect(router.currentRoute.value.params).toEqual({ host: 'video.blender.org', uuid: 'abc' })

    await wrapper.find('a.unknown').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/nowhere/in/particular')
    expect(router.currentRoute.value.query).toEqual({ x: '1' })
  })

  it('sanitises v-safer-html as the native sanitiser would', () => {
    const html = '<b onclick="steal()">bold</b><script>steal()</script><a href="/x" style="x">link</a>'
    const Html = {
      render: () => withDirectives(h('p'), [[vSaferHtml, html]]),
    }
    const wrapper = mountWithApp(Html)

    expect(wrapper.find('p').html()).toBe('<p><b>bold</b><a href="/x">link</a></p>')
  })
})
