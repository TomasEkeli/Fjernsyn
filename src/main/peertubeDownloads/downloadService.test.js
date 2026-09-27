import { describe, expect, it } from 'vitest'

import { buildFileName, createPeerTubeDownloadService } from './downloadService'
import { bytes, createFakeFetch } from './testing/fakeFetch'
import { createMemoryFileSystem } from '../ytdlp/testing/memoryFileSystem'

const UUID = '9c9de5e8-0a1e-484a-b099-e80766180a6d'
const KEY = `peertube:tilvids.com:${UUID}`
const FILE_URL = `https://tilvids.com/download/web-videos/${UUID}-1080.mp4`
const DOWNLOADS = '/home/tomas/Downloads'
const USER_AGENT = 'Fjernsyn/0.0.1 (+https://github.com/TomasEkeli/Fjernsyn)'

// The fields of the yt-dlp service's DownloadSnapshot, which the panel reads
const SNAPSHOT_FIELDS = [
  'videoId', 'title', 'quality', 'height', 'audioOnly', 'status', 'folder', 'destination', 'resuming', 'part', 'parts',
  'partKind', 'downloadedBytes', 'totalBytes', 'speed', 'eta', 'reason', 'exitCode', 'endedAt',
].sort()

/**
 * @param {object} [options]
 * @param {Record<string, import('./testing/fakeFetch').ScriptedResponse>} [options.responses]
 * @param {Record<string, string>} [options.settings]
 * @param {string[]} [options.existing] files already in the folder
 * @param {number} [options.stallMs]
 */
function setup({ responses = {}, settings = {}, existing = [], stallMs = 30_000 } = {}) {
  const fileSystem = createMemoryFileSystem()
  for (const filePath of existing) {
    fileSystem.files.set(filePath, { data: bytes(3, 9), mode: 0o644 })
  }

  const { fetch, requests } = createFakeFetch(responses)
  const clock = { time: 1_000_000 }

  const service = createPeerTubeDownloadService({
    fetch,
    fileSystem,
    readSetting: async id => settings[id] ?? '',
    defaultDownloadFolder: () => DOWNLOADS,
    now: () => clock.time,
    userAgent: USER_AGENT,
    platform: 'linux',
    stallMs,
  })

  /** @type {(import('./downloadService').PeerTubeDownloadOutcome & { at: number })[]} */
  const outcomes = []
  const report = (outcome) => {
    outcomes.push({ ...outcome, at: clock.time })
  }

  return { service, fileSystem, requests, clock, outcomes, report }
}

/**
 * @param {object} [overrides]
 */
function request(overrides = {}) {
  return { key: KEY, url: FILE_URL, title: 'A video', label: '1080p', resolution: 1080, audioOnly: false, videoUrl: null, ...overrides }
}

/**
 * @param {number} [length]
 * @param {Record<string, string>} [extra]
 */
function mp4Headers(length, extra = {}) {
  return { 'content-type': 'video/mp4', ...(length === undefined ? {} : { 'content-length': String(length) }), ...extra }
}

/**
 * @param {() => boolean} predicate
 */
async function until(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  expect(predicate()).toBe(true)
}

/**
 * @param {{ type: string }[]} outcomes
 */
const types = outcomes => outcomes.map(outcome => outcome.type)

describe('a download that goes well', () => {
  it('fetches the file with the prescribed User-Agent, no cookies, bypassing the HTTP cache', async () => {
    const { service, requests, report } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(4), chunks: [bytes(4)] } },
    })

    await service.start(request(), report)

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe(FILE_URL)
    expect(requests[0].init).toMatchObject({
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'manual',
    })
    expect(requests[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('writes to a temporary name and renames it once complete', async () => {
    const chunks = [bytes(1000, 1), bytes(1000, 2), bytes(500, 3)]
    const { service, fileSystem } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(2500), chunks } },
    })

    const finalPath = `${DOWNLOADS}/A video [1080p].mp4`
    let partSeen = false

    await service.start(request(), (outcome) => {
      if (outcome.type === 'started') {
        partSeen = fileSystem.files.has(`${finalPath}.part`) && !fileSystem.files.has(finalPath)
      }
    })

    expect(partSeen).toBe(true)
    expect(fileSystem.files.has(`${finalPath}.part`)).toBe(false)
    expect([...fileSystem.files.get(finalPath).data]).toEqual([...chunks.flatMap(chunk => [...chunk])])
  })

  it('reports preparing, then started with the destination, then finished with the path', async () => {
    const { service, report, outcomes } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(4), chunks: [bytes(4)] } },
    })

    await service.start(request(), report)

    expect(outcomes[0]).toMatchObject({ type: 'progress', videoId: KEY, title: 'A video', download: { status: 'preparing', folder: DOWNLOADS, destination: null } })

    const started = outcomes.find(outcome => outcome.type === 'started')
    expect(started.download).toMatchObject({
      videoId: KEY,
      status: 'downloading',
      destination: `${DOWNLOADS}/A video [1080p].mp4`,
      totalBytes: 4,
      downloadedBytes: 0,
    })

    const finished = outcomes.at(-1)
    expect(finished).toMatchObject({ type: 'finished', videoId: KEY, title: 'A video', path: `${DOWNLOADS}/A video [1080p].mp4` })
    expect(finished.download).toMatchObject({ status: 'finished', downloadedBytes: 4, speed: null, eta: null, endedAt: 1_000_000 })
  })

  it('carries a snapshot in the yt-dlp shape, so that the panel shows it unchanged', async () => {
    const { service, report, outcomes } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(4), chunks: [bytes(4)] } },
    })

    await service.start(request(), report)

    for (const outcome of outcomes) {
      expect(Object.keys(outcome.download).sort()).toEqual(SNAPSHOT_FIELDS)
    }

    expect(outcomes.at(-1).download).toMatchObject({
      quality: '1080p',
      height: 1080,
      audioOnly: false,
      resuming: false,
      part: 1,
      parts: 1,
      partKind: 'both',
      reason: null,
      exitCode: null,
    })
  })

  it('saves into the configured download folder when there is one', async () => {
    const { service, report, outcomes } = setup({
      settings: { ytDlpDownloadFolder: '/media/videos' },
      responses: { [FILE_URL]: { headers: mp4Headers(4), chunks: [bytes(4)] } },
    })

    await service.start(request(), report)

    expect(outcomes.at(-1).path).toBe('/media/videos/A video [1080p].mp4')
  })
})

describe('progress', () => {
  it('reports bytes, speed and time left, at most about once a second', async () => {
    const { service, clock, report, outcomes } = setup({
      responses: {
        [FILE_URL]: {
          headers: mp4Headers(1_000_000),
          chunks: Array.from({ length: 10 }, () => bytes(100_000)),
          // Each chunk arrives 250 ms after the one before
          onChunk: () => { clock.time += 250 },
        },
      },
    })

    await service.start(request(), report)

    const progress = outcomes.filter(outcome => outcome.type === 'progress' && outcome.download.status === 'downloading')
    expect(progress.length).toBeGreaterThanOrEqual(2)
    expect(progress.length).toBeLessThanOrEqual(3)

    const times = [outcomes.find(outcome => outcome.type === 'started').at, ...progress.map(outcome => outcome.at)]
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(1000)
    }

    // 100 kB every 250 ms is 400 kB/s
    const first = progress[0].download
    expect(first.speed).toBeCloseTo(400_000, -3)
    expect(first.totalBytes).toBe(1_000_000)
    expect(first.downloadedBytes).toBeGreaterThan(0)
    expect(first.eta).toBeCloseTo((1_000_000 - first.downloadedBytes) / first.speed, 3)
  })

  it('has no time left or total when the instance does not say the size', async () => {
    const { service, clock, report, outcomes } = setup({
      responses: {
        [FILE_URL]: {
          headers: { 'content-type': 'video/mp4' },
          chunks: Array.from({ length: 6 }, () => bytes(1000)),
          onChunk: () => { clock.time += 500 },
        },
      },
    })

    await service.start(request(), report)

    const progress = outcomes.filter(outcome => outcome.type === 'progress' && outcome.download.status === 'downloading')
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[0].download).toMatchObject({ totalBytes: null, eta: null })
    expect(outcomes.at(-1).type).toBe('finished')
  })
})

describe('failures', () => {
  it('fails on a bad status, naming it, and writes nothing', async () => {
    const { service, fileSystem, report, outcomes } = setup({
      responses: { [FILE_URL]: { status: 403, statusText: 'Forbidden' } },
    })

    await service.start(request(), report)

    expect(types(outcomes)).toEqual(['progress', 'failed'])
    expect(outcomes[1]).toMatchObject({ videoId: KEY, title: 'A video', exitCode: null, download: { status: 'failed' } })
    expect(outcomes[1].reason).toContain('403')
    expect(outcomes[1].download.reason).toBe(outcomes[1].reason)
    expect(fileSystem.files.size).toBe(0)
  })

  it('says the instance is limiting downloads on a 429, and to try again later', async () => {
    const { service, report, outcomes } = setup({
      responses: { [FILE_URL]: { status: 429, statusText: 'Too Many Requests' } },
    })

    await service.start(request(), report)

    const failed = outcomes.at(-1)
    expect(failed.type).toBe('failed')
    expect(failed.reason).toMatch(/limiting downloads/i)
    expect(failed.reason).toMatch(/try again later/i)
  })

  it('fails when the connection drops, and removes the partial file', async () => {
    const { service, fileSystem, report, outcomes } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(10_000), chunks: [bytes(1000)] } },
    })

    await service.start(request(), report)

    expect(outcomes.at(-1).type).toBe('failed')
    expect(outcomes.at(-1).reason).toMatch(/ended early/i)
    expect(fileSystem.files.size).toBe(0)
  })

  it('fails a body longer than its Content-Length, removing the partial file', async () => {
    const { service, fileSystem, report, outcomes } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(1500), chunks: [bytes(1000), bytes(1000)] } },
    })

    await service.start(request(), report)

    expect(outcomes.at(-1).type).toBe('failed')
    expect(outcomes.at(-1).reason).toMatch(/more than the 1500 bytes/)
    expect(fileSystem.files.size).toBe(0)
  })

  it('takes the size as unknown for a compressed body, with no ended early check', async () => {
    const { service, clock, report, outcomes } = setup({
      responses: {
        [FILE_URL]: {
          headers: mp4Headers(10_000, { 'content-encoding': 'gzip' }),
          chunks: [bytes(1000), bytes(1000)],
          onChunk: () => { clock.time += 1000 },
        },
      },
    })

    await service.start(request(), report)

    expect(outcomes.find(outcome => outcome.type === 'started').download.totalBytes).toBeNull()
    const progress = outcomes.filter(outcome => outcome.type === 'progress' && outcome.download.status === 'downloading')
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.every(outcome => outcome.download.totalBytes === null && outcome.download.eta === null)).toBe(true)
    expect(outcomes.at(-1).type).toBe('finished')
  })

  it('fails when fetching throws', async () => {
    const throwing = createPeerTubeDownloadService({
      fetch: async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED') },
      fileSystem: createMemoryFileSystem(),
      readSetting: async () => '',
      defaultDownloadFolder: () => DOWNLOADS,
      userAgent: USER_AGENT,
      platform: 'linux',
    })
    const seen = []
    await throwing.start(request(), outcome => seen.push(outcome))
    expect(seen.at(-1)).toMatchObject({ type: 'failed', reason: 'net::ERR_NAME_NOT_RESOLVED' })
  })

  it('fails a download that stalls, and removes the partial file', async () => {
    const { service, fileSystem, report, outcomes } = setup({
      stallMs: 20,
      responses: { [FILE_URL]: { headers: mp4Headers(10_000), chunks: [bytes(1000)], hang: true } },
    })

    await service.start(request(), report)

    expect(outcomes.at(-1).type).toBe('failed')
    expect(outcomes.at(-1).reason).toMatch(/tilvids\.com/)
    expect(fileSystem.files.size).toBe(0)
  })
})

describe('cancelling', () => {
  it('stops the download, removes the partial file and reports cancelled', async () => {
    const { service, fileSystem, report, outcomes } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(10_000), chunks: [bytes(1000)], hang: true } },
    })

    const done = service.start(request(), report)
    await until(() => outcomes.some(outcome => outcome.type === 'started'))

    expect(service.cancel(KEY)).toBe(true)
    await done

    expect(outcomes.at(-1)).toMatchObject({ type: 'cancelled', videoId: KEY, title: 'A video', download: { status: 'cancelled' } })
    expect(outcomes.some(outcome => outcome.type === 'failed')).toBe(false)
    expect(fileSystem.files.size).toBe(0)
  })

  it('cancels one still being prepared, before any byte', async () => {
    const { service, fileSystem, report, outcomes } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(4), chunks: [bytes(4)] } },
    })

    const done = service.start(request(), report)
    service.cancel(KEY)
    await done

    expect(outcomes.at(-1).type).toBe('cancelled')
    expect(fileSystem.files.size).toBe(0)
  })

  it('has nothing to cancel for a key that is not running', () => {
    const { service } = setup()
    expect(service.cancel(KEY)).toBe(false)
  })

  it('says nothing and keeps nothing on quit', async () => {
    const { service, fileSystem, report, outcomes } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(10_000), chunks: [bytes(1000)], hang: true } },
    })

    const done = service.start(request(), report)
    await until(() => outcomes.some(outcome => outcome.type === 'started'))
    const count = outcomes.length

    expect(service.quit()).toEqual([`${DOWNLOADS}/A video [1080p].mp4.part`])
    await done

    expect(outcomes).toHaveLength(count)
    expect(fileSystem.files.size).toBe(0)
  })
})

describe('quitting during a write', () => {
  it('returns the .part and removes it, saying nothing', async () => {
    const { service, fileSystem, report, outcomes } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(10_000), chunks: [bytes(1000)] } },
    })

    // A disk that never finishes the write
    const openWrite = fileSystem.openWrite
    let writing = false
    fileSystem.openWrite = async (filePath, options) => {
      const file = await openWrite(filePath, options)
      return {
        ...file,
        write: () => {
          writing = true
          return new Promise(() => {})
        },
      }
    }

    const done = service.start(request(), report)
    await until(() => writing)
    const count = outcomes.length

    expect(service.quit()).toEqual([`${DOWNLOADS}/A video [1080p].mp4.part`])
    await done

    expect(outcomes).toHaveLength(count)
    expect(fileSystem.files.size).toBe(0)
  })
})

describe('one download per key', () => {
  it('turns a second start away while the first runs', async () => {
    const { service, report, outcomes } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(10_000), chunks: [bytes(1000)], hang: true } },
    })

    const done = service.start(request(), report)
    await service.start(request(), report)

    expect(outcomes.at(-1)).toEqual({ type: 'already-running', videoId: KEY, title: 'A video', at: 1_000_000 })

    service.cancel(KEY)
    await done
  })

  it('takes the same key again once the first has ended', async () => {
    const { service, report, outcomes } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(4), chunks: [bytes(4)] } },
    })

    await service.start(request(), report)
    await service.start(request(), report)

    expect(types(outcomes).filter(type => type === 'finished')).toHaveLength(2)
  })
})

describe('the file name', () => {
  it('is sanitised in main from the title', async () => {
    const { service, report, outcomes } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(4), chunks: [bytes(4)] } },
    })

    await service.start(request({ title: '../../etc/pass\u0000wd: a "test" <video>?* | \\ \u202Emp4.exe. ' }), report)

    const path = outcomes.at(-1).path
    expect(path.startsWith(`${DOWNLOADS}/`)).toBe(true)
    const name = path.slice(DOWNLOADS.length + 1)
    expect(name).not.toMatch(/[/\\:*?"<>|\u202e]/)
    expect([...name].some(char => char.charCodeAt(0) < 0x20)).toBe(false)
    expect(name).toMatch(/ \[1080p\]\.mp4$/)
    expect(name.startsWith('.')).toBe(false)
  })

  it('never overwrites an existing file', async () => {
    const existing = `${DOWNLOADS}/A video [1080p].mp4`
    const { service, fileSystem, report, outcomes } = setup({
      existing: [existing, `${DOWNLOADS}/A video [1080p] (2).mp4.part`],
      responses: { [FILE_URL]: { headers: mp4Headers(4), chunks: [bytes(4)] } },
    })

    await service.start(request(), report)

    expect(outcomes.at(-1).path).toBe(`${DOWNLOADS}/A video [1080p] (3).mp4`)
    expect([...fileSystem.files.get(existing).data]).toEqual([9, 9, 9])
  })

  it('gives two downloads running at once names of their own', async () => {
    const otherKey = `${KEY}:720`
    const otherUrl = `https://tilvids.com/download/web-videos/${UUID}-720.mp4`
    const { service, report, outcomes } = setup({
      responses: {
        [FILE_URL]: { headers: mp4Headers(4), chunks: [bytes(4)] },
        [otherUrl]: { headers: mp4Headers(4), chunks: [bytes(4)] },
      },
    })

    await Promise.all([
      service.start(request({ resolution: null, label: 'Same' }), report),
      service.start(request({ key: otherKey, url: otherUrl, resolution: null, label: 'Same' }), report),
    ])

    const paths = outcomes.filter(outcome => outcome.type === 'finished').map(outcome => outcome.path).sort()
    expect(paths).toEqual([`${DOWNLOADS}/A video [Same] (2).mp4`, `${DOWNLOADS}/A video [Same].mp4`])
  })

  it('is audio with an audio extension from the content type', async () => {
    const { service, report, outcomes } = setup({
      responses: { [FILE_URL]: { headers: { 'content-type': 'audio/mp4' }, chunks: [bytes(4)] } },
    })

    await service.start(request({ resolution: 0, audioOnly: true, label: 'Audio only' }), report)

    expect(outcomes.at(-1).path).toBe(`${DOWNLOADS}/A video [audio].m4a`)
    expect(outcomes.at(-1).download).toMatchObject({ height: null, audioOnly: true, partKind: 'audio', quality: 'Audio only' })
  })

  it('takes the extension from the URL after redirects when the content type says nothing', async () => {
    const storage = 'https://storage.example.net/web-videos/x.webm'
    const { service, report, outcomes } = setup({
      responses: {
        [FILE_URL]: { status: 302, headers: { location: storage } },
        [storage]: { headers: { 'content-type': 'application/octet-stream' }, chunks: [bytes(4)] },
      },
    })

    await service.start(request(), report)

    expect(outcomes.at(-1).path).toBe(`${DOWNLOADS}/A video [1080p].webm`)
  })

  it('falls back to the video id when the title leaves nothing', async () => {
    const { service, report, outcomes } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(4), chunks: [bytes(4)] } },
    })

    await service.start(request({ title: ' ... ' }), report)

    expect(outcomes.at(-1).path).toBe(`${DOWNLOADS}/${UUID} [1080p].mp4`)
  })
})

describe('redirects', () => {
  const STORAGE = `https://bucket.s3.example.net/web-videos/${UUID}-1080.mp4`

  it('follows a redirect to object storage, holding it to the same rule', async () => {
    const { service, requests, report, outcomes } = setup({
      responses: {
        [FILE_URL]: { status: 302, headers: { location: STORAGE } },
        [STORAGE]: { headers: mp4Headers(4), chunks: [bytes(4)] },
      },
    })

    await service.start(request(), report)

    expect(requests.map(({ url }) => url)).toEqual([FILE_URL, STORAGE])
    expect(requests[1].init).toMatchObject({ redirect: 'manual', credentials: 'omit', headers: { 'User-Agent': USER_AGENT } })
    expect(outcomes.at(-1)).toMatchObject({ type: 'finished', path: `${DOWNLOADS}/A video [1080p].mp4` })
  })

  it('resolves a relative location against the URL that sent it', async () => {
    const moved = `https://tilvids.com/static/web-videos/${UUID}-1080.mp4`
    const { service, requests, report, outcomes } = setup({
      responses: {
        [FILE_URL]: { status: 307, headers: { location: `/static/web-videos/${UUID}-1080.mp4` } },
        [moved]: { headers: mp4Headers(4), chunks: [bytes(4)] },
      },
    })

    await service.start(request(), report)

    expect(requests.at(-1).url).toBe(moved)
    expect(outcomes.at(-1).type).toBe('finished')
  })

  it('refuses a redirect the URL rule does not allow, fetching nothing from it', async () => {
    for (const location of [
      'https://evil.example/steal',
      `http://tilvids.com/download/web-videos/${UUID}-1080.mp4`,
      'file:///etc/passwd',
      'https://user:pw@bucket.example.net/x.mp4',
    ]) {
      const { service, requests, fileSystem, report, outcomes } = setup({
        responses: {
          [FILE_URL]: { status: 301, headers: { location } },
          [location]: { headers: mp4Headers(4), chunks: [bytes(4)] },
        },
      })

      await service.start(request(), report)

      expect(requests, location).toHaveLength(1)
      expect(outcomes.at(-1).type, location).toBe('failed')
      expect(outcomes.at(-1).reason).toMatch(/redirected/)
      expect(fileSystem.files.size).toBe(0)
    }
  })

  it('refuses a redirect with no location', async () => {
    const { service, report, outcomes } = setup({
      responses: { [FILE_URL]: { status: 302 } },
    })

    await service.start(request(), report)

    expect(outcomes.at(-1).type).toBe('failed')
  })

  /**
   * @param {number} hops
   */
  function chain(hops) {
    const urls = Array.from({ length: hops + 1 }, (_, i) => `https://tilvids.com/download/hop${i}.mp4`)
    const responses = Object.fromEntries(urls.map((url, i) => [
      url,
      i < hops ? { status: 302, headers: { location: urls[i + 1] } } : { headers: mp4Headers(4), chunks: [bytes(4)] },
    ]))
    return { first: urls[0], responses }
  }

  it('follows up to five redirects', async () => {
    const { first, responses } = chain(5)
    const { service, requests, report, outcomes } = setup({ responses })

    await service.start(request({ url: first }), report)

    expect(requests).toHaveLength(6)
    expect(outcomes.at(-1).type).toBe('finished')
  })

  it('gives up after five', async () => {
    const { first, responses } = chain(6)
    const { service, requests, report, outcomes } = setup({ responses })

    await service.start(request({ url: first }), report)

    expect(requests).toHaveLength(6)
    expect(outcomes.at(-1)).toMatchObject({ type: 'failed' })
    expect(outcomes.at(-1).reason).toMatch(/more than 5/)
  })
})

describe('never replacing a file', () => {
  const FINAL = `${DOWNLOADS}/A video [1080p].mp4`
  const SECOND = `${DOWNLOADS}/A video [1080p] (2).mp4`

  it('takes the next name when a .part is already beside the chosen one, leaving it alone', async () => {
    const { service, fileSystem, report, outcomes } = setup({
      existing: [`${FINAL}.part`],
      responses: { [FILE_URL]: { headers: mp4Headers(4), chunks: [bytes(4)] } },
    })

    await service.start(request(), report)

    expect(outcomes.at(-1).path).toBe(SECOND)
    expect([...fileSystem.files.get(`${FINAL}.part`).data]).toEqual([9, 9, 9])
  })

  it('takes the next name when a .part turns up between the check and the open', async () => {
    const { service, fileSystem, report, outcomes } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(4), chunks: [bytes(4)] } },
    })

    // The check misses it once, as when another program creates it just then
    const exists = fileSystem.exists
    let missed = false
    fileSystem.files.set(`${FINAL}.part`, { data: bytes(3, 9), mode: 0o644 })
    fileSystem.exists = async (filePath) => {
      if (filePath === `${FINAL}.part` && !missed) {
        missed = true
        return false
      }
      return exists(filePath)
    }

    await service.start(request(), report)

    expect(outcomes.at(-1).path).toBe(SECOND)
    expect([...fileSystem.files.get(`${FINAL}.part`).data]).toEqual([9, 9, 9])
  })

  it('takes the next name when the final one is taken while downloading', async () => {
    const { service, fileSystem, report, outcomes } = setup({
      responses: {
        [FILE_URL]: {
          headers: mp4Headers(4),
          chunks: [bytes(4)],
          onChunk: () => {
            fileSystem.files.set(FINAL, { data: bytes(3, 9), mode: 0o644 })
          },
        },
      },
    })

    await service.start(request(), report)

    expect(outcomes.at(-1)).toMatchObject({ type: 'finished', path: SECOND, download: { destination: SECOND } })
    expect([...fileSystem.files.get(FINAL).data]).toEqual([9, 9, 9])
    expect([...fileSystem.files.get(SECOND).data]).toEqual([1, 1, 1, 1])
    expect(fileSystem.files.has(`${FINAL}.part`)).toBe(false)
  })

  it('renames instead where hard links are not supported, once the name is seen free', async () => {
    for (const code of ['EPERM', 'ENOTSUP', 'EXDEV']) {
      const { service, fileSystem, report, outcomes } = setup({
        responses: { [FILE_URL]: { headers: mp4Headers(4), chunks: [bytes(4)] } },
      })
      fileSystem.link = async () => { throw Object.assign(new Error(code), { code }) }

      await service.start(request(), report)

      expect(outcomes.at(-1).path, code).toBe(FINAL)
      expect(fileSystem.files.has(`${FINAL}.part`)).toBe(false)
    }
  })

  it('without hard links, still takes the next name when the final one is taken', async () => {
    const { service, fileSystem, report, outcomes } = setup({
      responses: {
        [FILE_URL]: {
          headers: mp4Headers(4),
          chunks: [bytes(4)],
          onChunk: () => {
            fileSystem.files.set(FINAL, { data: bytes(3, 9), mode: 0o644 })
          },
        },
      },
    })
    fileSystem.link = async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) }

    await service.start(request(), report)

    expect(outcomes.at(-1).path).toBe(SECOND)
    expect([...fileSystem.files.get(FINAL).data]).toEqual([9, 9, 9])
  })

  it('fails cleanly on any other error making the link, removing the .part', async () => {
    const { service, fileSystem, report, outcomes } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(4), chunks: [bytes(4)] } },
    })
    fileSystem.link = async () => { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }) }

    await service.start(request(), report)

    expect(outcomes.at(-1)).toMatchObject({ type: 'failed', reason: 'EIO: i/o error' })
    expect(fileSystem.files.size).toBe(0)
  })
})

describe('buildFileName', () => {
  it('steps around the console device names too', () => {
    expect(buildFileName({ title: 'CONIN$', fallback: UUID, tag: null, extension: 'mp4' })).toBe('_CONIN$.mp4')
    expect(buildFileName({ title: 'conout$', fallback: UUID, tag: null, extension: 'mp4' })).toBe('_conout$.mp4')
  })

  it('caps the title at 120 characters', () => {
    expect(buildFileName({ title: 'a'.repeat(300), fallback: UUID, tag: null, extension: 'mp4' })).toBe(`${'a'.repeat(120)}.mp4`)
  })

  it('steps around names Windows reserves', () => {
    expect(buildFileName({ title: 'CON', fallback: UUID, tag: null, extension: 'mp4' })).toBe('_CON.mp4')
    expect(buildFileName({ title: 'lpt1.backup', fallback: UUID, tag: null, extension: 'mp4' })).toBe('_lpt1.backup.mp4')
    expect(buildFileName({ title: 'Console', fallback: UUID, tag: null, extension: 'mp4' })).toBe('Console.mp4')
  })

  it('caps a long title, in bytes, without splitting a character', () => {
    const name = buildFileName({ title: '日本語'.repeat(200), fallback: UUID, tag: '1080p', extension: 'mp4' })
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(220)
    expect(name).toMatch(/^(日本語)+(日本?|日)? \[1080p\]\.mp4$/)
    expect(name).not.toContain('\uFFFD')
  })

  it('sanitises the label used as a tag', () => {
    expect(buildFileName({ title: 'A', fallback: UUID, tag: 'x/y', extension: 'mp4' })).toBe('A [x_y].mp4')
  })
})

describe('the session list', () => {
  it('lists running and ended downloads, and the finished file per key', async () => {
    const { service, report } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(4), chunks: [bytes(4)] } },
    })

    await service.start(request(), report)

    const { downloads, finished } = service.list()
    expect(downloads).toHaveLength(1)
    expect(downloads[0]).toMatchObject({ videoId: KEY, status: 'finished' })
    expect(finished).toEqual({ [KEY]: `${DOWNLOADS}/A video [1080p].mp4` })
  })

  it('drops a dismissed download from the list, but not its finished file', async () => {
    const { service, report } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(4), chunks: [bytes(4)] } },
    })

    await service.start(request(), report)
    service.dismiss(KEY)

    expect(service.list().downloads).toEqual([])
    expect(service.list().finished).toEqual({ [KEY]: `${DOWNLOADS}/A video [1080p].mp4` })
  })

  it('forgets ended downloads after a few minutes', async () => {
    const { service, clock, report } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(4), chunks: [bytes(4)] } },
    })

    await service.start(request(), report)
    clock.time += 6 * 60 * 1000

    expect(service.list().downloads).toEqual([])
  })

  it('reveals the finished file, or its folder once it has gone', async () => {
    const { service, fileSystem, report } = setup({
      responses: { [FILE_URL]: { headers: mp4Headers(4), chunks: [bytes(4)] } },
    })

    expect(await service.revealPath(KEY)).toBeNull()

    await service.start(request(), report)
    expect(await service.revealPath(KEY)).toEqual({ file: `${DOWNLOADS}/A video [1080p].mp4` })

    fileSystem.files.delete(`${DOWNLOADS}/A video [1080p].mp4`)
    expect(await service.revealPath(KEY)).toEqual({ folder: DOWNLOADS })
  })
})
