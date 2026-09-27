/**
 * The platform layer's wiring into the app: the one module under
 * `src/renderer/platform/` that knows about Vue, Vuex or the store.
 *
 * `installPlatformLayer(app, store)` builds a layer from the store's settings,
 * provides it to every view, and builds a fresh one whenever one of those
 * settings (or the locale) changes.
 *
 * What is provided is not a layer instance but a stable stand-in for
 * whichever layer is current: every property read on it is forwarded to the
 * current layer, which sits in a `shallowRef`. So a view keeps the object
 * `usePlatformLayer()` gave it for its whole life and still calls the layer
 * built from today's settings, and a `computed` over, say,
 * `layer.describe(video)` is recomputed after a rebuild, because the forwarded
 * read tracks the ref. A test provides a plain fake layer under
 * `PLATFORM_LAYER_KEY` instead, and `usePlatformLayer()` hands that over as is.
 *
 * What the layer knows of each PeerTube host (which hosts are PeerTube, their
 * config and version, any `Retry-After` still running) lives in its PeerTube
 * client. The client is built once per install and handed to every rebuild,
 * so a settings change does not forget a rate limit or ask a host again.
 *
 * Plain modules that are not components (the subscription refresh) call
 * `getPlatformLayer()` at the moment they need it, which returns the current
 * layer instance itself.
 */

import { inject, shallowRef, unref } from 'vue'

import i18n from '../i18n/index'
import { getVideoParamsFromUrl } from '../helpers/utils'
import { createPlatformLayer } from './index.js'
import { createPeerTubeClient } from './peertube/client'

export const PLATFORM_LAYER_KEY = Symbol('platformLayer')

/** @type {import('vuex').Store<any> | null} */
let installedStore = null

/** @type {import('vue').ShallowRef<object | null>} the layer built from the current settings */
const currentLayer = shallowRef(null)

/** @type {(() => void) | null} stops watching the settings of the store installed before */
let stopWatchingSettings = null

/**
 * The layer's configuration, as plain values read from the store.
 *
 * @param {import('vuex').Store<any>} store
 */
function readConfig(store) {
  const { getters } = store

  return {
    peertubeEnabled: getters.getEnablePeerTube,
    peertubeSearchSource: getters.getPeerTubeSearchSource,
    peertubeShowNsfw: getters.getPeerTubeShowNsfw,
    backendPreference: getters.getBackendPreference,
    backendFallback: getters.getBackendFallback,
    currentInvidiousInstanceUrl: getters.getCurrentInvidiousInstanceUrl,
    thumbnailPreference: getters.getThumbnailPreference,
    // The locale in use; the `currentLocale` setting may say `system`
    locale: unref(i18n.global.locale),
  }
}

/**
 * YouTube URL recognition for the layer, by the existing parser. Video URLs
 * only, for now.
 *
 * @param {string} url
 * @returns {{ platform: 'youtube', kind: 'video', ref: string, timestamp?: number | string, playlistId?: string } | null}
 */
function resolveYouTubeUrl(url) {
  const { videoId, timestamp, playlistId } = getVideoParamsFromUrl(url)

  if (!videoId) {
    return null
  }

  const resolved = { platform: 'youtube', kind: 'video', ref: videoId }

  if (timestamp != null) {
    resolved.timestamp = timestamp
  }

  if (playlistId) {
    resolved.playlistId = playlistId
  }

  return resolved
}

/**
 * The renderer's own fetch, looked up at call time. Main gives the requests
 * the layer marks the prescribed User-Agent (`src/main/peertubeRequests.js`).
 *
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 */
function rendererFetch(input, init) {
  return window.fetch(input, init)
}

/**
 * @param {import('vuex').Store<any>} store
 * @param {ReturnType<typeof createPeerTubeClient>} peertubeClient the per-host state every rebuild shares
 */
function buildLayer(store, peertubeClient) {
  return createPlatformLayer({
    fetch: rendererFetch,
    peertubeClient,
    youtube: { resolveUrl: resolveYouTubeUrl },
    config: readConfig(store),
  })
}

/** Forwards every read to the current layer, so holders never go stale */
const currentLayerStandIn = new Proxy({}, {
  get: (_target, property) => Reflect.get(currentLayer.value ?? {}, property),
  has: (_target, property) => currentLayer.value !== null && property in currentLayer.value,
})

/**
 * @param {import('vue').App} app
 * @param {import('vuex').Store<any>} store
 */
export function installPlatformLayer(app, store) {
  stopWatchingSettings?.()

  installedStore = store
  const peertubeClient = createPeerTubeClient({ fetch: rendererFetch })
  currentLayer.value = buildLayer(store, peertubeClient)

  stopWatchingSettings = store.watch(
    () => readConfig(store),
    () => {
      currentLayer.value = buildLayer(store, peertubeClient)
    }
  )

  app.provide(PLATFORM_LAYER_KEY, currentLayerStandIn)
}

/**
 * The layer, for a view or component (call in `setup`).
 */
export function usePlatformLayer() {
  const layer = inject(PLATFORM_LAYER_KEY, null)

  if (layer === null) {
    throw new Error('usePlatformLayer: no platform layer was provided (installPlatformLayer, or a fake in a test)')
  }

  return layer
}

/**
 * The current layer, for plain modules. Ask at the moment it is needed rather
 * than keeping it: a settings change replaces it.
 */
export function getPlatformLayer() {
  if (currentLayer.value === null) {
    throw new Error('getPlatformLayer: the platform layer is not installed yet')
  }

  return currentLayer.value
}

/**
 * Whether the experimental PeerTube setting is on, for guards and hooks.
 * False until the layer is installed.
 */
export function isPeerTubeEnabled() {
  return installedStore?.getters.getEnablePeerTube === true
}
