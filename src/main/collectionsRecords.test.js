import { describe, expect, it } from 'vitest'

import { isStorableCollectionRecord } from './collectionsRecords'

describe('what main writes to the collections datastores from a renderer', () => {
  it('takes a record with a string id', () => {
    expect(isStorableCollectionRecord({ _id: 'hackertube', kind: 'hackertube' })).toBe(true)
  })

  it('refuses anything without one', () => {
    for (const value of [null, undefined, 'x', 1, [], {}, { _id: 5 }]) {
      expect(isStorableCollectionRecord(value), JSON.stringify(value)).toBe(false)
    }
  })

  it('refuses a record with a field the datastore would read as an operator', () => {
    expect(isStorableCollectionRecord({ _id: 'x', $set: { votes: 1 } })).toBe(false)
    expect(isStorableCollectionRecord({ _id: 'x', $where: 'true' })).toBe(false)
  })

  it('asks a video\'s details for the video id as well, when told to', () => {
    expect(isStorableCollectionRecord({ _id: 'aaaaaaaaaaa' }, { videoId: true })).toBe(false)
    expect(isStorableCollectionRecord({ _id: 'aaaaaaaaaaa', videoId: 7 }, { videoId: true })).toBe(false)
    expect(isStorableCollectionRecord({ _id: 'aaaaaaaaaaa', videoId: 'aaaaaaaaaaa' }, { videoId: true })).toBe(true)
  })
})
