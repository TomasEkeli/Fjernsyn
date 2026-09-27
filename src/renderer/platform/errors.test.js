import { describe, expect, it } from 'vitest'

import { PlatformError } from './errors'

describe('PlatformError', () => {
  it('is an Error carrying its kind and what is known about it', () => {
    const error = new PlatformError('rateLimited', 'slow down', { status: 429, retryAfterMs: 7000, host: 'tilvids.com' })

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('PlatformError')
    expect(error.message).toBe('slow down')
    expect(error.kind).toBe('rateLimited')
    expect(error.status).toBe(429)
    expect(error.retryAfterMs).toBe(7000)
    expect(error.host).toBe('tilvids.com')
    expect(error.reason).toBeNull()
  })

  it('defaults what is not known to null', () => {
    const error = new PlatformError('unavailable', 'down')

    expect(error.status).toBeNull()
    expect(error.retryAfterMs).toBeNull()
    expect(error.reason).toBeNull()
    expect(error.host).toBeNull()
  })

  it('carries a refusal reason and a cause', () => {
    const cause = new TypeError('Failed to fetch')
    const error = new PlatformError('refused', 'password', { status: 401, reason: 'password', cause })

    expect(error.reason).toBe('password')
    expect(error.cause).toBe(cause)
  })

  it('refuses a kind that is not one of the five', () => {
    expect(() => new PlatformError('broken', 'x')).toThrow(TypeError)
  })
})
