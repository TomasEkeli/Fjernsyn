import { describe, expect, it } from 'vitest'

import { isWatchPath } from './watchRoute.js'

describe('isWatchPath', () => {
  it.each([
    ['/watch/dQw4w9WgXcQ'],
    ['/peertube/watch/video.blender.org/b29290cc-dc51-4a12-bcb2-2aa5fece7605'],
  ])('is a watch page: %s', (path) => {
    expect(isWatchPath(path)).toBe(true)
  })

  it.each([
    ['/subscriptions'],
    ['/channel/UC123'],
    ['/playlist/PL123'],
    ['/peertube/channel/blender@video.blender.org'],
    ['/peertube/search/watch'],
    ['/search/watch'],
    [''],
    [undefined],
  ])('is not a watch page: %s', (path) => {
    expect(isWatchPath(path)).toBe(false)
  })
})
