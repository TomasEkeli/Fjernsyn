import { describe, expect, it } from 'vitest'

import { sourceInstance, sourceKindLabel } from './sourceLabels'

const t = key => `<${key}>`

describe('how a source is described', () => {
  it('says what kind of place it is, and its kind as it is for one it has no words for', () => {
    expect(sourceKindLabel('hackertube', t)).toBe('<Sources.Kinds.HackerTube>')
    expect(sourceKindLabel('lemmy', t)).toBe('<Sources.Kinds.Lemmy>')
    expect(sourceKindLabel('piefed', t)).toBe('piefed')
  })

  it('names the instance it is on, with its port, and nothing for a URL that cannot be read', () => {
    expect(sourceInstance({ url: 'https://lemmy.cafe/c/mealtimevideos' })).toBe('lemmy.cafe')
    expect(sourceInstance({ url: 'https://lemmy.example:8536/c/videos' })).toBe('lemmy.example:8536')
    expect(sourceInstance({ url: 'https://hackertube.org' })).toBe('hackertube.org')
    expect(sourceInstance({ url: 'not a url' })).toBe('')
  })
})
