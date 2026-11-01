import { describe, expect, it } from 'vitest'

import { categoryAreas, categoryOf, withCategory } from './category'

const share = (sourceId, videoId, categories, extra = {}) => ({
  _id: `${sourceId}|${videoId}`,
  sourceId,
  videoId,
  title: videoId,
  author: '',
  votes: 1,
  why: null,
  sharedAt: null,
  discussionUrl: null,
  ...(categories === undefined ? {} : { categories }),
  seenAt: 0,
  ...extra,
})

const video = (videoId, extra = {}) => ({ type: 'video', videoId, title: videoId, author: '', lengthSeconds: '', ...extra })

const TAXONOMY = {
  version: 'v',
  areas: [
    { id: 'cs', name: 'Computing', categories: [{ id: 'compilers', name: 'Compilers' }, { id: 'databases', name: 'Databases' }] },
    { id: 'empty', name: 'Empty', categories: [] },
    { id: 'sci', name: 'Science', categories: [{ id: 'physics', name: 'Physics' }] },
  ],
}

describe('the wall in one category', () => {
  const shares = [
    share('hackertube', 'aaaaaaaaaaa', ['compilers', 'databases']),
    share('hackertube', 'bbbbbbbbbbb', ['physics']),
    share('lemmy:talks@x.y', 'aaaaaaaaaaa'),
    share('lemmy:talks@x.y', 'ccccccccccc'),
  ]
  const videos = [video('aaaaaaaaaaa'), video('bbbbbbbbbbb'), video('ccccccccccc')]

  it('is the whole wall, the same array, with no category chosen', () => {
    expect(withCategory(videos, shares, null)).toBe(videos)
  })

  it('keeps only the videos whose HackerTube share is in the category, in the wall\'s order', () => {
    expect(withCategory(videos, shares, 'databases').map(each => each.videoId)).toEqual(['aaaaaaaaaaa'])
    expect(withCategory(videos, shares, 'physics').map(each => each.videoId)).toEqual(['bbbbbbbbbbb'])
  })

  it('keeps a video shared by other sources too, when its HackerTube share is in the category', () => {
    const both = withCategory(videos, shares, 'compilers')

    expect(both).toEqual([videos[0]])
    expect(shares.filter(each => each.videoId === 'aaaaaaaaaaa').map(each => each.sourceId)).toContain('lemmy:talks@x.y')
  })

  it('takes no other source\'s categories, and leaves off a video HackerTube did not share', () => {
    const lemmyClaims = [...shares, share('lemmy:talks@x.y', 'ccccccccccc', ['physics'], { _id: 'lemmy:other@x.y|ccccccccccc', sourceId: 'lemmy:other@x.y' })]

    expect(withCategory(videos, lemmyClaims, 'physics').map(each => each.videoId)).toEqual(['bbbbbbbbbbb'])
  })

  it('is empty for a category no video is in', () => {
    expect(withCategory(videos, shares, 'nothing-here')).toEqual([])
  })

  it('matches a PeerTube video by its whole ref, not its id alone', () => {
    const peertube = [share('hackertube', 'u-u-i-d', ['physics'], { platform: 'peertube', host: 'a.example' })]
    const wall = [video('u-u-i-d', { platform: 'peertube', host: 'a.example' }), video('u-u-i-d', { platform: 'peertube', host: 'b.example' })]

    expect(withCategory(wall, peertube, 'physics')).toEqual([wall[0]])
  })
})

describe('the category chosen', () => {
  it('is a category of the taxonomy', () => {
    expect(categoryOf('physics', TAXONOMY)).toBe('physics')
  })

  it('is none for anything the taxonomy does not have, an area\'s id included, or with no taxonomy', () => {
    expect(categoryOf('gone', TAXONOMY)).toBeNull()
    expect(categoryOf('cs', TAXONOMY)).toBeNull()
    expect(categoryOf(null, TAXONOMY)).toBeNull()
    expect(categoryOf('', TAXONOMY)).toBeNull()
    expect(categoryOf('physics', null)).toBeNull()
  })
})

describe('the select\'s groups', () => {
  it('are the taxonomy\'s areas in its order, each with its categories, without an empty one', () => {
    expect(categoryAreas(TAXONOMY).map(area => area.name)).toEqual(['Computing', 'Science'])
    expect(categoryAreas(TAXONOMY)[0].categories.map(category => category.name)).toEqual(['Compilers', 'Databases'])
  })

  it('are none without a taxonomy', () => {
    expect(categoryAreas(null)).toEqual([])
    expect(categoryAreas({ version: null, areas: [] })).toEqual([])
  })
})
