import { describe, expect, it } from 'vitest'

import {
  badgeVotes,
  discussionLink,
  formatVotes,
  shareContext,
  shareDateText,
  votesBySource,
} from './voteBadge'

const EN = ['en-US']

/**
 * @param {Partial<import('./shares').CollectionValues>} collection
 * @param {object} [ref]
 */
function wallVideo(collection, ref = { videoId: 'aKLntZcp27M' }) {
  return {
    type: 'video',
    ...ref,
    title: 'Simple Made Easy',
    author: 'InfoQ',
    lengthSeconds: '',
    collection: { votes: null, sharedAt: null, sourceIds: [], ...collection },
  }
}

const SOURCES = {
  hackertube: { _id: 'hackertube', kind: 'hackertube', name: 'HackerTube' },
  'lemmy:talks@programming.dev': { _id: 'lemmy:talks@programming.dev', kind: 'lemmy', name: 'talks@programming.dev' },
  'lemmy:videos@lemmy.world': { _id: 'lemmy:videos@lemmy.world', kind: 'lemmy', name: 'videos@lemmy.world' },
}

/**
 * @param {Record<string, object>} shares by id
 */
function lookups(shares) {
  return {
    sourceFor: id => SOURCES[id],
    shareFor: id => shares[id],
  }
}

describe('the number on the badge', () => {
  it('is the votes summed, when the shown shares have any, zero included', () => {
    expect(badgeVotes(wallVideo({ votes: 35 }))).toBe(35)
    expect(badgeVotes(wallVideo({ votes: 0 }))).toBe(0)
    expect(badgeVotes(wallVideo({ votes: -3 }))).toBe(-3)
  })

  it('is none for a video no shown source voted on, or one with no collection at all', () => {
    expect(badgeVotes(wallVideo({ votes: null }))).toBeNull()
    expect(badgeVotes({ type: 'video', videoId: 'x' })).toBeNull()
    expect(badgeVotes(wallVideo({ votes: Number.NaN }))).toBeNull()
  })

  it('keeps a half vote, drops the rest of a fraction, and groups thousands', () => {
    expect(formatVotes(22.5, EN)).toBe('22.5')
    expect(formatVotes(17.5, EN)).toBe('17.5')
    expect(formatVotes(35, EN)).toBe('35')
    expect(formatVotes(0, EN)).toBe('0')
    expect(formatVotes(-3, EN)).toBe('-3')
    expect(formatVotes(1234, EN)).toBe('1,234')
    expect(formatVotes(0.1 + 0.2, EN)).toBe('0.3')
  })

  it('is written in the language asked for', () => {
    expect(formatVotes(22.5, ['nb-NO'])).toBe('22,5')
  })
})

describe('the hover on Collections: the sources that shared it, and their votes', () => {
  it('lists each shown source by name with its own votes, the most first', () => {
    const video = wallVideo({ votes: 17.5, sourceIds: ['lemmy:talks@programming.dev', 'hackertube'] })
    const shares = {
      'hackertube|aKLntZcp27M': { sourceId: 'hackertube', votes: 11.5, why: 'a classic' },
      'lemmy:talks@programming.dev|aKLntZcp27M': { sourceId: 'lemmy:talks@programming.dev', votes: 6, why: 'watch it' },
    }

    expect(votesBySource(video, lookups(shares))).toEqual([
      { sourceId: 'hackertube', name: 'HackerTube', votes: 11.5 },
      { sourceId: 'lemmy:talks@programming.dev', name: 'talks@programming.dev', votes: 6 },
    ])
  })

  it('says nothing of the why, the date or the discussion', () => {
    const video = wallVideo({ votes: 3, sourceIds: ['hackertube'] })
    const shares = {
      'hackertube|aKLntZcp27M': { sourceId: 'hackertube', votes: 3, why: 'why', sharedAt: 1, discussionUrl: 'https://news.ycombinator.com/item?id=1' },
    }

    expect(Object.keys(votesBySource(video, lookups(shares))[0]).sort()).toEqual(['name', 'sourceId', 'votes'])
  })

  it('lists a source without votes for it after those with, and sources tied on votes by name', () => {
    const video = wallVideo({ votes: 4, sourceIds: ['lemmy:videos@lemmy.world', 'hackertube', 'lemmy:talks@programming.dev'] })
    const shares = {
      'lemmy:videos@lemmy.world|aKLntZcp27M': { sourceId: 'lemmy:videos@lemmy.world', votes: 4 },
      'hackertube|aKLntZcp27M': { sourceId: 'hackertube', votes: null },
      'lemmy:talks@programming.dev|aKLntZcp27M': { sourceId: 'lemmy:talks@programming.dev', votes: 4 },
    }

    expect(votesBySource(video, lookups(shares)).map(row => [row.name, row.votes])).toEqual([
      ['talks@programming.dev', 4],
      ['videos@lemmy.world', 4],
      ['HackerTube', null],
    ])
  })

  it('finds a PeerTube video\'s share by its uuid and origin', () => {
    const ref = { videoId: '059ca8df-0000-4000-8000-000000000000', platform: 'peertube', host: 'peertube.example' }
    const video = wallVideo({ votes: 9, sourceIds: ['lemmy:videos@lemmy.world'] }, ref)
    const shares = {
      'lemmy:videos@lemmy.world|059ca8df-0000-4000-8000-000000000000@peertube.example': { votes: 9 },
    }

    expect(votesBySource(video, lookups(shares))).toEqual([
      { sourceId: 'lemmy:videos@lemmy.world', name: 'videos@lemmy.world', votes: 9 },
    ])
  })

  it('leaves out a source no longer followed, and lists one whose share is not held without votes', () => {
    const video = wallVideo({ votes: 2, sourceIds: ['lemmy:gone@lemmy.example', 'hackertube'] })

    expect(votesBySource(video, lookups({}))).toEqual([
      { sourceId: 'hackertube', name: 'HackerTube', votes: null },
    ])
  })

  it('is empty for a video with no collection', () => {
    expect(votesBySource({ type: 'video', videoId: 'x' }, lookups({}))).toEqual([])
  })
})

describe('the hover on a source\'s page: that share\'s own context', () => {
  it('gives the share\'s why, date, votes and discussion, with the source\'s kind', () => {
    const video = wallVideo({ votes: 24, sourceIds: ['hackertube'] })
    const shares = {
      'hackertube|aKLntZcp27M': {
        sourceId: 'hackertube',
        votes: 24,
        why: 'HN\'s perennial answer',
        sharedAt: Date.UTC(2026, 0, 1),
        discussionUrl: 'https://news.ycombinator.com/item?id=123',
      },
    }

    expect(shareContext(video, 'hackertube', lookups(shares))).toEqual({
      kind: 'hackertube',
      votes: 24,
      why: 'HN\'s perennial answer',
      sharedAt: Date.UTC(2026, 0, 1),
      discussionUrl: 'https://news.ycombinator.com/item?id=123',
    })
  })

  it('gives nulls for what the share does not say', () => {
    const video = wallVideo({ votes: 5, sourceIds: ['lemmy:videos@lemmy.world'] })
    const shares = { 'lemmy:videos@lemmy.world|aKLntZcp27M': { votes: 5 } }

    expect(shareContext(video, 'lemmy:videos@lemmy.world', lookups(shares))).toEqual({
      kind: 'lemmy',
      votes: 5,
      why: null,
      sharedAt: null,
      discussionUrl: null,
    })
  })

  it('treats an empty why as none', () => {
    const video = wallVideo({ votes: 5, sourceIds: ['lemmy:videos@lemmy.world'] })
    const shares = { 'lemmy:videos@lemmy.world|aKLntZcp27M': { votes: 5, why: '  ' } }

    expect(shareContext(video, 'lemmy:videos@lemmy.world', lookups(shares)).why).toBeNull()
  })

  it('is none without the share', () => {
    const video = wallVideo({ votes: 5, sourceIds: ['hackertube'] })

    expect(shareContext(video, 'hackertube', lookups({}))).toBeNull()
  })
})

describe('when it was shared', () => {
  it('is only the year for HackerTube, whose date is the first of January of the last year it was recommended', () => {
    expect(shareDateText(Date.UTC(2026, 0, 1), 'hackertube', EN)).toBe('2026')
  })

  it('is the day for a source that dates its posts', () => {
    expect(shareDateText(new Date(2026, 2, 3, 12).getTime(), 'lemmy', EN)).toBe('Mar 3, 2026')
  })

  it('is nothing without a date', () => {
    expect(shareDateText(null, 'lemmy', EN)).toBe('')
  })
})

describe('the discussion link', () => {
  it('is taken only as a web address', () => {
    expect(discussionLink('https://news.ycombinator.com/item?id=123')).toBe('https://news.ycombinator.com/item?id=123')
    expect(discussionLink('http://lemmy.example/post/1')).toBe('http://lemmy.example/post/1')
    // eslint-disable-next-line no-script-url
    expect(discussionLink('javascript:alert(1)')).toBeNull()
    expect(discussionLink('file:///etc/passwd')).toBeNull()
    expect(discussionLink('not a url')).toBeNull()
    expect(discussionLink(null)).toBeNull()
    expect(discussionLink(undefined)).toBeNull()
  })
})
