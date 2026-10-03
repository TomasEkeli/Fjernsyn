import { describe, expect, it } from 'vitest'

import { neighbourProfile } from './profileZapping'

const profiles = [{ _id: 'news' }, { _id: 'allChannels' }, { _id: 'music' }]

describe('neighbourProfile', () => {
  it('steps forward and back in the list order', () => {
    expect(neighbourProfile(profiles, 'allChannels', 1)._id).toBe('music')
    expect(neighbourProfile(profiles, 'allChannels', -1)._id).toBe('news')
  })

  it('wraps around at either end', () => {
    expect(neighbourProfile(profiles, 'music', 1)._id).toBe('news')
    expect(neighbourProfile(profiles, 'news', -1)._id).toBe('music')
  })

  it('has nowhere to go with a single profile', () => {
    expect(neighbourProfile([{ _id: 'allChannels' }], 'allChannels', 1)).toBeUndefined()
    expect(neighbourProfile([], 'allChannels', -1)).toBeUndefined()
  })

  it('starts from the edge stepped towards when the active profile is not listed', () => {
    expect(neighbourProfile(profiles, 'gone', 1)._id).toBe('news')
    expect(neighbourProfile(profiles, 'gone', -1)._id).toBe('music')
  })
})
