/**
 * Makes the HackerTube bundle the app ships, `static/collections/hackertube.json.gz`,
 * from HackerTube's published export (https://hackertube.org/data, ODC-By 1.0).
 *
 * Asks `/api/export` for the export's date, downloads `videos.jsonl` and
 * `taxonomy.json` from `/download/`, strips each video to the fields the app
 * uses with the same functions the app's update check uses
 * (`src/renderer/helpers/collections/hackertube.js`), and writes the result
 * as one gzipped JSON file. Never the zip, and never `mentions.jsonl`.
 *
 * Run by hand when a fresher bundle is wanted, not on every build, and commit
 * the file it writes: `pnpm run get-hackertube`.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

import { stripHackerTubeExport } from '../src/renderer/helpers/collections/hackertube.js'

const BASE_URL = 'https://hackertube.org'
const OUTPUT = resolve(import.meta.dirname, '../static/collections/hackertube.json.gz')

/**
 * @param {string} path
 * @param {'json' | 'text'} as
 */
async function download(path, as) {
  const response = await fetch(`${BASE_URL}${path}`)

  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status}`)
  }

  return as === 'json' ? response.json() : response.text()
}

const manifest = await download('/api/export', 'json')

if (typeof manifest?.generated !== 'string') {
  throw new Error('/api/export: no `generated` date in the manifest')
}

const [videosText, taxonomy] = await Promise.all([
  download('/download/videos.jsonl', 'text'),
  download('/download/taxonomy.json', 'json'),
])

const bundle = stripHackerTubeExport({ generated: manifest.generated, videosText, taxonomy })

const json = JSON.stringify(bundle)
// zlib writes no file name and no time into the header, so the same export
// gives the same bytes
const gzipped = gzipSync(json, { level: 9 })

mkdirSync(dirname(OUTPUT), { recursive: true })
writeFileSync(OUTPUT, gzipped)

const categories = bundle.taxonomy.areas.reduce((sum, area) => sum + area.categories.length, 0)

console.log(`HackerTube export of ${manifest.generated}: ${bundle.videos.length} of ${manifest.videos ?? '?'} videos, ${bundle.taxonomy.areas.length} areas, ${categories} categories`)
console.log(`${relative(process.cwd(), OUTPUT)}: ${gzipped.length} bytes (${json.length} bytes of JSON)`)
