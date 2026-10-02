import { describe, expect, it, vi } from 'vitest'

import { calculatePublishedDate } from '../../helpers/utils'
import { parseLocalComment } from '../../helpers/api/local'
import { PlatformError } from '../errors'
import { createPlatformLayer } from '../index'
import { createFakeYouTube, withMethods } from './testing/fakeYouTube'

import localComments from './fixtures/local--comments.json'
import localCommentsContinuation from './fixtures/local--comments-continuation.json'
import localCommentsNewest from './fixtures/local--comments-newest.json'
import localReplies from './fixtures/local--comment-replies.json'
import localRepliesContinuation from './fixtures/local--comment-replies-continuation.json'
import invidiousComments from './fixtures/invidious--comments.json'
import invidiousCommentsContinuation from './fixtures/invidious--comments-continuation.json'
import invidiousReplies from './fixtures/invidious--comment-replies.json'
import invidiousRepliesContinuation from './fixtures/invidious--comment-replies-continuation.json'

const VIDEO = 'jNQXAC9IVRw'
const YEAR = 31556952000

const noMore = () => ({ getContinuation: () => Promise.reject(new Error('No continuation item found')) })

/**
 * A `YT.Comments` from the fixture, its first thread able to load its replies
 * as a `YTNodes.CommentThread` does: into itself.
 */
function localCommentsInstance() {
  return withMethods(localComments, answer => {
    const thread = answer.contents[0]
    Object.assign(thread, {
      is_prepopulated: false,
      getReplies: vi.fn(async () => Object.assign(thread, structuredClone(localReplies.answer))),
      getContinuation: vi.fn(async () => withMethods(localRepliesContinuation, noMore)),
    })

    return {
      applySort: vi.fn(async () => withMethods(localCommentsNewest, noMore)),
      getContinuation: vi.fn(async () => withMethods(localCommentsContinuation, noMore)),
    }
  })
}

/** Invidious' answers, by the token asked for */
const invidiousByToken = {
  null: invidiousComments,
  'COMMENTS-PAGE-2': invidiousCommentsContinuation,
  'REPLIES-ZOO': invidiousReplies,
  'REPLIES-ZOO-2': invidiousRepliesContinuation,
}

function setUp({ backendPreference = 'local', backendFallback = false } = {}) {
  const instance = localCommentsInstance()
  const fake = createFakeYouTube({
    getLocalComments: async () => instance,
    parseLocalComment,
    calculatePublishedDate,
    invidiousGetComments: async ({ nextPageToken }) => structuredClone(invidiousByToken[nextPageToken].answer),
  })
  const layer = createPlatformLayer({
    fetch: () => Promise.reject(new TypeError('no network in tests')),
    youtube: fake.youtube,
    config: { backendPreference, backendFallback },
  })

  return { layer, fake, instance }
}

async function failure(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a failure')
}

/** A time estimated from relative text is "now" minus the span, give or take the test's run */
function expectAbout(time, ago) {
  expect(Math.abs(time - (Date.now() - ago))).toBeLessThan(60_000)
}

describe('YouTube comments on Local', () => {
  it('pages top comments to the end, every flag read', async () => {
    const { layer, instance } = setUp()

    const first = await layer.getComments(VIDEO)
    const [pinned, owner, member, plain] = first.items

    expect(instance.applySort).not.toHaveBeenCalled()
    expect(pinned).toMatchObject({
      id: 'UgzuC3zzpRZkjc5Qzsd4AaABAg',
      threadId: 'UgzuC3zzpRZkjc5Qzsd4AaABAg',
      text: 'We&apos;re so honored that the first ever YouTube video was filmed here!',
      textKind: 'html',
      author: '@SanDiegoZoo',
      authorAccount: '',
      authorThumbnail: expect.stringMatching(/^https:\/\/yt3\.ggpht\.com\//),
      isDeleted: false,
      replyCount: 985,
      authorId: 'UCC5NfQ6Mf0dq_eEwv4P_hWA',
      likes: 4800000,
      isPinned: true,
      isHearted: true,
      isOwner: false,
      isMember: false,
      hasOwnerReplied: false,
    })
    expectAbout(pinned.createdAt, 6 * YEAR)
    expect(pinned.repliesCursor).toEqual({ backend: 'local', continuation: instance.contents[0] })
    expect(pinned.repliesCursor.continuation).toBe(instance.contents[0])
    expect(owner).toMatchObject({ author: '@jawed', isOwner: true, isHearted: true, isPinned: false })
    expect(member).toMatchObject({ isMember: true, memberIconUrl: 'https://yt3.ggpht.com/member-badge=s16-c-k', hasOwnerReplied: true })
    expect(plain).toMatchObject({ replyCount: 0, repliesCursor: null })
    expect(first.cursor).toEqual({ backend: 'local', continuation: instance })

    const second = await layer.getComments(VIDEO, { cursor: first.cursor })

    expect(instance.getContinuation).toHaveBeenCalledTimes(1)
    expect(second.items.map(comment => comment.id)).toEqual(localCommentsContinuation.answer.contents.map(thread => thread.comment.comment_id))
    expect(second.cursor).toBeNull()
  })

  it('sorts newest first on the instance it fetched, without a second fetch', async () => {
    const { layer, fake, instance } = setUp()

    const page = await layer.getComments(VIDEO, { sort: 'newest' })

    expect(fake.callsOf('getLocalComments')).toEqual([[VIDEO]])
    expect(instance.applySort).toHaveBeenCalledWith('NEWEST_FIRST')
    expect(page.items.map(comment => comment.id)).toEqual(localCommentsNewest.answer.contents.map(thread => thread.comment.comment_id))
    expect(page.cursor).toBeNull()
  })

  it('pages a comment\'s replies from its repliesCursor to the end', async () => {
    const { layer, instance } = setUp()
    const [comment] = (await layer.getComments(VIDEO)).items
    const thread = instance.contents[0]

    const first = await layer.getCommentReplies(VIDEO, comment)

    expect(thread.getReplies).toHaveBeenCalledTimes(1)
    expect(first.items).toHaveLength(3)
    expect(first.items.every(reply => reply.threadId === comment.id)).toBe(true)
    expect(first.items[1]).toMatchObject({ author: '@TheGreekPianist', replyCount: 8, likes: 205000 })
    expect(first.items[1].repliesCursor.backend).toBe('local')
    expect(first.items[0].repliesCursor).toBeNull()
    expect(first.cursor).toEqual({ backend: 'local', continuation: thread })

    const second = await layer.getCommentReplies(VIDEO, comment, { cursor: first.cursor })

    expect(thread.getContinuation).toHaveBeenCalledTimes(1)
    expect(second.items.map(reply => reply.id)).toEqual(localRepliesContinuation.answer.replies.map(reply => reply.comment.comment_id))
    expect(second.cursor).toBeNull()
  })
})

describe('YouTube comments on Invidious', () => {
  it.each([
    ['top', false],
    ['newest', true],
  ])('pages %s comments to the end, the sort on every page, every flag read', async (sort, sortNewest) => {
    const { layer, fake } = setUp({ backendPreference: 'invidious' })

    const first = await layer.getComments(VIDEO, { sort })
    const [pinned, owner, member] = first.items

    expect(pinned).toEqual({
      id: 'UgzuC3zzpRZkjc5Qzsd4AaABAg',
      threadId: 'UgzuC3zzpRZkjc5Qzsd4AaABAg',
      text: 'We&#39;re so honored that the first ever YouTube video was filmed here!',
      textKind: 'html',
      author: '@SanDiegoZoo',
      authorAccount: '',
      authorThumbnail: 'https://inv.example/ggpht/UgzuC3zzpRZkjc5Qzsd4AaABAg=s88',
      createdAt: 1_600_000_000_000,
      isDeleted: false,
      replyCount: 985,
      authorId: 'UCC5NfQ6Mf0dq_eEwv4P_hWA',
      likes: 4800000,
      isPinned: true,
      isHearted: true,
      isOwner: false,
      isMember: false,
      memberIconUrl: '',
      repliesCursor: { backend: 'invidious', continuation: 'REPLIES-ZOO' },
    })
    expect(owner).toMatchObject({ isOwner: true, isPinned: false, isHearted: false })
    expect(member).toMatchObject({ isMember: true, memberIconUrl: 'https://inv.example/ggpht/member-badge=s16', repliesCursor: null, replyCount: 0 })
    expect(first.cursor).toEqual({ backend: 'invidious', continuation: 'COMMENTS-PAGE-2', sort })

    const second = await layer.getComments(VIDEO, { cursor: first.cursor })

    expect(second.items.map(comment => comment.author)).toEqual(['@Jeff-th5ob'])
    expect(second.cursor).toBeNull()
    expect(fake.callsOf('invidiousGetComments')).toEqual([
      [{ id: VIDEO, nextPageToken: null, sortNewest }],
      [{ id: VIDEO, nextPageToken: 'COMMENTS-PAGE-2', sortNewest }],
    ])
    expect(fake.callsOf('getLocalComments')).toEqual([])
  })

  it('pages a comment\'s replies from its repliesCursor to the end', async () => {
    const { layer, fake } = setUp({ backendPreference: 'invidious' })
    const [comment] = (await layer.getComments(VIDEO)).items

    const first = await layer.getCommentReplies(VIDEO, comment)

    expect(first.items.map(reply => reply.threadId)).toEqual([comment.id, comment.id])
    expect(first.items[0].createdAt).toBe(1_600_000_100_000)
    expect(first.items[1]).toMatchObject({ replyCount: 8, repliesCursor: { backend: 'invidious', continuation: 'REPLIES-PIANIST' } })
    expect(first.cursor).toEqual({ backend: 'invidious', continuation: 'REPLIES-ZOO-2' })

    const second = await layer.getCommentReplies(VIDEO, comment, { cursor: first.cursor })

    expect(second.items.map(reply => reply.author)).toEqual(['@nytro8027'])
    expect(second.cursor).toBeNull()
    expect(fake.callsOf('invidiousGetComments').slice(1)).toEqual([
      [{ id: VIDEO, nextPageToken: 'REPLIES-ZOO', sortNewest: false }],
      [{ id: VIDEO, nextPageToken: 'REPLIES-ZOO-2', sortNewest: false }],
    ])
  })
})

describe('YouTube comments, off and failing', () => {
  it.each([
    ['local', 'getLocalComments', 'The comments page did not have any content'],
    ['invidious', 'invidiousGetComments', 'Comments not found'],
  ])('answers comments off on %s as an empty page saying so, without falling back', async (backend, name, message) => {
    const { layer, fake } = setUp({ backendPreference: backend, backendFallback: true })
    fake.respond(name, new Error(message))

    expect(await layer.getComments(VIDEO)).toEqual({ items: [], cursor: null, commentsEnabled: false })
    expect(fake.calls.map(call => call.name)).toEqual([name])
  })

  it('falls back on a first page that failed, and the cursor stays on the backend that answered', async () => {
    const { layer, fake } = setUp({ backendFallback: true })
    fake.respond('getLocalComments', new Error('Request to https://www.youtube.com/youtubei/v1/next failed with status code 500'))

    const page = await layer.getComments(VIDEO)

    expect(page.items[0].repliesCursor.backend).toBe('invidious')
    expect(page.cursor.backend).toBe('invidious')
  })

  it('rejects any other failure as a PlatformError, and a later page never falls back', async () => {
    const { layer, fake, instance } = setUp({ backendFallback: true })
    const first = await layer.getComments(VIDEO)
    instance.getContinuation.mockRejectedValueOnce(new Error('fetch failed'))

    const error = await failure(layer.getComments(VIDEO, { cursor: first.cursor }))

    expect(error).toBeInstanceOf(PlatformError)
    expect(error.kind).toBe('unavailable')
    expect(fake.callsOf('invidiousGetComments')).toEqual([])

    const unfallen = setUp()
    unfallen.fake.respond('getLocalComments', new Error('fetch failed'))
    expect((await failure(unfallen.layer.getComments(VIDEO))).kind).toBe('unavailable')
  })
})
