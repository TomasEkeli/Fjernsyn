import { describe, expect, it, vi } from 'vitest'

import {
  downloadHackerTubeExport,
  fetchHackerTubeManifest,
  hackerTubeKind,
  isNewerExport,
} from './hackertube'
import { hackerTubeSource } from '../hackertube'

const NOW = Date.parse('2026-11-01T12:00:00Z')

// The manifest as /api/export answered on 2026-11-01, trimmed to what matters
const MANIFEST = {
  name: 'hackertube-data',
  generated: '2026-11-07',
  videos: 2,
  files: [{ name: 'videos.jsonl', bytes: 8634516, rows: 6454 }, { name: 'mentions.jsonl', bytes: 34691588, rows: 39834 }],
}

const ROWS = [
  { vid: 'aaaaaaaaaaa', title: 'A', channel: 'Ca', why_hn: 'why a', categories: [{ id: 'x', name: 'X' }], score: 25, hn: { recommenders: 1, first_year: 2018, last_year: 2026 }, quote: { hn_comment_id: 1 }, summary: 'dropped' },
  { vid: 'bbbbbbbbbbb', title: 'B', channel: 'Cb', why_hn: null, categories: [], score: 3, hn: { recommenders: 0, first_year: 2011, last_year: 2011 }, quote: null },
]

const TAXONOMY = { version: 'v2', areas: [{ id: 'a', name: 'Area', description: 'dropped', categories: [{ id: 'x', name: 'X', description: 'dropped' }] }] }

/**
 * @param {any} body
 * @param {number} [status]
 */
function answer(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}

/**
 * hackertube.org, as far as the update check asks it
 *
 * @param {object} [overrides] answers by path
 */
function fakeHackerTube(overrides = {}) {
  const routes = {
    '/api/export': () => answer(MANIFEST),
    '/download/videos.jsonl': () => answer(ROWS.map(row => JSON.stringify(row)).join('\n') + '\n'),
    '/download/taxonomy.json': () => answer(TAXONOMY),
    ...overrides,
  }

  return vi.fn(async (url) => {
    const { origin, pathname } = new URL(url)
    if (origin !== 'https://hackertube.org' || !Object.hasOwn(routes, pathname)) {
      return answer('not found', 404)
    }
    return routes[pathname]()
  })
}

/** @param {import('vitest').Mock} fetch */
const pathsAsked = fetch => fetch.mock.calls.map(([url]) => new URL(url).pathname)

describe('whether an export is newer than the one loaded', () => {
  it('is newer than nothing loaded', () => {
    expect(isNewerExport('2026-10-31', null)).toBe(true)
    expect(isNewerExport('2026-10-31', undefined)).toBe(true)
  })

  it('is not newer when it is the one loaded', () => {
    expect(isNewerExport('2026-10-31', '2026-10-31')).toBe(false)
  })

  it('is newer by a later date, and not by an earlier one', () => {
    expect(isNewerExport('2026-11-07', '2026-10-31')).toBe(true)
    expect(isNewerExport('2026-10-01', '2026-10-31')).toBe(false)
  })

  it('compares dates with times as the dates they are', () => {
    expect(isNewerExport('2026-10-31T10:00:00Z', '2026-10-31')).toBe(true)
    expect(isNewerExport('2026-10-31', '2026-10-31T10:00:00Z')).toBe(false)
  })

  it('takes a date it cannot read that differs from the one loaded for newer, so that a change of format is still loaded, once', () => {
    expect(isNewerExport('week 45', '2026-10-31')).toBe(true)
    expect(isNewerExport('week 45', 'week 45')).toBe(false)
  })
})

describe('HackerTube\'s export manifest', () => {
  it('is asked of /api/export, past any cache, with a time limit', async () => {
    const fetch = fakeHackerTube()

    expect(await fetchHackerTubeManifest(fetch)).toMatchObject({ generated: '2026-11-07' })
    expect(fetch).toHaveBeenCalledWith('https://hackertube.org/api/export', expect.objectContaining({ cache: 'no-cache', signal: expect.any(AbortSignal) }))
  })

  it('fails when the server answers with an error', async () => {
    await expect(fetchHackerTubeManifest(fakeHackerTube({ '/api/export': () => answer('down', 503) }))).rejects.toThrow('503')
  })

  it('fails when the answer is not JSON, or has no export date', async () => {
    await expect(fetchHackerTubeManifest(fakeHackerTube({ '/api/export': () => answer('<html>') }))).rejects.toThrow()
    await expect(fetchHackerTubeManifest(fakeHackerTube({ '/api/export': () => answer({ name: 'x' }) }))).rejects.toThrow('generated')
    await expect(fetchHackerTubeManifest(fakeHackerTube({ '/api/export': () => answer(null) }))).rejects.toThrow('generated')
  })

  it('fails when the server cannot be reached', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })

    await expect(fetchHackerTubeManifest(fetch)).rejects.toThrow('Failed to fetch')
  })
})

describe('downloading HackerTube\'s export', () => {
  it('downloads videos.jsonl and taxonomy.json, and only those, and strips them as the bundle is', async () => {
    const fetch = fakeHackerTube()

    const bundle = await downloadHackerTubeExport(fetch, '2026-11-07')

    expect(pathsAsked(fetch).sort()).toEqual(['/download/taxonomy.json', '/download/videos.jsonl'])
    expect(bundle.generated).toBe('2026-11-07')
    expect(bundle.videos.map(video => video.vid)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb'])
    expect(bundle.videos[0]).not.toHaveProperty('summary')
    expect(bundle.videos[0].categories).toEqual(['x'])
    expect(bundle.taxonomy).toEqual({ version: 'v2', areas: [{ id: 'a', name: 'Area', categories: [{ id: 'x', name: 'X' }] }] })
  })

  it('fails when either file cannot be downloaded', async () => {
    await expect(downloadHackerTubeExport(fakeHackerTube({ '/download/videos.jsonl': () => answer('gone', 404) }), '2026-11-07')).rejects.toThrow('404')
    await expect(downloadHackerTubeExport(fakeHackerTube({ '/download/taxonomy.json': () => answer('gone', 500) }), '2026-11-07')).rejects.toThrow('500')
  })

  it('fails on a videos file with no video in it, which is not an export but something else', async () => {
    await expect(downloadHackerTubeExport(fakeHackerTube({ '/download/videos.jsonl': () => answer('<html>maintenance</html>') }), '2026-11-07')).rejects.toThrow('no videos')
  })

  it('fails on a taxonomy that is not JSON', async () => {
    await expect(downloadHackerTubeExport(fakeHackerTube({ '/download/taxonomy.json': () => answer('<html>') }), '2026-11-07')).rejects.toThrow()
  })
})

describe('HackerTube as a source kind', () => {
  it('is the kind hackertube', () => {
    expect(hackerTubeKind.kind).toBe('hackertube')
  })

  it('recognises hackertube.org, in any of the forms it is written', () => {
    for (const url of ['https://hackertube.org', 'https://hackertube.org/', 'http://hackertube.org', 'hackertube.org', 'https://www.hackertube.org/data', 'https://hackertube.org/api/export', ' https://HackerTube.org ']) {
      expect(hackerTubeKind.recognise(url, NOW), url).toEqual(hackerTubeSource(NOW))
    }
  })

  it('recognises nothing else', () => {
    for (const url of ['', 'hackertube', 'https://nothackertube.org', 'https://hackertube.org.example.com', 'https://lemmy.cafe/c/mealtimevideos', 'ftp://hackertube.org', 'not a url at all']) {
      expect(hackerTubeKind.recognise(url, NOW), url).toBe(null)
    }
  })

  it('asks only for the manifest when the export is the one loaded, and gives nothing', async () => {
    const fetch = fakeHackerTube({ '/api/export': () => answer({ ...MANIFEST, generated: '2026-10-31' }) })

    const result = await hackerTubeKind.fetch({ ...hackerTubeSource(NOW), dataGenerated: '2026-10-31' }, { fetch })

    expect(pathsAsked(fetch)).toEqual(['/api/export'])
    expect(result).toEqual({ items: [] })
  })

  it('downloads a newer export, and gives its videos the export\'s date for the source, and its taxonomy as the source\'s own data', async () => {
    const fetch = fakeHackerTube()

    const result = await hackerTubeKind.fetch({ ...hackerTubeSource(NOW), dataGenerated: '2026-10-31' }, { fetch })

    expect(pathsAsked(fetch)).toEqual(['/api/export', '/download/videos.jsonl', '/download/taxonomy.json'])
    expect(result.items.map(video => video.vid)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb'])
    // The date on the source's record; the taxonomy, larger and rebuilt from
    // the bundle, apart from it
    expect(result.sourceFields).toEqual({ dataGenerated: '2026-11-07' })
    expect(result.sourceData).toEqual({ generated: '2026-11-07', taxonomy: { version: 'v2', areas: [{ id: 'a', name: 'Area', categories: [{ id: 'x', name: 'X' }] }] } })
  })

  it('never asks for the zip or the mentions', async () => {
    const fetch = fakeHackerTube()

    await hackerTubeKind.fetch(hackerTubeSource(NOW), { fetch })

    expect(pathsAsked(fetch).some(path => /\.zip$|mentions/.test(path))).toBe(false)
  })

  it('makes its videos HackerTube\'s shares', () => {
    const items = ROWS.map(row => ({ ...row, categories: row.categories.map(category => category.id) }))

    const shares = hackerTubeKind.toShares(items, hackerTubeSource(NOW), NOW)

    expect(shares).toHaveLength(2)
    expect(shares[0]).toMatchObject({ _id: 'hackertube|aaaaaaaaaaa', sourceId: 'hackertube', votes: 25, why: 'why a', categories: ['x'], seenAt: NOW })
  })
})
