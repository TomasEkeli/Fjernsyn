import { describe, expect, it, vi } from 'vitest'

import { PlatformError } from '../errors'
import { classifyYouTubeError } from './errors'
import { createBackendPolicy } from './policy'

const failing = (kind, reason = null) => new PlatformError(kind, `${kind} on purpose`, { reason })

/**
 * An attempt answering per backend: a value, or an error to throw.
 *
 * @param {{ local?: unknown, invidious?: unknown }} answers
 */
function attemptAnswering(answers) {
  return vi.fn(async (backend) => {
    const answer = answers[backend]

    if (answer instanceof Error) {
      throw answer
    }

    return answer
  })
}

async function failure(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a failure')
}

const both = { backendPreference: 'local', backendFallback: true }

describe('the YouTube backend policy, on a first page', () => {
  it('asks the preferred backend and nothing else when it answers', async () => {
    const attempt = attemptAnswering({ local: 'from local', invidious: 'from invidious' })

    expect(await createBackendPolicy({ config: both }).first(attempt, classifyYouTubeError)).toBe('from local')
    expect(attempt.mock.calls.map(call => call[0])).toEqual(['local'])
  })

  it.each(['notFound', 'unavailable', 'rateLimited'])('tries the other backend once for %s', async (kind) => {
    const attempt = attemptAnswering({ local: failing(kind), invidious: 'from invidious' })

    expect(await createBackendPolicy({ config: both }).first(attempt, classifyYouTubeError)).toBe('from invidious')
    expect(attempt.mock.calls.map(call => call[0])).toEqual(['local', 'invidious'])
  })

  it('falls back from Invidious to Local just the same', async () => {
    const attempt = attemptAnswering({ invidious: failing('notFound'), local: 'from local' })

    expect(await createBackendPolicy({ config: { ...both, backendPreference: 'invidious' } }).first(attempt, classifyYouTubeError)).toBe('from local')
  })

  // A refusal that may be about the address asking, not the video (ADR-0019)
  describe.each([
    ['local', 'invidious'],
    ['invidious', 'local'],
  ])('from %s', (preferred, other) => {
    const config = { ...both, backendPreference: preferred }

    it.each(['ipBlock', 'unexplained', null])('tries %s once on the other backend', async (reason) => {
      const attempt = attemptAnswering({ [preferred]: failing('refused', reason), [other]: `from ${other}` })

      expect(await createBackendPolicy({ config }).first(attempt, classifyYouTubeError)).toBe(`from ${other}`)
      expect(attempt.mock.calls.map(call => call[0])).toEqual([preferred, other])
    })

    it.each([
      ['refused', 'private'],
      ['refused', 'membersOnly'],
      ['refused', 'ageRestricted'],
      ['refused', 'drm'],
      ['invalid', null],
    ])('does not fall back for %s (%s): the first answer is final', async (kind, reason) => {
      const attempt = attemptAnswering({ [preferred]: failing(kind, reason), [other]: `from ${other}` })

      const error = await failure(createBackendPolicy({ config }).first(attempt, classifyYouTubeError))

      expect(error.kind).toBe(kind)
      expect(error.reason).toBe(reason)
      expect(attempt).toHaveBeenCalledTimes(1)
    })
  })

  it('throws the last failure when both fail', async () => {
    const attempt = attemptAnswering({ local: failing('unavailable'), invidious: failing('notFound') })

    expect((await failure(createBackendPolicy({ config: both }).first(attempt, classifyYouTubeError))).kind).toBe('notFound')
  })

  it('does not fall back with the setting off', async () => {
    const attempt = attemptAnswering({ local: failing('notFound'), invidious: 'from invidious' })

    const error = await failure(createBackendPolicy({ config: { ...both, backendFallback: false } }).first(attempt, classifyYouTubeError))

    expect(error.kind).toBe('notFound')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('asks Invidious alone in the web build, whatever the preference', async () => {
    const attempt = attemptAnswering({ local: 'from local', invidious: failing('unavailable') })

    const error = await failure(createBackendPolicy({ config: { ...both, supportsLocalApi: false } }).first(attempt, classifyYouTubeError))

    expect(error.kind).toBe('unavailable')
    expect(attempt.mock.calls.map(call => call[0])).toEqual(['invidious'])
  })

  it("classifies what a backend's module threw with the classifier it is given", async () => {
    const attempt = attemptAnswering({ local: new Error('Request to https://www.youtube.com/youtubei/v1/browse failed with status code 404'), invidious: 'from invidious' })

    expect(await createBackendPolicy({ config: both }).first(attempt, classifyYouTubeError)).toBe('from invidious')
  })
})

describe('the YouTube backend policy, on a later page', () => {
  it('goes to the backend the cursor names, whatever the preference', async () => {
    const attempt = attemptAnswering({ local: 'from local', invidious: 'from invidious' })
    const cursor = { backend: 'invidious', continuation: 'token' }

    expect(await createBackendPolicy({ config: both }).later(cursor, attempt, classifyYouTubeError)).toBe('from invidious')
    expect(attempt).toHaveBeenCalledWith('invidious', cursor)
  })

  it('never falls back: a failure there is thrown as it is', async () => {
    const attempt = attemptAnswering({ local: failing('unavailable'), invidious: 'from invidious' })

    const error = await failure(createBackendPolicy({ config: both }).later({ backend: 'local', continuation: {} }, attempt, classifyYouTubeError))

    expect(error.kind).toBe('unavailable')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('never falls back for a refusal either, even one about the address', async () => {
    const attempt = attemptAnswering({ local: failing('refused', 'ipBlock'), invidious: 'from invidious' })

    const error = await failure(createBackendPolicy({ config: both }).later({ backend: 'local', continuation: {} }, attempt, classifyYouTubeError))

    expect([error.kind, error.reason]).toEqual(['refused', 'ipBlock'])
    expect(attempt.mock.calls.map(call => call[0])).toEqual(['local'])
  })

  it.each([
    ['names no backend', { continuation: 'token' }],
    ['names an unknown backend', { backend: 'peertube', start: 30 }],
    ['is not an object', 30],
  ])('rejects a cursor that %s as invalid, without asking', async (_what, cursor) => {
    const attempt = attemptAnswering({ local: 'from local', invidious: 'from invidious' })

    expect((await failure(createBackendPolicy({ config: both }).later(cursor, attempt, classifyYouTubeError))).kind).toBe('invalid')
    expect(attempt).not.toHaveBeenCalled()
  })

  it('rejects a Local cursor in the web build as invalid', async () => {
    const attempt = attemptAnswering({ local: 'from local' })
    const policy = createBackendPolicy({ config: { ...both, supportsLocalApi: false } })

    expect((await failure(policy.later({ backend: 'local', continuation: {} }, attempt, classifyYouTubeError))).kind).toBe('invalid')
    expect(attempt).not.toHaveBeenCalled()
  })
})
