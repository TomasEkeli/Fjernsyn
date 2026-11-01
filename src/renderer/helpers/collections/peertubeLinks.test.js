import { describe, expect, it, vi } from 'vitest'

import { PlatformError } from '../../platform/errors'
import { createPlatformLayer } from '../../platform/index'
import { createFakeFetch } from '../../platform/peertube/testing/fakeFetch'
import blenderConfig from '../../platform/peertube/fixtures/video.blender.org--config.json'
import blenderHls from '../../platform/peertube/fixtures/video.blender.org--video-hls.json'
import { UNAVAILABLE_STALE_MS, unavailableRecord } from './details'
import {
  createHostMemory,
  createPeerTubeLinkResolver,
  HOST_VERDICT_STALE_MS,
  HOSTS_REMEMBERED,
  hostVerdict,
  knownPeerTubeVideos,
  PEERTUBE_HOSTS_KEY,
  readHostMemory,
  withHostVerdict,
} from './peertubeLinks'

const UUID = 'ef67ed68-de61-4c06-a9c0-90d1569bc9bf'
const ORIGIN = 'video.blender.org'

/** A storage as localStorage is, in memory */
function memoryStorage() {
  const items = new Map()
  return {
    getItem: key => items.has(key) ? items.get(key) : null,
    setItem: (key, value) => { items.set(key, String(value)) },
    items,
  }
}

describe('the hosts remembered', () => {
  it('reads nothing from nothing, or from what is not a memory', () => {
    expect(readHostMemory(null)).toEqual({})
    expect(readHostMemory('not json')).toEqual({})
    expect(readHostMemory('[1,2]')).toEqual({})
    expect(readHostMemory(JSON.stringify({ 'a.example': { peertube: 'yes', at: 1 }, 'b.example': { peertube: true, at: 2 } })))
      .toEqual({ 'b.example': { peertube: true, at: 2 } })
  })

  it('believes what a host was found to be for thirty days, and then asks again', () => {
    const memory = withHostVerdict({}, 'tilvids.com', true, 1000)

    expect(hostVerdict(memory, 'tilvids.com', 1000 + HOST_VERDICT_STALE_MS)).toBe(true)
    expect(hostVerdict(memory, 'tilvids.com', 1001 + HOST_VERDICT_STALE_MS)).toBe(null)
    expect(hostVerdict(withHostVerdict({}, 'github.com', false, 1000), 'github.com', 2000)).toBe(false)
    expect(hostVerdict(memory, 'unknown.example', 1000)).toBe(null)
  })

  it('does not believe a verdict from the future, which only a clock put back explains', () => {
    expect(hostVerdict(withHostVerdict({}, 'tilvids.com', false, 5000), 'tilvids.com', 1000)).toBe(null)
  })

  it('keeps no more than the most recently asked hosts', () => {
    let memory = {}
    for (let index = 0; index < HOSTS_REMEMBERED; index++) {
      memory = withHostVerdict(memory, `host${index}.example`, false, index)
    }

    memory = withHostVerdict(memory, 'newest.example', true, HOSTS_REMEMBERED)

    expect(Object.keys(memory)).toHaveLength(HOSTS_REMEMBERED)
    expect(memory).not.toHaveProperty('host0.example')
    expect(memory).toHaveProperty('host1.example')
    expect(memory['newest.example']).toEqual({ peertube: true, at: HOSTS_REMEMBERED })
  })

  it('is kept in the storage given, where another window finds it', () => {
    const storage = memoryStorage()

    createHostMemory(storage).remember('github.com', false, 1)

    expect(JSON.parse(storage.items.get(PEERTUBE_HOSTS_KEY))).toEqual({ 'github.com': { peertube: false, at: 1 } })
    expect(createHostMemory(storage).verdict('github.com', 2)).toBe(false)
  })

  it('remembers nothing, and fails nothing, when the storage cannot be used', () => {
    const broken = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') } }
    const memory = createHostMemory(broken)

    expect(() => memory.remember('github.com', false, 1)).not.toThrow()
    expect(memory.verdict('github.com', 1)).toBe(null)
  })
})

describe('the PeerTube videos kept, by uuid', () => {
  it('knows a video by its share, at its origin, whichever host the details are kept under', () => {
    const known = knownPeerTubeVideos(
      [{ _id: `s|${UUID}@${ORIGIN}`, sourceId: 's', videoId: UUID, platform: 'peertube', host: ORIGIN }, { _id: 's|dQw4w9WgXcQ', sourceId: 's', videoId: 'dQw4w9WgXcQ' }],
      { [`${UUID}@${ORIGIN}`]: { _id: `${UUID}@${ORIGIN}`, videoId: UUID, platform: 'peertube', host: ORIGIN, fetchedAt: 1 } }
    )

    expect(known.get(UUID)).toMatchObject({ ref: { platform: 'peertube', host: ORIGIN, videoId: UUID }, shared: true, record: { fetchedAt: 1 } })
    expect(known.has('dQw4w9WgXcQ')).toBe(false)
  })

  it('knows a video by its details alone, not shared', () => {
    const known = knownPeerTubeVideos([], { [`${UUID}@tilvids.com`]: unavailableRecord({ platform: 'peertube', host: 'tilvids.com', videoId: UUID }, 'gone', 1) })

    expect(known.get(UUID)).toMatchObject({ ref: { host: 'tilvids.com' }, shared: false, record: { unavailable: 'gone' } })
  })
})

describe('confirming a PeerTube candidate', () => {
  const summary = {
    type: 'video',
    platform: 'peertube',
    host: ORIGIN,
    videoId: UUID,
    title: 'Its own title',
    author: 'Its channel',
    authorId: `channel@${ORIGIN}`,
    lengthSeconds: 70,
    viewCount: 3,
    published: 4,
    liveNow: false,
    isUpcoming: false,
    nsfw: false,
    thumbnail: `https://${ORIGIN}/t.jpg`,
  }

  /** @param {Partial<import('./peertubeLinks').PeerTubeLinkDependencies> & { known?: Map<any, any>, verdicts?: Record<string, boolean | null> }} [overrides] */
  function setUp({ known = new Map(), verdicts = {}, ...overrides } = {}) {
    const remembered = []
    const deps = {
      enabled: () => true,
      known: vi.fn(() => known),
      hosts: {
        verdict: host => verdicts[host] ?? null,
        remember: (host, peertube) => { remembered.push([host, peertube]) },
      },
      resolveUrl: vi.fn(async url => ({ platform: 'peertube', kind: 'video', ref: { platform: 'peertube', host: new URL(url).hostname, videoId: UUID }, host: new URL(url).hostname, timestamp: null })),
      getVideoSummary: vi.fn(async () => summary),
      putDetails: vi.fn(async () => {}),
      now: () => 100,
      ...overrides,
    }

    return { deps, remembered, resolver: createPeerTubeLinkResolver(deps) }
  }

  it('asks the host whether it is PeerTube, then the video\'s origin, and answers its ref there, keeping its details', async () => {
    const { deps, remembered, resolver } = setUp()

    expect(await resolver.refFor({ host: 'tilvids.com', videoId: UUID })).toEqual({ platform: 'peertube', host: ORIGIN, videoId: UUID })
    expect(deps.resolveUrl).toHaveBeenCalledWith(`https://tilvids.com/videos/watch/${UUID}`)
    expect(deps.getVideoSummary).toHaveBeenCalledWith({ platform: 'peertube', host: 'tilvids.com', videoId: UUID })
    expect(remembered).toEqual([['tilvids.com', true]])
    expect(deps.putDetails).toHaveBeenCalledWith([expect.objectContaining({
      _id: `${UUID}@${ORIGIN}`,
      platform: 'peertube',
      host: ORIGIN,
      fetchedAt: 100,
      title: 'Its own title',
      authorId: `channel@${ORIGIN}`,
      lengthSeconds: 70,
      thumbnail: `https://${ORIGIN}/t.jpg`,
    })])
  })

  it('skips a host that is not PeerTube, and remembers so', async () => {
    const { deps, remembered, resolver } = setUp({ resolveUrl: vi.fn(async () => null) })

    expect(await resolver.refFor({ host: 'example.org', videoId: UUID })).toBe(null)
    expect(remembered).toEqual([['example.org', false]])
    expect(deps.getVideoSummary).not.toHaveBeenCalled()
    expect(deps.putDetails).not.toHaveBeenCalled()
  })

  it('asks nothing of a host remembered as not PeerTube', async () => {
    const { deps, resolver } = setUp({ verdicts: { 'example.org': false } })

    expect(await resolver.refFor({ host: 'example.org', videoId: UUID })).toBe(null)
    expect(deps.resolveUrl).not.toHaveBeenCalled()
  })

  it('asks a host remembered as PeerTube for the video straight away', async () => {
    const { deps, resolver } = setUp({ verdicts: { 'tilvids.com': true } })

    expect(await resolver.refFor({ host: 'tilvids.com', videoId: UUID })).toMatchObject({ host: ORIGIN })
    expect(deps.resolveUrl).not.toHaveBeenCalled()
    expect(deps.getVideoSummary).toHaveBeenCalledWith({ platform: 'peertube', host: 'tilvids.com', videoId: UUID })
  })

  it('skips a host that could not be asked this time, remembering nothing of it', async () => {
    const onFailure = vi.fn()
    const { remembered, resolver } = setUp({ resolveUrl: vi.fn(async () => { throw new PlatformError('unavailable', 'down') }), onFailure })

    expect(await resolver.refFor({ host: 'tilvids.com', videoId: UUID })).toBe(null)
    expect(remembered).toEqual([])
    expect(onFailure).toHaveBeenCalled()
  })

  it('asks nothing about a video already shared, and answers it at its origin', async () => {
    const known = new Map([[UUID, { ref: { platform: 'peertube', host: ORIGIN, videoId: UUID }, shared: true }]])
    const { deps, resolver } = setUp({ known })

    expect(await resolver.refFor({ host: 'tilvids.com', videoId: UUID })).toEqual({ platform: 'peertube', host: ORIGIN, videoId: UUID })
    expect(deps.resolveUrl).not.toHaveBeenCalled()
    expect(deps.getVideoSummary).not.toHaveBeenCalled()
  })

  it('asks nothing about a video whose details are kept', async () => {
    const known = new Map([[UUID, { ref: { platform: 'peertube', host: ORIGIN, videoId: UUID }, shared: false, record: { _id: 'x', videoId: UUID, fetchedAt: 1 } }]])
    const { deps, resolver } = setUp({ known })

    expect(await resolver.refFor({ host: ORIGIN, videoId: UUID })).toMatchObject({ host: ORIGIN })
    expect(deps.resolveUrl).not.toHaveBeenCalled()
  })

  it('skips a video kept as gone, and asks again once that mark is stale', async () => {
    const ref = { platform: 'peertube', host: 'tilvids.com', videoId: UUID }
    const known = new Map([[UUID, { ref, shared: false, record: unavailableRecord(ref, 'gone', 50) }]])

    const fresh = setUp({ known })
    expect(await fresh.resolver.refFor({ host: 'tilvids.com', videoId: UUID })).toBe(null)
    expect(fresh.deps.resolveUrl).not.toHaveBeenCalled()

    const stale = setUp({ known, now: () => 51 + UNAVAILABLE_STALE_MS })
    expect(await stale.resolver.refFor({ host: 'tilvids.com', videoId: UUID })).toMatchObject({ host: ORIGIN })
  })

  it.each([
    [new PlatformError('notFound', 'no', { status: 404, host: 'tilvids.com', body: { title: 'Not Found', detail: 'Video not found', status: 404 } }), 'gone'],
    [new PlatformError('refused', 'no', { status: 403, host: 'tilvids.com', reason: 'private' }), 'private'],
  ])('keeps a video its instance has no answer for as unavailable, and skips it: %s', async (error, unavailable) => {
    const { deps, resolver } = setUp({ getVideoSummary: vi.fn(async () => { throw error }) })

    expect(await resolver.refFor({ host: 'tilvids.com', videoId: UUID })).toBe(null)
    expect(deps.putDetails).toHaveBeenCalledWith([unavailableRecord({ platform: 'peertube', host: 'tilvids.com', videoId: UUID }, unavailable, 100)])
  })

  it('keeps nothing for a video that could not be had for a reason that says nothing of it', async () => {
    const { deps, resolver } = setUp({ getVideoSummary: vi.fn(async () => { throw new PlatformError('rateLimited', 'slow') }) })

    expect(await resolver.refFor({ host: 'tilvids.com', videoId: UUID })).toBe(null)
    expect(deps.putDetails).not.toHaveBeenCalled()
  })

  it('still answers the ref when its details cannot be kept', async () => {
    const { resolver } = setUp({ putDetails: vi.fn(async () => { throw new Error('disk') }) })

    expect(await resolver.refFor({ host: 'tilvids.com', videoId: UUID })).toMatchObject({ host: ORIGIN })
  })

  it('asks about a video posted twice once', async () => {
    const { deps, resolver } = setUp()

    const [a, b] = await Promise.all([
      resolver.refFor({ host: 'tilvids.com', videoId: UUID }),
      resolver.refFor({ host: ORIGIN, videoId: UUID }),
    ])

    expect(a).toEqual(b)
    expect(deps.getVideoSummary).toHaveBeenCalledTimes(1)
  })

  it('takes nothing for PeerTube, and asks nothing, while PeerTube is switched off', async () => {
    const { deps, resolver } = setUp({ enabled: () => false })

    expect(await resolver.refFor({ host: 'tilvids.com', videoId: UUID })).toBe(null)
    expect(deps.known).not.toHaveBeenCalled()
    expect(deps.resolveUrl).not.toHaveBeenCalled()
  })

  it('works through the platform layer itself: the config, then the video, and nothing more', async () => {
    const fake = createFakeFetch([blenderConfig, blenderHls])
    const layer = createPlatformLayer({ fetch: fake.fetch, config: { peertubeEnabled: true } })
    const putDetails = vi.fn(async () => {})
    const storage = memoryStorage()
    const resolver = createPeerTubeLinkResolver({
      enabled: () => layer.config.peertubeEnabled,
      known: () => new Map(),
      hosts: createHostMemory(storage),
      resolveUrl: url => layer.resolveUrl(url),
      getVideoSummary: ref => layer.getVideoSummary(ref),
      putDetails,
      now: () => 7,
    })
    const uuid = blenderHls.body.uuid

    expect(await resolver.refFor({ host: ORIGIN, videoId: uuid })).toEqual({ platform: 'peertube', host: ORIGIN, videoId: uuid })
    expect(fake.urls()).toEqual([`https://${ORIGIN}/api/v1/config`, `https://${ORIGIN}/api/v1/videos/${uuid}`])
    expect(putDetails.mock.calls[0][0][0]).toMatchObject({ _id: `${uuid}@${ORIGIN}`, lengthSeconds: 70, authorId: 'blender_studio@video.blender.org' })
    expect(createHostMemory(storage).verdict(ORIGIN, 8)).toBe(true)
  })

  it('takes a host whose config is not PeerTube\'s for not PeerTube, through the layer', async () => {
    const fake = createFakeFetch([])
    fake.respond('https://example.org/api/v1/config', { status: 404, body: '<html>Not found</html>' })
    const layer = createPlatformLayer({ fetch: fake.fetch, config: { peertubeEnabled: true } })
    const storage = memoryStorage()
    const resolver = createPeerTubeLinkResolver({
      enabled: () => true,
      known: () => new Map(),
      hosts: createHostMemory(storage),
      resolveUrl: url => layer.resolveUrl(url),
      getVideoSummary: ref => layer.getVideoSummary(ref),
      putDetails: vi.fn(),
      now: () => 7,
    })

    expect(await resolver.refFor({ host: 'example.org', videoId: UUID })).toBe(null)
    expect(fake.urls()).toEqual(['https://example.org/api/v1/config'])
    expect(createHostMemory(storage).verdict('example.org', 8)).toBe(false)
  })
})
