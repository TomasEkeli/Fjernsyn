import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick } from 'vue'

import { createFakeStore } from '../testing/store'
import { createPlatformLayer } from './index.js'
import { createPeerTubeClient } from './peertube/client'
import {
  PLATFORM_LAYER_KEY,
  getPlatformLayer,
  installPlatformLayer,
  isPeerTubeEnabled,
  usePlatformLayer,
} from './vue.js'
import { YOUTUBE_DEP_NAMES } from './youtube/deps'

// The layer itself is under test elsewhere; here it only records what it was
// built with, and says so through `describe`
vi.mock('./index.js', () => ({
  createPlatformLayer: vi.fn((deps) => ({
    deps,
    describe: () => ({ builtWith: deps.config }),
  })),
}))

// The client holds what is known of each PeerTube host; a token stands in
vi.mock('./peertube/client', () => ({
  createPeerTubeClient: vi.fn((deps) => ({ deps })),
}))

// The resolved locale lives in the i18n instance, not in the settings
vi.mock('../i18n/index', async () => {
  const { ref } = await import('vue')
  return { default: { global: { locale: ref('en-US') } } }
})

// The URL parser's module imports the router, which imports every view
vi.mock('../router/index', () => ({ default: {} }))

const SETTINGS = {
  getEnablePeerTube: false,
  getPeerTubeSearchSource: 'https://sepiasearch.org',
  getPeerTubeShowNsfw: false,
  getBackendPreference: 'local',
  getBackendFallback: true,
  getCurrentInvidiousInstanceUrl: 'https://invidious.example',
  getThumbnailPreference: '',
  getProxyVideos: false,
}

let store

/** What the probe view got from `usePlatformLayer()`, and a computed over it */
const probe = { layer: null, described: null }

const ProbeView = defineComponent({
  setup() {
    probe.layer = usePlatformLayer()
    probe.described = computed(() => probe.layer.describe({}))
    return () => h('div')
  },
})

function install() {
  const app = createApp(ProbeView)
  installPlatformLayer(app, store)
  return app
}

function lastDeps() {
  return createPlatformLayer.mock.lastCall[0]
}

beforeEach(() => {
  createPlatformLayer.mockClear()
  createPeerTubeClient.mockClear()
  store = createFakeStore({ getters: { ...SETTINGS } })
})

describe('the platform layer wiring', () => {
  it('builds the layer from the settings, as plain values', () => {
    install()

    expect(createPlatformLayer).toHaveBeenCalledTimes(1)
    expect(lastDeps().config).toMatchObject({
      peertubeEnabled: false,
      peertubeSearchSource: 'https://sepiasearch.org',
      peertubeShowNsfw: false,
      backendPreference: 'local',
      backendFallback: true,
      currentInvidiousInstanceUrl: 'https://invidious.example',
      thumbnailPreference: '',
      locale: 'en-US',
    })
  })

  it('hands every rebuild the same PeerTube client, so no host is forgotten', async () => {
    install()
    const client = lastDeps().peertubeClient

    store.setGetter('getPeerTubeShowNsfw', true)
    await nextTick()
    store.setGetter('getThumbnailPreference', 'start')
    await nextTick()

    expect(createPlatformLayer).toHaveBeenCalledTimes(3)
    expect(createPeerTubeClient).toHaveBeenCalledTimes(1)
    for (const [deps] of createPlatformLayer.mock.calls) {
      expect(deps.peertubeClient).toBe(client)
    }
    expect(client).toBe(createPeerTubeClient.mock.results[0].value)
  })

  it('hands the layer a fetch that goes through the renderer window', async () => {
    const response = new Response('{}')
    const fetch = vi.fn(async () => response)
    vi.stubGlobal('fetch', fetch)

    try {
      install()

      const clientFetch = createPeerTubeClient.mock.lastCall[0].fetch

      expect(await clientFetch('https://video.blender.org/api/v1/config', { headers: {} })).toBe(response)
      expect(await lastDeps().fetch('https://video.blender.org/api/v1/config', { headers: {} })).toBe(response)
      expect(fetch).toHaveBeenCalledWith('https://video.blender.org/api/v1/config', { headers: {} })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('resolves YouTube video URLs through the existing parser', () => {
    install()
    const { resolveUrl } = lastDeps().youtube

    expect(resolveUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s&list=PL123'))
      .toEqual({ platform: 'youtube', kind: 'video', ref: 'dQw4w9WgXcQ', timestamp: 65, playlistId: 'PL123' })
    expect(resolveUrl('https://youtu.be/dQw4w9WgXcQ'))
      .toEqual({ platform: 'youtube', kind: 'video', ref: 'dQw4w9WgXcQ' })
    expect(resolveUrl('https://video.blender.org/w/9c9de5e8-0a1e-484a-b099-e80766180a6d')).toBeNull()
    expect(resolveUrl('not a url')).toBeNull()
  })

  it('hands the layer the YouTube module functions its contract lists, by name', () => {
    install()
    const { youtube } = lastDeps()

    for (const names of Object.values(YOUTUBE_DEP_NAMES)) {
      for (const name of names) {
        expect(typeof youtube[name], name).toBe('function')
      }
    }
  })

  it('reads whether YouTube streams are proxied, and rebuilds when it changes', async () => {
    install()
    expect(lastDeps().config.proxyVideos).toBe(false)

    store.setGetter('getProxyVideos', true)
    await nextTick()

    expect(createPlatformLayer).toHaveBeenCalledTimes(2)
    expect(lastDeps().config.proxyVideos).toBe(true)
  })

  it('rebuilds the layer when one of its settings changes, and not otherwise', async () => {
    install()
    const first = getPlatformLayer()

    store.setGetter('getEnablePeerTube', true)
    await nextTick()

    expect(createPlatformLayer).toHaveBeenCalledTimes(2)
    expect(lastDeps().config.peertubeEnabled).toBe(true)
    expect(getPlatformLayer()).not.toBe(first)
  })

  it('rebuilds the layer when the locale changes', async () => {
    const { default: i18n } = await import('../i18n/index')
    install()

    i18n.global.locale.value = 'nb-NO'
    await nextTick()

    try {
      expect(lastDeps().config.locale).toBe('nb-NO')
    } finally {
      i18n.global.locale.value = 'en-US'
    }
  })

  it('gives views a layer that follows rebuilds', async () => {
    const app = install()
    app.mount(document.createElement('div'))

    expect(probe.described.value.builtWith.backendPreference).toBe('local')

    store.setGetter('getBackendPreference', 'invidious')
    await nextTick()

    expect(probe.described.value.builtWith.backendPreference).toBe('invidious')
    expect(probe.layer.deps).toBe(getPlatformLayer().deps)

    app.unmount()
  })

  it('lets a test hand a view its own layer', () => {
    const fake = { describe: () => 'fake' }

    const app = createApp(ProbeView)
    app.provide(PLATFORM_LAYER_KEY, fake)
    app.mount(document.createElement('div'))

    expect(probe.layer).toBe(fake)
    app.unmount()
  })

  it('says whether PeerTube is switched on, from the store', () => {
    install()
    expect(isPeerTubeEnabled()).toBe(false)

    store.setGetter('getEnablePeerTube', true)
    expect(isPeerTubeEnabled()).toBe(true)
  })

  it('reads the settings of the store installed last', async () => {
    install()
    const firstStore = store

    store = createFakeStore({ getters: { ...SETTINGS, getEnablePeerTube: true } })
    install()
    createPlatformLayer.mockClear()

    firstStore.setGetter('getBackendPreference', 'invidious')
    await nextTick()

    expect(createPlatformLayer).not.toHaveBeenCalled()
    expect(isPeerTubeEnabled()).toBe(true)
  })
})
