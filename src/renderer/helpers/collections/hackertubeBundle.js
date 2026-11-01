import { createWebURL } from '../utils'
import { HACKERTUBE_BUNDLE_FORMAT_VERSION } from './hackertube'

/** Where the app ships HackerTube's stripped export, see `_scripts/getHackerTubeBundle.mjs` */
export const HACKERTUBE_BUNDLE_PATH = '/static/collections/hackertube.json.gz'

/**
 * The bundle's bytes as the bundle. Gzipped as shipped; already unzipped is
 * read too, in case whatever served it decoded it on the way.
 *
 * @param {Uint8Array | ArrayBuffer} bytes
 * @returns {Promise<import('./hackertube').HackerTubeBundle>}
 */
export async function readHackerTubeBundle(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const gzipped = view.length >= 2 && view[0] === 0x1f && view[1] === 0x8b

  const text = gzipped
    ? await new Response(new Response(view).body.pipeThrough(new DecompressionStream('gzip'))).text()
    : new TextDecoder().decode(view)

  const bundle = JSON.parse(text)

  if (bundle?.formatVersion !== HACKERTUBE_BUNDLE_FORMAT_VERSION) {
    throw new Error(`HackerTube bundle: format ${bundle?.formatVersion} is not ${HACKERTUBE_BUNDLE_FORMAT_VERSION}`)
  }

  if (typeof bundle.generated !== 'string' || !Array.isArray(bundle.videos)) {
    throw new Error('HackerTube bundle: no generated date or no videos')
  }

  return bundle
}

/**
 * The bundle shipped with the app.
 *
 * @returns {Promise<import('./hackertube').HackerTubeBundle>}
 */
export async function fetchHackerTubeBundle() {
  const response = await fetch(createWebURL(HACKERTUBE_BUNDLE_PATH))

  if (!response.ok) {
    throw new Error(`HackerTube bundle: HTTP ${response.status}`)
  }

  return readHackerTubeBundle(await response.arrayBuffer())
}

/** @type {Promise<import('./hackertube').HackerTubeTaxonomy> | null} */
let shippedTaxonomy = null

/**
 * The taxonomy of the bundle shipped with the app, read once per window: for
 * the category select of an installation whose HackerTube data was loaded
 * before the taxonomy was kept (`getCollectionSourceData`), until an update
 * keeps a newer one. Asked again after a failure.
 *
 * @returns {Promise<import('./hackertube').HackerTubeTaxonomy>}
 */
export function shippedHackerTubeTaxonomy() {
  shippedTaxonomy ??= fetchHackerTubeBundle().then(bundle => bundle.taxonomy, (error) => {
    shippedTaxonomy = null
    throw error
  })

  return shippedTaxonomy
}
