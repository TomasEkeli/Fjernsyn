import { describe, expect, it } from 'vitest'

import { neighbourProfile, zapStepForKey } from './profileZapping'

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

describe('zapStepForKey', () => {
  const key = (k, modifiers = {}) => ({ key: k, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, ...modifiers })

  it('zaps forward on Ctrl+Right and back on Ctrl+Left', () => {
    expect(zapStepForKey(key('ArrowRight'))).toBe(1)
    expect(zapStepForKey(key('ArrowLeft'))).toBe(-1)
  })

  it('ignores the arrows without Ctrl', () => {
    expect(zapStepForKey(key('ArrowRight', { ctrlKey: false }))).toBe(0)
    expect(zapStepForKey(key('ArrowLeft', { ctrlKey: false }))).toBe(0)
  })

  it('ignores Ctrl with another modifier as well, which selects or moves something else', () => {
    expect(zapStepForKey(key('ArrowRight', { shiftKey: true }))).toBe(0)
    expect(zapStepForKey(key('ArrowLeft', { altKey: true }))).toBe(0)
    expect(zapStepForKey(key('ArrowRight', { metaKey: true }))).toBe(0)
  })

  it('ignores Ctrl with any other key', () => {
    expect(zapStepForKey(key('ArrowUp'))).toBe(0)
    expect(zapStepForKey(key('r'))).toBe(0)
  })
})
