// A PeerTube video's comments, read only, in the common `Comment` shape
// (`../shapes.js`), from the video's origin.
//
// - Threads: `GET /api/v1/videos/{uuid}/comment-threads?start&count&sort=-createdAt`,
//   paged by offset (see `./paging.js`). A video whose details say comments
//   are off (`commentsEnabled: false`) is an empty page without a request; an
//   instance answers a video with comments off with an empty list anyway.
// - Replies, one level at a time, so that deeper replies load on demand:
//   - 8.3 and later (`supports(host, 'commentReplies')`):
//     `GET /api/v1/videos/{uuid}/comments/{commentId}/replies?start&count`,
//     `{ total, data: [{ comment, children, totalChildren }] }`, paged. Used
//     for every level, so a thread tree the instance truncates
//     (`totalChildren` above `children.length`) never hides a reply.
//   - Older: `GET /api/v1/videos/{uuid}/comment-threads/{threadId}`, the whole
//     tree (`{ comment, children }`, no truncation before 8.3). The requested
//     comment is found anywhere in it and its direct children returned, in
//     one page.
// - `text` is what the instance stores, in one of two markups. A comment
//   written on a PeerTube instance is Markdown, as its author typed it; a
//   comment federated from elsewhere (Mastodon and the like) is the HTML its
//   server sent. PeerTube's own client renders both through Markdown with HTML
//   allowed. Here each comment says which it is: `html` when the text starts
//   with an HTML element, `markdown` otherwise. Either way it is rendered only
//   through the sanitising directive.
// - The comment id is the instance's number, for fetching replies only; it
//   is never a ref and never persisted.

import { PlatformError } from '../errors'
import { isPeerTubeVideoRef, peerTubeChannelRef } from '../refs'
import { pickAvatar } from './normalise'
import { pageOf, startOf } from './paging'

// The page size for threads and replies
export const COMMENT_COUNT = 20

// Federated comments are HTML, and start with an element: Mastodon wraps every
// post in <p>
const HTML_START = /^\s*<(?:p|div|span|a|br|blockquote|pre|ul|ol|h[1-6])[\s/>]/i

/**
 * @param {unknown} text
 * @returns {'html' | 'markdown'}
 */
function textKindOf(text) {
  return typeof text === 'string' && HTML_START.test(text) ? 'html' : 'markdown'
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isCommentId(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function timeOf(value) {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isNaN(time) ? undefined : time
}

/**
 * A comment in the common shape, or `null` when it has no id.
 *
 * @param {any} comment
 * @param {number} replyCount
 * @param {string} host the instance that answered
 * @returns {import('../shapes').Comment | null}
 */
function readComment(comment, replyCount, host) {
  if (!isCommentId(comment?.id)) {
    return null
  }

  const account = comment.account ?? null
  const accountHost = typeof account?.host === 'string' ? account.host : host
  const text = typeof comment.text === 'string' ? comment.text : ''

  return {
    id: comment.id,
    threadId: isCommentId(comment.threadId) ? comment.threadId : comment.id,
    text,
    textKind: textKindOf(text),
    author: (typeof account?.displayName === 'string' && account.displayName !== '')
      ? account.displayName
      : (typeof account?.name === 'string' ? account.name : ''),
    // An account, not a channel: never routed as one
    authorAccount: (account && peerTubeChannelRef(account.name, accountHost)) ?? '',
    authorThumbnail: account ? pickAvatar(account, host) : '',
    createdAt: timeOf(comment.createdAt) ?? 0,
    isDeleted: comment.isDeleted === true,
    replyCount,
  }
}

/**
 * A thread as the threads list sends it: its reply count is every reply in it.
 *
 * @param {any} comment
 * @param {string} host
 */
function readThread(comment, host) {
  return readComment(comment, typeof comment?.totalReplies === 'number' ? comment.totalReplies : 0, host)
}

/**
 * A node of a thread tree or of the replies endpoint, `{ comment, children,
 * totalChildren }`: its reply count is its direct replies.
 *
 * @param {any} node
 * @param {string} host
 */
function readNode(node, host) {
  const children = Array.isArray(node?.children) ? node.children : []
  const replyCount = typeof node?.totalChildren === 'number' ? node.totalChildren : children.length

  return readComment(node?.comment, replyCount, host)
}

/**
 * The node of a comment, anywhere in a tree.
 *
 * @param {any} node
 * @param {number} id
 * @returns {any}
 */
function findNode(node, id) {
  if (node?.comment?.id === id) {
    return node
  }

  for (const child of Array.isArray(node?.children) ? node.children : []) {
    const found = findNode(child, id)
    if (found) {
      return found
    }
  }

  return null
}

/**
 * @param {unknown} ref
 * @returns {{ host: string, uuid: string }}
 */
function videoOf(ref) {
  if (!isPeerTubeVideoRef(ref)) {
    throw new PlatformError('invalid', 'Not a PeerTube video ref')
  }

  return { host: ref.host, uuid: ref.videoId.toLowerCase() }
}

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('./client').createPeerTubeClient>} deps.client
 */
export function createCommentReader({ client }) {
  /**
   * @param {import('../shapes').PeerTubeVideoRef & { commentsEnabled?: boolean }} ref
   * @param {{ cursor?: unknown }} [options]
   * @returns {Promise<import('../shapes').Page<import('../shapes').Comment>>}
   */
  async function getComments(ref, { cursor = null } = {}) {
    const { host, uuid } = videoOf(ref)
    const start = startOf(cursor)

    if (ref.commentsEnabled === false) {
      return { items: [], cursor: null }
    }

    const body = await client.get(host, `/videos/${uuid}/comment-threads`, {
      start,
      count: COMMENT_COUNT,
      sort: '-createdAt',
    })

    return pageOf(body, start, comment => readThread(comment, host))
  }

  /**
   * @param {import('../shapes').PeerTubeVideoRef} ref
   * @param {import('../shapes').Comment} comment
   * @param {{ cursor?: unknown }} [options]
   * @returns {Promise<import('../shapes').Page<import('../shapes').Comment>>}
   */
  async function getCommentReplies(ref, comment, { cursor = null } = {}) {
    const { host, uuid } = videoOf(ref)

    if (!isCommentId(comment?.id)) {
      throw new PlatformError('invalid', 'Not a PeerTube comment')
    }

    const start = startOf(cursor)

    if (await client.supports(host, 'commentReplies')) {
      const body = await client.get(host, `/videos/${uuid}/comments/${comment.id}/replies`, {
        start,
        count: COMMENT_COUNT,
      })

      return pageOf(body, start, node => readNode(node, host))
    }

    const threadId = isCommentId(comment.threadId) ? comment.threadId : comment.id
    const tree = await client.get(host, `/videos/${uuid}/comment-threads/${threadId}`)
    const node = findNode(tree, comment.id)
    const children = Array.isArray(node?.children) ? node.children : []

    return {
      items: children.map(child => readNode(child, host)).filter(item => item !== null),
      cursor: null,
    }
  }

  return Object.freeze({ getComments, getCommentReplies })
}
