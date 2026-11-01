/**
 * Sources and shares, the shapes every source kind makes, and the wall made
 * of them.
 *
 * A share is one occurrence of a video in a source (`Share` below). A video shared by three sources has three shares and is one
 * card on a wall: shares are keyed by source and video ref, and the wall
 * groups them by the video ref alone.
 *
 * Framework-free and import-free, so that the build script can run it in
 * Node as it is.
 */

/**
 * @typedef {object} Share one occurrence of a video in a source
 * @property {string} _id the source id and the video's ref, see `shareId`
 * @property {string} sourceId
 * @property {string} videoId a YouTube video id, or a PeerTube video's uuid
 * @property {'peertube'} [platform] PeerTube only, as on every stored video
 * @property {string} [host] PeerTube only: the video's origin
 * @property {string} title what the source calls it, until the video's own details are known
 * @property {string} author the channel name the source gives, likewise
 * @property {number | null} votes the source's votes for it; null where the source has none.
 *   A share given without it (Lemmy, from a post whose header could not be
 *   read) leaves the votes kept as they are
 * @property {string | null} why the source's reason for it; likewise
 * @property {number | null} sharedAt when it was shared, in ms
 * @property {string | null} discussionUrl where the source discusses it
 * @property {string[]} [categories] HackerTube's category ids
 * @property {number} seenAt when the source was first seen to carry it, or
 *   last seen to change it, in ms (see `sharesToPut`)
 */

/**
 * @typedef {object} Source one followed place that shares videos
 * @property {string} _id
 * @property {string} kind
 * @property {string} url
 * @property {string} name
 * @property {number} followedAt
 * @property {string | null} [dataGenerated] HackerTube only: the `generated`
 *   of the data loaded into this installation's shares, null before any is
 * @property {number} [checkedAt] when a refresh last worked for it, in ms;
 *   absent before the first that did. The age the page shows
 * @property {number} [attemptedAt] when a refresh last asked it, in ms,
 *   worked or not; what the hour before opening refreshes again counts from
 * @property {number | null} [failedAt] when its last refresh failed, in ms,
 *   while that is its last refresh; null once one works
 */

/**
 * @typedef {{ videoId: string, host?: string }} VideoRef a YouTube video's id,
 *   or a PeerTube video's uuid with its origin host
 */

/**
 * The video's ref as one string: the video id, and for PeerTube `@` and its
 * origin host.
 *
 * @param {VideoRef} ref
 * @returns {string}
 */
export function shareVideoKey(ref) {
  return typeof ref.host === 'string' && ref.host !== '' ? `${ref.videoId}@${ref.host}` : ref.videoId
}

/**
 * A share's id: its source's id and its video's ref, one share per source
 * per video.
 *
 * @param {string} sourceId
 * @param {VideoRef} ref
 * @returns {string}
 */
export function shareId(sourceId, ref) {
  return `${sourceId}|${shareVideoKey(ref)}`
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * Shallow: right for a share's fields, which are strings, numbers, null and
 * arrays of strings (HackerTube's categories), and wrong for anything
 * nested deeper, which no share holds.
 *
 * @returns {boolean} whether two field values are the same, arrays element
 *   by element and in order
 */
function sameValue(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => item === b[index])
  }

  return a === b
}

/**
 * Of the shares a source gave on a fetch, the ones worth putting: those new
 * to the datastore, and those it keeps whose fields the source now gives
 * differently (votes, why, categories, title and the rest). Nothing is
 * removed: a kept share the source no longer gives is not among them, and
 * stays. A field a share is given without is left as kept, as the put does.
 *
 * When it was seen (`seenAt`) is not compared, or every share would change
 * on every fetch: a share is put with the time it was first seen, or last
 * seen changed. Given twice, the last of them counts.
 *
 * @param {Record<string, Share>} kept the shares kept, by `_id`
 * @param {Share[]} shares the shares the source gave
 * @returns {Share[]}
 */
export function sharesToPut(kept, shares) {
  /** @type {Map<string, Share>} */
  const given = new Map()

  for (const share of shares) {
    given.delete(share._id)
    given.set(share._id, share)
  }

  return [...given.values()].filter((share) => {
    const known = Object.hasOwn(kept, share._id) ? kept[share._id] : undefined
    if (known === undefined) { return true }

    return Object.keys(share).some(field => field !== 'seenAt' && !sameValue(share[field], known[field]))
  })
}

/**
 * @typedef {object} CollectionVideo a video on a collections wall: an
 *   ordinary video object, which every card action understands, with what its
 *   shares say about it under `collection`
 * @property {'video'} type
 * @property {string} videoId
 * @property {string} title
 * @property {string} author
 * @property {number | ''} lengthSeconds `''` until the details say, and not
 *   undefined, which the card would take for a live stream
 * @property {'peertube'} [platform]
 * @property {string} [host]
 * @property {string} [authorId] the channel, once the details say: what the
 *   card links to, and what hidden and marked channels are matched by
 * @property {number} [viewCount]
 * @property {number} [published]
 * @property {true} [liveNow]
 * @property {true} [isUpcoming]
 * @property {Date} [premiereDate]
 * @property {number} [lastUpdatedAt] when the details were fetched: part of
 *   the card's key on the wall, so that a card drawn before they came is drawn
 *   again with them, as a card reads its video once
 * @property {CollectionValues} collection what the shares of the sources
 *   shown say of it (`collectionValues`): what the wall is sorted by, and
 *   what the vote badge shows
 */

/**
 * What the details kept for a video say of it (`details.js` has the record's
 * shape), laid over what its shares said. A field the details have no value
 * for is left as the shares had it.
 *
 * @param {CollectionVideo} video
 * @param {any} details
 */
function withDetails(video, details) {
  if (typeof details.title === 'string' && details.title !== '') { video.title = details.title }
  if (typeof details.author === 'string' && details.author !== '') { video.author = details.author }
  if (typeof details.authorId === 'string' && details.authorId !== '') { video.authorId = details.authorId }
  if (typeof details.lengthSeconds === 'number') { video.lengthSeconds = details.lengthSeconds }
  if (typeof details.viewCount === 'number') { video.viewCount = details.viewCount }
  if (typeof details.published === 'number') { video.published = details.published }
  if (details.liveNow === true) { video.liveNow = true }
  if (details.isUpcoming === true) { video.isUpcoming = true }
  if (typeof details.premiereDate === 'number') { video.premiereDate = new Date(details.premiereDate) }
  if (typeof details.fetchedAt === 'number') { video.lastUpdatedAt = details.fetchedAt }
}

/**
 * @typedef {object} CollectionValues what a video's shares say of it on a
 *   wall, counting only the shares of the sources shown
 * @property {number | null} votes the shown shares' votes summed; null when
 *   none of them has votes (a source kind without votes, or a share whose
 *   votes could not be read), which is not the same as zero
 * @property {number | null} sharedAt the latest of the shown shares' dates,
 *   in ms; null when none has one
 * @property {string[]} sourceIds the shown sources that shared it, each
 *   once, in the order of its shares; empty when none of them is shown
 */

/**
 * What a video's shares say of it, counting only those of the sources shown:
 * its votes summed, the latest date it was shared, and which shown sources
 * shared it. The one answer to these, for the wall's order and for the vote
 * badge on its card, so that the badge always shows the number the wall is
 * sorted by.
 *
 * On Collections the sources shown are those whose chips are on; on a
 * source's page, that source alone, so that its own votes and its own dates
 * are the ones that count there.
 *
 * Votes are summed raw: a video shared widely gets every share's votes, which
 * is intended. A share with no votes, null or never given, adds nothing, and
 * a video none of whose shown shares has votes has none, not zero.
 *
 * @param {Share[]} shares one video's shares, of any sources
 * @param {ReadonlySet<string> | null} shown the ids of the sources shown;
 *   null for every source
 * @returns {CollectionValues}
 */
export function collectionValues(shares, shown) {
  /** @type {CollectionValues} */
  const values = { votes: null, sharedAt: null, sourceIds: [] }

  for (const share of shares) {
    if (shown !== null && !shown.has(share.sourceId)) { continue }

    if (isNumber(share.votes)) {
      values.votes = (values.votes ?? 0) + share.votes
    }

    if (isNumber(share.sharedAt) && (values.sharedAt === null || share.sharedAt > values.sharedAt)) {
      values.sharedAt = share.sharedAt
    }

    if (!values.sourceIds.includes(share.sourceId)) {
      values.sourceIds.push(share.sourceId)
    }
  }

  return values
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * The orders a collections wall can be in, each the most or the newest first:
 * by the shown shares' votes summed (`votes`, "upvotes"), by the latest shown
 * share's date (`shared`, "shared on community"), by the video's own publish
 * date (`published`) and by its views (`views`), the last two from its
 * details.
 *
 * @typedef {'votes' | 'shared' | 'published' | 'views'} CollectionSort
 */

/** @type {readonly CollectionSort[]} in the order the sort select offers them */
export const COLLECTION_SORTS = Object.freeze(['votes', 'shared', 'published', 'views'])

/** @type {CollectionSort} */
export const DEFAULT_COLLECTION_SORT = 'votes'

/**
 * A sort as stored, made safe: one of the four, or upvotes for anything else.
 *
 * @param {unknown} value
 * @returns {CollectionSort}
 */
export function collectionSortOf(value) {
  return COLLECTION_SORTS.includes(/** @type {any} */ (value)) ? /** @type {CollectionSort} */ (value) : DEFAULT_COLLECTION_SORT
}

/**
 * @param {number | null | undefined} a
 * @param {number | null | undefined} b
 * @returns {number} most first, nothing last
 */
function mostFirst(a, b) {
  const aKnown = isNumber(a)
  const bKnown = isNumber(b)

  if (!aKnown || !bKnown) { return aKnown === bKnown ? 0 : aKnown ? -1 : 1 }
  return b - a
}

/**
 * What each sort orders by, before the ties: the value it is named for
 *
 * @type {Record<CollectionSort, (video: CollectionVideo) => number | null | undefined>}
 */
const SORT_VALUES = {
  votes: video => video.collection.votes,
  shared: video => video.collection.sharedAt,
  published: video => video.published,
  views: video => video.viewCount,
}

/**
 * The wall: one video per video ref among the shares of the sources shown,
 * with the values those shares give it (`collectionValues`), in the order
 * asked for, the most or the newest first. A video missing the value sorted
 * on (details not yet known, no shown source with votes) comes after every
 * one that has it. Ties go to the votes, then to the latest shared, then to
 * the video id, so that the order is the same every time.
 *
 * A video none of whose shares is of a source shown is left off; one shown
 * source sharing it is enough.
 *
 * A video's details, once the crawl has them, say what it says of itself:
 * its own title, its channel, duration, views and date. A video YouTube said
 * is unavailable is left off.
 *
 * @param {Share[]} shares
 * @param {Record<string, any>} [details] the details kept, by the video's ref
 *   as one string (`shareVideoKey`)
 * @param {{ shown?: ReadonlySet<string> | null, sort?: CollectionSort | string }} [options]
 *   the ids of the sources shown, null (the default) for every one of them;
 *   the order, upvotes by default
 * @returns {CollectionVideo[]}
 */
export function wallVideos(shares, details = {}, { shown = null, sort = DEFAULT_COLLECTION_SORT } = {}) {
  /** @type {Map<string, Share[]>} */
  const byVideo = new Map()

  for (const share of shares) {
    const key = shareVideoKey(share)
    const group = byVideo.get(key)

    if (group === undefined) {
      byVideo.set(key, [share])
    } else {
      group.push(share)
    }
  }

  /** @type {CollectionVideo[]} */
  const videos = []

  for (const [key, group] of byVideo) {
    const collection = collectionValues(group, shown)

    if (collection.sourceIds.length === 0) { continue }

    // Read before it is looked for, so that a reactive map tells the wall
    // when a video's details arrive
    const kept = details[key]
    const known = Object.hasOwn(details, key) ? kept : undefined

    if (known !== undefined && known.unavailable !== undefined) { continue }

    const shownShares = shown === null ? group : group.filter(share => shown.has(share.sourceId))
    const [first] = shownShares

    /** @type {CollectionVideo} */
    const video = {
      type: 'video',
      videoId: first.videoId,
      title: shownShares.find(share => typeof share.title === 'string' && share.title !== '')?.title ?? '',
      author: shownShares.find(share => typeof share.author === 'string' && share.author !== '')?.author ?? '',
      lengthSeconds: '',
      collection,
    }

    if (first.platform === 'peertube') {
      video.platform = 'peertube'
      video.host = first.host
    }

    if (known !== undefined) {
      withDetails(video, known)
    }

    videos.push(video)
  }

  const valueOf = SORT_VALUES[collectionSortOf(sort)]

  return videos.sort((a, b) => {
    return mostFirst(valueOf(a), valueOf(b)) ||
      mostFirst(a.collection.votes, b.collection.votes) ||
      mostFirst(a.collection.sharedAt, b.collection.sharedAt) ||
      (a.videoId < b.videoId ? -1 : a.videoId > b.videoId ? 1 : 0)
  })
}
