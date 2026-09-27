import { describe, expect, it } from 'vitest'

import { PlatformError } from '../errors'
import { createPlatformLayer } from '../index'
import { createFakeFetch } from './testing/fakeFetch'

import blenderConfig from './fixtures/video.blender.org--config.json'
import blenderThreads from './fixtures/video.blender.org--comment-threads-with-replies.json'
import blenderTree from './fixtures/video.blender.org--comment-thread-tree.json'
import blurtConfig from './fixtures/blurt.media--config.json'
import blurtThreads from './fixtures/blurt.media--comment-threads.json'
import fsiConfig from './fixtures/peertube.f-si.org--config.json'
import fsiThreads from './fixtures/peertube.f-si.org--comment-threads.json'
import makertubeConfig from './fixtures/makertube.net--config.json'
import makertubeReplies from './fixtures/makertube.net--comment-replies.json'
import makertubeThreads from './fixtures/makertube.net--comment-threads.json'
import makertubeTree from './fixtures/makertube.net--comment-thread-tree.json'
import makertubeTreeTruncated from './fixtures/makertube.net--comment-thread-tree-truncated.json'

const MAKERTUBE = { platform: 'peertube', host: 'makertube.net', videoId: 'cb6fa58d-4981-4a4b-9a28-8af37d40f271' }
const BLENDER = { platform: 'peertube', host: 'video.blender.org', videoId: '3d95fb3d-c866-42c8-9db1-fe82f48ccb95' }
const BLURT = { platform: 'peertube', host: 'blurt.media', videoId: '9bcc834c-3f60-44a2-9f7a-818c3f2d53e4' }
const FSI = { platform: 'peertube', host: 'peertube.f-si.org', videoId: '8934b209-5a98-4314-a143-73e567cacd1c' }

/**
 * @param {{ host: string, videoId: string }} ref
 */
function api(ref) {
  return `https://${ref.host}/api/v1/videos/${ref.videoId}`
}

/**
 * @param {{ host: string, videoId: string }} ref
 * @param {number} [start]
 */
function threadsUrl(ref, start = 0) {
  return `${api(ref)}/comment-threads?start=${start}&count=20&sort=-createdAt`
}

/**
 * @param {{ host: string, videoId: string }} ref
 * @param {number} commentId
 * @param {number} [start]
 */
function repliesUrl(ref, commentId, start = 0) {
  return `${api(ref)}/comments/${commentId}/replies?start=${start}&count=20`
}

// The 8.3 replies endpoint's answer for comment 34723, the one reply below it,
// in the shape of the recorded answer for 34707
const REPLIES_TO_34723 = {
  status: 200,
  body: { total: 1, data: [{ ...makertubeTree.body.children[0].children[0] }] },
}

function setUp() {
  const fake = createFakeFetch([blenderConfig, blurtConfig, fsiConfig, makertubeConfig])
    .respond(threadsUrl(MAKERTUBE), makertubeThreads)
    .respond(repliesUrl(MAKERTUBE, 34707), makertubeReplies)
    .respond(repliesUrl(MAKERTUBE, 34723), REPLIES_TO_34723)
    // Registered, so that a test can prove it is never asked
    .respond(`${api(MAKERTUBE)}/comment-threads/34707`, makertubeTreeTruncated)
    .respond(threadsUrl(BLENDER), blenderThreads)
    .respond(`${api(BLENDER)}/comment-threads/7175`, blenderTree)
    .respond(threadsUrl(BLURT), blurtThreads)
    .respond(threadsUrl(FSI), fsiThreads)
  const layer = createPlatformLayer({ fetch: fake.fetch, config: { peertubeEnabled: true } })
  return { fake, layer }
}

/**
 * @template T
 * @param {T} fixture
 * @returns {T}
 */
function copy(fixture) {
  return structuredClone(fixture)
}

/**
 * @param {Promise<unknown>} promise
 * @returns {Promise<PlatformError>}
 */
async function failure(promise) {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(PlatformError)
    return error
  }
  throw new Error('expected the call to fail')
}

describe('getComments (PeerTube)', () => {
  it('reads a page of threads, newest first, from the video origin (makertube.net, 8.3)', async () => {
    const { fake, layer } = setUp()

    const page = await layer.getComments(MAKERTUBE)

    expect(fake.urls()).toEqual([threadsUrl(MAKERTUBE)])
    expect(page.items.map(comment => comment.id)).toEqual([34707, 34419, 34540, 34412, 34418])
    expect(page.items[0]).toEqual({
      id: 34707,
      threadId: 34707,
      text: makertubeThreads.body.data[0].text,
      // Federated from Mastodon: HTML
      textKind: 'html',
      author: 'Philipp :geeko:',
      authorAccount: 'derfopps@digitalcourage.social',
      authorThumbnail: 'https://makertube.net/lazy-static/avatars/936b56a4-fe42-4334-8b52-108d6542bae3.jpg',
      createdAt: Date.parse('2025-03-24T22:45:38.000Z'),
      isDeleted: false,
      // Every reply in the thread
      replyCount: 3,
    })
    // 89 threads
    expect(page.cursor).toBe(5)
  })

  it('reads a comment written on PeerTube itself as Markdown', async () => {
    const { layer } = setUp()

    const [second] = (await layer.getComments(MAKERTUBE)).items.slice(1)
    const blurt = await layer.getComments(BLURT)

    expect(second).toMatchObject({ id: 34419, textKind: 'markdown', replyCount: 2 })
    expect(blurt.items.map(({ id, textKind, author, authorAccount }) => ({ id, textKind, author, authorAccount }))).toEqual([
      { id: 10210, textKind: 'markdown', author: 'Brave-Smoke', authorAccount: 'brave.smoke@blurt.media' },
      { id: 10207, textKind: 'markdown', author: 'Dotevo', authorAccount: 'dotevo.media@blurt.media' },
    ])
    // blurt.media (6.3) sends avatar paths only
    expect(blurt.items[0].authorThumbnail).toBe('https://blurt.media/lazy-static/avatars/03b98328-79b5-4c0c-be48-775745002ebb.png')
    expect(blurt.cursor).toBeNull()
  })

  it('pages to the end', async () => {
    const { fake, layer } = setUp()
    fake.respond(threadsUrl(MAKERTUBE, 5), { status: 200, body: { total: 6, data: [makertubeThreads.body.data[0]] } })

    const first = await layer.getComments(MAKERTUBE)
    const second = await layer.getComments(MAKERTUBE, { cursor: first.cursor })

    expect(fake.urls()[1]).toBe(threadsUrl(MAKERTUBE, 5))
    expect(second.items).toHaveLength(1)
    expect(second.cursor).toBeNull()
  })

  it('reads a thread federated from Mastodon as HTML (video.blender.org, 8.2)', async () => {
    const { layer } = setUp()

    const thread = (await layer.getComments(BLENDER)).items.find(comment => comment.id === 7175)

    expect(thread).toMatchObject({ textKind: 'html', replyCount: 2 })
    expect(thread.text).toMatch(/^<p>/)
  })

  it('never asks for more than 100 at a time', async () => {
    const { fake, layer } = setUp()

    await layer.getComments(MAKERTUBE)
    await layer.getCommentReplies(MAKERTUBE, { id: 34707, threadId: 34707 })

    const counts = fake.urls().filter(url => url.includes('count=')).map(url => Number(new URL(url).searchParams.get('count')))
    expect(counts).toHaveLength(2)
    for (const count of counts) {
      expect(count).toBeGreaterThan(0)
      expect(count).toBeLessThanOrEqual(100)
    }
  })

  it.each([
    [{ cursor: -1 }],
    [{ cursor: 'next' }],
  ])('refuses %o, without a request', async (options) => {
    const { fake, layer } = setUp()

    expect((await failure(layer.getComments(MAKERTUBE, options))).kind).toBe('invalid')
    expect((await failure(layer.getCommentReplies(MAKERTUBE, { id: 34707, threadId: 34707 }, options))).kind).toBe('invalid')
    expect(fake.requests).toHaveLength(0)
  })

  it('keeps a deleted comment, which may have replies, without an author', async () => {
    const { layer } = setUp()

    const { items } = await layer.getComments(BLENDER)
    const deleted = items.find(comment => comment.id === 6849)

    expect(deleted).toEqual({
      id: 6849,
      threadId: 6849,
      text: '',
      textKind: 'markdown',
      author: '',
      authorAccount: '',
      authorThumbnail: '',
      createdAt: Date.parse('2022-07-09T23:38:52.402Z'),
      isDeleted: true,
      replyCount: 0,
    })
  })

  it('reads the singular avatar of older instances', async () => {
    const old = copy(blurtThreads)
    const account = old.body.data[0].account
    delete account.avatars
    account.avatar = { width: 120, path: '/lazy-static/avatars/old.png' }
    const { fake, layer } = setUp()
    fake.respond(threadsUrl(BLURT), old)

    const [first] = (await layer.getComments(BLURT)).items

    expect(first.authorThumbnail).toBe('https://blurt.media/lazy-static/avatars/old.png')
  })

  it('reads an instance with no comments (peertube.f-si.org, 6.2)', async () => {
    const { layer } = setUp()

    expect(await layer.getComments(FSI)).toEqual({ items: [], cursor: null })
  })

  describe('comments disabled', () => {
    it('is an empty page, without a request, for a video whose details say so', async () => {
      const { fake, layer } = setUp()

      expect(await layer.getComments({ ...MAKERTUBE, commentsEnabled: false })).toEqual({ items: [], cursor: null })
      expect(fake.requests).toHaveLength(0)
    })

    it('is an empty page when the instance answers with none, as it does for comments disabled', async () => {
      const { fake, layer } = setUp()
      fake.respond(threadsUrl(MAKERTUBE), { status: 200, body: { total: 0, totalNotDeletedComments: 0, data: [] } })

      expect(await layer.getComments(MAKERTUBE)).toEqual({ items: [], cursor: null })
    })
  })

  it.each([
    [{ platform: 'peertube', host: 'makertube.net', videoId: '42' }],
    [{ platform: 'peertube', host: 'www.youtube.com', videoId: MAKERTUBE.videoId }],
    ['dQw4w9WgXcQ'],
  ])('refuses %o, without a request', async (ref) => {
    const { fake, layer } = setUp()

    expect((await failure(layer.getComments(ref))).kind).toBe('invalid')
    expect(fake.requests).toHaveLength(0)
  })
})

describe('getCommentReplies (PeerTube)', () => {
  describe('on 8.3 and later (makertube.net): the replies endpoint', () => {
    it('reads a thread direct replies, each with its own reply count', async () => {
      const { fake, layer } = setUp()
      const [thread] = (await layer.getComments(MAKERTUBE)).items

      const page = await layer.getCommentReplies(MAKERTUBE, thread)

      expect(fake.urls()).toContain(repliesUrl(MAKERTUBE, 34707))
      expect(page.items.map(({ id, threadId, replyCount }) => ({ id, threadId, replyCount }))).toEqual([
        { id: 34723, threadId: 34707, replyCount: 1 },
        { id: 36396, threadId: 34707, replyCount: 0 },
      ])
      expect(page.items[0]).toMatchObject({
        author: 'Freizeitparkapp',
        authorAccount: 'freizeitparkapp@makertube.net',
        textKind: 'markdown',
        createdAt: Date.parse('2025-03-25T06:21:09.560Z'),
      })
      expect(page.cursor).toBeNull()
    })

    it('reads deeper replies through the same endpoint, so a truncated tree loses none', async () => {
      const { fake, layer } = setUp()
      const [thread] = (await layer.getComments(MAKERTUBE)).items
      const [reply] = (await layer.getCommentReplies(MAKERTUBE, thread)).items

      const deeper = await layer.getCommentReplies(MAKERTUBE, reply)

      expect(deeper.items.map(comment => comment.id)).toEqual([34724])
      expect(deeper.items[0]).toMatchObject({ threadId: 34707, replyCount: 0, textKind: 'html' })
      expect(fake.urls()).toContain(repliesUrl(MAKERTUBE, 34723))
      // The (truncated) thread tree is never asked for
      expect(fake.urls().some(url => url.includes('/comment-threads/'))).toBe(false)
    })

    it('pages the replies', async () => {
      const { fake, layer } = setUp()
      const more = copy(makertubeReplies)
      more.body.total = 3
      fake.respond(repliesUrl(MAKERTUBE, 34707), more)
      fake.respond(repliesUrl(MAKERTUBE, 34707, 2), { status: 200, body: { total: 3, data: [REPLIES_TO_34723.body.data[0]] } })
      const thread = { id: 34707, threadId: 34707 }

      const first = await layer.getCommentReplies(MAKERTUBE, thread)
      const second = await layer.getCommentReplies(MAKERTUBE, thread, { cursor: first.cursor })

      expect(first.cursor).toBe(2)
      expect(second.items.map(comment => comment.id)).toEqual([34724])
      expect(second.cursor).toBeNull()
    })
  })

  describe('before 8.3: the thread tree', () => {
    it('reads a thread direct replies from its tree (video.blender.org, 8.2)', async () => {
      const { fake, layer } = setUp()
      const thread = (await layer.getComments(BLENDER)).items.find(comment => comment.id === 7175)

      const page = await layer.getCommentReplies(BLENDER, thread)

      expect(fake.urls()).toContain(`${api(BLENDER)}/comment-threads/7175`)
      expect(fake.urls().some(url => url.includes('/replies'))).toBe(false)
      expect(page.items.map(({ id, threadId, replyCount, textKind, author }) => ({ id, threadId, replyCount, textKind, author }))).toEqual([
        { id: 12311, threadId: 7175, replyCount: 0, textKind: 'html', author: 'Karlo Comment' },
        { id: 12312, threadId: 7175, replyCount: 0, textKind: 'html', author: expect.any(String) },
      ])
      // The tree is whole: nothing more to page
      expect(page.cursor).toBeNull()
    })

    it('finds a deeper comment replies anywhere in the tree', async () => {
      const deep = copy(blenderTree)
      const [first, second] = deep.body.children
      first.children.push({ comment: { ...second.comment, id: 99001, inReplyToCommentId: first.comment.id }, children: [] })
      const { fake, layer } = setUp()
      fake.respond(`${api(BLENDER)}/comment-threads/7175`, deep)

      const [reply] = (await layer.getCommentReplies(BLENDER, { id: 7175, threadId: 7175 })).items
      expect(reply).toMatchObject({ id: 12311, replyCount: 1 })

      const deeper = await layer.getCommentReplies(BLENDER, reply)

      expect(deeper.items.map(comment => comment.id)).toEqual([99001])
      expect(deeper.cursor).toBeNull()
    })

    it('is an empty page for a comment the tree does not hold', async () => {
      const { layer } = setUp()

      expect(await layer.getCommentReplies(BLENDER, { id: 424242, threadId: 7175 })).toEqual({ items: [], cursor: null })
    })
  })

  it.each([
    [{ threadId: 34707 }],
    [{ id: '34707/../../x', threadId: 34707 }],
    [{ id: -1, threadId: 34707 }],
    [null],
  ])('refuses the comment %o, without a request', async (comment) => {
    const { fake, layer } = setUp()

    expect((await failure(layer.getCommentReplies(MAKERTUBE, comment))).kind).toBe('invalid')
    expect(fake.requests).toHaveLength(0)
  })
})
