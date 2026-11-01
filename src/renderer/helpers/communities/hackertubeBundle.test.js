import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { readHackerTubeBundle } from './hackertubeBundle'

const BUNDLE = {
  formatVersion: 1,
  generated: '2026-10-31',
  taxonomy: { version: 'v', areas: [] },
  videos: [{ vid: 'aaaaaaaaaaa', title: 'A', channel: 'C', why_hn: null, categories: [], score: 1, hn: { recommenders: 1, first_year: 2020, last_year: 2021 }, quote: null }],
}

describe('reading the HackerTube bundle', () => {
  it('reads the gzipped file the build script writes', async () => {
    const bytes = gzipSync(JSON.stringify(BUNDLE))

    expect(await readHackerTubeBundle(bytes)).toEqual(BUNDLE)
  })

  it('reads it already unzipped, as a server that decoded it on the way hands it over', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(BUNDLE))

    expect(await readHackerTubeBundle(bytes)).toEqual(BUNDLE)
  })

  it('refuses a bundle of a format this version cannot read', async () => {
    const bytes = gzipSync(JSON.stringify({ ...BUNDLE, formatVersion: 2 }))

    await expect(readHackerTubeBundle(bytes)).rejects.toThrow(/format/)
  })

  it('refuses something that is not a bundle', async () => {
    await expect(readHackerTubeBundle(gzipSync('{"videos": "no"}'))).rejects.toThrow()
    await expect(readHackerTubeBundle(new TextEncoder().encode('not json'))).rejects.toThrow()
  })
})
