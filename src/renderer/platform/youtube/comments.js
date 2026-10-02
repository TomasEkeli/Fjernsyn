// A YouTube video's comments and their replies, read only, in the common
// `Comment` shape (`../shapes.js`) widened with what the comment component
// shows, from Local or Invidious through the backend policy (`./policy.js`,
// ADR-0015). The mapping is the comments section of `./types.js`.
//
// - Comments: Local `getLocalComments(id)`, a `YT.Comments`, whose threads
//   `parseLocalComment(thread.comment, thread)` reads; Invidious
//   `invidiousGetComments({ id, nextPageToken, sortNewest })`, whose
//   `commentData` is already parsed. Each item is mapped from what the module
//   parsed, not from the raw nodes, except the time: both modules answer it as
//   localised relative text, so Local's is estimated from the node's
//   `published_time` (`calculatePublishedDate`, as the module does before
//   making it relative) and Invidious' is read exact from the raw entry's
//   `published`.
// - Sort is `top` (the default, YouTube's own and the old section's) or
//   `newest`. Local sorts with `applySort` on the instance it just fetched,
//   only when YouTube's header says the other sort is selected; Invidious takes
//   `sort_by` on every page, so its cursor carries the sort it was issued
//   under and a later page uses that, whatever the option says.
// - Replies start from the comment's `repliesCursor`, which names its backend
//   as any cursor does, and page on from the cursor each page answers. Both
//   go through `policy.later`: replies never fall back. Local: the thread's
//   `getReplies()` unless it came with its replies, then `getContinuation()`
//   on what answered last. Invidious: the reply token through
//   `invidiousGetComments` rather than `invidiousGetCommentReplies`, since
//   only the former hands back the raw entries with their `published` time.
//   It is the same request: the endpoint ignores `sort_by` for a reply token,
//   and `top` is what it assumes when none is sent.
// - Comments off: when the backend says the video has none (Local "The
//   comments page did not have any content", Invidious "Comments not found",
//   matched as the old section matches them), the first page is
//   `{ items: [], cursor: null, commentsEnabled: false }`. They are
//   recognised before the error is classified, since Invidious' message
//   would otherwise read as `notFound` and fall back. Any other failure is a
//   `PlatformError`, the first page falling back by its kind.

import { PlatformError } from '../errors'
import { classifyYouTubeError } from './errors'

/** What each backend's module throws for a video whose comments are off */
export const COMMENTS_OFF_MESSAGES = Object.freeze({
  local: 'The comments page did not have any content',
  invidious: 'Comments not found',
})

const LOCAL_SORTS = Object.freeze({ top: 'TOP_COMMENTS', newest: 'NEWEST_FIRST' })

/**
 * @param {unknown} error
 * @param {'local' | 'invidious'} backend
 */
function isCommentsOff(error, backend) {
  const message = /** @type {any} */ (error)?.message
  return typeof message === 'string' && message.includes(COMMENTS_OFF_MESSAGES[backend])
}

/**
 * @param {unknown} cursor
 * @returns {boolean}
 */
function isUsableCursor(cursor) {
  const { backend, continuation } = /** @type {any} */ (cursor) ?? {}

  return backend === 'local'
    ? typeof continuation?.getContinuation === 'function'
    : backend === 'invidious' && typeof continuation === 'string' && continuation !== ''
}

/**
 * @param {object} deps
 * @param {import('./deps').YouTubeDeps} deps.youtube
 * @param {ReturnType<typeof import('./policy').createBackendPolicy>} deps.policy
 */
export function createYouTubeCommentReader({ youtube, policy }) {
  /**
   * Local's time, estimated from its relative text; 0 when unreadable.
   *
   * @param {unknown} text
   * @returns {number}
   */
  function estimatedTime(text) {
    try {
      const time = youtube.calculatePublishedDate(String(text ?? '').replace('(edited)', '').trim())
      return Number.isFinite(time) ? time : 0
    } catch {
      return 0
    }
  }

  /**
   * @param {any} node a `YTNodes.CommentView`
   * @param {any} thread its `YTNodes.CommentThread`
   * @param {string} threadId
   * @returns {import('./types').YouTubeComment}
   */
  function localComment(node, thread, threadId) {
    const parsed = youtube.parseLocalComment(node, thread)

    return {
      id: parsed.id,
      threadId: threadId ?? parsed.id,
      text: parsed.text,
      textKind: 'html',
      author: parsed.author,
      authorAccount: '',
      authorThumbnail: parsed.authorThumb,
      createdAt: estimatedTime(node?.published_time),
      isDeleted: false,
      replyCount: parsed.numReplies,
      authorId: parsed.authorId,
      likes: parsed.likes,
      isPinned: !!parsed.isPinned,
      isHearted: !!parsed.isHearted,
      isOwner: !!parsed.isOwner,
      isMember: !!parsed.isMember,
      memberIconUrl: parsed.memberIconUrl,
      hasOwnerReplied: !!parsed.hasOwnerReplied,
      repliesCursor: parsed.hasReplyToken ? { backend: 'local', continuation: thread } : null,
    }
  }

  /**
   * Local's threads as comments; a reply thread without a comment is skipped,
   * as the old component skips it.
   *
   * @param {any[] | undefined} threads
   * @param {string} [threadId] the thread's, for replies
   */
  function localComments(threads, threadId) {
    return (threads ?? [])
      .filter(thread => thread?.comment)
      .map(thread => localComment(thread.comment, thread, threadId))
  }

  /**
   * @param {any} parsed an entry of `commentData`
   * @param {Map<string, number>} published by comment id, in seconds
   * @param {string} [threadId] the thread's, for replies
   * @returns {import('./types').YouTubeComment}
   */
  function invidiousComment(parsed, published, threadId) {
    const seconds = published.get(parsed.id)

    return {
      id: parsed.id,
      threadId: threadId ?? parsed.id,
      text: parsed.text,
      textKind: 'html',
      author: parsed.author,
      authorAccount: '',
      authorThumbnail: parsed.authorThumb,
      createdAt: Number.isFinite(seconds) ? seconds * 1000 : 0,
      isDeleted: false,
      replyCount: parsed.numReplies,
      authorId: parsed.authorId,
      likes: parsed.likes,
      isPinned: !!parsed.isPinned,
      isHearted: !!parsed.isHearted,
      isOwner: !!parsed.isOwner,
      isMember: !!parsed.isMember,
      memberIconUrl: parsed.memberIconUrl,
      // `hasOwnerReplied` is Local's alone: Invidious does not say
      repliesCursor: parsed.hasReplyToken ? { backend: 'invidious', continuation: parsed.replyToken } : null,
    }
  }

  /**
   * One Invidious comments request, for a page of threads or of replies.
   *
   * @param {string} id
   * @param {string | null} token
   * @param {'top' | 'newest'} sort
   * @param {string} [threadId] the thread's, for replies
   */
  async function invidiousPage(id, token, sort, threadId) {
    const { response, commentData } = await youtube.invidiousGetComments({ id, nextPageToken: token, sortNewest: sort === 'newest' })
    const published = new Map((response?.comments ?? []).map(entry => [entry.commentId, entry.published]))

    return {
      items: (commentData ?? []).map(parsed => invidiousComment(parsed, published, threadId)),
      continuation: response?.continuation || null,
    }
  }

  /**
   * @param {any} comments a `YT.Comments`
   */
  function localCommentsPage(comments) {
    return {
      items: localComments(comments.contents),
      cursor: comments.has_continuation ? { backend: 'local', continuation: comments } : null,
    }
  }

  /**
   * @param {string} id
   * @param {'top' | 'newest'} sort
   * @param {'local' | 'invidious'} backend
   * @returns {Promise<import('../shapes').Page<import('./types').YouTubeComment>>}
   */
  async function firstCommentsPage(id, sort, backend) {
    try {
      if (backend === 'local') {
        let comments = await youtube.getLocalComments(id)
        const newestSelected = comments.header?.sort_menu?.sub_menu_items?.[1]?.selected ?? false

        if (newestSelected !== (sort === 'newest')) {
          comments = await comments.applySort(LOCAL_SORTS[sort])
        }

        return localCommentsPage(comments)
      }

      const { items, continuation } = await invidiousPage(id, null, sort)
      return { items, cursor: continuation ? { backend: 'invidious', continuation, sort } : null }
    } catch (error) {
      if (isCommentsOff(error, backend)) {
        return { items: [], cursor: null, commentsEnabled: false }
      }

      throw error
    }
  }

  /**
   * A page of a video's comment threads, `top` first unless asked otherwise.
   * Hand the page's `cursor` back for the next.
   *
   * @param {string} ref a YouTube video id
   * @param {{ sort?: 'top' | 'newest', cursor?: unknown }} [options]
   * @returns {Promise<import('../shapes').Page<import('./types').YouTubeComment>>}
   */
  async function getComments(ref, { sort = 'top', cursor = null } = {}) {
    if (!Object.hasOwn(LOCAL_SORTS, sort)) {
      throw new PlatformError('invalid', `Not a YouTube comment sort: ${sort}`)
    }

    if (cursor == null) {
      return policy.first(backend => firstCommentsPage(ref, sort, backend), classifyYouTubeError)
    }

    if (!isUsableCursor(cursor)) {
      throw new PlatformError('invalid', 'Not a YouTube comments cursor')
    }

    return policy.later(cursor, async (backend, { continuation, sort: issuedUnder }) => {
      if (backend === 'local') {
        return localCommentsPage(await continuation.getContinuation())
      }

      const pageSort = issuedUnder === 'newest' ? 'newest' : 'top'
      const page = await invidiousPage(ref, continuation, pageSort)
      return { items: page.items, cursor: page.continuation ? { backend, continuation: page.continuation, sort: pageSort } : null }
    }, classifyYouTubeError)
  }

  /**
   * A page of a comment's direct replies, from its `repliesCursor` and then
   * from the cursor each page answers. A comment without replies is an empty
   * page.
   *
   * @param {string} ref a YouTube video id
   * @param {import('./types').YouTubeComment} comment as `getComments` or this returned it
   * @param {{ cursor?: unknown }} [options]
   * @returns {Promise<import('../shapes').Page<import('./types').YouTubeComment>>}
   */
  async function getCommentReplies(ref, comment, { cursor = null } = {}) {
    if (comment?.repliesCursor === undefined) {
      throw new PlatformError('invalid', 'Not a YouTube comment')
    }

    const start = cursor == null
    const from = start ? comment.repliesCursor : cursor

    if (from === null) {
      return { items: [], cursor: null }
    }

    if (!isUsableCursor(from)) {
      throw new PlatformError('invalid', 'Not a YouTube replies cursor')
    }

    return policy.later(from, async (backend, { continuation }) => {
      if (backend === 'local') {
        let answered = continuation

        if (!start) {
          answered = await continuation.getContinuation()
        } else if (!continuation.is_prepopulated) {
          await continuation.getReplies()
        }

        return {
          items: localComments(answered.replies, comment.threadId),
          cursor: answered.replies && answered.has_continuation ? { backend, continuation: answered } : null,
        }
      }

      const page = await invidiousPage(ref, continuation, 'top', comment.threadId)
      return { items: page.items, cursor: page.continuation ? { backend, continuation: page.continuation } : null }
    }, classifyYouTubeError)
  }

  return Object.freeze({ getComments, getCommentReplies })
}
