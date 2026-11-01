import { describe, expect, it, vi } from 'vitest'

import { lastRefreshOf, REFRESH_AFTER_MS, refreshCollectionSources, refreshIsDue } from './refresh'

const NOW = Date.parse('2026-11-01T12:00:00Z')
const MINUTE = 60_000

describe('whether opening Collections refreshes', () => {
  it('waits sixty minutes', () => {
    expect(REFRESH_AFTER_MS).toBe(60 * MINUTE)
  })

  it('refreshes when nothing has ever been refreshed', () => {
    expect(refreshIsDue(null, NOW)).toBe(true)
  })

  it('does not refresh when the last refresh was less than sixty minutes ago, or exactly sixty', () => {
    expect(refreshIsDue(NOW, NOW)).toBe(false)
    expect(refreshIsDue(NOW - 59 * MINUTE, NOW)).toBe(false)
    expect(refreshIsDue(NOW - 60 * MINUTE, NOW)).toBe(false)
  })

  it('refreshes when the last refresh was more than sixty minutes ago', () => {
    expect(refreshIsDue(NOW - 60 * MINUTE - 1, NOW)).toBe(true)
    expect(refreshIsDue(NOW - 3 * 24 * 60 * MINUTE, NOW)).toBe(true)
  })

  it('refreshes when the last refresh is in the future, as after the clock was put back', () => {
    expect(refreshIsDue(NOW + 5 * MINUTE, NOW)).toBe(true)
  })
})

describe('when Collections was last refreshed', () => {
  it('is never, with nothing followed', () => {
    expect(lastRefreshOf([])).toBe(null)
  })

  it('is never while a followed source has never been refreshed', () => {
    expect(lastRefreshOf([{ _id: 'a', checkedAt: NOW }, { _id: 'b' }])).toBe(null)
    expect(lastRefreshOf([{ _id: 'a', checkedAt: NOW }, { _id: 'b', checkedAt: null }])).toBe(null)
  })

  it('is when the source refreshed longest ago was, so that every source is at least that fresh', () => {
    expect(lastRefreshOf([{ _id: 'a', checkedAt: NOW }, { _id: 'b', checkedAt: NOW - 5 * MINUTE }])).toBe(NOW - 5 * MINUTE)
  })
})

/**
 * A source kind that answers from a table, for the engine's own tests; the
 * real kinds are tested beside them in `kinds/`
 *
 * @param {Record<string, { items?: any[], sourceFields?: object } | Error>} answers by source id
 */
function fakeKind(answers) {
  return {
    kind: 'fake',
    recognise: () => null,
    fetch: vi.fn(async (source, { fetch }) => {
      await fetch(source.url)
      const answer = answers[source._id]
      if (answer instanceof Error) { throw answer }
      return { items: answer.items ?? [], sourceFields: answer.sourceFields }
    }),
    toShares: vi.fn((items, source, seenAt) => items.map(videoId => ({
      _id: `${source._id}|${videoId}`,
      sourceId: source._id,
      videoId,
      title: videoId,
      author: '',
      votes: 1,
      why: null,
      sharedAt: null,
      discussionUrl: null,
      seenAt,
    }))),
  }
}

/**
 * @param {object} overrides
 */
function harness(overrides = {}) {
  const kept = overrides.kept ?? {}
  const sources = overrides.sources ?? [{ _id: 'one', kind: 'fake', url: 'https://one.example' }]
  const followed = new Set(sources.map(source => source._id))

  const deps = {
    sources,
    kinds: { fake: fakeKind(overrides.answers ?? { one: { items: [] } }) },
    fetch: vi.fn(async () => ({})),
    now: () => NOW,
    keptShares: () => kept,
    isFollowed: id => followed.has(id),
    putShares: vi.fn(async () => {}),
    updateSource: vi.fn(async () => {}),
    onProgress: vi.fn(),
    ...overrides.deps,
  }

  return { deps, followed }
}

describe('a refresh', () => {
  it('asks every source given, through the fetch it is given', async () => {
    const { deps } = harness({
      sources: [{ _id: 'one', kind: 'fake', url: 'https://one.example' }, { _id: 'two', kind: 'fake', url: 'https://two.example' }],
      answers: { one: { items: [] }, two: { items: [] } },
    })

    await refreshCollectionSources(deps)

    expect(deps.fetch.mock.calls.map(([url]) => url).sort()).toEqual(['https://one.example', 'https://two.example'])
  })

  it('puts the shares a source gave that are new or changed, and only those', async () => {
    const { deps } = harness({
      kept: { 'one|same': { _id: 'one|same', sourceId: 'one', videoId: 'same', title: 'same', author: '', votes: 1, why: null, sharedAt: null, discussionUrl: null, seenAt: 0 } },
      answers: { one: { items: ['same', 'new'] } },
    })

    const result = await refreshCollectionSources(deps)

    expect(deps.putShares).toHaveBeenCalledTimes(1)
    expect(deps.putShares.mock.calls[0][0].map(share => share._id)).toEqual(['one|new'])
    expect(result).toEqual({ failed: [], put: 1 })
  })

  it('puts nothing when a source has nothing new', async () => {
    const { deps } = harness()

    await refreshCollectionSources(deps)

    expect(deps.putShares).not.toHaveBeenCalled()
  })

  it('marks each source refreshed, with what its kind asks to keep on it, once its shares are in', async () => {
    const order = []
    const { deps } = harness({
      answers: { one: { items: ['new'], sourceFields: { dataGenerated: '2026-11-01' } } },
      deps: {
        putShares: vi.fn(async () => { order.push('shares') }),
        updateSource: vi.fn(async () => { order.push('source') }),
      },
    })

    await refreshCollectionSources(deps)

    expect(deps.updateSource).toHaveBeenCalledWith('one', { dataGenerated: '2026-11-01', checkedAt: NOW, failedAt: null })
    expect(order).toEqual(['shares', 'source'])
  })

  it('keeps everything a failing source has, marks it failed, and still refreshes the others', async () => {
    const { deps } = harness({
      sources: [{ _id: 'one', kind: 'fake', url: 'https://one.example' }, { _id: 'two', kind: 'fake', url: 'https://two.example' }],
      answers: { one: new Error('unreachable'), two: { items: ['new'] } },
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await refreshCollectionSources(deps)

    expect(result.failed).toEqual(['one'])
    expect(deps.updateSource).toHaveBeenCalledWith('one', { checkedAt: NOW, failedAt: NOW })
    expect(deps.updateSource).toHaveBeenCalledWith('two', { checkedAt: NOW, failedAt: null })
    expect(deps.putShares.mock.calls.flatMap(([shares]) => shares.map(share => share.sourceId))).toEqual(['two'])
  })

  it('counts a source whose shares could not be put as failed, and does not mark it refreshed with its kind\'s fields', async () => {
    const { deps } = harness({
      answers: { one: { items: ['new'], sourceFields: { dataGenerated: '2026-11-01' } } },
      deps: { putShares: vi.fn(async () => { throw new Error('disk') }) },
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await refreshCollectionSources(deps)

    expect(result.failed).toEqual(['one'])
    expect(deps.updateSource).toHaveBeenCalledTimes(1)
    expect(deps.updateSource).toHaveBeenCalledWith('one', { checkedAt: NOW, failedAt: NOW })
  })

  it('counts a source of a kind it does not know as failed', async () => {
    const { deps } = harness({ sources: [{ _id: 'odd', kind: 'unknown', url: 'https://odd.example' }] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await refreshCollectionSources(deps)

    expect(result.failed).toEqual(['odd'])
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('writes nothing for a source unfollowed while it was being asked', async () => {
    const { deps, followed } = harness({ answers: { one: { items: ['new'] } } })
    deps.kinds.fake.fetch.mockImplementationOnce(async () => {
      followed.delete('one')
      return { items: ['new'] }
    })

    await refreshCollectionSources(deps)

    expect(deps.putShares).not.toHaveBeenCalled()
    expect(deps.updateSource).not.toHaveBeenCalled()
  })

  it('says how many sources are done as it goes', async () => {
    const { deps } = harness({
      sources: [{ _id: 'one', kind: 'fake', url: 'https://one.example' }, { _id: 'two', kind: 'fake', url: 'https://two.example' }],
      answers: { one: { items: [] }, two: { items: [] } },
    })

    await refreshCollectionSources(deps)

    expect(deps.onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { done: 0, total: 2 },
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ])
  })

  it('asks at most three sources at once', async () => {
    let inFlight = 0
    let most = 0
    const sources = Array.from({ length: 7 }, (_, index) => ({ _id: `s${index}`, kind: 'fake', url: `https://s${index}.example` }))
    const { deps } = harness({
      sources,
      answers: Object.fromEntries(sources.map(source => [source._id, { items: [] }])),
      deps: {
        fetch: vi.fn(async () => {
          inFlight++
          most = Math.max(most, inFlight)
          await new Promise(resolve => setTimeout(resolve, 1))
          inFlight--
        }),
      },
    })

    await refreshCollectionSources(deps)

    expect(deps.fetch).toHaveBeenCalledTimes(7)
    expect(most).toBe(3)
  })
})
