// A YouTube channel's list items, from the layer's common shapes, as the
// subscription cache holds them (spec, "Phase 3 decisions", C9; story 59).
// Pure: the channel view writes what this answers through the store's own
// cache actions, as the old view does.
//
// An entry written from the channel page must be, field for field, what the
// feed descriptors (`helpers/subscriptionFeeds/`) write for the same video or
// post, so that the feed, its detail back-fill and the carry-over
// (`src/subscriptionVideoDetails.js`, ADR-0003, ADR-0005) cannot tell which
// path wrote it. The layer's YouTube items are the modules' own parses (Local
// `parseLocalChannelVideos`, `parseLocalCommunityPosts`; Invidious the API's
// objects), which are what the descriptors cache too, so little separates
// them:
//
// - a video, a short or a live gains `thumbnail: ''` in the layer (`forCard`
//   in `youtube/channels.js`: the card builds a YouTube thumbnail from the
//   id), which no descriptor writes, so it is dropped
// - a post is cached as it is: `Post` is the post component's field names,
//   which are the posts feed's (`postContent` `null` for none, as both
//   parsers answer a post without an attachment)

import { PLATFORM_YOUTUBE, platformOf } from './refs'

/**
 * One YouTube list item as the subscription cache holds it. A copy: the
 * store's cache actions fill in what they carry over in place, and the
 * view's own list stays as the layer answered it.
 *
 * @param {import('./shapes').VideoSummary | import('./shapes').Post} item
 * @returns {object}
 */
export function subscriptionCacheEntry(item) {
  if (item.type === 'community' || platformOf(item) !== PLATFORM_YOUTUBE) {
    return { ...item }
  }

  const { thumbnail, ...entry } = item
  return entry
}

/**
 * @param {Array<import('./shapes').VideoSummary | import('./shapes').Post>} items
 * @returns {object[]}
 */
export function subscriptionCacheEntries(items) {
  return items.map(subscriptionCacheEntry)
}
