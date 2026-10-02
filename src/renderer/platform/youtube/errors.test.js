import { describe, expect, it } from 'vitest'

import { PlatformError } from '../errors'
import { classifyInvidiousError, classifyLocalError, classifyLocalPlayability } from './errors'

/**
 * A `YT.VideoInfo` as far as its playability is concerned.
 *
 * @param {object} playability
 * @param {object} [more]
 */
function info(playability, more = {}) {
  return { playability_status: playability, streaming_data: { adaptive_formats: [] }, ...more }
}

describe('Local playability', () => {
  it.each([
    ['private', info({ status: 'LOGIN_REQUIRED', reason: 'This video is private', error_screen: { reason: { text: 'Private video' } } })],
    ['membersOnly', info({ status: 'UNPLAYABLE', reason: 'Join this channel to get access to members-only content', error_screen: { offer_id: 'sponsors_only_video' } })],
    ['ageRestricted', info({ status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm your age' })],
    ['ageRestricted', info({ status: 'UNPLAYABLE', reason: 'Video unavailable' }, { has_trailer: true, getTrailerInfo: () => null })],
    ['drm', info({ status: 'OK' }, { streaming_data: { adaptive_formats: [{ drm_families: ['WIDEVINE'] }] } })],
    ['ipBlock', info({ status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' })],
    ['ipBlock', info({ status: 'LOGIN_REQUIRED', reason: 'Please sign in' })],
    ['unexplained', info({ status: 'UNPLAYABLE', reason: 'Video unavailable' })],
  ])('reads a %s refusal', (reason, videoInfo) => {
    const error = classifyLocalPlayability(videoInfo)

    expect(error).toBeInstanceOf(PlatformError)
    expect(error.kind).toBe('refused')
    expect(error.reason).toBe(reason)
  })

  it('reads any other refusal as refused with no reason, in the old view\'s words', () => {
    const error = classifyLocalPlayability(info({
      status: 'UNPLAYABLE',
      reason: 'Video unavailable',
      error_screen: { subreason: { text: 'The uploader has not made this video available in your country' } },
    }))

    expect(error.kind).toBe('refused')
    expect(error.reason).toBeNull()
    expect(error.message).toBe('[UNPLAYABLE] Video unavailable: The uploader has not made this video available in your country')
  })

  it('reads a removed video as not found', () => {
    expect(classifyLocalPlayability(info({ status: 'ERROR', reason: 'This video has been removed by the uploader' })).kind).toBe('notFound')
  })

  it.each(['OK', 'LIVE_STREAM_OFFLINE'])('reads %s as playable, or at least describable', (status) => {
    expect(classifyLocalPlayability(info({ status }))).toBeNull()
  })
})

describe('Local errors', () => {
  const http = (status) => new Error(`Request to https://www.youtube.com/youtubei/v1/browse?prettyPrint=false failed with status code ${status}`)

  it.each([
    [404, 'notFound'],
    [429, 'rateLimited'],
    [400, 'invalid'],
    [403, 'refused'],
    [500, 'unavailable'],
  ])('reads an HTTP %i as %s, with the status', (status, kind) => {
    const cause = http(status)
    const error = classifyLocalError(cause)

    expect(error.kind).toBe(kind)
    expect(error.status).toBe(status)
    expect(error.cause).toBe(cause)
  })

  it('reads a network failure as unavailable', () => {
    expect(classifyLocalError(new TypeError('Failed to fetch')).kind).toBe('unavailable')
  })

  it('passes a platform error through as it is', () => {
    const refused = new PlatformError('refused', 'members only', { reason: 'membersOnly' })

    expect(classifyLocalError(refused)).toBe(refused)
  })
})

describe('Invidious errors', () => {
  it.each([
    ['This video is private', 'refused', 'private'],
    ['Join this channel to get access to members-only content like this video, and other exclusive perks.', 'refused', 'membersOnly'],
    ['Sign in to confirm your age', 'refused', 'ageRestricted'],
    ['This video may be inappropriate for some users.', 'refused', 'ageRestricted'],
    ['This video is DRM protected', 'refused', 'drm'],
    ['Sign in to confirm you’re not a bot', 'refused', 'ipBlock'],
    ['Please sign in', 'refused', 'ipBlock'],
    ['Video unavailable', 'notFound', null],
    ['This video has been removed by the uploader', 'notFound', null],
    ['This channel does not exist.', 'notFound', null],
    ['This account has been terminated', 'notFound', null],
    ['Too Many Requests', 'rateLimited', null],
    ['Could not extract video info. Instance is likely blocked.', 'unavailable', null],
  ])('reads "%s" as %s (%s)', (message, kind, reason) => {
    const error = classifyInvidiousError(new Error(message))

    expect(error.kind).toBe(kind)
    expect(error.reason).toBe(reason)
  })

  it.each([
    ['a network failure', new TypeError('Failed to fetch')],
    ['an answer that is not JSON', new SyntaxError('Unexpected token \'<\', "<html>" is not valid JSON')],
  ])('reads %s as unavailable', (_what, cause) => {
    const error = classifyInvidiousError(cause)

    expect(error.kind).toBe('unavailable')
    expect(error.cause).toBe(cause)
  })
})
