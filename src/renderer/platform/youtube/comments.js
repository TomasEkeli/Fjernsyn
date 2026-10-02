// A YouTube video's comments and their replies, read only, in the common
// `Comment` shape (`../shapes.js`), from Local or Invidious through the
// backend policy (`./policy.js`). The mapping is the comments section of
// `./types.js`.
//
// Not on the layer yet: every operation rejects as `invalid`, without a
// request, as any ref the layer does not know does.

import { PlatformError } from '../errors'

export function createYouTubeCommentReader() {
  async function notYet() {
    throw new PlatformError('invalid', 'YouTube comments are not on the layer yet')
  }

  return Object.freeze({
    getComments: notYet,
    getCommentReplies: notYet,
  })
}
